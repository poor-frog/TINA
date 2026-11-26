#!/usr/bin/env python3
"""Local TINA operations CLI. The repository location follows this file, even via a symlink."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import webbrowser

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stack
from tina_style import paint

VERSION = "0.4.0"
MUTATIONS = {"setup", "build", "deploy", "up", "restart", "down"}
IMPACTS = {
    "setup": "Create a private configuration and new data volumes; build and start a new local stack. Download build dependencies and infrastructure images. Host ASR/Capture are separate.",
    "build": "Build images without changing running containers. New workloads may use the updated tags.",
    "deploy": "Build and update containers; brief downtime is possible. Keep volumes. Provision a new API key.",
    "up": "Start or update containers from existing images; downtime is possible. Keep volumes.",
    "restart": "Restart existing containers; keep their images and volumes. Active work may be interrupted.",
    "down": "Stop and remove stack containers and networks. Keep all data volumes.",
    "open": "Open the interface in your default browser.",
}


class CliError(RuntimeError):
    def __init__(self, code, message, exit_code=2, data=None):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code
        self.data = data


class Parser(argparse.ArgumentParser):
    def error(self, message):
        if message.startswith("unrecognized arguments:"):
            message = "Unrecognized arguments; see --help. Use token sources instead of raw credential arguments."
        raise CliError("invalid_arguments", message)


def parser():
    options = Parser(add_help=False)
    options.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Output JSON")
    options.add_argument("--format", choices=["json", "table"], default=argparse.SUPPRESS)
    options.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS,
                         help="Preview only; no build/start/open or credential writes")
    options.add_argument("--yes", action="store_true", default=argparse.SUPPRESS,
                         help="Confirm the displayed deployment and impact without prompting")
    p = Parser(prog="tina", parents=[options], description="TINA repo operations. No command opens TUI on a TTY, status otherwise.")
    p.add_argument("--version", action="version", version="tina " + VERSION)
    commands = p.add_subparsers(dest="command")
    for name, help_text in {
        "status": "Service states, context, project and published ports (read-only)",
        "doctor": "Validate bindings, image availability and readiness (read-only)",
        "check": "Run allowlisted repository checks and save private logs",
        "asr": "Inspect, configure and verify global or account ASR settings",
        "setup": "Set up a new local installation without replacing existing configuration or data",
        "plan": "Resolve the source deployment plan without changes",
        "build": "Build images only; no container activation",
        "deploy": "Build, activate, wait and provision access (make all)",
        "up": "Activate existing images without a build",
        "restart": "Restart existing containers without changing their images",
        "down": "Remove stack containers/network; retain all data volumes",
        "logs": "Read bounded logs; --follow streams until Ctrl-C",
        "open": "Open an enabled UI",
        "tui": "Interactive operations menu",
    }.items():
        sub = commands.add_parser(name, parents=[options], help=help_text, description=help_text)
        if name in {"restart", "logs"}:
            sub.add_argument("service", nargs="?", help="Enabled service name; omit for the stack")
        if name == "logs":
            sub.add_argument("--tail", type=int, default=100, help="Lines per service (0–1000)")
            sub.add_argument("--follow", action="store_true")
        if name == "doctor":
            sub.add_argument("--full", action="store_true", help="Also inspect host Desktop, bridge, selected ASR and configured workers")
        if name == "setup":
            sub.add_argument("--project", default="tina-local", help="New Compose project and local image tag (default: tina-local)")
        if name == "check":
            from tina_checks import CHECKS
            sub.add_argument("suite", nargs="?", default="all", choices=[*CHECKS, "all"])
        if name == "asr":
            actions = sub.add_subparsers(dest="asr_action")
            sub.set_defaults(asr_action="status", scope=None)
            for action in ("status", "verify", "configure"):
                command = actions.add_parser(action, parents=[options], help=action.title() + " ASR settings")
                command.add_argument("--scope", choices=["global", "account"], default=None,
                                     help="Configure requires an explicit scope outside an interactive terminal")
                if action == "configure":
                    command.add_argument("--backend", choices=["deployment", "default", "custom", "funasr", "sherpa", "apple", "nvidia", "viegem"])
                    command.add_argument("--url", help="Explicit HTTP(S) endpoint without embedded credentials or query")
                    tokens = command.add_mutually_exclusive_group()
                    tokens.add_argument("--token-env", help="Environment variable name containing the endpoint token")
                    tokens.add_argument("--token-file", help="Owner-only file containing a single raw endpoint token (not a dotenv file)")
                    tokens.add_argument("--clear-token", action="store_true", help="Explicitly clear this endpoint credential")
        if name == "open":
            sub.add_argument("surface", choices=["terminal", "dashboard"], default="terminal", nargs="?")
    return p


def redact(text, selected):
    # Only display known secrets as redacted, including credentials inside URLs.
    secrets = set()
    values_list = [selected.env, *[v.get("environment", {}) for v in selected.config["services"].values()]] if selected else [os.environ]
    for values in values_list:
        for key, value in values.items():
            if re.search(r"token|password|secret|api_key|access_key|drain_key", key, re.I) and value and len(str(value)) >= 4:
                secrets.add(str(value))
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?(?:bearer|basic)\s+)\S+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|token|password|secret)[\"']?\s*[:=]\s*[\"']?)[^\s,\"'}]+",
                  r"\1[REDACTED]", text)
    return re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[REDACTED]@", text)


class SafeOutput:
    """Line-buffer child logs on stderr so stdout stays one JSON envelope."""
    def __init__(self, selected):
        self.selected, self.pending = selected, ""

    def write(self, value):
        self.pending += value
        while "\n" in self.pending or "\r" in self.pending:
            match = re.search(r"[\r\n]", self.pending)
            line, self.pending = self.pending[:match.start()], self.pending[match.end():]
            sys.stderr.write(redact(line, self.selected) + "\n")
            sys.stderr.flush()
        if len(self.pending) > 65536:
            # Oversize unbroken lines are suppressed rather than leaking a split credential.
            self.pending = "[oversize output suppressed]"
        return len(value)

    def flush(self):
        if self.pending:
            sys.stderr.write(redact(self.pending, self.selected) + "\n")
            self.pending = ""
        sys.stderr.flush()


@contextlib.contextmanager
def command_output(selected):
    original = stack.run
    sink = SafeOutput(selected)

    def run(args, *, env=None, capture=False, check=True):
        if capture:
            return original(args, env=env, capture=True, check=check)
        # Stream long builds without buffering all output. No shell interpolation.
        with subprocess.Popen(args, cwd=stack.HERE, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True) as child:
            try:
                for chunk in child.stdout:
                    sink.write(chunk)
                code = child.wait()
            except BaseException:
                import signal
                os.killpg(child.pid, signal.SIGINT)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                raise
        sink.flush()
        if check and code:
            raise stack.StackError(f"Command failed ({code}); see redacted stderr output.")
        return subprocess.CompletedProcess(args, code, "", "")

    stack.run = run
    try:
        yield sink
    finally:
        sink.flush()
        stack.run = original


def status(selected):
    rows = stack.json_rows(selected.compose("ps", "-a", "--format", "json", capture=True).stdout)
    services = []
    for name, spec in selected.services.items():
        instances = [row for row in rows if row.get("Service") == name]
        for row in instances or [{}]:
            services.append({
                "service": name, "container": row.get("Name"), "state": row.get("State", "missing"),
                "health": row.get("Health") or None, "exit_code": row.get("ExitCode"),
                "ports": [p["published"] for p in spec.get("ports", []) if p.get("published")],
            })
    terminal_published = any(p.get("published") and int(p["target"]) == 3000
                             for p in selected.services.get("terminal", {}).get("ports", []))
    return {"docker_context": selected.context, "project": selected.project, "services": services,
            "terminal_url": selected.endpoint("terminal", 3000) if terminal_published else None,
            "host_services": "Desktop/Capture/ASR/diarization/alignment managed separately; not tested"}


def targets(selected, args):
    service = getattr(args, "service", None)
    if service:
        if service not in selected.services:
            raise CliError("unknown_service", "Service not enabled: " + service)
        names = [service]
    else:
        names = list(selected.services)
    if args.command == "restart":
        names = [name for name in names if name != "storage-init"]
        if not names:
            raise CliError("invalid_service", "storage-init is a one-shot; use up for initialization.")
    return names


def confirm(selected, args):
    if args.command not in MUTATIONS:
        return
    print(paint(f"TINA · {selected.context} · {selected.project}", stream=sys.stderr, bold=True)
          + "\n" + IMPACTS[args.command], file=sys.stderr)
    if args.yes:
        return
    if (not sys.stdin.isatty() or not sys.stdout.isatty() or getattr(args, "json", False)
        or getattr(args, "format", None) == "json"):
        raise CliError("confirmation_required", "Pass --yes after reviewing tina plan or --dry-run.")
    try:
        accepted = input("Continue? [y/N] ").strip().lower() == "y"
    except EOFError:
        accepted = False
    if not accepted:
        raise CliError("cancelled", "Cancelled; no changes were made.", 130)


def execute(selected, args):
    if args.command == "asr":
        import tina_asr
        try:
            if args.dry_run and args.asr_action != "configure":
                return {"command": "asr " + args.asr_action, "dry_run": True, "will_write": False,
                        "scope": args.scope or "global"}
            tina_asr.validate_target(selected)
            if args.asr_action == "configure":
                def approve(preview):
                    print(paint(f"TINA · {selected.context} · {selected.project} · ASR settings", stream=sys.stderr, bold=True), file=sys.stderr)
                    print(json.dumps(preview, ensure_ascii=False, indent=2), file=sys.stderr)
                    if args.yes:
                        return
                    if (not sys.stdin.isatty() or not sys.stdout.isatty() or args.json
                        or getattr(args, "format", None) == "json"):
                        raise CliError("confirmation_required", "Pass --yes after reviewing the ASR scope and --dry-run.")
                    try:
                        accepted = input("Save these settings for new sessions? [y/N] ").strip().lower() == "y"
                    except EOFError:
                        accepted = False
                    if not accepted:
                        raise CliError("cancelled", "Cancelled; no settings were saved.", 130)
                return tina_asr.configure(selected, args, approve)
            data = tina_asr.inspect(selected, args.scope or "global", args.asr_action == "verify",
                                    lambda text: redact(text, selected))
            if args.asr_action == "verify" and not data["ready"]:
                raise CliError("asr_verification_failed", "Saved ASR settings did not pass host/container status checks.", 1, data)
            return data
        except tina_asr.AsrError as error:
            validation = {"scope_required", "backend_required", "invalid_backend", "invalid_choice", "invalid_endpoint",
                          "invalid_token", "token_source_missing", "unsafe_token_file", "token_decision_required",
                          "endpoint_required", "unsupported_token_field", "global_endpoint_owned", "backend_unconfigured"}
            raise CliError(error.code, str(error), 130 if error.code == "cancelled" else 2 if error.code in validation else 1, error.data)
    names = targets(selected, args)
    if args.command == "logs" and not 0 <= args.tail <= 1000:
        raise CliError("invalid_arguments", "--tail must be between 0 and 1000.")
    if args.dry_run:
        data = selected.plan_data()
        data.update({"command": args.command, "dry_run": True, "targets": names,
                     "impact": IMPACTS.get(args.command, "Read-only"), "will_write": False})
        return data
    if args.command == "status":
        return status(selected)
    if args.command == "plan":
        return selected.plan_data()
    if args.command == "doctor":
        if getattr(args, "full", False):
            from tina_diagnostics import full_diagnostics
            data = full_diagnostics(selected, lambda text: redact(text, selected))
            if not data["ready"]:
                raise CliError("diagnostics_failed", "One or more required checks failed; review diagnostics.", 1, data)
            return data
        selected.preflight()
        selected.guard_existing_config()
        selected.check_images()
        selected.readiness()
        return {**status(selected), "ready": True, "audio_ai_acceptance": "not_tested"}
    if args.command == "open":
        if args.surface not in selected.services:
            raise CliError("surface_disabled", "UI profile is not enabled: " + args.surface)
        url = selected.endpoint(args.surface, 3000)
        if not webbrowser.open(url):
            raise CliError("browser_failed", "Could not open browser. URL: " + url, 1)
        return {"url": url}
    if args.command == "logs":
        command = ["logs", "--no-color", "--tail", str(args.tail)]
        if args.follow:
            command += ["--follow"]
        if args.service:
            command += [args.service]
        if args.follow:
            selected.compose(*command)
            return {"follow_ended": True}
        text = selected.compose(*command, capture=True).stdout
        return {"logs": redact(text, selected), "tail": args.tail, "targets": names}
    selected.preflight()
    selected.guard_existing_config()
    confirm(selected, args)
    if args.command in {"build", "deploy"}:
        stack.run(["bash", str(stack.HERE / "mint-dev-env.sh"), str(selected.env_file)], env=selected.env)
        resolved = stack.Stack("build", env=selected.env)
        if (resolved.context, resolved.project, resolved.files) != (selected.context, selected.project, selected.files):
            raise CliError("configuration_changed", "Deployment changed during bootstrap; no build started.", 1)
        selected = resolved
        selected.validate_admin()
        selected.build()
        if args.command == "deploy":
            selected.activate()
            selected.provision_key()  # Preserve make-all access verification; never print the key.
        return {"command": args.command, "completed": True, "credentials_displayed": False}
    if args.command == "up":
        selected.validate_admin()
        selected.check_images()
        selected.activate()
    elif args.command == "down":
        selected.stop_asr_control()
        selected.compose("down", "--remove-orphans")
        if selected.viegem_device == "mps":
            selected.native_viegem("stop")
    elif args.command == "restart":
        rows = stack.json_rows(selected.compose("ps", "-a", "--format", "json", capture=True).stdout)
        if any(name not in {row.get("Service") for row in rows} for name in names):
            raise CliError("container_missing", "Use tina up to create missing containers; restart never recreates them.", 1)
        selected.compose("restart", "--no-deps", "--timeout", "30", *names)
        deadline = time.monotonic() + int(selected.env.get("WAIT_TIMEOUT", "180"))
        while True:
            try:
                selected.readiness(names)
                break
            except stack.StackError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
    return {"command": args.command, "targets": names, "completed": True, "volumes_retained": True}


def setup_next_steps(selected):
    prefix = "ENV_FILE=" + shlex.quote(str(selected.env_file)) + " "
    return {"terminal_url": selected.endpoint("terminal", 3000),
            "notes": ["Compose is ready. ASR and native Desktop/Capture are managed separately.",
                      "Open Terminal, create your local account, then configure agent credentials in Settings → Models.",
                      "ASR status probes do not test recognition quality or a real meeting."],
            "next_steps": [prefix + "tina asr configure --scope global",
                           prefix + "tina asr verify", prefix + "tina doctor --full"]}


def emit(ok, data, error, json_mode):
    envelope = {"ok": ok, "data": data} if ok else {"ok": False, "error": error}
    envelope["meta"] = {"schema_version": "1", "cli_version": VERSION}
    if not ok and data is not None:
        envelope["data"] = data
    if json_mode:
        print(json.dumps(envelope, ensure_ascii=False))
    elif data and any(key in data for key in ("diagnostics", "checks", "asr_settings", "asr_change", "setup")):
        print(paint(f"TINA · {data.get('docker_context', 'repository')} · {data.get('project') or data.get('repository')}", bold=True))
        if data.get("setup"):
            print(paint("  New installation · " + data["setup"], bold=True))
            print("    Configuration: " + data["env_file"])
            if data.get("terminal_url"):
                print("    Terminal: " + data["terminal_url"])
            if data.get("dry_run"):
                print("    " + data["impact"])
                print("    Services: " + ", ".join(data["services"]))
                print("    Loopback ports: " + ", ".join(
                    name + ":" + str(port) for name, ports in data["published_ports"].items() for port in ports))
        if data.get("asr_change"):
            change = data["asr_change"]
            print(paint("  ASR change · " + ("SAVED" if change.get("saved") else "PREVIEW"), bold=True))
            for key in ("scope", "account_id", "current_backend", "requested_backend", "stored_backend", "current_endpoint", "endpoint", "credential_change", "impact", "note"):
                if change.get(key) is not None:
                    print(f"    {key}: {change[key]}")
        for row in data.get("asr_settings", []):
            print("  " + paint(row["scope"], bold=True) + " · " + row["state"] + " · " + row.get("backend", "unresolved"))
            if row.get("account_id"):
                print("    Account ID: " + str(row["account_id"]))
            print("    Endpoint: " + (row.get("endpoint") or "not configured"))
            print("    Token: " + ("configured (hidden)" if row.get("token_set") else "not set"))
            if row.get("request_model"):
                print("    Request model: " + row["request_model"])
        for row in data.get("diagnostics", data.get("checks", [])):
            state = row.get("state", row.get("status"))
            token = "brand" if state in {"ready", "running", "pass"} else "muted" if state in {"unconfigured", "not_verified"} else "rejected"
            print(f"  {row['name']:<23} " + paint(f"{state:<18}", token) + (row.get("scope", "")))
            if row.get("model"):
                print(f"    {row['model']} · {row.get('device', '')}")
            if row.get("detail"):
                print("    " + row["detail"])
            if row.get("log_path"):
                print("    Log: " + row["log_path"])
            for line in row.get("failure_tail", []):
                print("    " + line)
        for note in data.get("notes", []):
            print(paint("  " + note, "muted"))
        for command in data.get("next_steps", []):
            print("    " + command)
        if not ok:
            print(paint(error["message"], "rejected", stream=sys.stderr), file=sys.stderr)
    elif ok:
        if "logs" in data:
            print(data["logs"], end="" if data["logs"].endswith("\n") else "\n")
        elif "services" in data and data["services"] and isinstance(data["services"][0], dict):
            print(paint(f"TINA · {data['docker_context']} · {data['project']}", bold=True))
            print(paint(f"  {'SERVICE':<17} {'STATE':<10} {'HEALTH':<10} PORTS", "muted"))
            for row in data["services"]:
                health = row["health"] or ("completed" if row["state"] == "exited" and row["exit_code"] == 0 else "-")
                token = "brand" if health == "healthy" else "rejected" if health == "unhealthy" else "muted"
                print(f"  {row['service']:<17} {row['state']:<10} "
                      + paint(f"{health:<10}", token) + " " + ",".join(row["ports"]))
            print("\n" + paint(data.get("terminal_url") or "No published Terminal URL"))
            print(paint(data["host_services"], "muted"))
        else:
            print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(paint(f"{error['code']}: {error['message']}", "rejected", stream=sys.stderr), file=sys.stderr)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    json_mode = "--json" in argv or not sys.stdout.isatty()
    selected = None
    error_data = None
    try:
        if any(value in {"--token", "--api-key"} or value.startswith(("--token=", "--api-key=")) for value in argv):
            raise CliError("invalid_arguments", "Raw credential arguments are not supported. Use --token-env, --token-file or hidden input.")
        args = parser().parse_args(argv)
        args.json = getattr(args, "json", False)
        args.dry_run = getattr(args, "dry_run", False)
        args.yes = getattr(args, "yes", False)
        if args.command == "asr":
            args.asr_action = args.asr_action or "status"
        if getattr(args, "format", None):
            json_mode = args.format == "json"
        elif args.json:
            json_mode = True
        if args.command is None:
            args.command = "tui" if sys.stdin.isatty() and sys.stdout.isatty() and not json_mode else "status"
        if args.command == "tui":
            if not sys.stdin.isatty() or not sys.stdout.isatty():
                raise CliError("interactive_terminal_required", "Use tina status --json without a TTY.")
            if args.dry_run:
                args.command = "plan"
            else:
                from tina_tui import run_tui
                import curses
                try:
                    return run_tui(main, lambda: status(stack.Stack("doctor")))
                except curses.error:
                    raise CliError("unsupported_terminal", "Cannot open TUI; try tina status --json.")
        if args.command == "check":
            from tina_checks import CHECKS, ROOT, run_checks
            if args.dry_run:
                names = list(CHECKS) if args.suite == "all" else [args.suite]
                data = {"dry_run": True, "repository": str(ROOT), "commands": [CHECKS[name] for name in names], "will_write": False}
            else:
                data = run_checks(args.suite, lambda text: redact(text, None))
                if not data["passed"]:
                    raise CliError("checks_failed", "Repository checks failed; see each log and failure detail.", 1, data)
            emit(True, data, None, json_mode)
            return 0
        if args.command == "setup":
            import tina_setup
            with command_output(None):
                selected = tina_setup.prepare(args.project)
            data = {**selected.plan_data(), "setup": "preview", "dry_run": args.dry_run,
                    "will_write": not args.dry_run, "impact": IMPACTS["setup"],
                    "published_ports": {name: [p["published"] for p in spec.get("ports", []) if p.get("published")]
                                        for name, spec in selected.services.items() if spec.get("ports")}}
            if args.dry_run:
                emit(True, data, None, json_mode)
                return 0
            print(json.dumps(data, indent=2), file=sys.stderr)
            confirm(selected, args)
            with command_output(selected):
                selected = tina_setup.create(selected)
            with command_output(selected):
                execute(selected, argparse.Namespace(command="deploy", yes=True, dry_run=False))
                data = {"setup": "platform_ready", "env_file": str(selected.env_file),
                        "docker_context": selected.context, "project": selected.project,
                        "asr_ready": False, **setup_next_steps(selected)}
                interactive = sys.stdin.isatty() and sys.stdout.isatty() and not json_mode
                if interactive:
                    try:
                        configure = input("\nConfigure an existing ASR endpoint now? [y/N] ").strip().lower() == "y"
                    except EOFError:
                        configure = False
                    if configure:
                        config_args = parser().parse_args(["asr", "configure", "--scope", "global"])
                        config_args.json, config_args.yes, config_args.dry_run = False, False, False
                        verify_args = argparse.Namespace(command="asr", asr_action="verify", scope="global", dry_run=False)
                        try:
                            execute(selected, config_args)
                            verification = execute(selected, verify_args)
                            data["asr_ready"] = verification["ready"]
                            data["diagnostics"] = verification["diagnostics"]
                        except CliError as error:
                            if error.code != "asr_verification_failed":
                                raise CliError(error.code, str(error), error.exit_code, data) from error
                            data["diagnostics"] = error.data["diagnostics"]
                            raise CliError(error.code, "Platform is ready, but ASR verification failed. Inspect the saved endpoint before recording.", 1, data)
            emit(True, data, None, json_mode)
            return 0
        selected = stack.Stack("build" if args.command in {"build", "deploy"} else
                               "plan" if args.command == "plan" else "doctor")
        with command_output(selected):
            data = execute(selected, args)
        data.setdefault("docker_context", selected.context)
        data.setdefault("project", selected.project)
        emit(True, data, None, json_mode)
        return 0
    except KeyboardInterrupt:
        code, message, exit_code = "cancelled", "Cancelled. Check tina status after an interrupted operation.", 130
    except CliError as error:
        code, message, exit_code = error.code, str(error), error.exit_code
        error_data = error.data
    except (stack.StackError, OSError, ValueError, KeyError) as error:
        code, message, exit_code = "operation_failed", str(error), 1
    if (selected is not None and args.command == "setup" and selected.env_file.exists()
            and error_data is None):
        prefix = "ENV_FILE=" + shlex.quote(str(selected.env_file)) + " "
        error_data = {"setup": "incomplete", "env_file": str(selected.env_file),
                      "docker_context": selected.context, "project": selected.project,
                      "notes": ["Configuration and any created resources were retained. No rollback or volume deletion was attempted."],
                      "next_steps": [prefix + "tina status", prefix + "tina deploy"]}
    if selected is not None:
        message = redact(message, selected)
    emit(False, error_data, {"code": code, "message": message, "retryable": False}, json_mode)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

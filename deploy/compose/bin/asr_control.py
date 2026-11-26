#!/usr/bin/env python3
"""Account-scoped ASR resource demand; owns only this deployment's VieGem worker."""
import json
import hashlib
import hmac
import importlib.util
import os
from pathlib import Path
import platform
import plistlib
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit
import urllib.request
import urllib.error

BACKENDS = ("viegem",)
MODEL = "5CD-AI/VieGem-ASR"


def request_json(url, headers=None, payload=None, method=None, timeout=8):
    req = urllib.request.Request(url, headers={"Content-Type": "application/json", **(headers or {})},
                                 data=None if payload is None else json.dumps(payload).encode(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code if error.code in (401, 403, 404, 409, 422) else 503
        raise ControlError(status, "ASR configuration changed or is unavailable; refresh and retry") from None
    except (OSError, ValueError):
        raise ControlError(503, "ASR service is unavailable; retry shortly") from None


class Identity:
    def __init__(self, selected):
        self.url = selected.endpoint("admin-api", 8001)
        self.headers = {"X-Internal-Secret": selected.services["admin-api"]["environment"]["INTERNAL_API_SECRET"]}
    def read(self, user_id=None):
        return request_json(self.url + "/internal/transcription/runtime?" + urlencode({"user_id": user_id or ""}), self.headers)
    def update(self, user_id, backend, enabled, revision):
        return request_json(self.url + f"/internal/users/{user_id}/transcription-runtime", self.headers,
                            {"backend": backend, "enabled": "true" if enabled else "false", "expected_revision": revision}, "PUT")


class Workers:
    def __init__(self, selected):
        self.selected = selected
        self.identity_env = selected.services["admin-api"]["environment"]
    def endpoint(self, backend):
        if backend == "viegem" and self.selected.viegem_device == "mps":
            host, _ = self.selected.native_viegem_access()
            if self.selected.context == "orbstack" and self._owns_loopback_viegem():
                host = "127.0.0.1"
            return f"http://{host}:18005"
        return self.selected.endpoint(backend, 8000)

    def _owns_loopback_viegem(self):
        from native_viegem import LABEL, ROOT
        agent = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
        try:
            config = plistlib.loads(agent.read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException):
            return False
        if not isinstance(config, dict) or config.get("WorkingDirectory") != str(ROOT):
            return False
        env = config.get("EnvironmentVariables")
        return (isinstance(env, dict) and env.get("TINA_VIEGEM_HOST") == "127.0.0.1"
                and env.get("TINA_VIEGEM_ENV_FILE") == str(self.selected.env_file.resolve()))

    def credential(self):
        return self.identity_env.get("TINA_VIEGEM_TOKEN", "")
    def status(self, backend):
        if backend not in self.selected.services and not (
                backend == "viegem" and self.selected.viegem_device == "mps"):
            return {"running": False, "ready": False,
                    "device": self.selected.viegem_device}
        try:
            info = request_json(self.endpoint(backend) + "/status", timeout=1)
            model = info["model"]
            if model["asr_model"] != MODEL:
                raise ControlError(503, "Unexpected worker on ASR port")
            recent = info.get("recent") or []
            completed = max((row["at_ms"] + (row.get("total_ms") or 0) for row in recent), default=0)
            return {"running": True, "ready": not info.get("draining", False), "device": model["device"],
                    "draining": info.get("draining", False), "idle_seconds": max(0, time.time() - completed / 1000)}
        except ControlError:
            return {"running": False, "ready": False, "device": self.selected.viegem_device}
    def owned_container(self, backend):
        import stack
        ids = stack.run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={self.selected.project}",
                         "--filter", "label=com.docker.compose.service=" + backend], env=self.selected.env, capture=True).stdout.split()
        if not ids:
            return
        containers = json.loads(stack.run(["docker", "inspect", *ids], env=self.selected.env, capture=True).stdout)
        for item in containers:
            files = item["Config"]["Labels"].get("com.docker.compose.project.config_files", "").split(",")
            if not files[0] or str(Path(files[0]).resolve()) != self.selected.files[0]:
                raise ControlError(409, "The ASR worker belongs to another checkout; it was not changed")
    def start(self, backend):
        from stack import ROOT
        if not self.status(backend)["running"]:
            if backend == "viegem" and self.selected.viegem_device == "mps":
                self.selected.native_viegem("start")
            else:
                self.owned_container(backend)
                self.selected.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", backend, capture=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if self.status(backend)["running"]:
                self.drain(backend, False)
                entry = importlib.util.spec_from_file_location("asr_probe", ROOT / "deploy/contracts/config.v1/preflight.py")
                module = importlib.util.module_from_spec(entry); entry.loader.exec_module(module)
                kind, body = module.audio_probe_body(MODEL)
                req = urllib.request.Request(self.endpoint(backend) + "/v1/audio/transcriptions", data=body,
                    headers={"Content-Type": kind, "Authorization": "Bearer " + self.credential()})
                try:
                    with urllib.request.urlopen(req, timeout=20) as response:
                        if response.status == 200 and isinstance(json.load(response).get("text"), str):
                            return
                except (OSError, ValueError):
                    raise ControlError(503, "ASR audio probe failed; your previous selection was preserved") from None
            time.sleep(1)
        raise ControlError(503, "ASR did not become ready; your previous selection was preserved")
    def drain(self, backend, enabled):
        secret = self.identity_env["INTERNAL_API_SECRET"]
        key = hmac.new(secret.encode(), f"tina-asr-drain:v1:{backend}".encode(), "sha256").hexdigest()
        try:
            request_json(self.endpoint(backend) + "/internal/drain", {"X-ASR-Control-Key": key}, {"draining": enabled})
            return True
        except ControlError:
            return False
    def stop(self, backend):
        if backend == "viegem" and self.selected.viegem_device == "mps":
            self.selected.native_viegem("stop")
        else:
            self.owned_container(backend)
            self.selected.compose("stop", backend, capture=True)
    def busy(self):
        import stack
        result = stack.run(["docker", "ps", "-q", "--filter", "network=" + self.selected.config["networks"]["tina"]["name"],
                            "--filter", "name=tina-mtg"], env=self.selected.env, capture=True, check=False)
        if result.returncode or result.stdout.strip():
            return True
        if "discord-connector" in self.selected.services:
            try:
                connector = request_json(self.selected.endpoint("discord-connector", 8091) + "/healthz", timeout=1)
                if type(connector.get("sessions")) is not int or connector["sessions"] > 0:
                    return True
            except ControlError:
                return True
        try:
            # shortcut: any local capture protects the worker; narrow per-session holds when Desktop exposes them.
            info = request_json("http://127.0.0.1:8056/health", timeout=1)
            return type(info.get("live_sessions")) is not int or info["live_sessions"] > 0
        except ControlError:
            with socket.socket() as sock:
                return sock.connect_ex(("127.0.0.1", 8056)) == 0


class ControlError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Controller:
    def __init__(self, identity, workers, state_file, instance, *, grace=10, clock=time.monotonic, revision=""):
        self.identity, self.workers = identity, workers
        self.state_file, self.instance = Path(state_file), instance
        self.grace, self.clock = grace, clock
        self.revision = revision
        self.lock = threading.Lock()
        self.operation = None
        self.unneeded_since, self.retry_after = {}, {}
        self.last_error = None

    def persist(self, counts):
        self.state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body = {"version": 1, "instance": self.instance,
                "desired": [name for name in BACKENDS if counts[name] > 0]}
        temporary = self.state_file.with_suffix(".new")
        temporary.write_text(json.dumps(body) + "\n"); temporary.chmod(0o600); temporary.replace(self.state_file)

    def status(self, user_id):
        data = self.identity.read(user_id)
        account = data["account"]
        return {"instance": self.instance, "account": {k: account[k] for k in ("backend", "enabled", "revision")},
                "counts": {name: data["counts"][name] for name in BACKENDS}, "workers": {name: self.workers.status(name) for name in BACKENDS},
                "operation": self.operation, "last_error": self.last_error}

    def select(self, user_id, backend, enabled, revision):
        if backend not in BACKENDS or type(enabled) is not bool or type(revision) is not int or revision < 0:
            raise ControlError(422, "Invalid ASR selection")
        if not self.lock.acquire(blocking=False):
            raise ControlError(409, "Another ASR operation is in progress; retry shortly")
        try:
            before = self.identity.read(user_id)["account"]
            if before["revision"] != revision:
                raise ControlError(409, "Transcription settings changed; refresh and retry")
            if not enabled and before["backend"] != backend:
                raise ControlError(409, "Only the selected model can be stopped for this account")
            self.operation = {"backend": backend, "phase": "starting" if enabled else "stopping"}
            if enabled:
                self.workers.start(backend)  # Preferences remain untouched until auth/audio succeeds.
            self.identity.update(user_id, backend, enabled, revision)
            data = self.identity.read(user_id)
            self.persist(data["counts"])
            self._retire(data["counts"])
            self.last_error = None
        finally:
            self.operation = None
            self.lock.release()
        return self.status(user_id)

    def _retire(self, counts):
        for backend in BACKENDS:
            if counts[backend] > 0:
                self.unneeded_since.pop(backend, None)
                continue
            state = self.workers.status(backend)
            if not state["running"]:
                self.unneeded_since.pop(backend, None)
                continue
            since = self.unneeded_since.setdefault(backend, self.clock())
            if self.clock() - since < self.grace or state.get("idle_seconds", float("inf")) < self.grace or self.workers.busy():
                continue
            if not self.workers.drain(backend, True):
                continue
            stopped = False
            try:
                # Another account may have saved a preference while the worker was draining.
                fresh = self.identity.read()["counts"]
                if fresh[backend] or self.workers.busy():
                    continue
                self.workers.stop(backend)
                stopped = True
            finally:
                if not stopped:
                    self.workers.drain(backend, False)

    def reconcile(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            data = self.identity.read()
            self.persist(data["counts"])
            for backend in BACKENDS:
                if data["counts"][backend] and self.clock() >= self.retry_after.get(backend, 0):
                    state = self.workers.status(backend)
                    if not state["running"] or state.get("draining"):
                        self.operation = {"backend": backend, "phase": "starting"}
                        try:
                            self.workers.start(backend)
                        except Exception:
                            self.retry_after[backend] = self.clock() + 30
                            self.last_error = f"Could not start {backend}; retrying later"
            self._retire(data["counts"])
        finally:
            self.operation = None
            self.lock.release()


def control_key(selected):
    secret = selected.services["admin-api"]["environment"]["INTERNAL_API_SECRET"]
    return hmac.new(secret.encode(), b"tina-asr-control:v1", "sha256").hexdigest()


def instance_of(selected):
    return hashlib.sha256((str(selected.env_file.resolve()) + "\0" + selected.project).encode()).hexdigest()[:20]


def bootstrap_launchagent(agent: Path):
    import stack
    args = ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(agent)]
    for attempt in range(5):
        result = stack.run(args, capture=True, check=False)
        if result.returncode == 0:
            return
        if result.returncode != 5 or attempt == 4:
            break
        time.sleep(1)
    raise ControlError(503, "Could not start the owned ASR controller LaunchAgent")


def handler(controller, key):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup(); self.connection.settimeout(5)
        def log_message(self, *_): pass
        def reply(self, code, body):
            encoded = json.dumps(body).encode()
            self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(encoded)))
            self.end_headers(); self.wfile.write(encoded)
        def handle_request(self, write):
            if not hmac.compare_digest(self.headers.get("X-ASR-Control-Key", "").encode(), key.encode()):
                return self.reply(401, {"detail": "Unauthorized"})
            try:
                parsed = urlsplit(self.path)
                if parsed.path == "/health" and not write:
                    return self.reply(200, {"instance": controller.instance, "revision": controller.revision, "ok": True})
                if parsed.path == "/shutdown" and write:
                    self.reply(200, {"ok": True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                if parsed.path != "/runtime":
                    return self.reply(404, {"detail": "Not found"})
                if write:
                    length = int(self.headers.get("Content-Length", "0"))
                    if self.headers.get("Transfer-Encoding") or not 0 < length <= 1024:
                        raise ControlError(413, "Invalid request size")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict) or set(payload) != {"user_id", "backend", "enabled", "revision"}:
                        raise ControlError(422, "Invalid ASR request")
                    uid = str(payload["user_id"])
                else:
                    payload = None
                    uid = parse_qs(parsed.query).get("user_id", [""])[0]
                if not uid.isascii() or not uid.isdigit() or len(uid) > 18 or int(uid) < 1:
                    raise ControlError(422, "Invalid account")
                result = (controller.select(uid, payload["backend"], payload["enabled"], payload["revision"])
                          if write else controller.status(uid))
                return self.reply(200, result)
            except ControlError as error:
                return self.reply(error.status, {"detail": str(error)})
            except (ValueError, TypeError, KeyError):
                return self.reply(422, {"detail": "Invalid ASR request"})
            except Exception:
                return self.reply(503, {"detail": "ASR operation failed; refresh status before retrying"})
        def do_GET(self): self.handle_request(False)
        def do_POST(self): self.handle_request(True)
    return Handler


def install(selected):
    import stack
    state = Path.home() / ".config/tina/asr-control" / instance_of(selected)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = {"instance": instance_of(selected), "env": {k: selected.env[k] for k in
              ("DOCKER_CONTEXT", "PROJECT", "COMPOSE_PROJECT", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "DOTENVX_BIN", "DOTENVX_KEY_FILE") if k in selected.env}}
    config["env"].update(ENV_FILE=str(selected.env_file.resolve()),
                         COMPOSE_FILE=os.pathsep.join(f for f in selected.files if f != stack.CUDA_OVERLAY))
    revision = hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name("stack.py").read_bytes()
                              + json.dumps(config["env"], sort_keys=True).encode()).hexdigest()
    config["revision"] = revision
    config_path = state / "config.json"
    config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
    port = selected.control_port
    key = control_key(selected)
    try:
        current = request_json(f"http://127.0.0.1:{port}/health", {"X-ASR-Control-Key": key}, timeout=2)
        if current.get("instance") == config["instance"]:
            if current.get("revision") == revision:
                return
            shutdown(selected)
        else:
            raise ControlError(409, "Another ASR controller owns this port")
    except ControlError as error:
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise ControlError(409, "ASR control port is already in use; its owner was not stopped") from error
    args = [sys.executable, str(stack.HERE / "bin/asr_control.py"), "serve", str(config_path)]
    log_dir = state
    if platform.system() == "Darwin":
        label = "local.tina.asr-control." + config["instance"]
        agent = Path.home() / "Library/LaunchAgents" / (label + ".plist")
        agent.parent.mkdir(parents=True, exist_ok=True)
        body = {"Label": label, "ProgramArguments": args, "WorkingDirectory": str(stack.ROOT),
                "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
                "EnvironmentVariables": {"PATH": os.environ["PATH"]},
                "StandardOutPath": str(log_dir / "stdout.log"), "StandardErrorPath": str(log_dir / "stderr.log")}
        agent.write_bytes(plistlib.dumps(body)); agent.chmod(0o600)
        bootstrap_launchagent(agent)
    else:
        # WSL2 has no launchd; detached controller persists across terminal close, make all restores after reboot.
        clean_env = {k: v for k, v in os.environ.items() if not any(x in k for x in ("SECRET", "TOKEN", "PRIVATE_KEY"))}
        with (log_dir / "stdout.log").open("ab") as stdout, (log_dir / "stderr.log").open("ab") as stderr:
            subprocess.Popen(args, cwd=stack.ROOT, env=clean_env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
    for _ in range(20):
        try:
            ready = request_json(f"http://127.0.0.1:{port}/health", {"X-ASR-Control-Key": key}, timeout=1)
            if ready.get("instance") == config["instance"]:
                print("ASR controller ready: account-scoped start/stop enabled.", flush=True)
                return
        except ControlError:
            pass
        time.sleep(.5)
    raise ControlError(503, "ASR controller did not become ready; inspect its private local logs")


def shutdown(selected):
    import stack
    instance = instance_of(selected)
    url = f"http://127.0.0.1:{selected.control_port}"
    headers = {"X-ASR-Control-Key": control_key(selected)}
    if platform.system() == "Darwin":
        label = "local.tina.asr-control." + instance
        agent = Path.home() / "Library/LaunchAgents" / (label + ".plist")
        if not agent.exists(): return
        body = plistlib.loads(agent.read_bytes())
        if body.get("WorkingDirectory") != str(stack.ROOT):
            raise ControlError(409, "ASR controller belongs to another checkout; it was not stopped")
        result = stack.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture=True, check=False)
        if result.returncode == 0:
            stack.run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], capture=True)
        agent.unlink()
    else:
        try:
            info = request_json(url + "/health", headers, timeout=2)
            if info.get("instance") != instance:
                raise ControlError(409, "Another ASR controller owns this port")
            request_json(url + "/shutdown", headers, {}, timeout=2)
        except ControlError as error:
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", selected.control_port)) == 0: raise error


def serve(config_path):
    import stack
    config_path = Path(config_path)
    config = json.loads(config_path.read_text())
    selected = stack.Stack("runtime-control", env={**os.environ, **config["env"]})
    if instance_of(selected) != config["instance"]:
        raise ControlError(409, "ASR controller deployment changed")
    selected.guard_existing_config()
    controller = Controller(Identity(selected), Workers(selected), config_path.parent / "state.json", config["instance"], revision=config.get("revision", ""))
    server = ThreadingHTTPServer(("127.0.0.1", selected.control_port), handler(controller, control_key(selected)))
    server.daemon_threads = True
    def reconcile():
        while True:
            try:
                controller.reconcile()
                if controller.last_error == "Could not reconcile ASR resources; no forced stop was performed":
                    controller.last_error = None
            except Exception: controller.last_error = "Could not reconcile ASR resources; no forced stop was performed"
            time.sleep(2)
    threading.Thread(target=reconcile, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    serve(sys.argv[2])

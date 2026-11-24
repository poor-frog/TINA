"""ASR settings adapter over existing Identity APIs. No model/process control or audio uploads."""
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys

import tina_diagnostics as diagnostics
from stack import json_rows

GLOBAL = ("deployment", "custom", "funasr", "sherpa", "apple", "nvidia", "viegem")
ACCOUNT = ("default", "custom", "funasr", "sherpa", "apple", "nvidia", "viegem")


class AsrError(RuntimeError):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.data = code, data


def read_input(prompt, hidden=False):
    try:
        return getpass.getpass(prompt) if hidden else input(prompt)
    except EOFError:
        raise AsrError("cancelled", "Cancelled; no settings were saved.")


def validate_target(selected):
    selected.validate_bindings()
    selected.guard_existing_config()
    rows = json_rows(selected.compose("ps", "--format", "json", "admin-api", capture=True).stdout)
    expected = {int(port["published"]) for port in selected.services["admin-api"].get("ports", [])
                if int(port["target"]) == 8001 and port.get("published")}
    if not any(row.get("Service") == "admin-api" and row.get("Project") == selected.project
               and row.get("State") == "running" and any(
                   port.get("TargetPort") == 8001 and port.get("PublishedPort") in expected
                   for port in row.get("Publishers", [])) for row in rows):
        raise AsrError("selected_stack_unavailable", "Selected project has no running Identity API at its configured published port. No settings request was sent.")


def headers(selected):
    secret = selected.services["admin-api"].get("environment", {}).get("INTERNAL_API_SECRET")
    if not secret:
        raise AsrError("identity_unconfigured", "Identity internal credential is not configured.")
    return {"X-Internal-Secret": secret}


def api(selected, path, auth, payload=None):
    result = diagnostics.request_json(selected.endpoint("admin-api", 8001) + path,
                                      auth, payload, method="PUT" if payload is not None else "GET")
    if result["state"] != "responding" or not isinstance(result.get("body"), dict):
        if payload is not None:
            rejected = 400 <= result.get("http_status", 0) < 500 and result.get("http_status") != 408
            raise AsrError("settings_rejected" if rejected else "settings_write_unconfirmed",
                "Identity rejected the settings update." if rejected else
                "Settings update was submitted but could not be confirmed. Run asr status; do not assume rollback or blindly retry.")
        raise AsrError("settings_" + result["state"], "Identity settings request failed; credentials and response bodies are suppressed.")
    return result["body"]


def account_key(selected):
    return (selected.env.get("TINA_API_KEY") or selected.env.get("TINA_DESKTOP_API_KEY")
            or selected.runtime.get("TINA_DESKTOP_API_KEY", ""))


def principal(selected, key):
    if not key:
        raise AsrError("account_credential_required", "Set TINA_API_KEY or bind TINA_DESKTOP_API_KEY; no account is selected implicitly.")
    result = diagnostics.request_json(selected.endpoint("admin-api", 8001) + "/internal/validate",
                                      headers(selected), {"token": key})
    body = result.get("body", {})
    uid = body.get("user_id") if isinstance(body, dict) else None
    if (result["state"] != "responding" or type(uid) is not int or uid < 1
        or not isinstance(body.get("scopes"), list) or any(not isinstance(scope, str) for scope in body["scopes"])
        or not {"bot", "tx", "legacy"}.intersection(body["scopes"])):
        raise AsrError("account_access_denied", "Account credential is invalid, expired or lacks bot/tx access. No global fallback was used.")
    return uid


def stored(selected, scope, key=""):
    if scope == "global":
        result = api(selected, "/internal/settings/transcription", headers(selected))
        if result.get("key") != "transcription" or not isinstance(result.get("value"), dict):
            raise AsrError("invalid_settings", "Identity returned an unsupported global settings response.")
        value = result["value"]
        for field in ("default_backend", "url", "token", "funasr_url", "sherpa_url", "apple_url", "apple_token", "nvidia_url", "nvidia_token", "viegem_url", "viegem_token"):
            if field in value and not isinstance(value[field], str):
                raise AsrError("invalid_settings", "Stored global ASR fields are malformed; inspect current settings.")
        return value
    value = api(selected, "/user/transcription", {"X-API-Key": key})
    if (not isinstance(value.get("available_backends"), list)
        or any(not isinstance(item, str) for item in value["available_backends"])
        or not isinstance(value.get("token_set"), bool)
        or value.get("url") is not None and not isinstance(value["url"], str)
        or value.get("backend") is not None and not isinstance(value["backend"], str)):
        raise AsrError("invalid_settings", "Account settings response is malformed; inspect current settings.")
    return value


def clean_url(url):
    if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise AsrError("invalid_endpoint", "Endpoint must be a credential-free HTTP(S) URL without whitespace, query or fragment.")
    try:
        result = diagnostics.endpoint(url, "")
    except ValueError:
        raise AsrError("invalid_endpoint", "Endpoint must be a credential-free HTTP(S) URL without query or fragment.")
    return result


def summary(resolved, scope):
    if resolved["state"] not in {"configured", "unconfigured"} or "config" not in resolved:
        return {"scope": scope, "state": resolved["state"], "detail": "Effective settings could not be resolved; no fallback was guessed."}
    config = resolved["config"]
    url = config.get("url", "")
    try:
        safe_url = clean_url(url) if url else None
    except AsrError:
        safe_url = "[invalid or credential-bearing endpoint]"
    token = config.get("token", "")
    if safe_url and token:
        safe_url = safe_url.replace(token, "[REDACTED]")
    model = config.get("model") or "server/default alias"
    model = "".join(c for c in model if c.isprintable())[:300]
    if token:
        model = model.replace(token, "[REDACTED]")
    return {"scope": scope, "state": resolved["state"], "backend": config["backend"], "endpoint": safe_url,
            "token_set": bool(token), "request_model": model,
            "applies_to": "next-session"}


def inspect(selected, scope, verify, clean):
    rows = []
    if scope == "account":
        key = account_key(selected)
        uid = principal(selected, key)
        result = diagnostics.resolve_asr(selected, key)
        rows.append({**summary(result, "account"), "account_id": uid})
        contexts = [(result, "asr_account_host", "account:" + str(uid), True),
                    (result, "asr_account_container", "account:" + str(uid), False)]
    else:
        global_result = diagnostics.resolve_asr(selected)
        rows.append(summary(global_result, "global"))
        key = selected.env.get("TINA_DESKTOP_API_KEY") or selected.runtime.get("TINA_DESKTOP_API_KEY", "")
        desktop_result = diagnostics.resolve_asr(selected, key) if key else global_result
        rows.append(summary(desktop_result, "desktop_bound_account" if key else "desktop_global_defaults"))
        contexts = [(desktop_result, "asr_desktop", rows[-1]["scope"], True),
                    (global_result, "asr_bot", "global_defaults_container", False)]
    data = {"asr_settings": rows, "applies_to": "next-session",
            "notes": ["Active sessions may keep a pinned backend. Bot user overrides may differ from global defaults.",
                      "No inference or audio-quality test is performed."]}
    if verify:
        data["diagnostics"] = [diagnostics.asr_check(selected, result, name, origin, clean, host)
                               for result, name, origin, host in contexts]
        data["ready"] = all(row["state"] == "ready" for row in data["diagnostics"])
    return data


def token_value(args, selected, new_url, old_url, has_token, interactive):
    variable, filename = getattr(args, "token_env", None), getattr(args, "token_file", None)
    if variable:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", variable) or not selected.env.get(variable):
            raise AsrError("token_source_missing", "The selected token environment variable is missing or invalid.")
        value = selected.env[variable]
    elif filename:
        path = Path(filename).expanduser()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2050):
                raise AsrError("unsafe_token_file", "Token file must be an owner-only regular file (0600), at most 2048 bytes.")
            value = source.read(2051).decode().strip()
    elif getattr(args, "clear_token", False):
        return ""
    elif interactive:
        value = read_input("Endpoint token (hidden; Enter keeps existing token only if endpoint is unchanged): ", hidden=True)
        if not value:
            if has_token and new_url != old_url:
                raise AsrError("token_decision_required", "Endpoint changed. Provide a new token, or explicitly use --clear-token.")
            return None
    else:
        if has_token and new_url != old_url:
            raise AsrError("token_decision_required", "Endpoint changed. Use --token-env, --token-file or --clear-token; stored credentials are not forwarded to another endpoint automatically.")
        return None
    if not value or len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AsrError("invalid_token", "Token must contain 1–2048 printable characters.")
    return value


def choose(prompt, choices):
    print(prompt, file=sys.stderr)
    for index, label in enumerate(choices, 1):
        print(f"  {index}. {label}", file=sys.stderr)
    answer = read_input("Selection (number, or q to cancel): ").strip()
    if answer.lower() in {"q", ""}:
        raise AsrError("cancelled", "Cancelled; no settings were saved.")
    if not answer.isdecimal() or not 1 <= int(answer) <= len(choices):
        raise AsrError("invalid_choice", "Select one of the listed choices.")
    return choices[int(answer) - 1]


def configure(selected, args, approve):
    interactive = (sys.stdin.isatty() and sys.stdout.isatty() and not getattr(args, "json", False)
                   and getattr(args, "format", None) != "json")
    scope = args.scope
    if not scope:
        if not interactive:
            raise AsrError("scope_required", "Configure requires --scope global or --scope account.")
        scope = choose("Which settings should change? Global affects new sessions without account overrides.", ("global", "account"))
    key = account_key(selected) if scope == "account" else ""
    uid = principal(selected, key) if scope == "account" else None
    current = stored(selected, scope, key)
    backend = args.backend
    allowed = GLOBAL if scope == "global" else ACCOUNT
    if not backend:
        if not interactive:
            raise AsrError("backend_required", "Configure requires --backend, or an interactive terminal.")
        if scope == "account":
            choices = [value for value in allowed if value in current.get("available_backends", ["default", "custom"])]
        else:
            choices = ["deployment", "custom"] + [value for value in allowed[2:] if current.get(value + "_url")
                and (value not in {"apple", "nvidia", "viegem"} or current.get(value + "_token"))]
        backend = choose("Select a configured backend. Custom uses an explicit endpoint; no local port is auto-selected.", choices)
    if backend not in allowed:
        raise AsrError("invalid_backend", "Backend is not supported for the selected scope.")
    if scope == "account" and backend not in current.get("available_backends", ["default", "custom"]):
        raise AsrError("backend_unconfigured", "Configure this named backend globally before selecting it for an account.")
    custom_slot = backend in {"custom", "deployment"}
    url_field = "url" if custom_slot else backend + "_url"
    token_field = "token" if custom_slot else backend + "_token"
    patch = {"default_backend": "deployment" if backend == "custom" else backend} if scope == "global" else {"backend": backend}
    if scope == "account" and backend != "custom":
        if args.url or args.token_env or args.token_file or args.clear_token:
            raise AsrError("global_endpoint_owned", "Account named/default selections use global endpoints. Configure endpoint credentials in global scope.")
        old_url, new_url, changed_token = None, None, None
    else:
        old_url = clean_url(current[url_field]) if current.get(url_field) else None
        new_url = clean_url(args.url) if args.url else old_url
        if interactive and not args.backend:
            entered = read_input("Endpoint URL (Enter keeps current, no secret in URL): ").strip()
            if entered:
                new_url = clean_url(entered)
        if not new_url and backend != "deployment":
            raise AsrError("endpoint_required", "Provide --url, or configure the endpoint first.")
        if new_url:
            patch[url_field] = new_url
        supports_token = custom_slot or backend in {"apple", "nvidia", "viegem"}
        if not supports_token and (args.token_env or args.token_file or args.clear_token):
            raise AsrError("unsupported_token_field", "This named backend has no credential slot in the existing API. Use a custom endpoint for token-authenticated services.")
        changed_token = token_value(args, selected, new_url, old_url,
            bool(current.get(token_field)) if scope == "global" else bool(current.get("token_set")),
            interactive and supports_token and not args.yes) if supports_token else None
        if changed_token and not new_url:
            raise AsrError("endpoint_required", "An explicit endpoint is required when setting an endpoint token.")
        if changed_token is not None:
            patch[token_field] = changed_token
    previous_endpoint, next_endpoint = old_url, new_url
    for secret in (changed_token, current.get(token_field) if scope == "global" else None):
        if isinstance(secret, str) and secret:
            previous_endpoint = previous_endpoint.replace(secret, "[REDACTED]") if previous_endpoint else None
            next_endpoint = next_endpoint.replace(secret, "[REDACTED]") if next_endpoint else None
    preview = {"scope": scope, "account_id": uid, "requested_backend": backend,
               "stored_backend": patch.get("default_backend", patch.get("backend")),
               "current_backend": current.get("default_backend" if scope == "global" else "backend") or ("deployment" if scope == "global" else "default"),
               "current_endpoint": previous_endpoint, "endpoint": next_endpoint,
               "credential_change": "keep" if changed_token is None else "clear" if changed_token == "" else "replace",
               "applies_to": "next-session", "dry_run": args.dry_run, "will_write": not args.dry_run,
               "impact": "All new sessions using global defaults; account overrides remain." if scope == "global"
                         else f"New sessions for account {uid}; global defaults remain.",
               "note": "Global custom endpoints use the existing deployment slot; this API does not store a per-endpoint model override."}
    if args.dry_run:
        return {"asr_change": preview}
    approve(preview)
    # shortcut: settings API has no CAS; re-read before partial writes, add server CAS before multi-admin editing.
    if stored(selected, scope, key) != current:
        raise AsrError("settings_changed", "Settings changed while reviewing. No write was made; preview again.")
    path = "/internal/settings/transcription" if scope == "global" else "/user/transcription"
    api(selected, path, headers(selected) if scope == "global" else {"X-API-Key": key}, patch)
    after = stored(selected, scope, key)
    resolved = diagnostics.resolve_asr(selected, key)
    for field, value in patch.items():
        if "token" in field:
            actual = after.get(field, "") if scope == "global" else resolved.get("config", {}).get("token", "")
            if actual != value:
                raise AsrError("write_not_verified", "Credential update was submitted but readback did not match; no automatic rollback was attempted.")
        elif after.get(field) != (value or None):
            raise AsrError("write_not_verified", "Update was submitted but readback did not match; inspect current settings.")
    return {"asr_change": {**preview, "saved": True}, "asr_settings": [summary(resolved, scope)],
            "notes": ["Settings were saved; run tina asr verify to check connectivity. Active sessions were not restarted."]}

"""Read-only health checks. Resolve ASR through Identity; never upload audio or load a model."""
import json
import re
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 262144
BACKENDS = {"deployment", "custom", "apple", "nvidia", "funasr", "sherpa", "viegem"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def endpoint(url, suffix, host=False):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("Unsupported endpoint URL")
    if host and parts.hostname == "host.docker.internal":
        parts = parts._replace(netloc="127.0.0.1" + (":" + str(parts.port) if parts.port else ""))
    path = re.sub(r"/v1/audio/transcriptions/?$", "", parts.path).rstrip("/")
    return urllib.parse.urlunsplit(parts._replace(path=path + suffix))


def request_json(url, headers=None, payload=None, method=None):
    endpoint(url, "")
    request = urllib.request.Request(url, headers=headers or {},
        data=json.dumps(payload).encode() if payload is not None else None, method=method)
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=3) as response:
            body = response.read(LIMIT + 1)
            if len(body) > LIMIT:
                return {"state": "invalid_response", "http_status": response.status}
            data = json.loads(body)
            return {"state": "responding", "http_status": response.status, "body": data}
    except urllib.error.HTTPError as error:
        state = ("access_denied" if error.code in {401, 403} else
                 "unsupported" if error.code == 404 else
                 "redirect_refused" if 300 <= error.code < 400 else "degraded")
        return {"state": state, "http_status": error.code}
    except (ValueError, UnicodeError):
        return {"state": "invalid_response"}
    except (OSError, urllib.error.URLError):
        return {"state": "unreachable"}


# Credentials go through stdin, never Docker argv/logs. The helper only performs one bounded GET.
CONTAINER_PROBE = r'''
import json,sys,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None
try:
 data=json.load(sys.stdin)
 req=urllib.request.Request(data["url"],headers={"Authorization":"Bearer "+data["token"]} if data["token"] else {})
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 with opener.open(req,timeout=3) as response:
  body=response.read(262145)
  result={"state":"responding","http_status":response.status,"body":json.loads(body)} if len(body)<=262144 else {"state":"invalid_response"}
except urllib.error.HTTPError as e:
 result={"state":"access_denied" if e.code in (401,403) else "unsupported" if e.code==404 else "redirect_refused" if 300<=e.code<400 else "degraded","http_status":e.code}
except (ValueError,UnicodeError):result={"state":"invalid_response"}
except Exception:result={"state":"unreachable"}
print(json.dumps(result))
'''


def container_request(selected, url, token):
    try:
        result = subprocess.run([*selected.base, "exec", "-T", "agent-api", "python", "-c", CONTAINER_PROBE],
            env=selected.env, input=json.dumps({"url": url, "token": token}),
            capture_output=True, text=True, timeout=8)
        if result.returncode or len(result.stdout) > LIMIT:
            return {"state": "unreachable"}
        body = json.loads(result.stdout)
        return body if isinstance(body, dict) else {"state": "invalid_response"}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"state": "unreachable"}


def resolve_asr(selected, token=""):
    env = selected.services["admin-api"].get("environment", {})
    secret = env.get("INTERNAL_API_SECRET", "")
    if not secret:
        return {"state": "unconfigured", "detail": "Identity internal credential is missing."}
    result = request_json(selected.endpoint("admin-api", 8001) + "/internal/transcription/resolve",
                          {"X-Internal-Secret": secret}, {"token": token})
    if result["state"] != "responding":
        return result
    data = result.get("body")
    if (not isinstance(data, dict) or data.get("backend") not in BACKENDS
        or any(not isinstance(data.get(key, ""), str) for key in ("url", "token", "model"))):
        return {"state": "invalid_response"}
    if data["backend"] == "deployment" and not data.get("url"):
        fallback = selected.services.get("meeting-api", {}).get("environment", {})
        data = {**data, "url": fallback.get("TRANSCRIPTION_SERVICE_URL", ""),
                "token": fallback.get("TRANSCRIPTION_SERVICE_TOKEN", ""),
                "model": fallback.get("TRANSCRIPTION_MODEL") or "whisper-1"}
    return {"state": "configured" if data.get("url") else "unconfigured", "config": data}


def asr_check(selected, resolved, name, scope, clean, host):
    row = {"name": name, "scope": scope, "required": True}
    if resolved["state"] != "configured":
        return {**row, "state": resolved["state"], "detail": "Could not resolve a configured backend; no fallback was guessed."}
    config = resolved["config"]
    row["backend"] = config["backend"]
    token = config.get("token", "")
    try:
        url = endpoint(config["url"], "/status", host=host)
    except ValueError:
        return {**row, "state": "invalid_response", "detail": "Configured endpoint is not a supported credential-free HTTP(S) URL."}
    result = (request_json(url, {"Authorization": "Bearer " + token} if token else {}) if host
              else container_request(selected, url, token))
    row["state"] = result["state"]
    if "http_status" in result:
        row["http_status"] = result["http_status"]
    body = result.get("body", {})
    model = body.get("model") if isinstance(body, dict) else None
    if result["state"] == "responding":
        if (not isinstance(body, dict) or body.get("version") != "asr-status.v1"
            or not isinstance(model, dict)
            or any(not isinstance(model.get(key), str) or len(model[key]) > 300
                   for key in ("asr_model", "alias", "vad_model", "device", "requested_device"))):
            row.update(state="invalid_response", detail="Endpoint did not return recognized ASR status.")
        else:
            scrub = lambda value: clean("".join(c for c in
                (value.replace(token, "[REDACTED]") if token else value) if c.isprintable()))
            row.update(state="ready", model=scrub(model["asr_model"]),
                       vad=scrub(model["vad_model"]), device=scrub(model["device"]))
    elif result["state"] == "unsupported":
        row["detail"] = "Backend has no supported /status endpoint; inference was not attempted."
    else:
        row["detail"] = "Configured backend did not pass the bounded status probe."
    return row


def full_diagnostics(selected, clean):
    rows = []
    for name, operation in [("compose_engine", selected.preflight), ("compose_binding", selected.guard_existing_config),
                            ("compose_images", selected.check_images), ("compose_services", selected.readiness)]:
        try:
            operation()
            rows.append({"name": name, "state": "ready", "required": True, "scope": "compose"})
        except Exception as error:
            rows.append({"name": name, "state": "error", "required": True, "scope": "compose", "detail": clean(str(error))[:500]})
    desktop = request_json("http://127.0.0.1:8056/health")
    body = desktop.get("body", {})
    recognized = isinstance(body, dict) and isinstance(body.get("ok"), bool) and isinstance(body.get("checks"), dict) and "stt_settings" in body["checks"]
    rows.append({"name": "desktop_host", "scope": "host:8056", "required": True,
                 "state": ("running" if body["ok"] else "degraded") if desktop["state"] == "responding" and recognized
                          else "invalid_response" if desktop["state"] == "responding" else desktop["state"],
                 "detail": "Desktop health is configuration/liveness evidence, not ASR inference evidence."})
    try:
        with socket.create_connection(("127.0.0.1", 9099), timeout=1):
            reachable = True
    except OSError:
        reachable = False
    rows.append({"name": "capture_bridge", "scope": "host:9099", "required": True,
                 "state": "not_verified" if reachable else "unreachable", "listener_reachable": reachable,
                 "detail": "TCP listener only; no capture session or WebSocket handshake was created."})
    global_asr = resolve_asr(selected)
    native_key = selected.env.get("TINA_DESKTOP_API_KEY") or selected.runtime.get("TINA_DESKTOP_API_KEY", "")
    desktop_asr = resolve_asr(selected, native_key) if native_key else global_asr
    rows.append(asr_check(selected, desktop_asr, "asr_desktop", "desktop_account" if native_key else "global_defaults_host", clean, True))
    rows.append(asr_check(selected, global_asr, "asr_bot", "global_defaults_container", clean, False))
    worker_env = {**selected.services.get("meeting-api", {}).get("environment", {}), **selected.env}
    for name, prefix in [("diarization", "DIARIZATION"), ("alignment", "ALIGNMENT")]:
        url = worker_env.get(prefix + "_SERVICE_URL", "")
        row = {"name": name, "scope": "deployment_worker_host", "required": bool(url)}
        if not url:
            row.update(state="unconfigured", detail="No endpoint in the selected deployment; host-only worker env files were not inspected.")
        else:
            try:
                result = request_json(endpoint(url, "/health", host=True))
                body = result.get("body", {})
                row["state"] = ("ready" if isinstance(body, dict) and body.get("status") == "ok" and isinstance(body.get("runtime"), str)
                                else "invalid_response") if result["state"] == "responding" else result["state"]
            except ValueError:
                row["state"] = "invalid_response"
            row["detail"] = "Worker health only; no alignment, diarization or model-loading job was submitted."
        rows.append(row)
    ready = all(row["state"] in {"ready", "running"}
                or row["name"] == "capture_bridge" and row.get("listener_reachable")
                for row in rows if row["required"])
    return {"docker_context": selected.context, "project": selected.project, "ready": ready,
            "complete": all(row["state"] not in {"not_verified", "unsupported"} for row in rows), "diagnostics": rows,
            "audio_ai_acceptance": "not_tested",
            "notes": ["ASR selection applies to new sessions; active sessions may keep a pinned backend.",
                      "Bot user overrides, Capture app permissions, AEC quality and microphone input are not tested.",
                      "Optional unconfigured workers and an unverified TCP listener are not reported as ready."]}

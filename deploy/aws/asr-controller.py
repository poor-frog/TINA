"""Account-scoped control for the ASR workers on the separate Speech EC2 instance."""
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

from asr_control import Controller, ControlError, handler, request_json
from preflight import audio_probe_body

SECRET = os.environ["TINA_INTERNAL_API_SECRET"]
ADMIN_URL = os.environ.get("ADMIN_API_URL", "http://admin-api:8001").rstrip("/")
MODELS = {
    "gipformer": "g-group-ai-lab/gipformer1.5-68M-rnnt",
    "viegem": "5CD-AI/VieGem-ASR",
}


class Identity:
    def __init__(self):
        self.headers = {"X-Internal-Secret": SECRET}

    def read(self, user_id=None):
        return request_json(
            ADMIN_URL + "/internal/transcription/runtime?" + urlencode({"user_id": user_id or ""}),
            self.headers, timeout=5,
        )

    def update(self, user_id, backend, enabled, revision):
        return request_json(
            ADMIN_URL + f"/internal/users/{user_id}/transcription-runtime", self.headers,
            {"backend": backend, "enabled": "true" if enabled else "false", "expected_revision": revision},
            method="PUT", timeout=8,
        )


class RemoteWorkers:
    def configuration(self, backend):
        if backend not in MODELS:
            raise ControlError(422, "Unknown ASR backend")
        settings = request_json(
            ADMIN_URL + "/internal/settings/transcription", {"X-Internal-Secret": SECRET}, timeout=5,
        ).get("value", {})
        url, token = settings.get(backend + "_url"), settings.get(backend + "_token")
        if backend == "gipformer":
            url = url or os.environ.get("TRANSCRIPTION_SERVICE_URL")
            token = token or os.environ.get("TRANSCRIPTION_SERVICE_TOKEN")
        if not url or not token:
            raise ControlError(422, "Configure the ASR worker URL and token in Global defaults")
        return url.rstrip("/"), token

    def status(self, backend):
        try:
            url, _ = self.configuration(backend)
            data = request_json(url + "/status", timeout=4)
            model = data.get("model") or {}
            if model.get("asr_model") != MODELS[backend]:
                raise ControlError(503, "Unexpected worker on the ASR endpoint")
            draining = bool(data.get("draining"))
            return {
                "running": True, "ready": not draining,
                "device": model.get("device", "cpu"), "draining": draining,
            }
        except ControlError:
            return {"running": False, "ready": False, "device": "cpu"}

    def start(self, backend):
        url, token = self.configuration(backend)
        if not self.status(backend)["ready"]:
            raise ControlError(503, "The selected worker on EC2 Speech is not ready")
        content_type, body = audio_probe_body(MODELS[backend])
        request = urllib.request.Request(
            url + "/v1/audio/transcriptions", data=body,
            headers={"Authorization": "Bearer " + token, "Content-Type": content_type}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                reply = json.load(response)
            if not isinstance(reply.get("text"), str):
                raise ControlError(503, "ASR audio probe returned invalid data")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
            raise ControlError(503, "ASR authenticated audio probe failed") from None

    def drain(self, backend, enabled):
        # Speech workers have their own deployment lifecycle.
        return False

    def stop(self, backend):
        return None

    def busy(self):
        return True


def main():
    controller = Controller(
        Identity(), RemoteWorkers(), "/state/state.json", "tina-aws-remote-gipformer",
        grace=10, revision="aws-v2",
    )
    key = hmac.new(SECRET.encode(), b"tina-asr-control:v1", "sha256").hexdigest()
    server = ThreadingHTTPServer(("0.0.0.0", 18007), handler(controller, key))
    server.daemon_threads = True
    print("ASR bridge running on private Compose network only", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

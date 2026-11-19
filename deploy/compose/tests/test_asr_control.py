"""Per-account resource arbitration; no real model, Docker or LaunchAgent is changed."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import importlib.util
import os
import subprocess
import threading
from types import SimpleNamespace
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

BIN = Path(__file__).resolve().parent.parent / "bin"
spec = importlib.util.spec_from_file_location("asr_control", BIN / "asr_control.py")
control = importlib.util.module_from_spec(spec); spec.loader.exec_module(control)


class Identity:
    def __init__(self):
        self.users = {"1": {"backend": "viegem", "enabled": True, "revision": 0},
                      "2": {"backend": "viegem", "enabled": True, "revision": 0}}
    def read(self, user_id=None):
        return {"account": copy.deepcopy(self.users.get(user_id)),
                "counts": {name: sum(u["enabled"] and u["backend"] == name for u in self.users.values()) for name in control.BACKENDS}}
    def update(self, uid, backend, enabled, revision):
        if self.users[uid]["revision"] != revision: raise control.ControlError(409, "Stale")
        self.users[uid] = {"backend": backend, "enabled": enabled, "revision": revision + 1}


class Workers:
    def __init__(self): self.running = {name: True for name in control.BACKENDS}; self.calls = []; self.busy_now = False; self.fail_start = False; self.can_drain = True
    def status(self, name): return {"running": self.running[name], "ready": self.running[name]}
    def start(self, name):
        if self.fail_start: raise control.ControlError(503, "Startup failed")
        self.calls.append(("start", name)); self.running[name] = True
    def stop(self, name): self.calls.append(("stop", name)); self.running[name] = False
    def busy(self): return self.busy_now
    def drain(self, name, enabled): self.calls.append(("drain", name, enabled)); return self.can_drain


class ControlTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.identity, self.workers = Identity(), Workers()
        self.controller = control.Controller(self.identity, self.workers, Path(directory.name) / "state.json", "fixture", grace=0)

    def test_launchagent_bootstrap_retries_transient_unloading_status(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 5 if len(calls) == 1 else 0)
        with patch.dict("sys.modules", {"stack": SimpleNamespace(run=run)}), \
             patch.object(control.time, "sleep") as sleep:
            control.bootstrap_launchagent(Path("/fixture/asr-control.plist"))
        self.assertEqual(len(calls), 2)
        sleep.assert_called_once_with(1)

    def test_install_persists_enabled_profiles_without_persisting_tts_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = SimpleNamespace(env={'COMPOSE_PROFILES': 'asr,speech', 'TTS_API_TOKEN': 'must-not-persist'},
                env_file=root / 'main.env', project='fixture', files=[str(root / 'compose.yml')], control_port=18987,
                services={'admin-api': {'environment': {'INTERNAL_API_SECRET': 'fixture-control-secret'}}})
            identity = control.instance_of(selected)
            fake_stack = SimpleNamespace(ROOT=root, HERE=BIN.parent, CUDA_OVERLAY='unused-overlay')
            responses = [control.ControlError(503, 'not running'), {'instance': identity}]
            with patch.dict('sys.modules', {'stack': fake_stack}), patch.object(control.Path, 'home', return_value=root), \
                 patch.object(control.platform, 'system', return_value='Linux'), \
                 patch.object(control, 'request_json', side_effect=responses), \
                 patch.object(control.socket, 'socket') as sock, patch.object(control.subprocess, 'Popen'):
                sock.return_value.__enter__.return_value.connect_ex.return_value = 1
                control.install(selected)
            saved = json.loads((root / '.config/tina/asr-control' / identity / 'config.json').read_text())
            self.assertEqual(saved['env']['COMPOSE_PROFILES'], 'asr,speech')
            self.assertNotIn('TTS_API_TOKEN', saved['env'])

    def test_missing_optional_viegem_profile_keeps_runtime_status_available(self):
        selected = SimpleNamespace(services={"admin-api": {"environment": {}}, "gipformer": {}},
            viegem_device="disabled", endpoint=lambda service, _: {"gipformer": "http://gipformer"}[service])
        workers = control.Workers(selected)
        self.controller.workers = workers
        with patch.object(control, "request_json", return_value={
                "model": {"asr_model": "g-group-ai-lab/gipformer1.5-68M-rnnt", "device": "cpu"}}) as probe:
            result = self.controller.status("1")
        self.assertTrue(result["workers"]["gipformer"]["ready"])
        self.assertFalse(result["workers"]["viegem"]["running"])
        self.assertFalse(result["workers"]["viegem"]["ready"])
        probe.assert_called_once_with("http://gipformer/status", timeout=1)

    def test_native_mps_status_does_not_require_a_compose_viegem_service(self):
        selected = SimpleNamespace(services={"admin-api": {"environment": {}}}, context="orbstack", viegem_device="mps",
                                   native_viegem_access=lambda: ("192.168.139.3", "http://192.168.139.3:18005"))
        with patch.object(control, "request_json", return_value={
                "model": {"asr_model": "5CD-AI/VieGem-ASR", "device": "mps"}}) as probe:
            result = control.Workers(selected).status("viegem")
        self.assertTrue(result["ready"])
        probe.assert_called_once_with("http://192.168.139.3:18005/status", timeout=1)

    def test_kiri_native_mps_controller_probes_loopback(self):
        selected = SimpleNamespace(services={"admin-api": {"environment": {}}},
            context="kiri", viegem_device="mps",
            native_viegem_access=lambda: ("127.0.0.1", "http://host.docker.internal:18005"))
        with patch.object(control, "request_json", return_value={
                "model": {"asr_model": "5CD-AI/VieGem-ASR", "device": "mps"}}) as probe:
            result = control.Workers(selected).status("viegem")
        self.assertTrue(result["ready"])
        probe.assert_called_once_with("http://127.0.0.1:18005/status", timeout=1)

    def test_switch_keeps_worker_required_by_another_account(self):
        self.controller.select("1", "gipformer", True, 0)
        self.assertTrue(self.workers.running["viegem"])
        self.assertEqual(self.identity.users["2"]["backend"], "viegem")
        self.controller.select("2", "gipformer", True, 0)
        self.assertFalse(self.workers.running["viegem"])
    def test_busy_sessions_and_inflight_audio_prevent_stop(self):
        self.workers.busy_now = True
        self.controller.select("1", "gipformer", True, 0); self.controller.select("2", "gipformer", True, 0)
        self.assertTrue(self.workers.running["viegem"])
        self.workers.busy_now = False; self.workers.can_drain = False; self.controller.reconcile()
        self.assertTrue(self.workers.running["viegem"])
        self.workers.can_drain = True; self.controller.reconcile(); self.assertFalse(self.workers.running["viegem"])
    def test_failed_identity_recheck_reopens_drained_worker(self):
        original = self.identity.read
        def fail(_=None): raise control.ControlError(503, "Identity unavailable")
        self.identity.read = fail
        with self.assertRaises(control.ControlError): self.controller._retire({"gipformer": 1, "viegem": 0})
        self.assertIn(("drain", "viegem", False), self.workers.calls)
        self.assertTrue(self.workers.running["viegem"])
        self.identity.read = original
    def test_recent_completed_audio_defers_retirement(self):
        self.controller.grace = 10
        self.controller.unneeded_since["viegem"] = -1000
        original = self.workers.status
        self.workers.status = lambda name: {**original(name), "idle_seconds": 2}
        self.controller._retire({"gipformer": 1, "viegem": 0})
        self.assertTrue(self.workers.running["viegem"])
        self.assertFalse(any(call[0] == "drain" for call in self.workers.calls))
    def test_failed_start_and_stale_selection_never_overwrite_preferences(self):
        before = copy.deepcopy(self.identity.users); self.workers.fail_start = True
        with self.assertRaises(control.ControlError): self.controller.select("1", "gipformer", True, 0)
        self.assertEqual(self.identity.users, before)
        self.workers.fail_start = False
        with self.assertRaises(control.ControlError): self.controller.select("1", "gipformer", True, 99)
        self.assertEqual(self.identity.users, before)

    def test_http_requires_derived_key_and_rejects_extra_fields(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), control.handler(self.controller, "control-private"))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/runtime"
        def call(payload, key):
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"X-ASR-Control-Key": key})
            try:
                with urllib.request.urlopen(req) as response: return response.status, json.load(response)
            except urllib.error.HTTPError as error: return error.code, json.load(error)
        payload = {"user_id": "1", "backend": "gipformer", "enabled": True, "revision": 0}
        self.assertEqual(call(payload, "wrong")[0], 401)
        self.assertEqual(call({**payload, "command": "stop everything"}, "control-private")[0], 422)
        code, body = call(payload, "control-private")
        self.assertEqual(code, 200)
        self.assertEqual(body["account"]["backend"], "gipformer")
        self.assertNotIn("control-private", str(body))

    def test_discord_sessions_hold_workers_and_unavailable_connector_fails_safe(self):
        root = Path(__file__).resolve().parents[3]
        spec = importlib.util.spec_from_file_location("deployment_stack", root / "deploy/compose/bin/stack.py")
        stack = importlib.util.module_from_spec(spec); spec.loader.exec_module(stack)
        selected = SimpleNamespace(config={"networks": {"tina": {"name": "test-net"}}}, env={},
            services={"discord-connector": {}, "admin-api": {"environment": {}}}, endpoint=lambda *_: "http://127.0.0.1:18101")
        workers = control.Workers(selected)
        with patch.dict("sys.modules", {"stack": stack}), patch.object(stack, "run", return_value=SimpleNamespace(returncode=0, stdout="")), \
             patch.object(control, "request_json", return_value={"sessions": 1}):
            self.assertTrue(workers.busy())
        with patch.dict("sys.modules", {"stack": stack}), patch.object(stack, "run", return_value=SimpleNamespace(returncode=0, stdout="")), \
             patch.object(control, "request_json", side_effect=control.ControlError(503, "unavailable")):
            self.assertTrue(workers.busy())

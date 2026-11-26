"""Host installation and credential boundaries without changing any real LaunchAgent."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import plistlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("native_viegem", ROOT / "deploy/compose/bin/native_viegem.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeViegemTests(unittest.TestCase):
    def test_probe_uses_the_configured_bind_address(self):
        requests = []
        def urlopen(request, **kwargs):
            requests.append(request)
            response = io.BytesIO(b'{"text":"ok"}')
            response.status = 200
            return response
        with patch.object(native.urllib.request, "urlopen", urlopen):
            self.assertTrue(native.probe("fixture-token", "192.168.139.3"))
        self.assertEqual(requests[0].full_url, "http://192.168.139.3:18005/v1/audio/transcriptions")

    def test_build_tools_do_not_receive_runtime_secrets(self):
        with patch.dict(os.environ, {"TINA_VIEGEM_TOKEN": "secret", "TINA_VIEGEM_INTERNAL_SECRET": "internal",
                                     "DOTENV_PRIVATE_KEY": "key"}), patch.object(native.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0)
            native.command(["uv", "--version"])
            env = run.call_args.kwargs["env"]
            self.assertNotIn("TINA_VIEGEM_TOKEN", env)
            self.assertNotIn("TINA_VIEGEM_INTERNAL_SECRET", env)
            self.assertNotIn("DOTENV_PRIVATE_KEY", env)

    def test_mismatched_token_prevents_startup(self):
        with tempfile.TemporaryDirectory() as d:
            env_file, keys = Path(d) / ".env", Path(d) / ".env.keys"
            env_file.write_text("TINA_VIEGEM_TOKEN=encrypted:fixture\n")
            keys.write_text("private-fixture")
            with patch.dict(os.environ, {"TINA_VIEGEM_ENV_FILE": str(env_file), "TINA_VIEGEM_KEYS_FILE": str(keys),
                                         "TINA_VIEGEM_TOKEN": "a" * 32}), patch.object(native, "command") as command:
                command.return_value = subprocess.CompletedProcess([], 0, "b" * 32)
                with self.assertRaisesRegex(RuntimeError, "differ"):
                    native.token()

    def test_prepare_creates_python_and_verifies_native_model(self):
        calls = []
        def command(args, **kwargs):
            calls.append([str(a) for a in args])
            return subprocess.CompletedProcess(args, 0, "3.11\n")
        with tempfile.TemporaryDirectory() as d, patch.object(native, "ROOT", Path(d)), \
             patch.object(native, "token", return_value="fixture"), patch.object(native, "command", command), \
             patch.object(native.shutil, "which", return_value="/installed"):
            native.prepare()
            self.assertTrue(any(c[:4] == ["uv", "venv", "--python", "3.11"] for c in calls))
            self.assertEqual(sum(c[-1].endswith("install-models.py") for c in calls), 1)

    def test_mps_compute_failure_prevents_model_download(self):
        calls = []
        def command(args, **kwargs):
            calls.append([str(a) for a in args])
            return subprocess.CompletedProcess(args, 1 if "torch.backends.mps" in str(args) else 0, "3.11\n")
        with tempfile.TemporaryDirectory() as d, patch.object(native, "ROOT", Path(d)), \
             patch.object(native, "token"), patch.object(native, "command", command), \
             patch.object(native.shutil, "which", return_value="/installed"):
            with self.assertRaisesRegex(RuntimeError, "MPS"):
                native.prepare()
            self.assertFalse(any(c[-1].endswith("install-models.py") for c in calls))

    def test_registration_preserves_defaults_and_never_copies_resolved_token(self):
        for current in ({}, {"default_backend": "sherpa", "token": "existing-secret"}):
            calls = []
            def urlopen(request, **kwargs):
                calls.append(request)
                value = {**current, "viegem_token": "runtime-only-secret"}
                if request.data:
                    value.update(json.loads(request.data))
                return io.BytesIO(json.dumps({"value": value}).encode())
            with self.subTest(current=current), patch.dict(os.environ, {"TINA_VIEGEM_ADMIN_URL": "http://identity",
                    "TINA_VIEGEM_INTERNAL_SECRET": "fixture-secret"}), patch.object(native, "token"), \
                    patch.object(native.urllib.request, "urlopen", urlopen):
                native.register()
                patch_body = json.loads(calls[-1].data)
                self.assertNotIn("viegem_token", patch_body)
                if current:
                    self.assertNotIn("default_backend", patch_body)
                else:
                    self.assertEqual(patch_body["default_backend"], "viegem")

    def test_foreign_launchagent_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            agent = home / "Library/LaunchAgents/local.tina.viegem.plist"
            agent.parent.mkdir(parents=True)
            original = plistlib.dumps({"WorkingDirectory": "/another/checkout"})
            agent.write_bytes(original)
            with patch.object(native.Path, "home", return_value=home), patch.object(native, "token"), \
                 patch.object(native, "command") as command, self.assertRaisesRegex(RuntimeError, "another checkout"):
                native.start()
            command.assert_not_called()
            self.assertEqual(agent.read_bytes(), original)

    def test_missing_plist_never_claims_a_loaded_worker_was_stopped(self):
        with tempfile.TemporaryDirectory() as d, patch.object(native.Path, "home", return_value=Path(d)), \
             patch.object(native, "command") as command:
            command.return_value = subprocess.CompletedProcess([], 0)
            with self.assertRaisesRegex(RuntimeError, "no matching managed plist"):
                native.stop()
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[0][1], "print")

    def test_fresh_registry_with_injected_credentials_receives_viegem_default(self):
        calls = []
        def urlopen(request, **kwargs):
            calls.append(request)
            value = {"viegem_token": "injected-vie-secret"}
            if request.data:
                value.update(json.loads(request.data))
            return io.BytesIO(json.dumps({"value": value, "configured": False}).encode())
        with patch.dict(os.environ, {"TINA_VIEGEM_ADMIN_URL": "http://identity", "TINA_VIEGEM_INTERNAL_SECRET": "fixture-secret"}), \
             patch.object(native, "token"), patch.object(native.urllib.request, "urlopen", urlopen):
            native.register()
        payload = json.loads(calls[-1].data)
        self.assertEqual(payload, {"viegem_url": "http://host.docker.internal:18005", "default_backend": "viegem"})

    def test_registration_migrates_only_the_known_legacy_host_endpoint(self):
        calls = []
        current = {"viegem_url": native.LEGACY_HOST_ENDPOINT, "default_backend": "viegem"}
        def urlopen(request, **kwargs):
            calls.append(request)
            value = {**current, "viegem_token": "runtime-only-secret"}
            if request.data:
                value.update(json.loads(request.data))
            return io.BytesIO(json.dumps({"value": value, "configured": True}).encode())
        with patch.dict(os.environ, {"TINA_VIEGEM_ADMIN_URL": "http://identity",
                                    "TINA_VIEGEM_INTERNAL_SECRET": "fixture-secret",
                                    "TINA_VIEGEM_URL": "http://192.168.139.3:18005"}), \
             patch.object(native, "token"), patch.object(native.urllib.request, "urlopen", urlopen):
            native.register()
        self.assertEqual(json.loads(calls[-1].data), {"viegem_url": "http://192.168.139.3:18005"})

    def test_container_migration_only_removes_owned_native_job(self):
        with tempfile.TemporaryDirectory() as d, patch.object(native.Path, "home", return_value=Path(d)), \
             patch.dict(os.environ, {"TINA_VIEGEM_ENV_FILE": "/fixture/.env"}), patch.object(native, "command") as command:
            agent = Path(d) / "Library/LaunchAgents/local.tina.viegem.plist"
            agent.parent.mkdir(parents=True)
            command.return_value = subprocess.CompletedProcess([], 0)
            agent.write_bytes(plistlib.dumps({"WorkingDirectory": "/foreign"}))
            with self.assertRaisesRegex(RuntimeError, "another checkout"):
                native.stop()
            command.assert_not_called()
            agent.write_bytes(plistlib.dumps({"WorkingDirectory": str(native.ROOT)}))
            native.stop()
            self.assertFalse(agent.exists())
            self.assertTrue(any(c.args[0][1] == "bootout" for c in command.call_args_list))

    def test_busy_unmanaged_port_is_not_stopped(self):
        with tempfile.TemporaryDirectory() as d, patch.object(native.Path, "home", return_value=Path(d)), \
             patch.object(native, "token"), patch.object(native, "command") as command, \
             patch.object(native.socket, "socket") as socket:
            socket.return_value.__enter__.return_value.connect_ex.return_value = 0
            command.return_value = subprocess.CompletedProcess([], 1)
            with self.assertRaisesRegex(RuntimeError, "another process"):
                native.start()
            self.assertEqual(command.call_count, 1)

    def test_launchd_transient_error_retries_and_rerun_preserves_running_worker(self):
        calls, attempts = [], []
        def command(args, **kwargs):
            calls.append(args)
            if args[1] == "print":
                code = 0 if len(attempts) == 2 else 1
            elif args[1] == "bootstrap":
                attempts.append(1)
                code = 5 if len(attempts) == 1 else 0
            else:
                code = 0
            return subprocess.CompletedProcess(args, code)
        with tempfile.TemporaryDirectory() as d, patch.object(native.Path, "home", return_value=Path(d)), \
             patch.object(native, "token", return_value="secret-not-in-plist"), \
             patch.object(native, "probe", return_value=True), patch.object(native, "command", command), \
             patch.object(native.time, "sleep"), patch.object(native.socket, "socket") as socket, \
             patch.dict(os.environ, {"TINA_VIEGEM_ENV_FILE": "/fixture/.env", "TINA_VIEGEM_KEYS_FILE": "/fixture/.env.keys",
                                     "TINA_VIEGEM_HOST": "192.168.139.3"}):
            socket.return_value.__enter__.return_value.connect_ex.return_value = 1
            native.start()
            agent = Path(d) / "Library/LaunchAgents/local.tina.viegem.plist"
            config = plistlib.loads(agent.read_bytes())
            self.assertEqual(config["EnvironmentVariables"]["TINA_VIEGEM_HOST"], "192.168.139.3")
            self.assertNotIn(b"secret-not-in-plist", agent.read_bytes())
            socket.return_value.__enter__.return_value.connect_ex.return_value = 0
            native.start()
            self.assertEqual(len(attempts), 2)
            self.assertFalse(any(c[1] == "bootout" for c in calls))

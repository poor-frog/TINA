"""Deployment regressions; no live stack is started or stopped by this suite."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("compose_entrypoint", ROOT / "deploy/compose/bin/stack.py")
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)


def fixture():
    return {
        "name": "existing",
        "networks": {"tina": {"name": "existing_tina"}},
        "volumes": {"agent-workspaces": {"name": "existing_agent-workspaces"}},
        "services": {
            "runtime": {"build": {}, "environment": {
                "DOCKER_NETWORK": "existing_tina", "AGENT_WORKER_IMAGE": "worker:resolved",
                "BROWSER_IMAGE": "bot:resolved", "RUNTIME_BACKEND": "docker"},
                "volumes": [{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}],
                "healthcheck": {"test": ["CMD", "true"]}},
            "agent-api": {"build": {}, "environment": {
                "TINA_WORKSPACE_MOUNT_SOURCE": "existing_agent-workspaces"},
                "volumes": [{"type": "volume", "source": "agent-workspaces", "target": "/workspaces"}]},
            "agent-worker": {"build": {"context": "."}, "image": "worker:resolved", "profiles": ["build-only"]},
            "admin-api": {"build": {"context": "."}, "environment": {"ADMIN_API_TOKEN": "private-fixture"},
                          "ports": [{"target": 8001, "published": "28057", "host_ip": "127.0.0.1"}]},
            "terminal": {"build": {"context": "."}, "ports": [{"target": 3000, "published": "23000"}]},
            "gateway": {"build": {"context": "."}, "ports": [{"target": 8000, "published": "28056"}]},
            "storage-init": {"entrypoint": ["true"]},
            "meeting-api": {"depends_on": {"storage-init": {"condition": "service_completed_successfully"}}},
            "redis": {"image": "registry.example/valkey:fixture"},
        },
    }


class Docker:
    def __init__(self):
        self.config = fixture()
        self.calls = []
        self.rows = [{"Service": name, "State": "running", "Health": "healthy"}
                     for name in self.config["services"] if name not in {"agent-worker", "storage-init"}]
        self.rows.append({"Service": "storage-init", "State": "exited", "ExitCode": 0})
        self.containers = []
        self.fail_build = self.fail_up = self.fail_access = False
        self.missing = set()
        self.context = "fixture-docker"
        self.gpu_driver_ok = self.gpu_compute_ok = True
        self.fail_bridge_lookup = False

    def __call__(self, args, *, env=None, capture=False, check=True):
        args = list(args)
        if len(args) > 1 and args[0] == "docker" and args[1].startswith("--context="):
            args = [args[0], *args[2:]]
        self.calls.append((args, dict(env or {})))
        code, out = 0, ""
        if args[:2] == ["docker", "compose"]:
            if "config" in args:
                if "--environment" in args:
                    values = {k: v for k, v in self.config["services"]["admin-api"]["environment"].items()
                              if k == "TINA_VIEGEM_TOKEN"}
                    keys = ("TINA_VIEGEM_DEVICE", "COMPOSE_PROFILES", "TINA_MEETING_VOICE", "TTS_API_TOKEN",
                            "LIVEKIT_AGENT_URL", "TRANSCRIPTION_SERVICE_URL", "TRANSCRIPTION_SERVICE_TOKEN",
                            "TRANSCRIPTION_MODEL")
                    values.update({k: (env or {})[k] for k in keys if k in (env or {})})
                    out = "\n".join(f"{k}={v}" for k, v in values.items())
                else:
                    config = copy.deepcopy(self.config)
                    runtime = config["services"].get("runtime", {})
                    for mount in runtime.get("volumes", []):
                        if mount.get("target") == "/var/run/docker.sock":
                            mount["source"] = (env or {}).get("TINA_DOCKER_SOCKET_PATH", mount["source"])
                    out = json.dumps(config)
            elif "build" in args:
                code = int(self.fail_build)
            elif "up" in args:
                code = int(self.fail_up)
            elif "ps" in args:
                out = json.dumps(self.rows)
        elif args[:2] == ["docker", "version"]:
            out = "27.0.0"
        elif args[:2] == ["docker", "run"] and "nvidia-smi" in args:
            code, out = int(not self.gpu_driver_ok), "GPU 0: fixture"
        elif args[:2] == ["docker", "run"] and "--gpus" in args:
            code = int(not self.gpu_compute_ok)
        elif args[:3] == ["docker", "context", "show"]:
            out = self.context
        elif args[:2] == ["ifconfig", "bridge100"]:
            code = int(self.fail_bridge_lookup)
            out = "" if code else "bridge100: flags=...\n\tinet 192.168.139.3 netmask 0xfffffe00 broadcast 192.168.139.255\n"
        elif args[:2] == ["docker", "ps"]:
            out = "existing-container" if self.containers else ""
        elif args[:2] == ["docker", "inspect"]:
            out = json.dumps(self.containers)
        elif args[:3] == ["docker", "image", "inspect"]:
            code = int(args[-1] in self.missing)
        elif args[0] == "git":
            out = "testsha"
        elif args[0].endswith("/provision-token"):
            code, out = (9, "") if self.fail_access else (0, "fixture-user-key")
        if check and code:
            raise stack.StackError("injected command failure")
        return subprocess.CompletedProcess(args, code, out, "")


class EntryPointTest(unittest.TestCase):
    def setUp(self):
        self.docker = Docker()
        for item in [patch.object(stack, "run", self.docker),
                     patch.dict(os.environ, {"ENV_FILE": str(ROOT / "deploy/compose/.env.example")}, clear=True),
                     patch.object(stack, 'tts_environment', side_effect=stack.StackError('TTS_API_TOKEN fixture is missing')),
                     patch.object(stack.time, "sleep")]:
            item.start()
            self.addCleanup(item.stop)

    def invoke(self, action):
        with patch.object(stack.sys, "argv", ["stack.py", action]), contextlib.redirect_stdout(io.StringIO()):
            stack.main()

    def test_build_failure_prevents_activation_and_provisioning(self):
        self.docker.fail_build = True
        with self.assertRaises(stack.StackError):
            self.invoke("all")
        self.assertFalse(any("up" in args or args[0].endswith("/provision-token")
                             for args, _ in self.docker.calls))

    def test_images_built_and_checked_before_waiting_for_activation(self):
        self.invoke("all")
        calls = [args for args, _ in self.docker.calls]
        build = next(i for i, args in enumerate(calls) if "build" in args and "agent-worker" in args)
        checks = [i for i, args in enumerate(calls) if args[:3] == ["docker", "image", "inspect"]]
        up = next(i for i, args in enumerate(calls) if "up" in args)
        access = next(i for i, args in enumerate(calls) if args[0].endswith("/provision-token"))
        self.assertLess(build, min(checks))
        self.assertLess(max(checks), up)
        self.assertLess(up, access)
        self.assertTrue({"--wait", "--wait-timeout", "--no-build", "--pull", "never"} <= set(calls[up]))

    def test_normal_deployment_never_prints_the_provisioned_api_key(self):
        output = io.StringIO()
        selected = stack.Stack('all')
        with contextlib.redirect_stdout(output): selected.access()
        self.assertNotIn('fixture-user-key', output.getvalue())
        self.assertIn('API access provisioned', output.getvalue())

    def test_kiri_docker_runtime_refuses_unsafe_named_workspace_volume_subpath(self):
        self.docker.context = "kiri"
        selected = stack.Stack("plan")
        runtime_socket = next(m for m in selected.services["runtime"]["volumes"]
                              if m.get("target") == "/var/run/docker.sock")
        self.assertEqual(runtime_socket["source"], str(Path.home() / ".kiri/run/docker.sock"))
        selected.runtime["TINA_WORKSPACE_MOUNT_SOURCE"] = "existing_agent-workspaces"
        with self.assertRaisesRegex(stack.StackError, "does not enforce the workspace VolumeOptions.Subpath"):
            selected.validate_bindings()

    def test_legacy_asr_profile_does_not_restore_the_retired_worker(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token"
        env = {**os.environ, "TINA_VIEGEM_DEVICE": "cpu", "COMPOSE_PROFILES": "asr,dashboard",
               "TRANSCRIPTION_SERVICE_URL": "http://gipformer:8000",
               "TRANSCRIPTION_SERVICE_TOKEN": "retired-token", "TRANSCRIPTION_MODEL": "retired-model"}
        selected = stack.Stack("plan", env=env)
        self.assertEqual(selected.env["COMPOSE_PROFILES"], "dashboard,viegem")
        self.assertEqual(selected.env["TINA_USE_VIEGEM_DEFAULT"], "1")
        for key in ("TRANSCRIPTION_SERVICE_URL", "TRANSCRIPTION_SERVICE_TOKEN", "TRANSCRIPTION_MODEL"):
            self.assertEqual(selected.env[key], "")
        external = stack.Stack("plan", env={**env, "TRANSCRIPTION_SERVICE_URL": "https://external.example"})
        self.assertEqual(external.env["TRANSCRIPTION_SERVICE_URL"], "https://external.example")
        self.assertNotIn("TINA_USE_VIEGEM_DEFAULT", external.env)

    def test_doctor_accepts_a_paused_unused_asr_worker_but_rejects_a_required_failed_one(self):
        from types import SimpleNamespace
        self.docker.config['services']['admin-api']['environment']['INTERNAL_API_SECRET'] = 'fixture-internal'
        self.docker.config['services']['viegem'] = {'image':'asr:fixture'}
        self.docker.rows.append({'Service':'viegem','State':'exited','ExitCode':143})
        selected = stack.Stack('doctor')
        selected.viegem_device = 'cpu'
        counts = {'viegem':0}
        class ControlError(Exception): pass
        module = SimpleNamespace(Identity=lambda _:SimpleNamespace(read=lambda:{'counts':counts}),
            Workers=lambda _:SimpleNamespace(status=lambda _: {'ready':False}),ControlError=ControlError)
        with patch.dict(sys.modules, {'asr_control':module}):
            self.assertEqual(selected.doctor_readiness(), {'viegem'})
            counts['viegem'] = 1
            with self.assertRaisesRegex(stack.StackError, 'not ready: viegem'):
                selected.doctor_readiness()
            counts['viegem'] = False
            with self.assertRaisesRegex(stack.StackError, 'Invalid managed ASR demand'):
                selected.doctor_readiness()

    def test_voice_profile_prepares_models_before_activation(self):
        services = self.docker.config['services']
        services['redis']['image'] = 'registry.example/valkey:fixture'
        services.update({'meeting-voice-models': {'image': 'bot:resolved'},
                         'tts-models': {'image': 'tts:fixture'},
                         'tts': {'image': 'tts:fixture', 'build': {'context': '.'}, 'depends_on': {
                             'meeting-voice-models': {'condition': 'service_completed_successfully'},
                             'tts-models': {'condition': 'service_completed_successfully'}}}})
        self.docker.rows.extend([{'Service': name, 'State': 'exited', 'ExitCode': 0}
                                 for name in ('meeting-voice-models', 'tts-models')])
        self.docker.rows.append({'Service': 'tts', 'State': 'running', 'Health': 'healthy'})
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'TTS_API_TOKEN': 'test-only-' + 'x' * 40}):
            self.invoke('all')
        calls = [args for args, _ in self.docker.calls]
        self.assertFalse(any('pull' in args and any(name in args for name in ('meeting-voice-models', 'tts-models')) for args in calls))
        up = next(i for i, args in enumerate(calls) if 'up' in args)
        for name in ('meeting-voice-models', 'tts-models'):
            prepared = next(i for i, args in enumerate(calls) if 'run' in args and name in args)
            self.assertLess(prepared, up)
        self.assertTrue(any('--profile' in args and 'speech' in args for args in calls))
        self.assertTrue(any('pull' in args and args[-1] == 'redis' for args in calls))

    def test_asr_controller_can_preserve_voice_profile_without_receiving_tts_credentials(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'COMPOSE_PROFILES': 'asr,speech'}):
            selected = stack.Stack('runtime-control')
        self.assertIn('speech', selected.env['COMPOSE_PROFILES'].split(','))
        self.assertNotIn('TTS_API_TOKEN', selected.env)

    def test_voice_profile_refuses_missing_tts_token_before_build(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1'}):
            with self.assertRaisesRegex(stack.StackError, 'TTS_API_TOKEN'):
                stack.Stack('all')
        self.assertFalse(any('build' in args for args, _ in self.docker.calls))

    def test_voice_loads_dedicated_tts_env_without_wrapper_and_does_not_forward_keys(self):
        token = 'test-only-' + 'x' * 40
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1'}), patch.object(
            stack, 'tts_environment', return_value={'TTS_API_TOKEN': token, 'TTS_SERVICE_URL': 'http://tts:8000'}) as load:
            selected = stack.Stack('all')
        self.assertTrue(selected.voice_credentials_ready)
        self.assertEqual(selected.env['TTS_API_TOKEN'], token)
        self.assertIn('speech', selected.env['COMPOSE_PROFILES'].split(','))
        self.assertEqual(load.call_count, 1)
        self.assertFalse(any(key.startswith('DOTENV_PRIVATE_KEY') for key in selected.env))

    def test_plan_can_report_missing_voice_credentials_without_bootstrapping(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1'}):
            selected = stack.Stack('plan')
        self.assertFalse(selected.plan_data()['tts_credentials_ready'])
        self.assertTrue(selected.plan_data()['meeting_voice'])
        self.assertFalse(any('build' in args or 'up' in args for args, _ in self.docker.calls))

    def test_default_livekit_plan_allows_missing_secret_but_start_requires_it(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'LIVEKIT_AGENT_URL': 'http://livekit-agent:8080'}), patch.object(
            stack, 'livekit_credentials', side_effect=stack.StackError('INTERNAL_API_SECRET required')):
            selected = stack.Stack('plan')
            self.assertIn('livekit', selected.env['COMPOSE_PROFILES'].split(','))
            with self.assertRaisesRegex(stack.StackError, 'INTERNAL_API_SECRET'):
                stack.Stack('all')
        self.assertFalse(any('build' in args or 'up' in args for args, _ in self.docker.calls))

    def test_kws_install_reuses_valid_cache_without_operator_source(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'TTS_API_TOKEN': 'test-only-' + 'x' * 40}):
            selected = stack.Stack('build')
        selected.services['meeting-voice-models'] = {'image': 'bot:resolved'}
        selected.prepare_wakeword()
        commands = [args for args, _ in self.docker.calls if 'run' in args]
        self.assertEqual(len(commands), 1)
        self.assertIn('kws_shadow', commands[0][-1])
        self.assertNotIn('--volume', commands[0])

    def test_missing_kws_source_fails_before_application_activation(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'TTS_API_TOKEN': 'test-only-' + 'x' * 40}):
            selected = stack.Stack('build')
        selected.services['meeting-voice-models'] = {'image': 'bot:resolved'}
        selected.kws_models_dir = Path('/missing-synthetic-kws-source')
        selected.compose = lambda *a, **k: subprocess.CompletedProcess([], 1, '', '')
        with self.assertRaisesRegex(stack.StackError, 'TINA_KWS_MODELS_DIR'):
            selected.prepare_wakeword()
        self.assertFalse(any('up' in args for args, _ in self.docker.calls))

    def test_kws_install_uses_readonly_source_and_rechecks_installed_cache(self):
        with patch.dict(os.environ, {'TINA_MEETING_VOICE': '1', 'TTS_API_TOKEN': 'test-only-' + 'x' * 40}):
            selected = stack.Stack('build')
        selected.services['meeting-voice-models'] = {'image': 'bot:resolved'}
        with tempfile.TemporaryDirectory() as directory:
            selected.kws_models_dir = Path(directory)
            for name in ('hey_tina', 'tina_oi'): (Path(directory) / (name + '.onnx')).write_bytes(b'fixture')
            calls = []
            def compose(*args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess([], 1 if len(calls) == 1 else 0, '', '')
            selected.compose = compose
            selected.prepare_wakeword()
        self.assertEqual(len(calls), 3)
        self.assertIn('--volume', calls[1])
        self.assertTrue(any(str(arg).endswith(':/source:ro') for arg in calls[1]))
        self.assertIn('kws_shadow', calls[-1][-1])

    def test_failed_wait_does_not_mint_key(self):
        self.docker.fail_up = True
        with self.assertRaises(stack.StackError):
            self.invoke("all")
        self.assertFalse(any(args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_native_viegem_prepares_before_build_and_registers_before_access(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["admin-api"]["environment"]["INTERNAL_API_SECRET"] = "internal-fixture-secret"
        self.docker.context = "orbstack"
        with patch.object(stack.platform, "system", return_value="Darwin"), \
             patch.object(stack.platform, "machine", return_value="arm64"), \
             patch.object(stack, "_dotenvx_key_file", return_value=Path("/private/fixture.keys")), \
             patch.dict("sys.modules", {"asr_control": type("Control", (), {
                 "shutdown": staticmethod(lambda _selected: self.docker.calls.append((["asr-control", "shutdown"], {}))),
                 "install": staticmethod(lambda _selected: self.docker.calls.append((["asr-control", "install"], {})))
             })()}):
            self.invoke("all")
        calls = [args for args, _ in self.docker.calls]
        native = {args[-1]: i for i, args in enumerate(calls) if any(str(a).endswith("native_viegem.py") for a in args)}
        build = next(i for i, args in enumerate(calls) if "build" in args and "agent-worker" in args)
        controller_stop = next(i for i, args in enumerate(calls) if args[:2] == ["asr-control", "shutdown"])
        up = next(i for i, args in enumerate(calls) if "up" in args)
        controller = next(i for i, args in enumerate(calls) if args[:2] == ["asr-control", "install"])
        access = next(i for i, args in enumerate(calls) if args[0].endswith("/provision-token"))
        self.assertLess(native["prepare"], build)
        self.assertLess(build, controller_stop)
        self.assertLess(controller_stop, up)
        self.assertLess(build, native["start"])
        self.assertLess(up, native["start"])
        self.assertLess(native["start"], native["register"])
        self.assertLess(native["register"], controller)
        self.assertLess(controller, access)
        self.assertFalse(any("fixture-token" in str(args) for args in calls))
        start_env = next(env for args, env in self.docker.calls
                         if any(str(a).endswith("native_viegem.py") for a in args) and args[-1] == "start")
        self.assertEqual(start_env["TINA_VIEGEM_HOST"], "192.168.139.3")
        self.assertEqual(start_env["TINA_VIEGEM_URL"], "http://192.168.139.3:18005")

    def test_orbstack_native_viegem_fails_closed_without_bridge_address(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.context = "orbstack"
        self.docker.fail_bridge_lookup = True
        with patch.object(stack.platform, "system", return_value="Darwin"), \
             patch.object(stack.platform, "machine", return_value="arm64"), \
             patch.dict(os.environ, {"TINA_VIEGEM_DEVICE": "mps"}), \
             patch.object(stack, "_dotenvx_key_file", return_value=Path("/private/fixture.keys")):
            selected = stack.Stack("plan")
            with self.assertRaisesRegex(stack.StackError, "bridge100 address"):
                selected.native_viegem("register")

    def test_container_viegem_skips_native_setup_on_all_hosts(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["viegem"] = {"image": "viegem:fixture"}
        with patch.dict(os.environ, {"TINA_VIEGEM_DEVICE": "cpu"}):
            selected = stack.Stack("all")
        for system in ("Linux", "Darwin"):
            with patch.object(stack.platform, "system", return_value=system), \
                 patch.object(stack.platform, "machine", return_value="arm64"):
                selected.native_viegem("prepare")
                selected.native_viegem("start")
        self.assertFalse(any(any(str(a).endswith("native_viegem.py") for a in args) for args, _ in self.docker.calls))

    def test_container_viegem_requires_token_before_build(self):
        self.docker.config["services"]["viegem"] = {"image": "viegem:fixture"}
        with self.assertRaisesRegex(stack.StackError, "requires TINA_VIEGEM_TOKEN"):
            stack.Stack("all").build()
        self.assertFalse(any("build" in args for args, _ in self.docker.calls))

    def test_container_registration_probes_its_published_port(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["viegem"] = {"image": "viegem:fixture", "ports": [{"target": 8000, "published": "18006"}]}
        with patch.dict(os.environ, {"TINA_VIEGEM_DEVICE": "cpu"}):
            selected = stack.Stack("all")
        with patch.object(stack, "_dotenvx_key_file", return_value=Path("/fixture/.env.keys")):
            selected.native_viegem("register")
        helper = [(args, env) for args, env in self.docker.calls if any(str(a).endswith("native_viegem.py") for a in args)]
        self.assertEqual(helper[-1][1]["TINA_VIEGEM_URL"], "http://host.docker.internal:18006")
        probes = [args for args, _ in self.docker.calls if "exec" in args]
        self.assertIn("http://host.docker.internal:18006", probes[-1][-1])

    def test_container_model_downloads_do_not_depend_on_viegem_native_or_token(self):
        self.docker.config["services"]["viegem-models"] = {"image": "fixture-model-installer"}
        selected = stack.Stack("all")
        selected.build()
        calls = [args for args, _ in self.docker.calls]
        downloads = [args[-1] for args in calls if "run" in args and "--no-deps" in args]
        self.assertEqual(downloads, ["viegem-models"])
        self.assertFalse(any("up" in args for args in calls))

    def test_cuda_driver_and_compute_failures_prevent_activation(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["viegem"] = {"image": "viegem-cuda:fixture"}
        for failure in ("gpu_driver_ok", "gpu_compute_ok"):
            with self.subTest(failure=failure), patch.object(stack.platform, "system", return_value="Linux"):
                self.docker.calls.clear()
                self.docker.gpu_driver_ok = self.docker.gpu_compute_ok = True
                setattr(self.docker, failure, False)
                with self.assertRaisesRegex(stack.StackError, "GPU|CUDA"):
                    self.invoke("all")
                self.assertFalse(any("up" in args or args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_cuda_plan_adds_overlay_but_never_runs_gpu_or_build_jobs(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["viegem"] = {"image": "viegem-cuda:fixture"}
        with patch.object(stack.platform, "system", return_value="Linux"):
            selected = stack.Stack("plan")
        self.assertEqual(selected.viegem_device, "cuda")
        self.assertIn(stack.CUDA_OVERLAY, selected.files)
        self.assertFalse(any(args[:2] == ["docker", "run"] or "build" in args for args, _ in self.docker.calls))

    def test_cuda_checks_precede_activation_and_are_not_repeated_within_deploy(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.config["services"]["viegem"] = {"image": "viegem-cuda:fixture",
            "ports": [{"target": 8000, "published": "18005"}]}
        self.docker.rows.append({"Service": "viegem", "State": "running", "Health": "healthy"})
        with patch.object(stack.platform, "system", return_value="Linux"), \
             patch.object(stack, "_dotenvx_key_file", return_value=Path("/fixture/.env.keys")):
            self.invoke("all")
        calls = [args for args, _ in self.docker.calls]
        probes = [i for i, args in enumerate(calls) if args[:2] == ["docker", "run"] and "--gpus" in args]
        up = next(i for i, args in enumerate(calls) if "up" in args)
        self.assertEqual(len(probes), 2)
        self.assertLess(max(probes), up)

    def test_mps_gpu_switch_can_stop_only_the_old_owned_compose_viegem(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        with patch.object(stack.platform, "system", return_value="Darwin"), patch.object(stack.platform, "machine", return_value="arm64"):
            selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {"com.docker.compose.project.config_files": ",".join(selected.files),
            "com.docker.compose.service": "viegem"}}, "State": {"Running": True}}]
        selected.guard_existing_config()

    def test_mps_down_stops_owned_native_job_after_docker_without_removing_volumes(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        with patch.object(stack.platform, "system", return_value="Darwin"), patch.object(stack.platform, "machine", return_value="arm64"), \
             patch.object(stack, "_dotenvx_key_file", return_value=Path("/fixture/.env.keys")):
            self.invoke("down")
        calls = [args for args, _ in self.docker.calls]
        down = next(i for i, args in enumerate(calls) if "down" in args)
        native_stop = next(i for i, args in enumerate(calls) if any(str(a).endswith("native_viegem.py") for a in args) and args[-1] == "stop")
        self.assertLess(down, native_stop)
        self.assertNotIn("-v", calls[down])

    def test_mps_migration_rejects_foreign_cpu_worker_even_with_config_change_allowed(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        self.docker.containers = [{"Config": {"Labels": {"com.docker.compose.project.config_files": "/foreign/docker-compose.yml",
            "com.docker.compose.service": "viegem"}}, "State": {"Running": True}}]
        with patch.object(stack.platform, "system", return_value="Darwin"), patch.object(stack.platform, "machine", return_value="arm64"), \
             patch.dict(os.environ, {"ALLOW_CONFIG_CHANGE": "1"}), self.assertRaisesRegex(stack.StackError, "another checkout"):
            stack.Stack("all").guard_existing_config()
        self.assertFalse(any("stop" in args for args, _ in self.docker.calls))

    def test_native_viegem_failure_does_not_report_success_or_provision_access(self):
        self.docker.config["services"]["admin-api"]["environment"]["TINA_VIEGEM_TOKEN"] = "fixture-token" * 4
        original = self.docker.__call__
        def fail_registration(args, **kwargs):
            if any(str(a).endswith("native_viegem.py") for a in args) and args[-1] == "register":
                raise stack.StackError("injected native ASR failure")
            return original(args, **kwargs)
        with patch.object(stack.platform, "system", return_value="Darwin"), \
             patch.object(stack.platform, "machine", return_value="arm64"), \
             patch.object(stack, "_dotenvx_key_file", return_value=Path("/private/fixture.keys")), \
             patch.object(stack, "run", fail_registration), self.assertRaisesRegex(stack.StackError, "native ASR"):
            self.invoke("all")
        self.assertFalse(any(args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_final_unhealthy_service_fails_before_access(self):
        self.docker.rows[0]["Health"] = "unhealthy"
        with self.assertRaisesRegex(stack.StackError, "not ready"):
            self.invoke("all")
        self.assertFalse(any(args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_access_failure_propagates_and_uses_resolved_port(self):
        self.docker.fail_access = True
        with self.assertRaisesRegex(stack.StackError, "provisioning failed"):
            self.invoke("all")
        attempts = [env for args, env in self.docker.calls if args[0].endswith("/provision-token")]
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(env["ADMIN_API_URL"] == "http://127.0.0.1:28057" for env in attempts))

    def test_missing_worker_prevents_up(self):
        self.docker.missing.add("worker:resolved")
        with self.assertRaisesRegex(stack.StackError, "agent-worker"):
            self.invoke("all")
        self.assertFalse(any("up" in args for args, _ in self.docker.calls))

    def test_different_override_chain_blocks_mutation(self):
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": "/existing/machine.yml"}}}]
        with self.assertRaisesRegex(stack.StackError, "override"):
            self.invoke("all")
        self.assertFalse(any("build" in args or "up" in args for args, _ in self.docker.calls))

    def test_matching_override_chain_is_allowed(self):
        selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": ",".join(selected.files)}}}]
        selected.guard_existing_config()

    def test_runtime_spawned_worker_does_not_block_matching_compose_deployment(self):
        selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.service": "agent-worker"}}}, {"Config": {"Labels": {
            "com.docker.compose.project.config_files": ",".join(selected.files)}}}]
        selected.guard_existing_config()

    def test_explicit_config_change_is_available(self):
        self.docker.containers = [{"Config": {"Labels": {}}}]
        with patch.dict(os.environ, {"ALLOW_CONFIG_CHANGE": "1"}):
            stack.Stack("all").guard_existing_config()

    def test_profile_cannot_silently_omit_running_dashboard(self):
        selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": ",".join(selected.files),
            "com.docker.compose.service": "dashboard"}}, "State": {"Running": True}}]
        with self.assertRaisesRegex(stack.StackError, "COMPOSE_PROFILES"):
            selected.guard_existing_config()

    def test_starting_healthcheck_is_not_accepted(self):
        self.docker.rows[0]["Health"] = "starting"
        with self.assertRaises(stack.StackError):
            stack.Stack("doctor").readiness()

    def test_oneshot_failure_and_missing_service_are_rejected(self):
        selected = stack.Stack("doctor")
        self.docker.rows[-1]["ExitCode"] = 2
        with self.assertRaisesRegex(stack.StackError, "storage-init"):
            selected.readiness()
        self.docker.rows = [row for row in self.docker.rows if row["Service"] != "terminal"]
        with self.assertRaisesRegex(stack.StackError, "terminal: missing"):
            selected.readiness()

    def test_running_worker_without_healthcheck_is_accepted(self):
        stack.Stack("doctor").readiness()

    def test_network_workspace_and_worker_mismatch_fail_closed(self):
        for field in ("DOCKER_NETWORK", "AGENT_WORKER_IMAGE"):
            with self.subTest(field=field):
                config = copy.deepcopy(self.docker.config)
                self.docker.config["services"]["runtime"]["environment"][field] = "wrong"
                with self.assertRaises(stack.StackError):
                    stack.Stack("plan").validate_bindings()
                self.docker.config = config
        self.docker.config["services"]["agent-api"]["environment"]["TINA_WORKSPACE_MOUNT_SOURCE"] = "wrong"
        with self.assertRaises(stack.StackError):
            stack.Stack("plan").validate_bindings()

    def test_plan_does_not_mutate_or_expose_secrets(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            stack.Stack("plan").plan()
        self.assertNotIn("private-fixture", out.getvalue())
        self.assertFalse(any("up" in args or "build" in args for args, _ in self.docker.calls))

    def test_infrastructure_pull_failure_prevents_activation(self):
        original = self.docker.__call__
        def fail_pull(args, **kwargs):
            if "pull" in args:
                raise stack.StackError("injected infrastructure pull failure")
            return original(args, **kwargs)
        with patch.object(stack, "run", fail_pull), self.assertRaisesRegex(stack.StackError, "infrastructure"):
            self.invoke("all")
        self.assertFalse(any("up" in args for args, _ in self.docker.calls))

    def test_destroy_requires_explicit_opt_in(self):
        with self.assertRaisesRegex(stack.StackError, "DESTROY"):
            self.invoke("destroy")
        self.assertFalse(any("down" in args for args, _ in self.docker.calls))

    def test_down_never_removes_volumes(self):
        self.invoke("down")
        down = next(args for args, _ in self.docker.calls if "down" in args)
        self.assertNotIn("-v", down)

    def test_global_context_switch_does_not_move_builds_or_checks_to_another_daemon(self):
        selected = stack.Stack("all")
        self.assertIn("--context=fixture-docker", selected.base)
        self.docker.context = "another-daemon"
        selected.preflight()
        selected.build()
        for args, env in self.docker.calls:
            if args[:2] == ["docker", "build"] or args[:3] == ["docker", "image", "inspect"]:
                self.assertEqual(env["DOCKER_CONTEXT"], "fixture-docker")
                self.assertNotIn("BUILDX_BUILDER", env)

    def test_remote_builder_override_is_refused_before_build(self):
        with patch.dict(os.environ, {"BUILDX_BUILDER": "another-daemon"}):
            with self.assertRaisesRegex(stack.StackError, "BUILDX_BUILDER"):
                self.invoke("all")
        self.assertFalse(any(args[:2] == ["docker", "build"] for args, _ in self.docker.calls))

    def test_both_services_reject_published_admin_placeholder(self):
        for path, key in [
            ("core/identity/services/admin-api/src/admin_api/config.v1.json", "ADMIN_API_TOKEN"),
            ("core/meetings/services/meeting-api/src/meeting_api/config.v1.json", "ADMIN_TOKEN"),
        ]:
            declaration = json.loads((ROOT / path).read_text())
            entry = next(item for item in declaration["keys"] if item["key"] == key)
            self.assertIn("dev-admin-token", entry["forbidden_values"])
        self.docker.config["services"]["admin-api"]["environment"]["ADMIN_API_TOKEN"] = "dev-admin-token"
        with self.assertRaises(stack.StackError):
            self.invoke("all")


class BootstrapTest(unittest.TestCase):
    def test_release_key_bootstraps_local_speech_only_on_fresh_config(self):
        script = ROOT / "deploy/compose/mint-dev-env.sh"
        with tempfile.TemporaryDirectory() as td:
            new = Path(td) / "fresh.env"
            old = Path(td) / "existing.env"
            subprocess.run(["bash", str(script), str(old)], capture_output=True, check=True)
            old_bytes = old.read_bytes()
            for file in (new, old):
                subprocess.run(["bash", str(script), str(file), "--voice-release"],
                               capture_output=True, check=True)
            values = dict(line.split("=", 1) for line in new.read_text().splitlines()
                          if "=" in line and not line.startswith("#"))
            self.assertEqual(values["TINA_MEETING_VOICE"], "1")
            self.assertIn("asr", values["COMPOSE_PROFILES"].split(","))
            self.assertEqual(values["TRANSCRIPTION_SERVICE_URL"], "http://gipformer:8000")
            self.assertEqual(len(values["TRANSCRIPTION_SERVICE_TOKEN"]), 64)
            self.assertTrue(old.read_bytes() == old_bytes)

    def test_fresh_secrets_are_private_unique_and_idempotent(self):
        script = ROOT / "deploy/compose/mint-dev-env.sh"
        with tempfile.TemporaryDirectory() as td:
            files = [Path(td) / name for name in ("first.env", "second.env")]
            for file in files:
                subprocess.run(["bash", str(script), str(file)], capture_output=True, check=True)
            def admin(file):
                return next(line.split("=", 1)[1] for line in file.read_text().splitlines()
                            if line.startswith("ADMIN_TOKEN="))
            first = files[0].read_bytes()
            self.assertEqual(len(admin(files[0])), 64)
            self.assertNotEqual(admin(files[0]), admin(files[1]))
            self.assertEqual(files[0].stat().st_mode & 0o077, 0)
            subprocess.run(["bash", str(script), str(files[0])], capture_output=True, check=True)
            self.assertEqual(first, files[0].read_bytes())

    def test_existing_placeholder_refused_without_rotating_any_secret(self):
        with tempfile.TemporaryDirectory() as td:
            file = Path(td) / ".env"
            for value in ("dev-admin-token", "'dev-admin-token'", '"dev-admin-token"'):
                original = f"ADMIN_TOKEN={value}\nINTERNAL_API_SECRET=\n"
                file.write_text(original)
                result = subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(file)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(file.read_text(), original)
                self.assertNotIn(value, result.stderr)

    def test_existing_nonempty_credential_is_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            file = Path(td) / ".env"
            # A leading # without preceding whitespace is a dotenv value, not an empty assignment.
            for value in ("private-existing-credential", "#private-existing-credential"):
                file.write_text("ADMIN_TOKEN=" + value + "\n")
                subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(file)],
                               capture_output=True, check=True)
                self.assertTrue(file.read_text().startswith("ADMIN_TOKEN=" + value + "\n"))

    def test_dry_run_never_executes_docker_or_bootstrap(self):
        with tempfile.TemporaryDirectory() as td:
            marker = Path(td) / "called"
            docker = Path(td) / "docker"
            docker.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(marker))}\nexit 97\n")
            docker.chmod(0o755)
            env = dict(os.environ, PATH=td + os.pathsep + os.environ["PATH"])
            for target in ("all", "build", "down", "bot", "doctor"):
                result = subprocess.run(["make", "-n", target], cwd=ROOT, env=env, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(marker.exists(), target)


@unittest.skipUnless(shutil.which("dotenvx"), "Dotenvx CLI required")
class DotenvxEnvTest(unittest.TestCase):
    @staticmethod
    def values(text):
        result = {}
        for line in text.splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                result[key] = value.strip().strip("\"'")
        return result

    def test_encrypted_compose_env_is_materialized_private_without_changing_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source, key_file = root / ".env", root / ".env.keys"
            source.write_text("TEST_VALUE=round-trip\n")
            subprocess.run(["dotenvx", "encrypt", "-f", str(source), "-fk", str(key_file)],
                           capture_output=True, check=True)
            encrypted = source.read_text()

            decrypted, temporary = stack._dotenvx_env_source(
                source, dict(os.environ, DOTENVX_KEY_FILE=str(key_file)))
            try:
                values = {}
                for line in decrypted.read_text().splitlines():
                    if "=" in line and not line.lstrip().startswith("#"):
                        key, value = line.split("=", 1)
                        values[key] = value.strip().strip("\"'")
                self.assertEqual(values["TEST_VALUE"], "round-trip")
                self.assertEqual(decrypted.stat().st_mode & 0o077, 0)
                self.assertEqual(source.read_text(), encrypted)
            finally:
                temporary.cleanup()

    def test_bootstrap_keeps_generated_secrets_encrypted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            env_file, key_file = root / ".env", root / ".env.keys"
            env_file.write_text("ADMIN_TOKEN=\nINTERNAL_API_SECRET=\nTINA_FLOWS_API_KEY=\nTINA_FLOWS_TIMELINE_KEY=\n")
            subprocess.run(["dotenvx", "encrypt", "-f", str(env_file), "-fk", str(key_file)],
                           capture_output=True, check=True)
            subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(env_file)],
                           env=dict(os.environ, DOTENVX_KEY_FILE=str(key_file)),
                           capture_output=True, check=True, text=True)

            encrypted = env_file.read_text()
            self.assertTrue(all(f"{key}=encrypted:" in encrypted for key in (
                "ADMIN_TOKEN", "INTERNAL_API_SECRET", "TINA_FLOWS_API_KEY", "TINA_FLOWS_TIMELINE_KEY")))
            decrypted = subprocess.run(["dotenvx", "decrypt", "--stdout", "-f", str(env_file), "-fk", str(key_file)],
                                       capture_output=True, check=True, text=True).stdout
            values = self.values(decrypted)
            self.assertTrue(all(len(values[key]) == 64 for key in (
                "ADMIN_TOKEN", "INTERNAL_API_SECRET", "TINA_FLOWS_API_KEY", "TINA_FLOWS_TIMELINE_KEY")))

@unittest.skipUnless(shutil.which("docker"), "Compose CLI required; daemon not needed")
class ComposeConfigTest(unittest.TestCase):
    def test_real_compose_resolves_project_profiles_override_and_image_variables(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            overlay = directory / "machine override.yml"
            overlay.write_text("services:\n  terminal:\n    environment:\n      REVIEW_MARKER: present\n")
            env_file = directory / "chosen.env"
            env_file.write_text(
                "COMPOSE_PROJECT_NAME=custom-from-dotenv\nIMAGE_TAG=fixture\nADMIN_TOKEN=private-config-fixture\n"
                "BROWSER_IMAGE=tina/tina-bot:${IMAGE_TAG}\nCOMPOSE_PROFILES=dashboard\n"
                f"COMPOSE_FILE={ROOT / 'deploy/compose/docker-compose.yml'}:{overlay}\n")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("COMPOSE_", "PROJECT", "IMAGE_TAG", "BROWSER_IMAGE", "ENV_FILE"))}
            env["ENV_FILE"] = str(env_file)
            with patch.dict(os.environ, env, clear=True):
                selected = stack.Stack("plan")
                selected.validate_bindings()
                self.assertEqual(selected.project, "custom-from-dotenv")
                self.assertEqual(selected.images()["bot"], "tina/tina-bot:dev")
                self.assertTrue("dashboard" in selected.services, "dotenv dashboard profile was ignored")
                self.assertEqual(selected.files[-1], str(overlay.resolve()))
                self.assertTrue(selected.services["runtime"]["environment"].get("ADMIN_TOKEN") == "private-config-fixture",
                                "runtime read a different dotenv file")
                self.assertEqual(selected.services["terminal"]["environment"]["REVIEW_MARKER"], "present")
                with patch.dict(os.environ, {"PROJECT": "explicit-project", "IMAGE_TAG": "chosen"}):
                    explicit = stack.Stack("plan")
                    explicit.validate_bindings()
                    self.assertEqual(explicit.project, "explicit-project")
                    self.assertEqual(explicit.images()["bot"], "tina/tina-bot:chosen")
            self.assertIn("IMAGE_TAG=fixture", env_file.read_text())


class LiveKitCredentialTests(unittest.TestCase):
    def test_keys_are_separate_deterministic_and_never_plain_control_secret(self):
        secret='private-fixture-control-secret-32-characters'
        result=stack.livekit_credentials({'INTERNAL_API_SECRET':secret})
        self.assertEqual(result,stack.livekit_credentials({'INTERNAL_API_SECRET':secret}))
        self.assertEqual(len(result['LIVEKIT_API_SECRET']),64)
        self.assertNotIn(secret,result['LIVEKIT_KEYS'])
        self.assertNotEqual(result,stack.livekit_credentials({'INTERNAL_API_SECRET':secret+'2'}))
        with self.assertRaises(stack.StackError):stack.livekit_credentials({'INTERNAL_API_SECRET':''})


if __name__ == "__main__":
    unittest.main()

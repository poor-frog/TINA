#!/usr/bin/env python3
"""Source-build entrypoint. Compose owns dotenv/interpolation; never source/eval .env."""
from __future__ import annotations

import hashlib
import json
import hmac
import importlib.util
import ipaddress
import os
import platform
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent.parent
CUDA_OVERLAY = str(HERE / "docker-compose.viegem-cuda.yml")
SOURCE_ACTIONS = {"all", "build", "bot", "plan"}


class StackError(RuntimeError):
    pass


def tts_environment(env):
    """Reuse the dedicated encrypted TTS loader; never guess its key from the main env."""
    spec = importlib.util.spec_from_file_location('tina_tts_env', ROOT / 'deploy/tts/run.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        loaded = module.runtime_env(env)
    except module.EnvError as exc:
        raise StackError(str(exc)) from None
    return {key: loaded[key] for key in ('TTS_API_TOKEN', 'TTS_SERVICE_URL', 'TINA_TTS_MODELS') if key in loaded}


def run(args, *, env=None, capture=False, check=True, input_text=None):
    result = subprocess.run(args, cwd=HERE, env=env, text=True,
                            capture_output=capture, check=False, input=input_text)
    if check and result.returncode:
        # Config/env output may contain credentials; never include it in an exception.
        raise StackError(f"Command failed ({result.returncode}): {shlex.join(args)}")
    return result


def _dotenvx_key_file(path: Path, env: dict[str, str]) -> Path | None:
    explicit = env.get("DOTENVX_KEY_FILE")
    if explicit:
        key_file = Path(explicit).expanduser()
        if not key_file.is_absolute():
            key_file = ROOT / key_file
        if not key_file.is_file():
            raise StackError("DOTENVX_KEY_FILE does not exist; no encrypted env values were read.")
        return key_file
    return next((candidate for candidate in (path.parent / ".env.keys", ROOT / ".env.keys")
                 if candidate.is_file()), None)


def _dotenvx_env_source(path: Path, env: dict[str, str]) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    encrypted = any(
        line.partition("=")[2].strip().strip("\"'").startswith("encrypted:")
        for line in path.read_text().splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    if not encrypted:
        return path, None

    dotenvx = env.get("DOTENVX_BIN") or shutil.which("dotenvx")
    if not dotenvx:
        raise StackError("This env file is Dotenvx-encrypted; install dotenvx and provide its private key.")
    key_file = _dotenvx_key_file(path, env)
    command = [dotenvx, "decrypt", "--stdout", "-f", str(path)]
    if key_file:
        command += ["-fk", str(key_file)]
    try:
        plaintext = run(command, env=env, capture=True).stdout
    except StackError:
        raise StackError("Dotenvx could not decrypt the selected env file; check its matching private key.") from None

    # Compose's service env_file reader cannot decrypt Dotenvx values itself.
    temporary = tempfile.TemporaryDirectory(prefix="tina-dotenvx-")
    decrypted = Path(temporary.name) / path.name
    decrypted.write_text(plaintext, encoding="utf-8")
    decrypted.chmod(0o600)
    return decrypted, temporary


def json_rows(text):
    if not text.strip():
        return []
    if text.lstrip().startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def select_viegem_device(enabled, requested="auto"):
    if not enabled:
        return "disabled"
    requested = requested.strip().lower()
    if requested not in {"auto", "mps", "cuda", "cpu"}:
        raise StackError("TINA_VIEGEM_DEVICE must be auto, mps, cuda, or cpu.")
    system, machine = platform.system(), platform.machine()
    if system == "Windows":
        raise StackError("Run make all inside WSL2 on Windows with NVIDIA GPU support enabled in Docker Desktop.")
    if requested == "auto":
        requested = "mps" if system == "Darwin" else "cuda"
    if requested == "mps" and (system != "Darwin" or machine != "arm64"):
        raise StackError("Automatic MPS requires an Apple Silicon Mac; CPU is available only with explicit TINA_VIEGEM_DEVICE=cpu.")
    if requested == "cuda" and system != "Linux":
        raise StackError("Docker CUDA requires Linux/WSL2 and an accessible NVIDIA GPU.")
    return requested


def livekit_credentials(values):
    """Separate local server keys, derived from the existing encrypted control-plane secret."""
    secret = values.get('INTERNAL_API_SECRET', '')
    if len(secret) < 32 or secret.startswith('encrypted:'):
        raise StackError('LiveKit pilot requires the encrypted INTERNAL_API_SECRET.')
    key = 'tina-local'
    derived = hmac.new(secret.encode(), b'tina-livekit-server:v1', 'sha256').hexdigest()
    return {'LIVEKIT_API_KEY': key, 'LIVEKIT_API_SECRET': derived, 'LIVEKIT_KEYS': f'{key}: {derived}'}


class Stack:
    def __init__(self, action, *, env=None):
        self.env = dict(os.environ if env is None else env)
        if action in SOURCE_ACTIONS:
            self.env.setdefault("IMAGE_TAG", "dev")
        self.env_file = Path(self.env.get("ENV_FILE") or ".env")
        if not self.env_file.is_absolute():
            self.env_file = HERE / self.env_file
        # plan/doctor must not create a file. A fresh-install preview reads the template.
        source = self.env_file if self.env_file.exists() else HERE / ".env.example"
        self._dotenvx_temp = None
        compose_env_file, self._dotenvx_temp = _dotenvx_env_source(source, self.env)
        self.env["TINA_COMPOSE_ENV_FILE"] = str(compose_env_file)
        project = self.env.get("PROJECT") or self.env.get("COMPOSE_PROJECT")
        if project:
            self.env["COMPOSE_PROJECT_NAME"] = project
        base = ["docker", "compose", "--project-directory", str(HERE),
                "--env-file", str(compose_env_file)]
        interpolation = run([*base, "config", "--environment"], env=self.env, capture=True)
        values = dict(line.split("=", 1) for line in interpolation.stdout.splitlines() if "=" in line)
        try:
            self.control_port = int(values.get("TINA_ASR_CONTROL_PORT") or "18007")
        except ValueError:
            raise StackError("TINA_ASR_CONTROL_PORT must be a valid TCP port") from None
        if not 1024 <= self.control_port <= 65535:
            raise StackError("TINA_ASR_CONTROL_PORT must be between 1024 and 65535")
        if values.get("INTERNAL_API_SECRET"):
            self.env['TINA_TTS_PROFILE_KEY']=hmac.new(values['INTERNAL_API_SECRET'].encode(),b'tina-tts-profile:v1','sha256').hexdigest()
            for backend in ("gipformer", "viegem"):
                self.env[f"TINA_{backend.upper()}_DRAIN_KEY"] = hmac.new(
                    values["INTERNAL_API_SECRET"].encode(), f"tina-asr-drain:v1:{backend}".encode(), "sha256").hexdigest()
        self.viegem_device = select_viegem_device(bool(values.get("TINA_VIEGEM_TOKEN")),
                                                  values.get("TINA_VIEGEM_DEVICE") or "auto")
        self.env.setdefault('TINA_VIEGEM_NAME_BIAS', values.get('TINA_VIEGEM_NAME_BIAS') or '0')
        self.env.setdefault('TINA_VIEGEM_CUSTOM_WEIGHT', values.get('TINA_VIEGEM_CUSTOM_WEIGHT') or '1.0')
        self.env.setdefault('TINA_VIEGEM_CUSTOM_WORDS_FILE', values.get('TINA_VIEGEM_CUSTOM_WORDS_FILE') or '')
        self._cuda_verified = False
        profiles = [p.strip() for p in values.get("COMPOSE_PROFILES", "").split(",") if p.strip()]
        if values.get('LIVEKIT_AGENT_URL'):
            try:
                self.env.update(livekit_credentials(values))
            except StackError:
                if action != 'plan': raise
            if 'livekit' not in profiles:
                profiles.append('livekit')
        if self.viegem_device == "mps":
            profiles = [p for p in profiles if p != "viegem"]
        elif self.viegem_device in {"cuda", "cpu"} and "viegem" not in profiles:
            profiles.append("viegem")
        self.voice_enabled = values.get('TINA_MEETING_VOICE', '').lower() in {'1', 'true', 'yes'}
        if (values.get('LIVEKIT_AGENT_URL') and not self.voice_enabled
                and action in ('all', 'build', 'doctor')):
            raise StackError('LIVEKIT_AGENT_URL requires TINA_MEETING_VOICE=1. Unset LIVEKIT_AGENT_URL to disable the Agents runtime.')
        self.kws_models_dir = Path(values.get('TINA_KWS_MODELS_DIR') or self.env.get('TINA_KWS_MODELS_DIR')
                                   or ROOT / 'output/wakeword-training/tina-v1/models').expanduser()
        if not self.kws_models_dir.is_absolute(): self.kws_models_dir = ROOT / self.kws_models_dir
        self.kws_models_dir = self.kws_models_dir.resolve()
        self.voice_credentials_ready = False
        if self.voice_enabled:
            token = values.get('TTS_API_TOKEN', '')
            if not token and action != 'runtime-control':
                try:
                    self.env.update(tts_environment(self.env))
                    values.update({key: self.env[key] for key in ('TTS_API_TOKEN', 'TTS_SERVICE_URL') if key in self.env})
                    token = values.get('TTS_API_TOKEN', '')
                except StackError:
                    if action != 'plan': raise
            self.voice_credentials_ready = (len(token) >= 32 and not token.startswith('encrypted:')
                                            and token.isascii() and all(33 <= ord(c) <= 126 for c in token))
            if action not in ('runtime-control', 'plan') and not self.voice_credentials_ready:
                raise StackError('Meeting voice requires TTS_API_TOKEN; load its encrypted env with deploy/tts/run.py.')
            if not values.get('TTS_SERVICE_URL'):
                self.env['TTS_SERVICE_URL'] = 'http://tts:8000'
            if 'speech' not in profiles:
                profiles.append('speech')
        self.env["COMPOSE_PROFILES"] = ",".join(profiles)
        # Global Docker context may change while a long build runs. Pin it once,
        # including Buildx, so builds, image checks and activation use one daemon.
        if not self.env.get("DOCKER_CONTEXT") and not self.env.get("DOCKER_HOST"):
            self.env["DOCKER_CONTEXT"] = values.get("DOCKER_CONTEXT") or run(
                ["docker", "context", "show"], env=self.env, capture=True).stdout.strip()
        self.context = self.env.get("DOCKER_CONTEXT") or "default"
        if not self.context:
            raise StackError("Cannot resolve Docker context.")
        # Kiri keeps its Engine socket under ~/.kiri; /var/run/docker.sock may still target OrbStack.
        self.env["TINA_DOCKER_SOCKET_PATH"] = (
            str(Path.home() / ".kiri/run/docker.sock") if self.context == "kiri" else "/var/run/docker.sock"
        )
        self._native_viegem_access_cache = None
        self.builder = self.env.pop("BUILDX_BUILDER", None) or self.context
        # Compose's Buildx subprocess also needs the global flag; environment-only
        # context selection can leave Bake on the globally selected daemon.
        if self.env.get("DOCKER_CONTEXT"):
            base = ["docker", "--context=" + self.context, *base[1:]]
        # Explicit --profile replaces COMPOSE_PROFILES in some Compose versions.
        # Carry selected profiles explicitly before adding build-only for config inspection.
        for profile in profiles:
            if profile.strip() and profile.strip() != "build-only":
                base += ["--profile", profile.strip()]
        separator = values.get("COMPOSE_PATH_SEPARATOR") or os.pathsep
        if values.get("COMPOSE_FILE"):
            files = values["COMPOSE_FILE"].split(separator)
        else:
            files = ["docker-compose.yml"]
            if (HERE / "docker-compose.override.yml").exists():
                files.append("docker-compose.override.yml")
        self.files = [str((HERE / file).resolve()) for file in files
                      if str((HERE / file).resolve()) != CUDA_OVERLAY]
        if self.viegem_device == "cuda":
            self.files.append(CUDA_OVERLAY)
        # Pin the selected chain, including its project directory, on every subsequent command.
        self.base = base
        for file in self.files:
            self.base += ["-f", file]
        initial = self.compose("--profile", "build-only", "config", "--format", "json", capture=True)
        self.config = json.loads(initial.stdout)
        self.project = self.config["name"]
        self.env["COMPOSE_PROJECT_NAME"] = self.project
        self.base += ["-p", self.project]
        # Re-resolve after pinning: internal network/workspace names must follow the same project.
        self.config = json.loads(self.compose("--profile", "build-only", "config",
                                             "--format", "json", capture=True).stdout)
        self.services = {name: spec for name, spec in self.config["services"].items()
                         if "build-only" not in spec.get("profiles", [])}
        self.runtime = self.services["runtime"].get("environment", {})

    def compose(self, *args, capture=False, check=True):
        return run([*self.base, *args], env=self.env, capture=capture, check=check)

    def validate_bindings(self):
        expected = self.config["networks"]["tina"]["name"]
        if self.runtime.get("DOCKER_NETWORK") != expected:
            raise StackError("Runtime DOCKER_NETWORK differs from the selected Compose network.")
        if self.runtime.get("RUNTIME_BACKEND", "docker") == "docker":
            socket_mount = next((mount for mount in self.services["runtime"].get("volumes", [])
                                 if mount.get("target") == "/var/run/docker.sock"), None)
            if not socket_mount or socket_mount.get("source") != self.env["TINA_DOCKER_SOCKET_PATH"]:
                raise StackError("Runtime Docker socket mount differs from the selected Docker context.")
            workspace_source = self.runtime.get("TINA_WORKSPACE_MOUNT_SOURCE", "")
            if self.context == "kiri" and workspace_source and not workspace_source.startswith("/"):
                raise StackError(
                    "Kiri Docker does not enforce the workspace VolumeOptions.Subpath mount. "
                    "Runtime is stopped to protect cross-workspace isolation; use a backend that "
                    "enforces subPath (such as Kubernetes) before enabling workload spawns."
                )
        api = self.services["agent-api"]
        for mount in api.get("volumes", []):
            if mount["target"] == "/workspaces" and mount["type"] == "volume":
                expected = self.config["volumes"][mount["source"]]["name"]
                actual = api.get("environment", {}).get("TINA_WORKSPACE_MOUNT_SOURCE")
                if actual != expected:
                    raise StackError("Agent workspace backing differs from the selected Compose volume.")
        worker = self.config["services"]["agent-worker"]["image"]
        if worker != self.runtime.get("AGENT_WORKER_IMAGE"):
            raise StackError("Agent worker build image differs from Runtime AGENT_WORKER_IMAGE.")

    def guard_existing_config(self):
        ids = run(["docker", "ps", "-aq", "--filter",
                   f"label=com.docker.compose.project={self.project}"],
                  env=self.env, capture=True).stdout.split()
        if not ids:
            return
        containers = json.loads(run(["docker", "inspect", *ids], env=self.env, capture=True).stdout)
        # Runtime workers share the project label but are not created by Compose.
        containers = [item for item in containers if not (
            item["Config"]["Labels"].get("com.docker.compose.service") == "agent-worker"
            and not item["Config"]["Labels"].get("com.docker.compose.project.config_files"))]
        if not containers:
            return
        if self.viegem_device == "mps":
            for item in containers:
                labels = item["Config"]["Labels"]
                if item.get("State", {}).get("Running") and labels.get("com.docker.compose.service") == "viegem":
                    owner = labels.get("com.docker.compose.project.config_files", "").split(",")[0]
                    if not owner or str(Path(owner).resolve()) != self.files[0]:
                        raise StackError("The running VieGem container belongs to another checkout; automatic MPS migration did not stop it.")
        chains = {tuple(str(Path(file).resolve()) for file in
                        item["Config"]["Labels"].get("com.docker.compose.project.config_files", "").split(",")
                        if file and str(Path(file).resolve()) != CUDA_OVERLAY)
                  for item in containers}
        if chains != {tuple(file for file in self.files if file != CUDA_OVERLAY)} and self.env.get("ALLOW_CONFIG_CHANGE") != "1":
            raise StackError(
                "Selected Compose files differ from the existing deployment. Preserve its override "
                "chain with COMPOSE_FILE, or set ALLOW_CONFIG_CHANGE=1 for an intentional configuration "
                "change. No containers were changed.")
        excluded = {item["Config"]["Labels"].get("com.docker.compose.service") for item in containers
                    if item.get("State", {}).get("Running")}
        excluded -= set(self.services) | {"agent-worker", None}
        if self.viegem_device == "mps":
            excluded -= {"viegem", "viegem-models"}
        if excluded and self.env.get("ALLOW_CONFIG_CHANGE") != "1":
            raise StackError("Running services excluded by selected profiles: " + ", ".join(sorted(excluded))
                             + ". Preserve COMPOSE_PROFILES or explicitly set ALLOW_CONFIG_CHANGE=1.")

    def preflight(self):
        version = run(["docker", "version", "--format", "{{.Server.Version}}"],
                      env=self.env, capture=True).stdout.strip().lstrip("v")
        if not version or not version.split(".")[0].isdigit() or int(version.split(".")[0]) < 26:
            raise StackError("Docker engine >=26 is required for workspace volume subpaths.")
        self.validate_bindings()

    def validate_admin(self):
        token = self.services["admin-api"].get("environment", {}).get("ADMIN_API_TOKEN", "")
        # Keep the deployment entrypoint aligned with the actual service declaration.
        declaration = json.loads((ROOT / "core/identity/services/admin-api/src/admin_api/config.v1.json").read_text())
        entry = next(key for key in declaration["keys"] if key["key"] == "ADMIN_API_TOKEN")
        if not token.strip() or token.strip() in entry.get("forbidden_values", []):
            raise StackError("ADMIN_TOKEN is missing or a published placeholder; configure a private secret.")
        return token

    def images(self):
        return {"bot": self.runtime["BROWSER_IMAGE"],
                "agent-worker": self.runtime["AGENT_WORKER_IMAGE"]}

    def check_images(self, *, bot_only=False):
        missing = []
        images = self.images()
        if not bot_only:
            images.update({name: spec["image"] for name, spec in self.services.items() if spec.get("image")})
        for name, image in images.items():
            if bot_only and name != "bot":
                continue
            if run(["docker", "image", "inspect", image], env=self.env, capture=True, check=False).returncode:
                missing.append(f"{name} ({image})")
        if missing:
            raise StackError("Required images missing: " + ", ".join(missing))

    def build_bot(self):
        if self.builder != self.context:
            raise StackError("BUILDX_BUILDER must match the selected Docker context for local source builds.")
        image = self.images()["bot"]
        requested = self.env.get("BOT_IMAGE")
        if requested and requested != image:
            raise StackError("BOT_IMAGE differs from resolved BROWSER_IMAGE; configure the latter instead.")
        run(["docker", "build", "-f", str(ROOT / "core/meetings/modules/join/Dockerfile.env"),
             "-t", "tina/meet-join-env:dev", str(ROOT / "core/meetings/modules/join")], env=self.env)
        sha = run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                  capture=True, check=False).stdout.strip() or "unknown"
        run(["docker", "build", "-t", image, "--build-arg", f"TINA_IMAGE_VERSION={sha}",
             "-f", str(ROOT / "core/meetings/services/bot/Dockerfile"), str(ROOT)], env=self.env)

    def build(self):
        # Build-only workers and ALL enabled service images precede any up/recreate.
        if self.viegem_device == "cuda":
            probe = run(["docker", "run", "--rm", "--gpus", "all", "--entrypoint", "nvidia-smi",
                         "python:3.11-slim", "-L"], env=self.env, capture=True, check=False)
            if probe.returncode or "GPU" not in probe.stdout:
                raise StackError("Docker cannot access an NVIDIA GPU. Check the Windows NVIDIA driver, WSL2 and Docker GPU support; no CPU fallback was used.")
        self.native_viegem("prepare")
        self.build_bot()
        names = [name for name, spec in self.services.items() if spec.get("build")]
        self.compose("build", *names, "agent-worker")
        # Init jobs reuse source-built images without a build stanza of their own.
        # Pull only registry images; --ignore-buildable alone still pulls those local aliases.
        local_images = {spec.get('image') for spec in self.services.values() if spec.get('build')}
        local_images.update(self.images().values())
        registry_services = [name for name, spec in self.services.items()
                             if spec.get('image') and spec['image'] not in local_images]
        if registry_services:
            self.compose("pull", "--ignore-buildable", *registry_services)
        self.check_images()
        self.verify_viegem_cuda()
        for service in ("gipformer-models", "viegem-models", "meeting-voice-models", "tts-models"):
            if service in self.services:
                if service == "tts-models":
                    self.prepare_tts_models()
                else:
                    self.compose("run", "--rm", "--no-deps", service)
        self.prepare_wakeword()

    def prepare_tts_models(self):
        command = ("run", "--rm", "--no-deps", "-T")
        check = ('from pathlib import Path; from engine import verify_assets; '
                 'verify_assets(Path("/models"))')
        result = self.compose(*command, "--entrypoint", "python", "tts-models", "-c", check,
                              capture=True, check=False)
        if result.returncode == 0:
            return
        descriptor = json.loads((ROOT / "deploy/tts/bundle-release.json").read_text())
        key_file = _dotenvx_key_file(ROOT / "deploy/tts/.env", self.env)
        if key_file is None:
            raise StackError("First-run TTS requires the shared release .env.keys file.")
        with tempfile.TemporaryDirectory(prefix="tina-tts-release-") as tmp:
            directory = Path(tmp)
            envelope = directory / ".env"
            envelope.write_text('TINA_TTS_BUNDLE_PASSWORD="' + descriptor["password"] + '"\n')
            env = {k: v for k, v in self.env.items() if not k.startswith("DOTENV_PRIVATE_KEY")}
            get = run([self.env.get("DOTENVX_BIN") or "dotenvx", "get", "TINA_TTS_BUNDLE_PASSWORD",
                       "--quiet", "--strict", "--overload", "--no-armor", "--no-native",
                       "--no-1password", "--no-bitwarden", "-f", str(envelope), "-fk", str(key_file)],
                      env=env, capture=True, check=False)
            password = get.stdout.strip()
            if get.returncode or not re.fullmatch(r"[a-f0-9]{64}", password):
                raise StackError("The selected .env.keys cannot unlock the TTS release. Use its matching key or restore a verified model volume.")
            print("Downloading the pinned TTS release bundle from GitHub.", flush=True)
            archive = directory / "models.enc"
            digest = hashlib.sha256()
            total = 0
            deadline = time.monotonic() + 900
            try:
                with urlopen(descriptor["url"], timeout=60) as src, archive.open("wb") as out:
                    while chunk := src.read(1024**2):
                        total += len(chunk)
                        if total > 600 * 1024**2 or time.monotonic() > deadline:
                            raise StackError("TTS release download exceeded its size or time limit.")
                        digest.update(chunk)
                        out.write(chunk)
            except OSError:
                raise StackError("Could not download the pinned TTS release from GitHub.") from None
            if digest.hexdigest() != descriptor["sha256"]:
                raise StackError("TTS release download failed checksum verification.")
            run([*self.base, *command, "--volume", str(archive) + ":/bundle.enc:ro",
                 "tts-models", "python", "install_models.py", "--encrypted-archive", "/bundle.enc"],
                env=self.env, input_text=password + "\n")

    def prepare_wakeword(self):
        if not self.voice_enabled or 'meeting-voice-models' not in self.services:
            return
        verify = ('from pathlib import Path; from tina_meeting_voice.kws_shadow import verify; '
                  'verify(Path("/models/meeting-voice/livekit-tina-v1"))')
        command = ('run', '--rm', '--no-deps', '--entrypoint', '/opt/tina-voice/bin/python')
        result = self.compose(*command, 'meeting-voice-models', '-c', verify, capture=True, check=False)
        if result.returncode == 0:
            return
        source = self.kws_models_dir
        if not all((source / (name + '.onnx')).is_file() for name in ('hey_tina', 'tina_oi')):
            raise StackError('KWS models are missing or invalid. Provide hey_tina.onnx and tina_oi.onnx '
                             'in TINA_KWS_MODELS_DIR, or restore the meeting-voice-models cache. No application containers were restarted.')
        self.compose(*command, '--volume', str(source) + ':/source:ro',
                     '--volume', str(ROOT / 'deploy/wakeword/install_local.py') + ':/installer.py:ro',
                     'meeting-voice-models', '/installer.py', '/source', '/models/meeting-voice', capture=True)
        self.compose(*command, 'meeting-voice-models', '-c', verify, capture=True)

    def verify_viegem_cuda(self):
        if self.viegem_device != "cuda" or self._cuda_verified:
            return
        code = ("import torch; assert torch.cuda.is_available(), 'CUDA unavailable'; "
                "x=torch.ones((2,2),device='cuda'); assert (x@x).sum().item()==8; torch.cuda.synchronize()")
        probe = run(["docker", "run", "--rm", "--gpus", "all", "--entrypoint", "python",
                     self.services["viegem"]["image"], "-c", code], env=self.env, capture=True, check=False)
        if probe.returncode:
            raise StackError("The pinned VieGem CUDA image could not compute on the GPU; check GPU/driver compatibility. No CPU fallback was used.")
        self._cuda_verified = True

    def native_viegem(self, action):
        identity = self.services["admin-api"].get("environment", {})
        token = identity.get("TINA_VIEGEM_TOKEN")
        container = self.viegem_device in {"cuda", "cpu"}
        if not token:
            if "viegem" in self.services:
                raise StackError("The viegem profile requires TINA_VIEGEM_TOKEN in the selected deployment env.")
            return
        if container and action in ("prepare", "start"):
            return
        if not container and (platform.system() != "Darwin" or platform.machine() != "arm64"):
            if action == "prepare":
                print("VieGem: native auto-start requires Mac Apple Silicon; external workers remain separately managed.")
            return
        key_file = _dotenvx_key_file(self.env_file, self.env)
        if not key_file:
            raise StackError("Automatic VieGem startup requires a private .env.keys file.")
        host, endpoint = self.native_viegem_access() if not container else ("127.0.0.1", "")
        if container:
            endpoint = f"http://host.docker.internal:{urlsplit(self.endpoint('viegem', 8000)).port}"
        env = dict(self.env, TINA_VIEGEM_ENV_FILE=str(self.env_file.resolve()),
                   TINA_VIEGEM_KEYS_FILE=str(key_file.resolve()), TINA_VIEGEM_TOKEN=token,
                   TINA_VIEGEM_ADMIN_URL=self.endpoint("admin-api", 8001),
                   TINA_VIEGEM_INTERNAL_SECRET=identity.get("INTERNAL_API_SECRET", ""),
                   TINA_VIEGEM_URL=endpoint, TINA_VIEGEM_HOST=host)
        if action == "register":
            # Probe from Docker before selecting this host endpoint in a fresh registry.
            code = '''import os, json, urllib.request
from admin_api.config_preflight import audio_probe_body
kind, body = audio_probe_body("5CD-AI/VieGem-ASR")
req = urllib.request.Request(ENDPOINT + "/v1/audio/transcriptions", data=body,
    headers={"Content-Type":kind,"Authorization":"Bearer "+os.environ["TINA_VIEGEM_TOKEN"]})
with urllib.request.urlopen(req, timeout=20) as response:
    assert response.status == 200 and isinstance(json.load(response).get("text"), str)
'''
            code = code.replace("ENDPOINT", repr(endpoint))
            self.compose("exec", "-T", "admin-api", "python", "-c", code, capture=True)
        run([sys.executable, str(HERE / "bin/native_viegem.py"), action], env=env)

    def readiness(self, services=None):
        rows = json_rows(self.compose("ps", "-a", "--format", "json", capture=True).stdout)
        completed = {name for spec in self.services.values()
                     for name, dep in spec.get("depends_on", {}).items()
                     if dep.get("condition") == "service_completed_successfully"}
        failures = []
        for name, spec in self.services.items():
            if services is not None and name not in services:
                continue
            instances = [row for row in rows if row.get("Service") == name]
            if not instances:
                failures.append(f"{name}: missing")
                continue
            for row in instances:
                state = row.get("State", "")
                if name in completed:
                    ok = state == "exited" and row.get("ExitCode") == 0
                else:
                    ok = state == "running"
                    if spec.get("healthcheck") and not spec["healthcheck"].get("disable"):
                        ok = ok and row.get("Health") == "healthy"
                if not ok:
                    failures.append(f"{name}: {state}/{row.get('Health') or row.get('ExitCode', '')}")
        if failures:
            raise StackError("Services not ready: " + ", ".join(failures))
        if self.voice_enabled and 'tts' in self.services and (services is None or 'tts' in services):
            code = ('import os,urllib.request; r=urllib.request.Request("http://127.0.0.1:8000/ready", '
                    'headers={"X-API-Key":os.environ["TTS_API_TOKEN"]}); '
                    'assert urllib.request.urlopen(r,timeout=5).status==200')
            self.compose('exec', '-T', 'tts', 'python', '-c', code, capture=True)
        if 'livekit-agent' in self.services and (services is None or 'livekit-agent' in services):
            code = ('import urllib.request; '
                    'assert urllib.request.urlopen("http://127.0.0.1:8080/ready",timeout=12).status==200')
            self.compose('exec', '-T', 'livekit-agent', 'python', '-c', code, capture=True)

    def doctor_readiness(self):
        required = set(self.services)
        paused = set()
        if self.services['admin-api'].get('environment', {}).get('INTERNAL_API_SECRET'):
            from asr_control import Identity, Workers, ControlError
            try:
                counts = Identity(self).read()['counts']
                workers = Workers(self)
                managed = ({'gipformer'} if 'gipformer' in self.services else set())
                if self.viegem_device != 'disabled': managed.add('viegem')
                for backend in managed:
                    count = counts.get(backend)
                    if type(count) is not int or count < 0:
                        raise StackError('Invalid managed ASR demand metadata')
                    if count == 0:
                        required.discard(backend); paused.add(backend)
                    elif not workers.status(backend).get('ready'):
                        raise StackError('ASR backend required by enabled accounts is not ready: ' + backend)
            except (ControlError, KeyError):
                raise StackError('Could not verify managed ASR demand/readiness') from None
        self.readiness(required)
        return paused

    def endpoint(self, service, target):
        for port in self.services[service].get("ports", []):
            if int(port["target"]) == target and port.get("published"):
                host = port.get("host_ip") or "127.0.0.1"
                if host in ("0.0.0.0", "::"):
                    host = "127.0.0.1"
                if ":" in host:
                    host = f"[{host}]"
                return f"http://{host}:{port['published']}"
        raise StackError(f"No published port for {service}:{target}.")

    def native_viegem_access(self):
        if self._native_viegem_access_cache is not None:
            return self._native_viegem_access_cache
        host, endpoint = "127.0.0.1", "http://host.docker.internal:18005"
        if self.context == "orbstack":
            bridge = run(["ifconfig", "bridge100"], env=self.env, capture=True, check=False)
            for line in bridge.stdout.splitlines():
                fields = line.split()
                if len(fields) > 1 and fields[0] == "inet":
                    try:
                        address = ipaddress.IPv4Address(fields[1])
                    except ipaddress.AddressValueError:
                        continue
                    if address.is_private and not address.is_loopback:
                        host = str(address)
                        endpoint = f"http://{host}:18005"
                        break
            else:
                raise StackError("Could not find OrbStack's private bridge100 address for the native VieGem worker.")
        self._native_viegem_access_cache = (host, endpoint)
        return self._native_viegem_access_cache

    def provision_key(self, email=None):
        env = dict(self.env, ADMIN_TOKEN=self.validate_admin(),
                   ADMIN_API_URL=self.endpoint("admin-api", 8001),
                   EMAIL=email or self.env.get("EMAIL", "self-host@tina.test"),
                   SCOPES=self.env.get("SCOPES", "bot,tx"))
        for attempt in range(3):
            result = run([str(HERE / "bin/provision-token")], env=env, capture=True, check=False)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            if attempt < 2:
                time.sleep(1)
        raise StackError("API key provisioning failed; the deployment is not verified. Check admin-api.")

    def capabilities(self):
        stt = self.services["meeting-api"].get("environment", {})
        state = "endpoint configured" if stt.get("TRANSCRIPTION_SERVICE_URL") else "no deployment endpoint"
        print(f"STT: {state}; effective user/global backends must be tested in Settings → Models.")
        print("Agent: user model/subscription credentials are checked in Settings → Models.")
        print("Host services: Desktop, native Capture, extension, diarization and alignment are managed separately.")
        print(f"VieGem: {self.viegem_device}; auto uses native MPS on Apple Silicon and verified Docker CUDA on Linux/WSL2. KenLM/FSMN stay on CPU.")

    def plan_data(self):
        self.validate_bindings()
        return {"project": self.project, "docker_context": self.context,
                          "env_file": str(self.env_file),
                          "compose_files": self.files, "services": list(self.services),
                          "viegem_device": self.viegem_device,
                          "meeting_voice": self.voice_enabled,
                          "tts_credentials_ready": self.voice_credentials_ready,
                          "kws_models_source": str(self.kws_models_dir),
                          "native_viegem": bool(self.services["admin-api"].get("environment", {}).get("TINA_VIEGEM_TOKEN")
                                                and "viegem" not in self.services and platform.system() == "Darwin" and platform.machine() == "arm64"),
                          "container_viegem": "viegem" in self.services,
                          "images": self.images(),
                          "volumes": {key: value.get("name") for key, value in self.config.get("volumes", {}).items()},
                          "order": ["bootstrap", "preflight", "build bot/services/worker",
                                    "check images", "up --no-build --pull never --wait",
                                    "check readiness", "provision access"]}

    def plan(self):
        print(json.dumps(self.plan_data(), indent=2))
        self.capabilities()

    def activate(self):
        self.guard_existing_config()
        self.verify_viegem_cuda()
        if self.viegem_device == "mps":
            # This project may still have the old CPU worker bound to the native port.
            self.compose("--profile", "viegem", "stop", "viegem", "viegem-models", capture=True)
        elif self.viegem_device == "cpu" and platform.system() == "Darwin":
            self.native_viegem("stop")
        self.stop_asr_control()
        self.compose("up", "-d", "--no-build", "--pull", "never", "--wait",
                     "--wait-timeout", self.env.get("WAIT_TIMEOUT", "180"))
        self.readiness()
        if ("gipformer" in self.services or self.viegem_device != "disabled") and self.services["admin-api"].get("environment", {}).get("INTERNAL_API_SECRET"):
            from asr_control import install
            install(self)
        try:
            self.native_viegem("start")
        except StackError:
            if self.viegem_device == "mps":
                self.compose("--profile", "viegem", "start", "viegem", capture=True, check=False)
            raise
        self.native_viegem("register")

    def stop_asr_control(self):
        if self.services["admin-api"].get("environment", {}).get("INTERNAL_API_SECRET"):
            from asr_control import shutdown
            shutdown(self)

    def access(self):
        self.provision_key()
        print(f"Terminal UI: {self.endpoint('terminal', 3000)}")
        print(f"API gateway: {self.endpoint('gateway', 8000)}")
        if "dashboard" in self.services:
            print(f"Dashboard: {self.endpoint('dashboard', 3000)}")
        print('API access provisioned. Use make -C deploy/compose provision-token only when a token is needed.')

    def probe(self):
        env = dict(self.env)
        env.setdefault("GATEWAY_URL", self.endpoint("gateway", 8000))
        if not env.get("TINA_API_KEY"):
            env["TINA_API_KEY"] = self.provision_key("probe@example.test")
        env.setdefault("PROBE_MODE", "mock" if "mock" in self.images()["bot"] else "real")
        env["PROBE_SWEEP_CMD"] = shlex.join([*self.base, "logs", "--tail=40"])
        # One scoped sweep; do not gather unrelated deployments' bot logs.
        env["PROBE_SWEEP_CMD"] += (
            "\nfor c in $(docker ps -aq --filter "
            + shlex.quote("network=" + self.config["networks"]["tina"]["name"])
            + " --filter name=tina-mtg | head -3); do docker logs --tail=30 \"$c\"; done")
        run(["bash", str(ROOT / "scripts/probe/journey.sh")], env=env)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "plan"
    if action in {"all", "build"}:
        env_file = os.environ.get("ENV_FILE") or ".env"
        seed = ["bash", str(HERE / "mint-dev-env.sh"), env_file]
        if (env_file == ".env" and not (HERE / ".env").exists()
                and "TINA_MEETING_VOICE" not in os.environ
                and _dotenvx_key_file(ROOT / "deploy/tts/.env", os.environ)):
            seed.append("--voice-release")
        run(seed)
    stack = Stack(action)
    if action == "plan":
        stack.plan()
    elif action in {"all", "build", "bot"}:
        stack.preflight()
        stack.guard_existing_config()
        if action == "bot":
            stack.build_bot()
            stack.check_images(bot_only=True)
            return
        stack.validate_admin()
        stack.build()
        if action == "all":
            try:
                stack.activate()
                stack.access()
            except StackError:
                print("Deployment incomplete; inspect make ps/logs. Existing data volumes were retained.", file=sys.stderr)
                raise
            stack.capabilities()
            print(f"TINA Compose ready: {stack.project}")
    elif action == "doctor":
        stack.preflight()
        stack.guard_existing_config()
        stack.check_images()
        paused = stack.doctor_readiness()
        if paused: print('ASR without enabled account demand: ' + ', '.join(sorted(paused)))
        stack.capabilities()
        print(f"Compose services ready: {stack.project}; audio/AI acceptance not exercised.")
    elif action == "access":
        stack.access()
    elif action == "token":
        print(stack.provision_key())
    elif action == "check-images":
        stack.check_images(bot_only=True)
    elif action == "preflight":
        stack.preflight()
    elif action == "capabilities":
        stack.capabilities()
    elif action == "project":
        print(stack.project)
    elif action == "probe":
        stack.guard_existing_config()
        stack.probe()
    elif action in {"down", "destroy"}:
        stack.validate_bindings()
        stack.guard_existing_config()
        if action == "destroy" and stack.env.get("DESTROY") != "yes":
            raise StackError("Refusing to delete volumes. Explicitly set DESTROY=yes.")
        stack.stop_asr_control()
        stack.compose("down", *(["-v"] if action == "destroy" else []), "--remove-orphans")
        if stack.viegem_device == "mps":
            stack.native_viegem("stop")
    elif action in {"ps", "logs", "compose"}:
        args = {"ps": ["ps"], "logs": ["logs", "-f"]}.get(action, sys.argv[2:])
        if action == "compose" and args and args[0] in {"up", "down", "build", "run"}:
            stack.validate_bindings()
            stack.guard_existing_config()
        stack.compose(*args)
    else:
        raise StackError(f"Unknown stack action: {action}")


if __name__ == "__main__":
    try:
        main()
    except (StackError, KeyError, ValueError, OSError) as error:
        print(f"✗ {error}", file=sys.stderr)
        sys.exit(1)

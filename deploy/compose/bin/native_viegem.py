#!/usr/bin/env python3
"""Mac host worker lifecycle used by the source-build deployment entrypoint."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "deploy/transcription/viegem"
LABEL = "local.tina.viegem"
MODEL = "5CD-AI/VieGem-ASR"
LEGACY_HOST_ENDPOINT = "http://host.docker.internal:18005"


def command(args, *, capture=False, check=True):
    # Build tools do not need runtime credentials or private decryption keys.
    env = {k: v for k, v in os.environ.items()
           if k not in {"TINA_VIEGEM_TOKEN", "TINA_VIEGEM_INTERNAL_SECRET"} and not k.startswith("DOTENV_PRIVATE_KEY")}
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env,
                            capture_output=capture, text=True)
    if check and result.returncode:
        raise RuntimeError(f"VieGem command failed: {Path(args[0]).name} (exit {result.returncode}).")
    return result


def token():
    env_file = Path(os.environ["TINA_VIEGEM_ENV_FILE"])
    key_file = Path(os.environ["TINA_VIEGEM_KEYS_FILE"])
    if not key_file.is_file() or not any(
        line.startswith("TINA_VIEGEM_TOKEN=") and "encrypted:" in line for line in env_file.read_text().splitlines()
    ):
        raise RuntimeError("Automatic VieGem startup requires an encrypted TINA_VIEGEM_TOKEN and its .env.keys file.")
    result = command([os.environ.get("DOTENVX_BIN", "dotenvx"), "get", "TINA_VIEGEM_TOKEN",
                      "--quiet", "--strict", "--overload", "-f", env_file, "-fk", key_file], capture=True)
    value = result.stdout.strip()
    if len(value) < 32 or value != os.environ["TINA_VIEGEM_TOKEN"]:
        raise RuntimeError("VieGem worker and deployment token differ; no worker was changed.")
    return value


def prepare():
    token()
    missing = [name for name in ("uv", "cmake") if not shutil.which(name)]
    if missing:
        brew = shutil.which("brew")
        if not brew:
            raise RuntimeError("Install uv and cmake (or Homebrew for automatic installation), then rerun make all.")
        command([brew, "install", *missing])
    command(["xcrun", "--find", "clang"], capture=True)
    python = ROOT / ".venv/viegem/bin/python"
    if not python.exists():
        command(["uv", "venv", "--python", "3.11", ROOT / ".venv/viegem"])
    version = command([python, "-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"], capture=True)
    if version.stdout.strip() != "3.11":
        raise RuntimeError(".venv/viegem must use Python 3.11; the existing environment was preserved.")
    command(["uv", "pip", "install", "--python", python, "-r", WORKER / "requirements.txt"])
    probe = command([python, "-c", "import torch; assert torch.backends.mps.is_available(), 'MPS unavailable'; "
                     "x=torch.ones((2,2),device='mps'); assert (x@x).sum().item()==8; torch.mps.synchronize()"],
                    capture=True, check=False)
    if probe.returncode:
        raise RuntimeError("Native PyTorch could not compute on MPS; check this Mac's Metal/macOS support. No CPU fallback was used.")
    command([python, WORKER / "install-models.py"])
    print("VieGem: Python, dependencies and pinned model checksums ready.", flush=True)


def probe(value, host="127.0.0.1"):
    spec = importlib.util.spec_from_file_location("asr_preflight", ROOT / "deploy/contracts/config.v1/preflight.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    content_type, body = module.audio_probe_body(MODEL)
    req = urllib.request.Request(f"http://{host}:18005/v1/audio/transcriptions", data=body,
                                 headers={"Content-Type": content_type, "Authorization": "Bearer " + value})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status == 200 and isinstance(json.load(response).get("text"), str)
    except (OSError, ValueError):
        return False


def start():
    value = token()
    home = Path.home()
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    domain = f"gui/{os.getuid()}"
    old = plistlib.loads(agent.read_bytes()) if agent.exists() else None
    if old and old.get("WorkingDirectory") != str(ROOT):
        raise RuntimeError("A VieGem LaunchAgent belongs to another checkout. It was not replaced.")
    if old and old.get("EnvironmentVariables", {}).get("TINA_VIEGEM_ENV_FILE") not in (
            None, os.environ["TINA_VIEGEM_ENV_FILE"]):
        raise RuntimeError("A VieGem LaunchAgent belongs to another deployment environment. It was not replaced.")
    loaded = command(["launchctl", "print", domain + "/" + LABEL], capture=True, check=False).returncode == 0
    if loaded and not old:
        raise RuntimeError("A loaded VieGem job has no matching managed plist; it was not stopped.")
    with socket.socket() as sock:
        busy = sock.connect_ex(("127.0.0.1", 18005)) == 0
    if busy and not (loaded and old):
        raise RuntimeError("Port 18005 is already owned by another process; no process was stopped.")
    logs = home / "Library/Logs/TINA"
    logs.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256()
    for path in sorted(p for p in WORKER.glob("*.py") if not p.name.startswith("test_")) + [WORKER / "start.sh", WORKER / "requirements.txt",
            WORKER / "model-assets.json", WORKER / "custom_words.txt", ROOT / "deploy/transcription/http_worker.py",
            ROOT / "deploy/transcription/gipformer/requirements.txt",
            ROOT / "deploy/transcription/gipformer/engine.py", ROOT / "deploy/transcription/gipformer/telemetry.py"]:
        fingerprint.update(path.read_bytes())
    config = {
        "Label": LABEL, "WorkingDirectory": str(ROOT), "ProgramArguments": ["/bin/sh", str(WORKER / "start.sh")],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
        "StandardOutPath": str(logs / "viegem.stdout.log"), "StandardErrorPath": str(logs / "viegem.stderr.log"),
        "EnvironmentVariables": {"PATH": os.environ["PATH"], "TINA_VIEGEM_DEVICE": "mps",
            "TINA_VIEGEM_NAME_BIAS": os.environ.get("TINA_VIEGEM_NAME_BIAS", "0"),
            "TINA_VIEGEM_CUSTOM_WEIGHT": os.environ.get("TINA_VIEGEM_CUSTOM_WEIGHT", "1.0"),
            "TINA_VIEGEM_CUSTOM_WORDS_FILE": os.environ.get("TINA_VIEGEM_CUSTOM_WORDS_FILE", ""),
            "TINA_VIEGEM_HOST": os.environ.get("TINA_VIEGEM_HOST", "127.0.0.1"),
            "TOKENIZERS_PARALLELISM": "false", "TINA_VIEGEM_REVISION": fingerprint.hexdigest(),
            "TINA_VIEGEM_ENV_FILE": os.environ["TINA_VIEGEM_ENV_FILE"],
            "TINA_VIEGEM_KEYS_FILE": os.environ["TINA_VIEGEM_KEYS_FILE"],
            "DOTENVX_BIN": shutil.which(os.environ.get("DOTENVX_BIN", "dotenvx")) or "dotenvx"},
    }
    print(f"VieGem: LaunchAgent bind address {config['EnvironmentVariables']['TINA_VIEGEM_HOST']}.", flush=True)
    bind_host = config["EnvironmentVariables"]["TINA_VIEGEM_HOST"]
    if old == config and loaded and probe(value, bind_host):
        print("VieGem: existing managed worker passed authenticated audio probe.", flush=True)
        return
    agent.parent.mkdir(parents=True, exist_ok=True)
    temporary = agent.with_suffix(".plist.new")
    temporary.write_bytes(plistlib.dumps(config)); temporary.chmod(0o600); temporary.replace(agent)
    print(f"VieGem: LaunchAgent configured at {agent} on {bind_host}.", flush=True)
    if loaded:
        command(["launchctl", "bootout", domain + "/" + LABEL], capture=True)
    for _ in range(5):
        # launchd may still be unloading a job after bootout has returned successfully.
        result = command(["launchctl", "bootstrap", domain, agent], capture=True, check=False)
        if result.returncode == 0:
            break
        if result.returncode != 5:
            break
        time.sleep(1)
    if result.returncode:
        if old:
            agent.write_bytes(plistlib.dumps(old))
            command(["launchctl", "bootstrap", domain, agent], capture=True, check=False)
        raise RuntimeError(f"launchctl bootstrap failed (exit {result.returncode}); the previous plist was restored.")
    for _ in range(60):
        if probe(value, bind_host):
            print(f"VieGem: managed Apple MPS worker passed authenticated probe at {bind_host}.", flush=True)
            return
        time.sleep(1)
    raise RuntimeError("VieGem did not pass its audio probe; inspect ~/Library/Logs/TINA/viegem.stderr.log.")


def stop():
    agent = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    domain = f"gui/{os.getuid()}/{LABEL}"
    if not agent.exists():
        if command(["launchctl", "print", domain], capture=True, check=False).returncode == 0:
            raise RuntimeError("A loaded VieGem job has no matching managed plist; it was not stopped.")
        return
    config = plistlib.loads(agent.read_bytes())
    if config.get("WorkingDirectory") != str(ROOT) or config.get("EnvironmentVariables", {}).get("TINA_VIEGEM_ENV_FILE") not in (
            None, os.environ["TINA_VIEGEM_ENV_FILE"]):
        raise RuntimeError("Native VieGem belongs to another checkout/environment; it was not stopped.")
    if command(["launchctl", "print", domain], capture=True, check=False).returncode == 0:
        command(["launchctl", "bootout", domain], capture=True)
    agent.unlink()
    print("VieGem: owned native LaunchAgent stopped and removed; model files preserved.", flush=True)


def register():
    token()
    url = os.environ["TINA_VIEGEM_ADMIN_URL"].rstrip("/") + "/internal/settings/transcription"
    headers = {"X-Internal-Secret": os.environ["TINA_VIEGEM_INTERNAL_SECRET"], "Content-Type": "application/json"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
            settings = json.load(response)
            current = settings["value"]
        endpoint = os.environ.get("TINA_VIEGEM_URL", "http://host.docker.internal:18005")
        if current.get("viegem_url") not in (None, "", endpoint, LEGACY_HOST_ENDPOINT):
            raise RuntimeError("Existing VieGem URL belongs to another endpoint; it was not overwritten.")
        patch = {"viegem_url": endpoint}
        if settings.get("configured") is False or ("configured" not in settings and
                not {k: v for k, v in current.items() if k != "viegem_token"}):
            patch["default_backend"] = "viegem"
        req = urllib.request.Request(url, headers=headers, method="PUT", data=json.dumps(patch).encode())
        with urllib.request.urlopen(req, timeout=10) as response:
            saved = json.load(response)["value"]
        if saved.get("viegem_url") != endpoint or (current.get("default_backend") and
                current["default_backend"] != saved.get("default_backend")):
            raise RuntimeError("VieGem registration did not preserve the existing default backend.")
    except (OSError, ValueError, KeyError):
        raise RuntimeError("VieGem could not register with Identity; make all is incomplete.") from None
    print("VieGem: registered with Identity; existing transcription preferences preserved.", flush=True)


if __name__ == "__main__":
    try:
        {"prepare": prepare, "start": start, "stop": stop, "register": register}[sys.argv[1]]()
    except (RuntimeError, OSError, KeyError) as error:
        print(f"VieGem setup failed: {error}", file=sys.stderr)
        sys.exit(1)

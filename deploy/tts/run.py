#!/usr/bin/env python3
"""Load the TTS token without injecting its decryption key into launched commands."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


class EnvError(RuntimeError):
    pass


def runtime_env(source=None):
    env = dict(os.environ if source is None else source)
    dotenvx = env.get('DOTENVX_BIN') or shutil.which('dotenvx')
    if not dotenvx:
        raise EnvError('Install dotenvx in this OS, or set DOTENVX_BIN to its executable.')
    local = Path.home() / '.config/tina/tts-local'
    local_default = not env.get('TINA_TTS_ENV_FILE') and not env.get('TINA_TTS_KEYS_FILE') and (
        (local / '.env').exists() or (local / '.env.keys').exists())
    env_file = Path(env.get('TINA_TTS_ENV_FILE') or (local / '.env' if local_default else HERE / '.env')).expanduser()
    if not env_file.is_absolute():
        env_file = ROOT / env_file
    key_file = Path(env.get('TINA_TTS_KEYS_FILE') or (local / '.env.keys' if local_default else ROOT / '.env.keys')).expanduser()
    if not key_file.is_absolute():
        key_file = ROOT / key_file
    if not env_file.is_file():
        raise EnvError('TTS env file is missing; use the encrypted deploy/tts/.env from this checkout.')
    if not key_file.is_file():
        raise EnvError('TTS key is missing; obtain the matching tts.env.keys privately from the operator.')
    try:
        values = [line.partition('=')[2].strip().strip('\"\'')
            for line in env_file.read_text(encoding='utf-8').splitlines()
            if line.partition('=')[0].strip() == 'TTS_API_TOKEN']
    except OSError:
        raise EnvError('Cannot read the selected TTS env file.') from None
    if len(values) != 1 or not values[0].startswith('encrypted:'):
        raise EnvError('Selected TTS env must contain one encrypted TTS_API_TOKEN; ambient fallback is disabled.')
    # Main-stack private keys may be in the caller's environment. Never use them to decrypt TTS.
    decrypt_env = {k: v for k, v in env.items() if not k.startswith('DOTENV_PRIVATE_KEY')}
    try:
        result = subprocess.run([dotenvx, 'get', 'TTS_API_TOKEN', '--quiet', '--strict', '--overload',
            '--no-armor', '--no-native', '--no-1password', '--no-bitwarden',
            '-f', str(env_file), '-fk', str(key_file)], env=decrypt_env, cwd=ROOT,
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise EnvError('Dotenvx could not run; no service was started.') from None
    token = result.stdout.strip()
    if result.returncode or not token or token.startswith('encrypted:') or '\n' in token or '\r' in token:
        # Dotenvx diagnostics can contain secret values. Do not include stdout/stderr here.
        raise EnvError('Cannot decrypt TTS_API_TOKEN; check the matching TTS env/key files.')
    env['TTS_API_TOKEN'] = token
    env.setdefault('TTS_SERVICE_URL', 'http://tts:8000')
    env.setdefault('TINA_TTS_MODELS', str(Path.home() / '.cache/tina/tts'))
    # Dotenvx ran in a subprocess; its TTS private key was never injected into this environment.
    return env


def main(argv=None):
    command = list(sys.argv[1:] if argv is None else argv)
    if command[:1] == ['--']:
        command.pop(0)
    if not command:
        print('Usage: python3 deploy/tts/run.py -- COMMAND [ARGS...]', file=sys.stderr)
        return 2
    try:
        env = runtime_env()
        return subprocess.call(command, cwd=ROOT, env=env)
    except EnvError as exc:
        print('TTS environment: ' + str(exc), file=sys.stderr)
        return 1
    except OSError:
        print('TTS environment: cannot start the requested command.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

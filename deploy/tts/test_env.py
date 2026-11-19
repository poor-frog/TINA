"""Portable TTS startup: fail closed, keep keys private, no Docker/model required."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tts_env', HERE / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RuntimeEnvTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env_file = Path(self.temp.name) / '.env'
        self.key_file = Path(self.temp.name) / 'private.keys'
        self.env_file.write_text('TTS_API_TOKEN=encrypted:fixture\n', encoding='utf-8')
        self.key_file.write_text('fixture-key', encoding='utf-8')
        self.env = {'DOTENVX_BIN': 'fixture-dotenvx', 'TINA_TTS_ENV_FILE': str(self.env_file),
                    'TINA_TTS_KEYS_FILE': str(self.key_file)}

    def test_local_encrypted_pair_is_selected_without_overrides(self):
        home = Path(self.temp.name) / 'home'
        local = home / '.config/tina/tts-local'
        local.mkdir(parents=True)
        (local / '.env').write_text('TTS_API_TOKEN=encrypted:local-fixture\n')
        (local / '.env.keys').write_text('fixture-local-key')
        result = subprocess.CompletedProcess([], 0, 'fixture-local-token', '')
        with patch.object(runner.Path, 'home', return_value=home), patch.object(runner.subprocess, 'run', return_value=result) as decrypt:
            env = runner.runtime_env({'DOTENVX_BIN': 'fixture-dotenvx'})
        self.assertEqual(env['TTS_API_TOKEN'], 'fixture-local-token')
        args = decrypt.call_args.args[0]
        self.assertEqual(args[args.index('-f') + 1], str(local / '.env'))
        self.assertEqual(args[args.index('-fk') + 1], str(local / '.env.keys'))

    def test_incomplete_local_pair_does_not_fall_back_to_shared_credentials(self):
        home = Path(self.temp.name) / 'home'
        local = home / '.config/tina/tts-local'
        local.mkdir(parents=True)
        (local / '.env').write_text('TTS_API_TOKEN=encrypted:local-fixture\n')
        with patch.object(runner.Path, 'home', return_value=home), patch.object(runner.subprocess, 'run') as decrypt:
            with self.assertRaisesRegex(runner.EnvError, 'key is missing'):
                runner.runtime_env({'DOTENVX_BIN': 'fixture-dotenvx'})
        decrypt.assert_not_called()

    def test_missing_key_never_starts_decryption(self):
        self.key_file.unlink()
        with patch.object(runner.subprocess, 'run') as run:
            with self.assertRaisesRegex(runner.EnvError, 'key is missing'):
                runner.runtime_env(self.env)
        run.assert_not_called()

    def test_bad_key_failure_hides_dotenvx_output(self):
        result = subprocess.CompletedProcess([], 1, 'secret-from-output', 'secret-from-error')
        with patch.object(runner.subprocess, 'run', return_value=result):
            with self.assertRaises(runner.EnvError) as caught:
                runner.runtime_env(self.env)
        self.assertNotIn('secret-from', str(caught.exception))

    def test_missing_encrypted_token_never_uses_ambient_fallback(self):
        for content in ('OTHER=value\n', 'TTS_API_TOKEN=plaintext\n'):
            with self.subTest(content=content), patch.object(runner.subprocess, 'run') as run:
                self.env_file.write_text(content, encoding='utf-8')
                with self.assertRaisesRegex(runner.EnvError, 'ambient fallback is disabled'):
                    runner.runtime_env(self.env | {'TTS_API_TOKEN': 'ambient-token'})
                run.assert_not_called()

    def test_only_token_is_loaded_and_ambient_main_key_is_preserved(self):
        result = subprocess.CompletedProcess([], 0, 'fixture-decrypted-token\n', '')
        with patch.object(runner.subprocess, 'run', return_value=result) as run:
            env = runner.runtime_env(self.env | {'DOTENV_PRIVATE_KEY': 'main-stack-key',
                'TTS_API_TOKEN': 'wrong-ambient-token', 'TINA_TTS_MODELS': '/custom/cache'})
        self.assertEqual(env['TTS_API_TOKEN'], 'fixture-decrypted-token')
        self.assertEqual(env['TINA_TTS_MODELS'], '/custom/cache')
        self.assertEqual(env['DOTENV_PRIVATE_KEY'], 'main-stack-key')
        self.assertNotIn('DOTENV_PRIVATE_KEY', run.call_args.kwargs['env'])
        args = run.call_args.args[0]
        self.assertIn('--strict', args)
        self.assertIn('--overload', args)
        self.assertNotIn('fixture-decrypted-token', args)

    def test_ciphertext_or_empty_result_never_reaches_child(self):
        for text in ('', 'encrypted:undecrypted', 'token\nlog output'):
            with self.subTest(text=text), patch.object(runner.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], 0, text, '')):
                with self.assertRaises(runner.EnvError):
                    runner.runtime_env(self.env)

    def test_failed_environment_never_executes_child(self):
        with patch.object(runner, 'runtime_env', side_effect=runner.EnvError('missing key')), \
                patch.object(runner.subprocess, 'call') as call, patch('sys.stderr'):
            self.assertEqual(runner.main(['--', 'docker', 'compose', 'up']), 1)
        call.assert_not_called()


@unittest.skipUnless(shutil.which('dotenvx'), 'Dotenvx CLI required for real crypto proof')
class EncryptedTransferTests(unittest.TestCase):
    def test_copied_env_and_key_work_in_another_home_without_key_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / '.env'
            key = root / '.env.keys'
            token = 'fixture-transfer-token-0123456789abcdef'
            source.write_text('TTS_API_TOKEN=' + token + '\nUNRELATED_SECRET=not-for-child\n', encoding='utf-8')
            env = {k: v for k, v in os.environ.items() if not k.startswith('DOTENV_PRIVATE_KEY')}
            result = subprocess.run(['dotenvx', 'encrypt', '--no-armor', '--no-native',
                '-f', str(source), '-fk', str(key)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, 'Fixture encryption failed')
            self.assertNotIn(token, source.read_text(encoding='utf-8'))
            peer = root / 'peer'
            peer.mkdir()
            shutil.copyfile(source, peer / '.env')
            shutil.copyfile(key, peer / 'tts.env.keys')
            env.update(HOME=str(peer), USERPROFILE=str(peer), TINA_TTS_ENV_FILE=str(peer / '.env'),
                TINA_TTS_KEYS_FILE=str(peer / 'tts.env.keys'), TTS_API_TOKEN='wrong-ambient-token')
            env.pop('TINA_TTS_MODELS', None)
            probe = ('import os,json; print(json.dumps({'
                '"matches":os.environ["TTS_API_TOKEN"]=="' + token + '",'
                '"private_key_names":[k for k in os.environ if k.startswith("DOTENV_PRIVATE_KEY")],'
                '"unrelated_present":"UNRELATED_SECRET" in os.environ,'
                '"models":os.environ["TINA_TTS_MODELS"]}))')
            result = subprocess.run([sys.executable, str(HERE / 'run.py'), '--', sys.executable, '-c', probe],
                env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertTrue(data['matches'])
            self.assertEqual(data['private_key_names'], [])
            self.assertFalse(data['unrelated_present'])
            self.assertEqual(Path(data['models']), peer / '.cache/tina/tts')
            self.assertNotIn(token, result.stdout + result.stderr)
            (peer / 'tts.env.keys').write_text('DOTENV_PRIVATE_KEY=' + '1' * 64, encoding='utf-8')
            failed = subprocess.run([sys.executable, str(HERE / 'run.py'), '--', sys.executable, '-c', probe],
                env=env, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(failed.stdout, '')
            self.assertNotIn(token, failed.stderr)


if __name__ == '__main__':
    unittest.main()

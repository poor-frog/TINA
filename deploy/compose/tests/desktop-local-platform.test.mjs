import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSecretPath, protectIngestSecret } from '../bin/desktop-local-platform.mjs';

test('Windows secret uses LocalAppData and never guesses a macOS HOME path', () => {
  assert.equal(captureSecretPath('win32', 'C:\\Users\\Test\\AppData\\Local', 'ignored'),
    'C:\\Users\\Test\\AppData\\Local\\local.tina.capture\\desktop-ingest-token');
  assert.throws(() => captureSecretPath('win32', '', 'ignored'), /LOCALAPPDATA/);
});

test('macOS secret location and format stay compatible', () => {
  assert.equal(captureSecretPath('darwin', undefined, '/Users/test'),
    '/Users/test/Library/Application Support/local.tina.capture/desktop-ingest-token');
  assert.equal(protectIngestSecret('ab'.repeat(32), 'darwin'), 'ab'.repeat(32));
});

test('Windows protects the token for the current user instead of storing plaintext',
  { skip: process.platform !== 'win32' }, () => {
    const secret = 'ab'.repeat(32);
    const protectedSecret = protectIngestSecret(secret, 'win32');
    assert.match(protectedSecret, /^[a-f0-9]+$/i);
    assert.notEqual(protectedSecret, secret);
    assert.ok(protectedSecret.length > secret.length);
  });

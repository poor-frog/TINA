import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function captureSecretPath(platform = process.platform, localAppData = process.env.LOCALAPPDATA, home = homedir()) {
  if (platform === 'win32') {
    if (!localAppData || !win32.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute path');
    return win32.join(localAppData, 'local.tina.capture', 'desktop-ingest-token');
  }
  return posix.join(home, 'Library/Application Support/local.tina.capture/desktop-ingest-token');
}

export function protectIngestSecret(secret, platform = process.platform) {
  if (platform !== 'win32') return secret;
  // DPAPI binds this file to the interactive Windows user; no plaintext token enters argv.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); '
    + '$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); '
    + '[BitConverter]::ToString($protected).Replace("-","")'],
  { input: secret, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
}

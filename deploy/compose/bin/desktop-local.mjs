/** Host Desktop shares identity settings with the compose stack; secrets never go to clients. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { startDesktop } from '../../../core/meetings/services/desktop/dist/desktop.js';
import { startAuthenticatedIngestProxy } from '../../../core/meetings/services/desktop/dist/authenticated-ingest-proxy.js';
import { startDictationPolishProxy } from '../../../core/meetings/services/desktop/dist/dictation-polish-proxy.js';
import { captureSecretPath, protectIngestSecret } from './desktop-local-platform.mjs';

const env = parseEnv(readFileSync(process.env.ENV_FILE || new URL('../.env', import.meta.url), 'utf8'));
const secret = process.env.TINA_INTERNAL_API_SECRET || env.INTERNAL_API_SECRET;
if (!secret) throw new Error('Set INTERNAL_API_SECRET in deploy/compose/.env before starting Desktop');
if (secret.startsWith('encrypted:')) throw new Error('Decrypt the deployment config first or select a private plaintext ENV_FILE');
const ingestSecret = randomBytes(32).toString('hex');
const ingestSecretPath = captureSecretPath();
const captureDataDirectory = dirname(ingestSecretPath);
const storedIngestSecret = protectIngestSecret(ingestSecret);
const diarizationEnvPath = join(homedir(), '.config', 'tina', 'diarization.env');
const diarizationEnv = existsSync(diarizationEnvPath) ? parseEnv(readFileSync(diarizationEnvPath, 'utf8')) : {};
const diarizationToken = process.env.DIARIZATION_SERVICE_TOKEN || env.DIARIZATION_SERVICE_TOKEN || diarizationEnv.TINA_DIARIZATION_TOKEN || '';
let diarizationUrl = process.env.DIARIZATION_SERVICE_URL || env.DIARIZATION_SERVICE_URL || (diarizationToken ? 'http://127.0.0.1:18014' : '');
if (diarizationUrl) {
  const endpoint = new URL(diarizationUrl);
  if (endpoint.hostname === 'host.docker.internal') endpoint.hostname = '127.0.0.1';
  diarizationUrl = endpoint.toString().replace(/\/+$/, '');
}

const alignmentEnvPath = join(homedir(), '.config', 'tina', 'alignment.env');
const alignmentEnv = existsSync(alignmentEnvPath) ? parseEnv(readFileSync(alignmentEnvPath, 'utf8')) : {};
const alignmentToken = process.env.ALIGNMENT_SERVICE_TOKEN || env.ALIGNMENT_SERVICE_TOKEN || alignmentEnv.TINA_ALIGNMENT_TOKEN || '';
let alignmentUrl = process.env.ALIGNMENT_SERVICE_URL || env.ALIGNMENT_SERVICE_URL || (alignmentToken ? 'http://127.0.0.1:18015' : '');
if (alignmentUrl) {
  const endpoint = new URL(alignmentUrl);
  if (endpoint.hostname === 'host.docker.internal') endpoint.hostname = '127.0.0.1';
  alignmentUrl = endpoint.toString().replace(/\/+$/, '');
}

function removeIngestSecret() {
  try {
    if (readFileSync(ingestSecretPath, 'utf8') === storedIngestSecret) unlinkSync(ingestSecretPath);
  } catch {}
}

let txUrl = process.env.TINA_DESKTOP_TRANSCRIPTION_URL || process.env.TRANSCRIPTION_SERVICE_URL || env.TRANSCRIPTION_SERVICE_URL || '';
if (txUrl) {
  const endpoint = new URL(txUrl);
  if (endpoint.hostname === 'host.docker.internal') endpoint.hostname = '127.0.0.1';
  txUrl = endpoint.toString().replace(/\/+$/, '');
}
let initialMeetings = [];
if (process.env.TINA_DESKTOP_RESTORE_FILE) {
  initialMeetings = JSON.parse(readFileSync(process.env.TINA_DESKTOP_RESTORE_FILE, 'utf8')).meetings;
  if (!Array.isArray(initialMeetings) || initialMeetings.some(m => !Number.isSafeInteger(m.id) || m.id < 1
      || typeof m.platform !== 'string' || typeof m.native_meeting_id !== 'string'
      || typeof m.start_time !== 'string' || m.status !== 'completed' || !Array.isArray(m.segments))) {
    throw new Error('Restore file must contain exported, completed Desktop meetings');
  }
}
let desktop;
let authenticatedIngestProxy;
try {
  desktop = await startDesktop({
    ingestPort: 0,
    txUrl, txToken: process.env.TRANSCRIPTION_SERVICE_TOKEN || env.TRANSCRIPTION_SERVICE_TOKEN || '',
    txModel: process.env.TRANSCRIPTION_MODEL || env.TRANSCRIPTION_MODEL || 'whisper-1',
    recordingsDir: process.env.TINA_RECORDINGS_DIR || env.TINA_RECORDINGS_DIR
      || (process.platform === 'win32' ? join(captureDataDirectory, 'recordings') : undefined),
    initialMeetings,
    alignment: alignmentUrl ? { url: alignmentUrl, token: alignmentToken } : undefined,
    diarization: diarizationUrl ? { url: diarizationUrl, token: diarizationToken } : undefined,
    transcriptionSettings: {
      url: process.env.TINA_ADMIN_API_URL || `http://127.0.0.1:${env.ADMIN_API_PORT || 18057}`,
      secret, apiKey: process.env.TINA_DESKTOP_API_KEY || env.TINA_DESKTOP_API_KEY || '',
      deploymentUrl: process.env.TINA_DESKTOP_TRANSCRIPTION_URL || undefined,
    },
  });
  authenticatedIngestProxy = await startAuthenticatedIngestProxy({
    desktopPort: desktop.ingestPort,
    secret: ingestSecret,
    port: 9099,
  });
  mkdirSync(captureDataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(captureDataDirectory, 0o700);
  writeFileSync(ingestSecretPath, storedIngestSecret, { mode: 0o600 });
  chmodSync(ingestSecretPath, 0o600);
} catch (error) {
  removeIngestSecret();
  await authenticatedIngestProxy?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  throw error;
}
const dictationPolishProxy = await startDictationPolishProxy({
  gatewayUrl: process.env.TINA_GATEWAY_URL || env.TINA_GATEWAY_URL
    || `http://127.0.0.1:${env.API_GATEWAY_HOST_PORT || 18056}`,
  apiKey: process.env.TINA_DESKTOP_API_KEY || env.TINA_DESKTOP_API_KEY || '',
  port: 8057,
}).catch(error => {
  console.warn(`[desktop] dictation polish proxy unavailable: ${error instanceof Error ? error.message : error}`);
  return undefined;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  try {
    await Promise.all([desktop.close(), authenticatedIngestProxy?.close(), dictationPolishProxy?.close()]);
  } finally {
    removeIngestSecret();
    process.exit(0);
  }
});

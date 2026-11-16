import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { encodeAudioFrame } from '@tina/capture-codec';
import { startDesktop } from './desktop.js';
import { transcriptionResolver } from './transcription-settings.js';

const listen = async (server: Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = (server: Server) => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
const seen: string[] = [];
const stt = (name: string) => createServer(async (req, res) => {
  for await (const _ of req) { /* drain multipart */ }
  assert.equal(req.headers.authorization, 'Bearer service-only-secret');
  if (req.url === '/health') { res.writeHead(200); res.end('{}'); return; }
  seen.push(name);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: name, segments: [{ text: name, start: 0, end: 2.5 }] }));
});
const a = stt('first'), b = stt('second');
const aUrl = await listen(a), bUrl = await listen(b);
let selected = { backend: 'sherpa', url: aUrl };
let offline = false;
const received: string[] = [];
const identity = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  assert.equal(req.url, '/internal/transcription/resolve');
  assert.equal(req.headers['x-internal-secret'], 'identity-only-secret');
  const token = JSON.parse(body).token; received.push(token);
  res.setHeader('Content-Type', 'application/json');
  if (token === 'invalid') { res.writeHead(401); return res.end('{}'); }
  if (offline) { res.writeHead(503); return res.end('{}'); }
  res.end(JSON.stringify({ ...selected, token: 'service-only-secret', model: 'custom', summary: {
    label: selected.backend, source: token ? 'user' : 'platform',
  } }));
});
const identityUrl = await listen(identity);
const desk = await startDesktop({ statePath: ':memory:', ingestPort: 0, gatewayPort: 0, quiet: true,
  initialMeetings: [{ id: 40, platform: 'desktop', native_meeting_id: 'saved', status: 'completed', start_time: new Date().toISOString(), segments: [] }],
  txUrl: 'http://never-fallback.invalid', transcriptionSettings: { url: identityUrl, secret: 'identity-only-secret' } });
const sockets: WebSocket[] = [];
const open = (id: string, token = '') => new Promise<{ ws: WebSocket; frame: any }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${desk.ingestPort}/ingest?platform=desktop&native_meeting_id=${id}&api_key=${token}`);
  sockets.push(ws); ws.on('error', reject);
  ws.once('message', bytes => resolve({ ws, frame: JSON.parse(bytes.toString()) }));
});
const base = `http://127.0.0.1:${desk.gatewayPort}`;
try {
  const preview = await (await fetch(`${base}/transcription/config`, { headers: { 'X-API-Key': 'owner-key' } })).json() as any;
  assert.equal(preview.backend, 'sherpa'); assert.equal(preview.source, 'user');
  assert.ok(!JSON.stringify(preview).includes('secret')); assert.ok(!JSON.stringify(preview).includes(aUrl));
  const first = await open('first', 'owner-key');
  assert.equal(first.frame.type, 'ready'); assert.equal(first.frame.meeting_id, 41);
  assert.equal((await (await fetch(`${base}/transcripts/desktop/saved`)).json() as any).id, 40); assert.equal(first.frame.transcription.backend, 'sherpa');
  assert.ok(!JSON.stringify(first.frame).includes('secret'));
  selected = { backend: 'funasr', url: bUrl };
  const second = await open('second');
  assert.equal(second.frame.transcription.backend, 'funasr'); assert.equal(second.frame.transcription.source, 'platform');
  const existing = await (await fetch(`${base}/transcripts/desktop/first`)).json() as any;
  assert.equal(existing.transcription.backend, 'sherpa', 'saving settings cannot change the running session');
  const pcm = Float32Array.from({ length: 48000 }, (_, i) => 0.1 * Math.sin(i * 0.05));
  first.ws.send(Buffer.from(encodeAudioFrame(1000, Date.now(), pcm, 'You')));
  second.ws.send(Buffer.from(encodeAudioFrame(1000, Date.now(), pcm, 'You')));
  for (const id of ['first', 'second']) {
    await fetch(`${base}/extension/sessions/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'desktop', native_meeting_id: id }) });
  }
  assert.ok(seen.includes('first') && seen.includes('second'), 'audio must reach each pinned STT endpoint');
  selected = { backend: 'viegem', url: bUrl };
  const viegem = await open('managed-viegem');
  assert.equal(viegem.frame.transcription.backend, 'viegem');
  assert.ok(!JSON.stringify(viegem.frame).includes('secret'));
  await fetch(`${base}/extension/sessions/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'desktop', native_meeting_id: 'managed-viegem' }) });
  const denied = await open('denied', 'invalid'); assert.equal(denied.frame.type, 'error');
  const deniedMeeting = await (await fetch(`${base}/transcripts/desktop/denied`)).json() as any;
  assert.equal(deniedMeeting.id, 0, 'authentication failure must not create a meeting');
  offline = true;
  assert.equal((await fetch(`${base}/transcription/config`)).status, 503, 'settings outage must not select another backend');
  offline = false;
  const resolve = transcriptionResolver({ url: aUrl, token: '', model: 'env-model' },
    { url: identityUrl, secret: 'identity-only-secret', apiKey: 'bound-owner' });
  await resolve(); assert.equal(received.at(-1), 'bound-owner');
  await resolve('extension-owner'); assert.equal(received.at(-1), 'extension-owner');
  selected = { backend: 'funasr', url: 'http://127.0.0.1:1' };
  const unavailable = await open('unavailable');
  assert.equal(unavailable.frame.type, 'error'); assert.match(unavailable.frame.message, /not ready/);
  assert.equal((await (await fetch(`${base}/transcripts/desktop/unavailable`)).json() as any).id, 0);
  assert.equal((await (await fetch(`${base}/health`)).json() as any).checks.stt_url, null);
  selected = { backend: 'sherpa', url: 'http://host.docker.internal:18001' };
  assert.equal((await resolve()).url, 'http://127.0.0.1:18001');
  const hostResolve = transcriptionResolver({ url: aUrl, token: '', model: 'env-model' },
    { url: identityUrl, secret: 'identity-only-secret', deploymentUrl: bUrl });
  selected = { backend: 'deployment', url: 'http://transcription-api' };
  assert.equal((await hostResolve()).url, bUrl, 'host override maps only the deployment backend');
  selected = { backend: 'custom', url: aUrl };
  assert.equal((await hostResolve()).url, aUrl, 'personal/custom endpoints are never replaced');
  console.log('PASS: central ASR selection, personal/global identity, pinned audio routing, safe metadata, and fail-closed lookup');
} finally {
  for (const ws of sockets) ws.terminate();
  await desk.close(); await close(identity); await close(a); await close(b);
}

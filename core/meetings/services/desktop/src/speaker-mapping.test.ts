import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WebSocket } from 'ws';
import type { TranscriptSegment } from '@tina/gmeet-pipeline';
import { startDesktop, type Meeting } from './desktop.js';
import { TranscriptJournal, RevisionConflict } from './transcript-journal.js';
import { attributedVoice, emptySpeakers, observeSpeakers, renameSpeaker, stableUuid } from './speaker-registry.js';
import { diarizationInput, validateDiarization } from './speaker-diarization.js';
import { transcriptReviewPage } from './transcript-review.js';

const epoch = 1800000000000;
const segment = (id: string, channel: number, start: number, end: number, text: string, speaker = 'Alice'): TranscriptSegment => ({
  segment_id: id, speaker_key: `ch-${channel}:${id}`, speaker, text, start: epoch / 1000 + start,
  end: epoch / 1000 + end, completed: true, source: 'glow-bound', confidence: 1,
});
const example = (): Meeting => ({ id: 1, platform: 'desktop', native_meeting_id: 'speaker-test', status: 'completed',
  start_time: new Date(epoch).toISOString(), segments: [
    segment('local-one', 1000, 0, 1, 'Tôi sẽ gửi báo cáo trước thứ Sáu.', 'You'),
    segment('local-two', 1000, 1, 2, 'Currently the service is ready.', 'You'),
    segment('remote-one', 999, 0, 1, 'First remote sentence.'),
    segment('remote-two', 999, 1, 2, 'We agreed to ship the update.'),
    segment('overlap', 999, 2, 3, 'Two simultaneous voices.'),
    segment('historical-raw-mic', 1002, 0, 1, 'I will never use raw sidecar text as memory evidence.'),
    { ...segment('unfinished', 999, 3, 4, 'I will not finalize this draft.'), completed: false },
  ] });
const key = 'desktop/speaker-test';
const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
const validate = (name: string, value: unknown) => {
  const schema = JSON.parse(readFileSync(new URL(`../../../contracts/${name}.v1/${name}.schema.json`, import.meta.url), 'utf8'));
  const check = ajv.getSchema(schema.$id) || ajv.compile(schema);
  assert(check(value), JSON.stringify(check.errors));
};

assert.match(stableUuid('sample'), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const observed = emptySpeakers(), meeting = example();
observeSpeakers(observed, meeting, [...meeting.segments, segment('raw-sidecar', 1002, 0, 1, 'Never evidence')]);
assert.equal(observed.segments['local-one'].speaker_id, observed.segments['local-two'].speaker_id);
assert.notEqual(observed.segments['remote-one'].speaker_id, observed.segments['remote-two'].speaker_id, 'same mixed-track label never proves the same person');
assert(!observed.segments['raw-sidecar']);
const meet = { ...meeting, platform: 'google_meet' }, participants = emptySpeakers();
observeSpeakers(participants, meet, [
  { ...segment('p1', 2, 0, 1, 'a'), participant_id: 'person-a' },
  { ...segment('p2', 3, 1, 2, 'b'), participant_id: 'person-a' },
  { ...segment('p3', 4, 2, 3, 'c'), participant_id: 'person-b' },
]);
assert.equal(participants.segments.p1.speaker_id, participants.segments.p2.speaker_id);
assert.notEqual(participants.segments.p1.speaker_id, participants.segments.p3.speaker_id, 'same display name cannot merge distinct participant IDs');
const confirmedPerson = participants.segments.p1.speaker_id;
renameSpeaker(participants, confirmedPerson, 1, 'Lan');
observeSpeakers(participants, meet, [{ ...segment('p1', 2, 0, 1, 'a'), participant_id: 'late-different-participant' }]);
assert.equal(participants.segments.p1.speaker_id, confirmedPerson, 'late participant metadata cannot move an owner-confirmed identity');
assert.equal(attributedVoice(0, 1000, [{ start_ms: 0, end_ms: 1000, speaker: 1 }]), 1);
assert.equal(attributedVoice(0, 1000, [{ start_ms: 0, end_ms: 1000, speaker: 1 }, { start_ms: 0, end_ms: 1000, speaker: 2 }]), null);
assert.equal(attributedVoice(0, 400, [{ start_ms: 0, end_ms: 400, speaker: 1 }]), null);

const directory = mkdtempSync(join(tmpdir(), 'tina-speakers-')), database = join(directory, 'transcripts.sqlite');
let journal = new TranscriptJournal(database);
try {
  journal.save(meeting);
  const session = journal.captureSession(key, 'source-session');
  journal.receivePcm(key, session, 999, 0, epoch, new Float32Array(48000).fill(.1), 'System audio');
  journal.receivePcm(key, session, 1000, 0, epoch, new Float32Array(48000).fill(.2), 'You');
  journal.receivePcm(key, session, 1002, 0, epoch, new Float32Array(48000).fill(.5), 'You (raw)');
  const local = journal.speakerState(key).segments['local-one'].speaker_id;
  journal.renameSpeaker(meeting, local, 1, 'Lan');
  assert.throws(() => journal.renameSpeaker(meeting, local, 1, 'Stale'), RevisionConflict);
  journal.correct(key, meeting.segments[0], 0, 'Tôi sẽ gửi bản sửa trước thứ Sáu.');
  const canonical = journal.canonical(meeting), memory: any = journal.memory(meeting);
  validate('canonical-transcript', canonical); validate('meeting-memory', memory); validate('stt-foundation', journal.foundation(meeting));
  assert.equal(canonical.segments[0].speaker_name, 'Lan');
  assert(!canonical.segments.some(s => s.segment_id === 'historical-raw-mic'));
  assert(!canonical.segments.some(s => s.segment_id === 'unfinished'), 'drafts never become canonical or memory evidence');
  assert.equal(canonical.segments[0].revision, 1); assert.equal(canonical.segments[0].raw_text, meeting.segments[0].text);
  assert(memory.facts.some((fact: any) => fact.evidence[0].speaker_name === 'Lan'));
  assert(memory.facts.every((fact: any) => fact.assignee_id === null));
  for (const event of journal.pendingRevisions()) {
    if (event.event.type === 'speaker.revised') { validate('speaker-revision', event.event); assert(!('name' in event.event) && !('text' in event.event)); }
  }
  const input = diarizationInput(journal, key);
  assert.equal(input.audio.readUInt16LE(34), 16); assert.equal(input.duration_ms, 3000);
  assert.equal(input.audio.readInt16LE(44), Math.round(.1 * 32767), 'only system audio reaches the worker');
  assert.throws(() => validateDiarization({ model: 'x', audio_sha256: 'bad', duration_ms: 3000, turns: [] }, input.audio, 3000));
  assert.throws(() => validateDiarization({ model: 'x', audio_sha256: createHash('sha256').update(input.audio).digest('hex'), duration_ms: NaN, turns: [] }, input.audio, 3000));
  journal.close(); journal = new TranscriptJournal(database);
  assert.equal(journal.speakerState(key).segments['local-one'].speaker_id, local);
  assert.equal(journal.canonical(meeting).revision, canonical.revision, 'projection and speaker IDs survive restart');
  (journal as any).db.exec("CREATE TRIGGER fail_speaker_outbox BEFORE INSERT ON transcript_outbox BEGIN SELECT RAISE(ABORT,'outbox failed'); END");
  assert.throws(() => journal.renameSpeaker(meeting, local, 2, 'Must roll back'));
  assert.equal(journal.speakerState(key).speakers[local].name, 'Lan');
  (journal as any).db.exec('DROP TRIGGER fail_speaker_outbox');
} finally { journal.close(); }

let invalid = false, held = false, release: (() => void) | undefined, calls = 0;
const worker = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer private-worker-token');
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks), start = body.indexOf(Buffer.from('RIFF'));
  assert(start >= 0); const audio = body.subarray(start, start + 44 + body.readUInt32LE(start + 40));
  calls++;
  if (held) await new Promise<void>(resolve => { release = resolve; });
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ model: 'fixture-worker-v1', audio_sha256: invalid ? '0'.repeat(64) : createHash('sha256').update(audio).digest('hex'), duration_ms: (audio.length - 44) / 32,
    turns: [{ start_ms: 0, end_ms: 1000, speaker: 0 }, { start_ms: 1000, end_ms: 3000, speaker: 1 }, { start_ms: 2000, end_ms: 3000, speaker: 0 }] }));
});
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
const desktop = await startDesktop({ ingestPort: 0, gatewayPort: 0, recordingsDir: directory, statePath: database, quiet: true, txUrl: '',
  canAccess: subject => subject !== 'denied', diarization: { url: `http://127.0.0.1:${(worker.address() as any).port}`, token: 'private-worker-token' } });
const base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/speaker-test`;
const request = async (path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) => {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
async function finished() {
  for (let i = 0; i < 200; i++) { const response = await request('/diarization'); if (response.body.job?.status !== 'running') return response.body.job; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Speaker analysis did not finish');
}
const socket = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws`), denied = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws?api_key=denied`);
const received: any[] = [], leaked: any[] = [];
socket.on('message', value => received.push(JSON.parse(String(value)))); denied.on('message', value => leaked.push(JSON.parse(String(value))));
try {
  await Promise.all([once(socket, 'open'), once(denied, 'open')]);
  for (const client of [socket, denied]) client.send(JSON.stringify({ action: 'subscribe', meetings: [{ platform: 'desktop', native_id: 'speaker-test' }] }));
  assert.equal((await request('/speakers', 'GET', undefined, { 'X-API-Key': 'denied' })).status, 403);
  assert.equal((await request('/memory', 'GET', undefined, { 'X-API-Key': 'denied' })).status, 403);
  assert.equal((await request('/speakers/assign', 'POST', {}, { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await request('/diarization/start', 'POST', { num_speakers: 0 })).status, 422);
  held = true;
  let started = await request('/diarization/start', 'POST', { num_speakers: 2 }); assert.equal(started.status, 202);
  while (!release) await new Promise(r => setTimeout(r, 5));
  const edited = await request('/segments/remote-two', 'PATCH', { expected_revision: 0, text: 'We agreed to ship the corrected update.' }); assert.equal(edited.status, 200);
  held = false; release!(); release = undefined;
  let job = await finished(); assert.equal(job.status, 'completed');
  assert.equal((await request('/diarization/apply', 'POST', { job_id: job.id })).status, 409, 'delayed worker cannot overwrite revisions');
  let registry = (await request('/speakers')).body;
  const protectedId = registry.segments['remote-one'].speaker_id;
  assert.equal((await request('/speakers/' + protectedId, 'PATCH', { expected_revision: 1, name: null })).status, 200);
  started = await request('/diarization/start', 'POST', {}); assert.equal(started.status, 202); job = await finished();
  assert.deepEqual(job.items.map((item: any) => item.cluster), [0, 1, null]);
  assert.equal((await request('/diarization/apply', 'POST', { job_id: job.id })).status, 200);
  assert.equal((await request('/diarization/apply', 'POST', { job_id: job.id })).status, 200, 'Apply retry is idempotent');
  registry = (await request('/speakers')).body;
  assert.equal(registry.segments['remote-one'].speaker_id, protectedId, 'manual unknown is protected');
  const previousVoice = registry.segments['remote-two'].speaker_id;
  await request('/diarization/start', 'POST', { num_speakers: 2 }); job = await finished();
  assert.equal((await request('/diarization/apply', 'POST', { job_id: job.id })).status, 200);
  registry = (await request('/speakers')).body;
  assert.notEqual(registry.segments['remote-two'].speaker_id, previousVoice, 'changed analysis settings cannot silently reuse a named acoustic identity');
  const voice = registry.segments['remote-two'].speaker_id, entry = registry.speakers.find((s: any) => s.speaker_id === voice);
  assert.equal(entry.source, 'diarization'); assert.equal(entry.name, null);
  assert.equal((await request('/speakers/' + voice, 'PATCH', { expected_revision: entry.revision, name: 'An' })).status, 200);
  assert.equal((await request('/speakers/' + voice, 'PATCH', { expected_revision: entry.revision, name: 'Stale' })).status, 409);
  registry = (await request('/speakers')).body;
  const renamedRevision = registry.speakers.find((s: any) => s.speaker_id === voice).revision;
  assert.equal((await request('/speakers/assign', 'POST', { expected_revision: registry.revision, segment_id: 'overlap', speaker_id: voice })).status, 200);
  assert.equal((await request('/speakers/assign', 'POST', { expected_revision: registry.revision, segment_id: 'overlap', speaker_id: null })).status, 409);
  const canonical = (await request('/canonical')).body, memory = (await request('/memory')).body;
  validate('canonical-transcript', canonical); validate('meeting-memory', memory); validate('stt-foundation', (await request('/foundation')).body);
  assert.equal(canonical.segments.find((s: any) => s.segment_id === 'remote-two').speaker_name, 'An');
  assert.equal(canonical.segments.find((s: any) => s.segment_id === 'remote-two').revision, 1);
  assert(memory.facts.some((f: any) => f.evidence.some((e: any) => e.segment_id === 'remote-two' && e.speaker_name === 'An')));
  const renamedEvent = () => received.some(e => e.type === 'speaker.revised' && e.speaker_id === voice && e.revision === renamedRevision);
  const renamedTranscript = () => received.some(e => e.type === 'transcript' && !('pending' in e)
    && e.confirmed.some((s: any) => s.speaker === 'An'));
  for (let i = 0; i < 100 && (!renamedEvent() || !renamedTranscript()); i++) await new Promise(r => setTimeout(r, 10));
  const event = received.find(e => e.type === 'speaker.revised' && e.speaker_id === voice && e.revision === renamedRevision);
  assert(event); validate('speaker-revision', event);
  assert(!('name' in event) && !('text' in event));
  assert(renamedTranscript());
  assert(!leaked.some(e => e.type === 'speaker.revised' || e.type === 'transcript'), 'denied subscribers receive no identities or transcript');
  for (const id of ['remote-two', 'overlap']) {
    registry = (await request('/speakers')).body;
    assert.equal((await request('/speakers/assign', 'POST', { expected_revision: registry.revision, segment_id: id, speaker_id: null })).status, 200);
  }
  registry = (await request('/speakers')).body;
  assert(registry.speakers.some((s: any) => s.speaker_id === voice && s.name === 'An' && s.segment_count === 0), 'confirmed identities remain available for reassignment');
  assert.equal((await request('/speakers/assign', 'POST', { expected_revision: registry.revision, segment_id: 'remote-two', speaker_id: voice })).status, 200);
  const before = JSON.stringify((await request('/speakers')).body);
  invalid = true; await request('/diarization/start', 'POST', {}); job = await finished(); assert.equal(job.status, 'failed');
  assert.equal(JSON.stringify((await request('/speakers')).body), before);
  invalid = false; held = true; await request('/diarization/start', 'POST', {});
  while (!release) await new Promise(r => setTimeout(r, 5));
  await request('/diarization/cancel', 'POST', {}); held = false; release!(); release = undefined;
  assert.equal((await finished()).status, 'cancelled');
  assert.equal(JSON.stringify((await request('/speakers')).body), before);
  const html = transcriptReviewPage('/transcripts/desktop/speaker-test');
  new Function(html.match(/<script>([\s\S]*)<\/script>/)![1]);
  assert(html.includes('Speaker identities') && html.includes('Meeting memory candidates'));
  console.log(`PASS speaker mapping: stable local/participant IDs, unknown mixed voices, CAS, raw preservation, restart, canonical/memory contracts, worker provenance, Apply, ACL, outbox, cancellation (${calls} isolated worker calls)`);
} finally {
  release?.(); socket.terminate(); denied.terminate(); await desktop.close();
  worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}

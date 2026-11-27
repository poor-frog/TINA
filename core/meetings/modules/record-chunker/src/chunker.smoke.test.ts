/**
 * chunker.smoke — the MediaRecorder loop in isolation (no browser).
 *
 * record-chunker is the pure-logic recording brick: it wraps a MediaRecorder over
 * a combined audio stream and emits recording.v1 chunks (base64 + chunkSeq + isFinal
 * + mimeType). This test stubs the four browser globals it touches (MediaRecorder,
 * AudioContext-free path via direct MediaRecorderChunker, btoa, window/logBot) and
 * drives the REAL class to prove the contract the server reconciler depends on:
 *   1. chunkSeq increments monotonically from 0 across timeslice chunks;
 *   2. each chunk's base64 is the base64 of the blob body (round-trips);
 *   3. mimeType is the negotiated supported type;
 *   4. stop() emits exactly one extra chunk with isFinal=true (empty body OK)
 *      and resolves only AFTER that final onChunk completes.
 *
 * No assertion lib — same shape as mixed/pipeline's *.smoke.test.ts (tsx + exit code).
 */

// ── minimal browser-global stubs (installed before importing the brick) ─────────
const enc = (s: string): string => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).btoa = (s: string) => enc(s);
// the brick reads isTypeSupported off window.MediaRecorder, so the stub must live there too.
(globalThis as any).window = { logBot: (_m: string) => {} };

/** A fake Blob whose arrayBuffer() yields the bytes we seeded. */
class FakeBlob {
  constructor(private bytes: Uint8Array) {}
  get size() { return this.bytes.length; }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

/** A fake MediaRecorder that lets the test fire ondataavailable / stop on demand. */
class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  constructor(_stream: any, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; }
  start(_timeslice?: number) { this.state = 'recording'; this.onstart?.(); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  /** test helper — deliver a timeslice blob */
  emit(bytes: Uint8Array) { this.ondataavailable?.({ data: new FakeBlob(bytes) }); }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder; // brick reads window.MediaRecorder.isTypeSupported

// import AFTER globals exist (the module reads window/MediaRecorder lazily at runtime)
import { MediaRecorderChunker, createRecordingTap, type RecordingChunk } from './index';

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  const got: RecordingChunk[] = [];
  let started = 0;
  const chunker = new MediaRecorderChunker({
    stream: {} as any, // unused by the FakeMediaRecorder
    timesliceMs: 1000,
    onChunk: async (c) => { got.push(c); return true; },
    onStarted: () => { started++; },
  });

  await chunker.start();
  const mr = chunker.getMediaRecorder() as unknown as FakeMediaRecorder;
  if (!mr) { console.log('❌ FAIL — start() did not create a MediaRecorder'); process.exit(1); }

  // two timeslice chunks with distinct bodies
  const body0 = new Uint8Array([1, 2, 3, 4, 250, 0, 127]);
  const body1 = new Uint8Array([9, 8, 7]);
  mr.emit(body0);
  mr.emit(body1);
  // let the async ondataavailable handlers settle
  await new Promise((r) => setTimeout(r, 10));

  await chunker.stop(); // → onstop → final chunk

  // ── assertions ────────────────────────────────────────────────────────────────
  const fails: string[] = [];
  if (started !== 1) fails.push(`onStarted fired ${started}× (want 1)`);
  if (got.length !== 3) fails.push(`emitted ${got.length} chunks (want 3: 2 data + 1 final)`);

  const [c0, c1, cF] = got;
  if (c0) {
    if (c0.chunkSeq !== 0) fails.push(`chunk0 seq=${c0.chunkSeq} (want 0)`);
    if (c0.isFinal) fails.push('chunk0 isFinal=true (want false)');
    if (!eqBytes(decode(c0.base64), body0)) fails.push('chunk0 base64 did not round-trip body0');
    if (c0.mimeType !== 'audio/webm;codecs=opus') fails.push(`chunk0 mimeType=${c0.mimeType} (want negotiated opus)`);
  }
  if (c1) {
    if (c1.chunkSeq !== 1) fails.push(`chunk1 seq=${c1.chunkSeq} (want 1)`);
    if (!eqBytes(decode(c1.base64), body1)) fails.push('chunk1 base64 did not round-trip body1');
  }
  if (cF) {
    if (cF.chunkSeq !== 2) fails.push(`final seq=${cF.chunkSeq} (want 2)`);
    if (!cF.isFinal) fails.push('final chunk isFinal=false (want true)');
    if (cF.base64 !== '') fails.push(`final chunk body=${JSON.stringify(cF.base64)} (want empty)`);
  }

  console.log(`chunks: ${JSON.stringify(got.map((c) => ({ seq: c.chunkSeq, final: c.isFinal, bytes: decode(c.base64).length })))}`);
  if (fails.length) {
    console.log('❌ FAIL — ' + fails.join('; '));
    process.exit(1);
  }
  console.log('✅ PASS — seq increments 0,1, bodies round-trip base64, final chunk isFinal=true(empty), mimeType negotiated');

  // ── dynamic late-stream attachment (Meet stream 3 mid-meeting regression) ──────
  class FakeTrack {
    endedListeners: (() => void)[] = [];
    stopped = false;
    addEventListener(ev: string, fn: () => void) { if (ev === 'ended') this.endedListeners.push(fn); }
    stop() { this.stopped = true; }
    fireEnded() { for (const fn of this.endedListeners) fn(); }
  }
  class FakeMediaStream {
    constructor(public id: string, private tracks: FakeTrack[] = [new FakeTrack()]) {}
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }
  (globalThis as any).MediaStream = FakeMediaStream;

  const attachedIds: string[] = [];
  let disconnectedCount = 0;
  let ctxClosed = false;
  (globalThis as any).AudioContext = class FakeAudioContext {
    createMediaStreamDestination() { return { stream: new FakeMediaStream('dest-mix') }; }
    createMediaStreamSource(s: FakeMediaStream) {
      attachedIds.push(s.id);
      return {
        connect(_dest: any) {},
        disconnect() { disconnectedCount++; },
      };
    }
    async close() { ctxClosed = true; }
  };

  const track0 = new FakeTrack();
  const els: any[] = [{ paused: false, srcObject: new FakeMediaStream('stream-0', [track0]) }];
  (globalThis as any).document = { querySelectorAll: () => els };

  const tapChunks: RecordingChunk[] = [];
  const tap = createRecordingTap({
    timesliceMs: 1000,
    rescanMs: 25,
    onChunk: async (c) => { tapChunks.push(c); return true; },
  });
  await tap.start();
  if (attachedIds.length !== 1 || attachedIds[0] !== 'stream-0') {
    console.log('❌ FAIL — initial stream not attached:', attachedIds);
    process.exit(1);
  }

  // Simulate Google Meet spawning a new remote audio stream mid-meeting (stream 3).
  els.push({ paused: false, srcObject: new FakeMediaStream('stream-3') });
  await new Promise((r) => setTimeout(r, 70));
  if (!attachedIds.includes('stream-3')) {
    console.log('❌ FAIL — late stream-3 was not dynamically attached:', attachedIds);
    process.exit(1);
  }
  // Duplicate rescan ticks must not double-attach the same stream.
  const countBefore = attachedIds.length;
  await new Promise((r) => setTimeout(r, 60));
  if (attachedIds.length !== countBefore) {
    console.log('❌ FAIL — duplicate attachment detected:', attachedIds);
    process.exit(1);
  }
  // Ended stream can reconnect if recycled.
  track0.fireEnded();
  await new Promise((r) => setTimeout(r, 50));
  if (attachedIds.filter((id) => id === 'stream-0').length !== 2) {
    console.log('❌ FAIL — ended stream did not reconnect on rescan:', attachedIds);
    process.exit(1);
  }

  await tap.stop();
  if (!ctxClosed || disconnectedCount < 2) {
    console.log('❌ FAIL — tap.stop() did not clean up AudioContext/sources');
    process.exit(1);
  }
  console.log('✅ PASS — createRecordingTap dynamically attaches late streams, deduplicates, reconnects ended tracks, and cleans up');
  process.exit(0);
}

main().catch((e) => { console.error('❌ FAIL —', e?.message || e); process.exit(1); });

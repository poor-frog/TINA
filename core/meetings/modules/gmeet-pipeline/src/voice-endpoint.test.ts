import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createGmeetPipeline, type VoiceHypothesis } from './gmeet-pipeline.js';
import { setLogger } from './log.js';
setLogger(() => {});
const epoch = 1800000000000;
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(hold = false) {
  const requests: number[] = [], hypotheses: VoiceHypothesis[] = [], texts: string[] = [];
  const pending: Array<() => void> = [];
  let active = 0, maxActive = 0, sample = 0;
  const pipe = createGmeetPipeline({ config: { submitInterval: 2 },
    transcribe: async pcm => {
      requests.push(pcm.length); maxActive = Math.max(maxActive, ++active);
      if (hold) await new Promise<void>(resolve => pending.push(resolve));
      active--;
      return { text: 'TINA ơi hỏi demo', segments: [{ text: 'TINA ơi hỏi demo', start: 0, end: pcm.length / 16000 }] };
    }, onHypothesis: h => hypotheses.push(h),
    sink: { segment: s => texts.push(s.text), finalize() {} } });
  return { pipe, requests, hypotheses, texts, pending, maxActive: () => maxActive,
    feed(ms: number, channel = 0) { pipe.feedAudio(channel, 'Speaker', new Float32Array(ms * 16).fill(.1), epoch + sample / 16, null, sample); sample += ms * 16; } };
}

test('VAD submits a short call before cadence/minimum; duplicate endpoints reuse the same request', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture();
  try {
    f.feed(600); mock.timers.tick(1400);
    assert.equal(f.requests.length, 0);
    f.pipe.requestEndpoint(0, epoch + 600); f.pipe.requestEndpoint(0, epoch + 600);
    await tick();
    assert.deepEqual(f.requests, [9600]); assert.equal(f.hypotheses[0].final, true);
    assert.equal(f.hypotheses[0].startMs, epoch); assert.equal(f.hypotheses[0].endMs, epoch + 600);
    assert.equal(f.hypotheses[0].asrCompletedAtMs, epoch + 1400);
    await f.pipe.dispose(); assert.deepEqual(f.texts, ['TINA ơi hỏi demo']); assert.equal(f.requests.length, 1);
  } finally { await f.pipe.dispose(); mock.timers.reset(); }
});

test('voice endpoints follow the capture clock when it drifts from indexed audio time', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const hypotheses: VoiceHypothesis[] = [];
  const archived: Array<{captureMs: number; sourceCaptureMs: number}> = [];
  const submitted: Float32Array[] = [];
  const pipe = createGmeetPipeline({
    config: { submitInterval: 100 },
    onAudioFrame: frame => archived.push(frame),
    onHypothesis: value => hypotheses.push(value),
    transcribe: async pcm => {
      submitted.push(pcm);
      return { text: 'TINA ơi hỏi demo', segments: [{ text: 'TINA ơi hỏi demo', start: 0, end: pcm.length / 16000 }] };
    },
    sink: { segment() {}, finalize() {} },
  });
  const samples = new Float32Array(1024).fill(.1);
  try {
    for (let frame = 0; frame < 20; frame++) {
      pipe.feedAudio(0, 'Speaker', samples, epoch + frame * 64 + frame * .5, null, frame * samples.length);
    }
    mock.timers.tick(2000);
    const speechEnd = epoch + 20 * 64 + 19 * .5;
    pipe.requestEndpoint(0, speechEnd);
    await tick();
    assert.equal(hypotheses.at(-1)?.final, true, 'fresh captured speech must reach the VAD endpoint');
    assert.equal(hypotheses.at(-1)?.endMs, speechEnd);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].length, samples.length * 20, 'clock correlation preserves every audio sample');
    assert.equal(archived.at(-1)?.captureMs, epoch + 19 * 64, 'the indexed archive retains its source-local clock');
    assert.equal(archived.at(-1)?.sourceCaptureMs, epoch + 19 * 64 + 19 * .5);
  } finally { await pipe.dispose(); mock.timers.reset(); }
});

test('an already running request covering speech end is reused without parallel or duplicate ASR', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture(true);
  try {
    f.feed(2100); mock.timers.tick(2100); assert.equal(f.requests.length, 1);
    f.pipe.requestEndpoint(0, epoch + 2100); f.pipe.requestEndpoint(0, epoch + 2100);
    assert.equal(f.requests.length, 1); f.pending.shift()!(); await tick();
    assert.equal(f.requests.length, 1); assert.equal(f.hypotheses[0].final, true);
    await f.pipe.dispose(); assert.equal(f.maxActive(), 1); assert.deepEqual(f.texts, ['TINA ơi hỏi demo']);
  } finally { mock.timers.reset(); }
});

test('a completed ASR result is promoted locally without requesting the same audio again', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture();
  try {
    f.feed(2100); mock.timers.tick(2100); await tick(); assert.equal(f.hypotheses[0].final, false);
    f.pipe.requestEndpoint(0, epoch + 2100); await tick();
    assert.equal(f.requests.length, 1); assert.equal(f.hypotheses.at(-1)?.final, true);
    assert.equal(f.hypotheses[0].text, f.hypotheses.at(-1)?.text);
    await f.pipe.dispose();
  } finally { mock.timers.reset(); }
});

test('a missing tail waits for the current request then submits once; every captured sample is retained', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture(true);
  try {
    f.feed(2100); mock.timers.tick(2100);
    f.feed(600); mock.timers.tick(600); f.pipe.requestEndpoint(0, epoch + 2700);
    assert.equal(f.requests.length, 1); f.pending.shift()!(); await tick();
    assert.deepEqual(f.requests, [33600, 43200]); assert.equal(f.hypotheses[0].final, false);
    f.pending.shift()!(); await tick(); assert.equal(f.hypotheses.at(-1)?.final, true);
    assert.equal(f.maxActive(), 1); await f.pipe.dispose(); assert.equal(f.requests.length, 2);
  } finally { mock.timers.reset(); }
});

test('new speech while endpoint ASR is pending prevents premature voice finalization and keeps its audio', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture(true);
  try {
    f.feed(600); mock.timers.tick(1400); f.pipe.requestEndpoint(0, epoch + 600);
    f.feed(700); f.pipe.requestEndpoint(0, null); f.pending.shift()!(); await tick();
    assert.equal(f.hypotheses[0].final, false); assert.equal(f.requests.length, 1);
    f.pipe.requestEndpoint(0, epoch + 1300); assert.equal(f.requests.length, 2);
    f.pending.shift()!(); await tick(); assert.equal(f.hypotheses.at(-1)?.endMs, epoch + 1300);
    await f.pipe.dispose(); assert.equal(f.requests.length, 2);
  } finally { mock.timers.reset(); }
});

test('background sound above the PCM retention floor does not override the VAD speech endpoint', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture();
  try {
    f.feed(600);
    f.pipe.feedAudio(0, 'Speaker', new Float32Array(12800).fill(.001), epoch + 600, null, 9600);
    mock.timers.tick(1400); f.pipe.requestEndpoint(0, epoch + 600); await tick();
    assert.equal(f.requests.length, 1); assert.equal(f.hypotheses[0].final, true);
    await f.pipe.dispose();
  } finally { mock.timers.reset(); }
});

test('late endpoints cannot target a new speaker through its pre-roll or another channel', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const f = fixture();
  try {
    f.feed(600);
    f.pipe.feedAudio(0, 'Other speaker', new Float32Array(9600).fill(.1), epoch + 600, 'other', 9600);
    await tick(); assert.equal(f.requests.length, 1, 'rotation closes only the old turn');
    f.pipe.requestEndpoint(1, epoch + 1200); f.pipe.requestEndpoint(0, epoch + 500);
    f.pipe.requestEndpoint(0, NaN); f.pipe.requestEndpoint(0, epoch + 10000);
    assert.equal(f.requests.length, 1);
    mock.timers.tick(1200); f.pipe.requestEndpoint(0, epoch + 1200); await tick();
    assert.equal(f.requests.length, 2); assert.equal(f.hypotheses.at(-1)?.speakerKey, 'ch-0:2');
    await f.pipe.dispose();
  } finally { mock.timers.reset(); }
});

test('voice onset excludes pre-roll while the original ASR source span remains intact', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch + 2000 });
  const f = fixture();
  try {
    f.pipe.feedAudio(0, undefined, new Float32Array(3200), epoch + 1900, null, 0);
    f.pipe.feedAudio(0, 'Speaker', new Float32Array(9600).fill(.1), epoch + 2100, null, 3200);
    mock.timers.tick(1500); f.pipe.requestEndpoint(0, epoch + 2700); await tick();
    assert.equal(f.hypotheses[0].startMs, epoch + 1900);
    assert.equal(f.hypotheses[0].speechStartMs, epoch + 2100);
    await f.pipe.dispose();
  } finally { mock.timers.reset(); }
});

test('buffer reset fences late ASR before any voice observer sees it', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch });
  const observed: VoiceHypothesis[] = [];
  let resolve!: (value: {text: string}) => void, calls = 0;
  const pipe = createGmeetPipeline({ config: { maxRetainedDuration: 1, minAudioDuration: .1, submitInterval: .1 },
    transcribe: async () => ++calls === 1 ? new Promise(r => { resolve = r; }) : {text: 'fresh words'},
    onHypothesis: h => observed.push(h), sink: { segment() {}, finalize() {} } });
  try {
    pipe.feedAudio(0, 'Speaker', new Float32Array(9600).fill(.1), epoch, null, 0);
    mock.timers.tick(100); pipe.requestEndpoint(0, epoch + 600);
    pipe.feedAudio(0, 'Speaker', new Float32Array(9600).fill(.001), epoch + 600, null, 9600);
    resolve({text: 'TINA ơi old question'}); await tick();
    assert(!observed.some(h => h.text.includes('old question')));
    await pipe.dispose();
  } finally { mock.timers.reset(); }
});

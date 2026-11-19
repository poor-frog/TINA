import assert from 'node:assert/strict';
import { createGmeetPipeline, type VoiceHypothesis } from './gmeet-pipeline.js';
for (const failObserver of [false, true]) {
  const hypotheses: VoiceHypothesis[] = [], texts: string[] = [];
  let calls = 0;
  const pipe = createGmeetPipeline({ config: { minAudioDuration: .2, submitInterval: 3600 },
    transcribe: async pcm => { calls++; return { text: 'TINA ơi, ai làm demo?', language: 'vi', segments: [{ text: 'TINA ơi, ai làm demo?', start: 0, end: pcm.length / 16000 }] }; },
    onHypothesis: value => { hypotheses.push(value); if (failObserver) throw new Error('voice observer failed'); },
    onAsrDiagnostic: value => { assert.equal(value.channel, 2); assert(!('text' in value)); if(failObserver)throw new Error('metrics observer failed'); },
    sink: { segment: value => texts.push(value.text), finalize() {} } });
  const start = 1800000000000;
  pipe.feedAudio(2, 'Speaker', new Float32Array(16000).fill(.1), start, null, 0);
  await pipe.dispose();
  assert.equal(calls, 1, 'voice observation must not create another ASR request');
  assert.equal(hypotheses[0]?.channel, 2);
  assert.equal(hypotheses[0]?.startMs, start);
  assert.equal(hypotheses[0]?.endMs, start + 1000);
  assert.equal(hypotheses[0]?.final, true);
  assert.equal(hypotheses[0]?.text, 'TINA ơi, ai làm demo?');
  assert(texts.includes('TINA ơi, ai làm demo?'), 'observer failure must preserve raw transcript');
}
console.log('PASS ASR voice observation: one original request, channel/source clock, transcript preserved on voice failure');

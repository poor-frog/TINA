import assert from 'node:assert/strict';
import { TranscriptionClient } from './transcription-client.js';
const original = globalThis.fetch;
try {
  for (const [header, expected] of [['asr_queue;dur=12.5, asr_inference;dur=30',12.5], ['',undefined],
    ['asr_queue;dur=-1',undefined], ['asr_queue;dur=Infinity',undefined], ['asr_queue;dur=9999999',undefined]] as const) {
    globalThis.fetch = async () => new Response(JSON.stringify({text:'original words',segments:[]}),{headers:{'server-timing':header}});
    const result = await new TranscriptionClient({serviceUrl:'http://synthetic.test',maxRetries:0}).transcribe(new Float32Array(1600));
    assert.equal(result.queue_ms,expected); assert.equal(result.text,'original words');
  }
} finally { globalThis.fetch = original; }
console.log('Server-Timing: measured queue only, malformed/missing values stay absent; text preserved');

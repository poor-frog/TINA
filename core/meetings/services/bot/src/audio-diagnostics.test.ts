import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioDiagnostics } from './audio-diagnostics.js';

test('per-channel sample clocks distinguish gaps, overlap, clock resets and absent clocks', () => {
  let now = 2000; const d = new AudioDiagnostics(() => now);
  const pcm = new Float32Array(1024).fill(.1);
  d.frame(0, pcm, 1900, 0); d.frame(0, pcm, 1964, 1024);
  d.frame(0, pcm, 2028, 3072); d.frame(0, pcm, 2028, 3072);
  d.frame(1, pcm, 1900);
  let rows = d.snapshot().channels;
  assert.equal(rows[0].frames, 4); assert.equal(rows[0].gap_samples, 1024); assert.equal(rows[0].overlap_samples, 1024);
  assert.equal(rows[1].sample_clock, false); assert.equal(rows[1].gap_samples, 0);
  d.frame(0, pcm, 1964, 0); assert.equal(d.snapshot().channels[0].clock_resets, 1);
  for(let i=2;i<30;i++)d.frame(i,pcm,1900,0);
  assert.equal(d.snapshot().channels.length,16);
  now += 31000; assert.equal(d.snapshot().channels.length,0);
});

test('ASR diagnostics preserve concurrent requests and never invent backend queue time', () => {
  const d = new AudioDiagnostics(() => 2000); d.frame(0,new Float32Array(1024),1900,0);
  d.asr({channel:0,request:1,stage:'started',at_ms:2000,capture_age_ms:80});
  d.asr({channel:0,request:2,stage:'started',at_ms:2010,capture_age_ms:30});
  d.asr({channel:0,request:1,stage:'completed',at_ms:2020,roundtrip_ms:20,queue_ms:2});
  assert.equal(d.snapshot().channels[0].asr_inflight,1); assert.equal(d.snapshot().channels[0].queue_ms,undefined);
  d.asr({channel:0,request:2,stage:'completed',at_ms:2030,roundtrip_ms:20});
  const row = d.snapshot().channels[0]; assert.equal(row.asr_inflight,0); assert.equal(row.queue_ms,undefined); assert.equal(row.roundtrip_ms,20);
  assert.equal(row.capture_age_ms,30); assert(!JSON.stringify(d.snapshot()).includes('text'));
  d.asr({channel:0,request:3,stage:'started',at_ms:2030});
  d.asr({channel:0,request:3,stage:'failed',at_ms:2040});
  assert.equal(d.snapshot().channels[0].asr_errors,1);
});

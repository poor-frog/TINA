// Run in the bot image with the voice cache read-only and a synthetic float32 PCM fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { MeetingVoice, nativeVoiceWorker, nativeKwsWorker } from '/app/core/meetings/services/bot/dist/meeting-voice.js';

const bytes = readFileSync(process.argv[2]);
const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
assert(audio.length > 0 && audio.every(Number.isFinite));
const states = [], logs = [];
let answers = 0, playback = 0, cursor = 0;
let base;
const api = { config: async () => ({enabled: true, ready: true, revision: 1}),
  answer: async question => {assert.equal(question, answers ? 'Còn deadline?' : 'ai phụ trách demo?');
    answers++; return {text: answers===1 ? 'Lan phụ trách demo.' : 'Thứ Sáu.'};},
  state: async state => {states.push(state);} };
const player = {async speak() {playback++; return 'completed';}, async stop() {}};
async function waitFor(check) {
  const deadline = Date.now() + 20000;
  while (!check()) {assert(Date.now() < deadline, 'native worker readiness/detection timed out'); await delay(25);}
}
function metrics() {
  return logs.filter(s => s.startsWith('{')).map(s => JSON.parse(s)).filter(s => s.type === 'kws');
}
const voice = new MeetingVoice(api, player, async () => {}, nativeVoiceWorker, s => logs.push(s),
  async () => true, undefined, nativeKwsWorker);
async function replay() {
  for (let offset = 0; offset < audio.length; offset += 1024) {
    const chunk = audio.slice(offset, offset + 1024);
    voice.feed(11, chunk, base + cursor / 16, 'synthetic-caller', cursor);
    voice.feed(12, new Float32Array(chunk.length), base + cursor / 16, 'silent-channel', cursor);
    cursor += chunk.length;
    await delay(64);
  }
}
try {
  await voice.start();
  await waitFor(() => states.includes('LISTENING') && metrics().some(e => e.status === 'ready'));
  assert.deepEqual(metrics().find(e => e.status === 'ready').models, ['hey_tina', 'tina_oi']);
  base = Date.now()+1;
  await replay();
  await waitFor(() => metrics().some(e => e.status === 'wake' && e.model === 'tina_oi' && e.channel === 11));
  assert(!metrics().some(e => e.status === 'wake' && e.channel === 12));
  assert(states.includes('CAPTURING'));
  assert.equal(answers, 0);
  voice.hypothesis({channel:11, participant:'synthetic-caller', speakerKey:'synthetic',
    startMs:base, endMs:base+cursor/16, text:'tin anh ơi, ai phụ trách demo?', final:true});
  for (let i=0;i<24;i++) {
    voice.feed(11,new Float32Array(1024),base+cursor/16,'synthetic-caller',cursor);
    voice.feed(12,new Float32Array(1024),base+cursor/16,'silent-channel',cursor);
    cursor+=1024; await delay(64);
  }
  await waitFor(() => answers === 1 && playback === 1 && states.includes('QUIET'));
  await waitFor(() => states.at(-1) === 'LISTENING');
  base=Date.now()+1-cursor/16;
  const followStart=base+cursor/16;
  await replay();
  voice.hypothesis({channel:11,participant:'synthetic-caller',speakerKey:'next',startMs:followStart,
    endMs:base+cursor/16,text:'Còn deadline?',final:true});
  for(let i=0;i<20;i++){
    voice.feed(11,new Float32Array(1024),base+cursor/16,'synthetic-caller',cursor);
    voice.feed(12,new Float32Array(1024),base+cursor/16,'silent-channel',cursor);
    cursor+=1024;await delay(64);
  }
  await waitFor(()=>answers===2&&playback===2);
  assert.equal(metrics().filter(e=>e.status==='wake').length,1,'follow-up must not need another acoustic wake');
  const detections = metrics().filter(e => e.status === 'wake').length;
  await voice.external({action: 'speak'}, replay);
  await delay(200);
  assert.equal(metrics().filter(e => e.status === 'wake').length, detections, 'playback must gate KWS');
  assert.equal(answers, 2); assert.equal(playback, 2);
  assert(!states.includes('ERROR'));
  assert(!logs.join(' ').includes('synthetic-caller'));
  console.log(JSON.stringify({native_vad_ready: true, native_kws_ready: true, two_channel_64ms_replay: true,
    tina_oi_detected: true, silent_channel_wakes: 0, speaking_gates_kws: true, kws_llm_calls: answers,
    kws_tts_calls: playback, same_caller_followup_without_wake:true, redundant_acks:0,
    fake_asr_api_and_playback: true, live_meeting: false}));
} finally {await voice.stop();}

states.length = 0; logs.length = 0;
const missing = new MeetingVoice(api, player, async () => {}, nativeVoiceWorker, s => logs.push(s),
  async () => true, undefined, (event, failed) => nativeVoiceWorker(event, failed,
    {...process.env, TINA_VOICE_MODEL_DIR: '/deliberately-missing-model-cache'}, 'kws'));
try {
  await missing.start();
  await waitFor(() => states.includes('ERROR') && metrics().some(e => e.status === 'failed'));
  assert(!states.includes('LISTENING'));
  console.log(JSON.stringify({missing_kws_assets_refuse_voice_activation: true}));
} finally {await missing.stop();}

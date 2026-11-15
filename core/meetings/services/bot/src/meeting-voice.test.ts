import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeetingVoice, voiceApi, type VoiceApi, type VoiceWorker, type VoiceDiagnostic, type WorkerFactory } from './meeting-voice.js';
import type { SpeakController } from './capture-bridge.js';
import { invocation, VoiceTrigger, speechSentences, summaryWaitNotice, SUMMARY_NOTICE, VOICE_NOTICES, VOICE_SERVICE_ERROR, VOICE_PROGRESS_NOTICES, voiceProgressNotice, isFixedVoiceNotice } from './voice-trigger.js';
import { createBotPipeline, type BotPipeline } from './pipeline.js';
import type { AudioSnapshot } from './audio-diagnostics.js';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms));
test('spoken tool progress requires a fresh matching turn, revision and known stage',()=>{
  const now=Date.now(), base={request_id:'turn',revision:2,observed_at_ms:now,stage:'reading_documents'};
  for(const [stage,text] of Object.entries(VOICE_PROGRESS_NOTICES)){
    assert.equal(voiceProgressNotice({...base,stage},'turn',2,now),text);
    assert(isFixedVoiceNotice(text));
  }
  for(const bad of [null,{}, {...base,request_id:'old'}, {...base,revision:1},
    {...base,observed_at_ms:now-15_000},{...base,observed_at_ms:now+1},
    {...base,observed_at_ms:'now'},{...base,stage:'invented_tool'},{...base,stage:'__proto__'}])
    assert.equal(voiceProgressNotice(bad,'turn',2,now),undefined);
});
test('native cancellation waits for core acknowledgment and rejects an invalid success response',async()=>{
  const response=deferred<Response>();const calls:object[]=[];
  const api=voiceApi('http://core.test/bots/voice/1/session','synthetic',async(_url,init)=>{
    calls.push(JSON.parse(init?.body as string));return response.promise;
  });
  let done=false;const cancelled=Promise.resolve(api.cancelTurn!('old')).then(()=>{done=true;});
  await tick(5);assert.equal(done,false);assert.deepEqual(calls,[{state:'QUIET',request_id:'old'}]);
  response.resolve(Response.json({accepted:true}));await cancelled;assert(done);
  const invalid=voiceApi('http://core.test','synthetic',async()=>Response.json({ready:true}));
  await assert.rejects(async()=>{await invalid.cancelTurn!('old');});
});
function fixture(answer: () => Promise<{text: string; clarification?: boolean; evidence_available?: boolean}> = async () => ({ text: 'Lan phụ trách demo. Hạn là thứ Sáu.' }), player?: SpeakController, shadowFactory?: WorkerFactory, turnFactory?: WorkerFactory,vadFactory?:WorkerFactory) {
  const diagnostics: VoiceDiagnostic[] = [], logs: string[] = [];
  const audio: AudioSnapshot[] = [];
  const endpoints:Array<{channel:number;endMs:number|null}>=[];
  const speakerKeys: Array<string | undefined> = [];
  const progress:Array<{state:string;text:string}>=[];
  const speechDeadlines: Array<number | undefined> = [];
  const states: string[] = [], spoken: string[] = [], questions: string[] = [], reports: string[] = [], sent: object[] = [];
  let event!: (v: Record<string, unknown>) => void;
  let config = { enabled: true, ready: true, revision: 1, wake_variants: [] as string[] };
  const worker: VoiceWorker = { send(v) { sent.push(v); return true; }, close() {} };
  const api: VoiceApi = { config: async () => config, answer: async (question, _id, _rev, _signal, speaker) => { questions.push(question); speakerKeys.push(speaker); return answer(); }, state: async (state, _, detail, snapshot) => { states.push(state); if (detail) diagnostics.push(detail); if(snapshot)audio.push(snapshot); } };
  const voice = new MeetingVoice(api, player || { async speak(text, _, started, deadline) { spoken.push(text); speechDeadlines.push(deadline); started?.(); return 'completed'; }, async stop() {} },
    async (_, state, text) => { if(text!==undefined)progress.push({state,text});else reports.push(state); }, onEvent => { event = onEvent; return worker; }, value => { logs.push(value); }, undefined,
    (channel,endMs)=>{endpoints.push({channel,endMs});}, shadowFactory,turnFactory,undefined,vadFactory);
  const emit = (v: object) => event({ generation: 0, ...v });
  const capture = async (text = 'Tina ơi, ai phụ trách demo?') => {
    emit({ event: 'state', state: 'LISTENING' });
    const start = Date.now() + 1;
    await tick(5);
    voice.hypothesis({ channel: 0, speakerKey: 'ch-0:1', startMs: start, endMs: start + 10, text, final: true });
    emit({ event: 'activity', channel: 0, speech: false, endMs: start + 10, stamp: start + 20 });
    await tick(450);
  };
  return { voice, api, states, diagnostics, logs, audio, endpoints, progress, spoken, speechDeadlines, questions, speakerKeys, reports, sent, capture, emit, setConfig: (v: typeof config) => { config = v; } };
}

test('server cancellation and heard-prefix receipt do not wait for stalled microphone control',async()=>{
  const local=deferred<void>();const calls:string[]=[];
  const api:VoiceApi={config:async()=>({enabled:true,ready:true,revision:1,wake_variants:[]}),
    answer:async()=>({text:'unused'}),state:async()=>{},cancelTurn:async()=>{calls.push('cancel');}};
  const voice=new MeetingVoice(api,{async speak(){return 'completed';},stop(){calls.push('local-stop');return local.promise;}},
    async(_id,state,text)=>{calls.push(`receipt:${state}:${text}`);});
  Object.assign(voice,{requestId:'00000000-0000-4000-8000-000000000123',playbackStarted:true,playedText:'Đã phát.'});
  const cancelled=(voice as any).cancel();
  await new Promise(resolve=>setImmediate(resolve));
  assert(calls.includes('local-stop'));assert(calls.includes('cancel'));
  assert(calls.indexOf('receipt:stopped:Đã phát.')<calls.indexOf('cancel'));
  local.resolve();await cancelled;
});

for(const probe of ['configuration','asr'])test(`healthy polling rearms after consecutive transient ${probe} probe errors without reviving retired workers`,async()=>{
  let fail=false,starts=0;const events:Array<(event:Record<string,unknown>)=>void>=[];
  const states:string[]=[];
  const voice=new MeetingVoice({config:async()=>{
    if(probe==='configuration'&&fail)throw Error('synthetic temporary configuration failure');
    return {enabled:true,ready:true,revision:1};
  },answer:async()=>({text:'unused'}),state:async state=>{states.push(state);}},
  {speak:async()=> 'completed',stop:async()=>{}},async()=>{},callback=>{
    starts++;events.push(callback);return {send:()=>true,close(){}};
  },()=>{},async()=>{if(probe==='asr'&&fail)throw Error('synthetic temporary ASR health failure');return true;});
  const poll=async()=>{clearTimeout((voice as any).pollTimer);await (voice as any).poll();clearTimeout((voice as any).pollTimer);};
  try{
    await voice.start();clearTimeout((voice as any).pollTimer);
    events[0]({event:'state',state:'LISTENING',generation:0});
    fail=true;await poll();await poll();assert.equal(starts,1);
    fail=false;await poll();assert.equal(starts,2);
    assert.notEqual(states.at(-1),'ERROR');
    const count=states.length;events[0]({event:'state',state:'LISTENING',generation:0});
    assert.equal(states.length,count,'retired callbacks cannot arm listening');
    events[1]({event:'state',state:'LISTENING',generation:0});assert.equal(states.at(-1),'LISTENING');
  }finally{await voice.stop();}
});

test('worker construction failures are not treated as transient readiness probe failures',async()=>{
  let constructions=0;const states:string[]=[];
  const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
    answer:async()=>({text:'unused'}),state:async state=>{states.push(state);}},
    {speak:async()=> 'completed',stop:async()=>{}},async()=>{},()=>{
      constructions++;throw Error('synthetic worker startup failure');
    },()=>{});
  try{
    await voice.start();clearTimeout((voice as any).pollTimer);
    await (voice as any).poll();clearTimeout((voice as any).pollTimer);
    assert.equal(constructions,1);assert.equal(states.at(-1),'ERROR');
  }finally{await voice.stop();}
});

for(const failure of ['microphone','lease','receipt','existing-error','manual-speaking'])test(`probe recovery preserves ${failure} error fences`,async()=>{
  let configFails=false,cleanupFails=true,starts=0;
  const states:string[]=[];
  const voice=new MeetingVoice({config:async()=>{
    if(configFails)throw Error('synthetic temporary probe failure');
    return {enabled:true,ready:true,revision:1};
  },answer:async()=>({text:'unused'}),state:async state=>{states.push(state);},
  cancelTurn:async()=>{if(failure==='lease'&&cleanupFails)throw Error('Unconfirmed core release');}},
  {speak:async()=> 'completed',stop:async()=>{if(failure==='microphone'&&cleanupFails)throw Error('Unconfirmed mute');}},
  async()=>{if(failure==='receipt'&&cleanupFails)throw Error('Unconfirmed receipt');},
  ()=>{starts++;return {send:()=>true,close(){}};},()=>{});
  const poll=async()=>{clearTimeout((voice as any).pollTimer);await (voice as any).poll();clearTimeout((voice as any).pollTimer);};
  try{
    await voice.start();clearTimeout((voice as any).pollTimer);
    if(failure==='lease'||failure==='receipt')Object.assign(voice,{requestId:'00000000-0000-4000-8000-000000000123',playbackStarted:failure==='receipt'});
    if(failure==='existing-error')(voice as any).setState('ERROR');
    if(failure==='manual-speaking')Object.assign(voice,{externalSpeaking:true});
    configFails=true;await poll();cleanupFails=false;configFails=false;await poll();
    assert.equal(starts,1);assert.equal(states.at(-1),'ERROR');
  }finally{cleanupFails=false;await voice.stop();}
});

test('hosted VAD disagreement or failure cannot delay or replace primary question dispatch',async()=>{
  for(const unavailable of [false,true]){
    let remote!:(event:Record<string,unknown>)=>void;let fail!:()=>void;
    const f=fixture(undefined,undefined,undefined,undefined,(event,failed)=>{
      remote=event;fail=failed;
      return {close(){},send(value:any){
        if(value.type==='endpoint')remote({event:'endpoint',id:value.id,generation:value.generation,channel:value.channel,ready:false});
        return true;
      }};
    });
    await f.voice.start();remote({event:'vad-ready'});if(unavailable)fail();
    await f.capture();
    assert.deepEqual(f.questions,['ai phụ trách demo?']);
    assert(!f.states.includes('ERROR'));
    assert(f.logs.some(value=>value.includes('livekit_vad_shadow')));
    await f.voice.stop();
  }
});

test('pending shadow inference never delays question dispatch',async()=>{
  let event!:(value:Record<string,unknown>)=>void;
  const observations:object[]=[];
  const f=fixture(undefined,undefined,undefined,callback=>{event=callback;return{
    send(value){observations.push(value);return true;},close(){}};});
  await f.voice.start();event({event:'turn-ready'});f.emit({event:'state',state:'LISTENING'});
  const start=Date.now()+1;await tick(5);
  f.voice.feed(0,new Float32Array(1600),start);
  f.voice.hypothesis({channel:0,speakerKey:'ch-0:1',startMs:start,endMs:start+10,
    text:'Tina ơi, ai phụ trách demo?',final:true});
  f.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20});
  await tick(450);
  assert.equal(observations.length,1);
  assert.deepEqual(f.questions,['ai phụ trách demo?']);
  assert(f.states.includes('THINKING'));
  await f.voice.stop();
});

function acousticFixture(answer?: () => Promise<{text: string; clarification?: boolean; evidence_available?: boolean}>) {
  let event!: (value: Record<string, unknown>) => void, fail!: () => void;
  const messages: Array<Record<string, unknown>> = [];
  const f = fixture(answer, undefined, (callback, failed) => {
    event = callback; fail = failed;
    return {send(message) {messages.push(message as Record<string, unknown>); return true;}, close() {}};
  });
  const emit = (value: object) => event({event: 'kws', generation: 0, ...value});
  const ready = () => emit({status: 'ready', models: ['hey_tina', 'tina_oi']});
  const wake = (start: number, extra: object = {}) => {
    f.voice.feed(2, new Float32Array(1024), start, 'transport-id', 2048);
    emit({status: 'wake', model: 'tina_oi', channel: 2, participant: 'transport-id', score: .95,
      source_start_ms: start, source_frame_end_ms: start+32, processing_ms: 1.2, ...extra});
  };
  const wakeFor=(channel:number,participant:string|undefined,start:number,extra:object={})=>{
    f.voice.feed(channel,new Float32Array(1024),start,participant,2048);
    emit({status:'wake',model:'tina_oi',channel,participant,score:.95,
      source_start_ms:start,source_frame_end_ms:start+32,processing_ms:1.2,...extra});
  };
  return {...f, ready, wake, wakeFor, fail: () => fail(), kws: emit, messages};
}

test('only whole-meeting recap-like requests get the fixed waiting notice', () => {
  for (const question of ['Tổng hợp toàn bộ quyết định trong cuộc họp.', 'Tóm tắt cuộc họp', 'Summarize the entire meeting'])
    assert.equal(summaryWaitNotice(question), SUMMARY_NOTICE);
  for (const question of ['Ai phụ trách demo?', 'Tóm tắt 5 phút vừa rồi', 'Cách tóm tắt cuộc họp?'])
    assert.equal(summaryWaitNotice(question), undefined);
});

test('cached waiting notices bypass the busy Agents session but answer TTS keeps its turn binding', async () => {
  const api = voiceApi('http://core.test/bots/voice/1/session', 'synthetic-capability', async url => {
    if (String(url).endsWith('/config')) return Response.json({enabled: true, ready: true, revision: 1,
      engine: 'livekit', agent_url: 'http://agents.test/bots/1/session'});
    return Response.json({text: 'Lan phụ trách demo.'});
  });
  await api.config(AbortSignal.timeout(1000));
  await api.answer('Tóm tắt cuộc họp', 'synthetic-request', 1, AbortSignal.timeout(1000));
  for (const notice of Object.values(VOICE_NOTICES).flat()) assert.equal(api.speechService?.(notice), undefined);
  assert.equal(api.speechService?.('Lan phụ trách demo.')?.requestId, 'synthetic-request');
});

test('a complete Hey TINA question gets a waiting phrase then its answer, not a name acknowledgment', async () => {
  const result = deferred<{text: string}>(), f = acousticFixture(() => result.promise);
  try {
    await f.voice.start(); f.emit({event: 'state', state: 'LISTENING'}); f.ready();
    const start = Date.now() + 1; await tick(5); f.wake(start);
    f.voice.hypothesis({channel: 2, participant: 'transport-id', speakerKey: 's', startMs: start,
      endMs: start + 100, text: 'Hey TINA, task này đã giao cho ai chưa?', final: true});
    f.emit({event: 'activity', channel: 2, speech: false, endMs: start + 100, stamp: start + 100});
    await tick(1350);
    assert.deepEqual(f.questions, ['task này đã giao cho ai chưa?']);
    assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0]]);
    result.resolve({text: 'Lan phụ trách task này.'}); await tick(40);
    assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0], 'Lan phụ trách task này.']);
  } finally {result.resolve({text: 'Lan phụ trách task này.'}); await f.voice.stop();}
});

test('name-only responses rotate independently through their own public phrases', async () => {
  const f = fixture();
  try {
    for (const expected of VOICE_NOTICES.wake) {
      await f.voice.start(); await f.capture('TINA ơi');
      assert.equal(f.spoken.at(-1), expected);
      assert.equal(f.questions.length, 0);
      await f.voice.stop();
    }
    assert.equal(new Set(f.spoken).size, VOICE_NOTICES.wake.length);
  } finally {await f.voice.stop();}
});

test('slow question notices rotate once per turn and never claim a specific tool ran', async () => {
  const replies = VOICE_NOTICES.wait.map(() => deferred<{text: string}>()); let calls = 0;
  const f = fixture(() => replies[calls++].promise);
  try {
    await f.voice.start();
    for (let i = 0; i < replies.length; i++) {
      await f.capture('TINA ơi, ai phụ trách task này?'); await tick(1000);
      assert.equal(f.spoken.at(-1), VOICE_NOTICES.wait[i]);
      replies[i].resolve({text: 'Lan.'}); await tick(40);
    }
    assert.deepEqual(f.spoken.filter(isFixedVoiceNotice), [...VOICE_NOTICES.wait]);
    assert(!f.spoken.join(' ').includes('web')); assert(!f.spoken.join(' ').includes('Wiki'));
  } finally {for (const result of replies) result.resolve({text: 'Lan.'}); await f.voice.stop();}
});

test('a slow answer announces its actual document lookup once and then plays the verified answer',async()=>{
  const reply=deferred<{text:string}>(),f=fixture(()=>reply.promise);
  const config=f.api.config;
  f.api.answer=async(_question,id,revision)=>{
    f.api.config=async signal=>({...await config(signal),progress:{request_id:id,revision,stage:'reading_documents',observed_at_ms:Date.now()}});
    return reply.promise;
  };
  try{
    await f.voice.start();await f.capture();await tick(1000);
    assert.deepEqual(f.spoken,[VOICE_PROGRESS_NOTICES.reading_documents]);
    reply.resolve({text:'Lan phụ trách demo.'});await tick(40);
    assert.deepEqual(f.spoken,[VOICE_PROGRESS_NOTICES.reading_documents,'Lan phụ trách demo.']);
    assert.deepEqual(f.reports,['started','completed']);
  }finally{reply.resolve({text:'Lan phụ trách demo.'});await f.voice.stop();}
});

test('an answer that arrives during the notice policy check skips filler and preserves the reply', async () => {
  const result = deferred<{text: string}>(), checking = deferred<void>(), release = deferred<void>();
  const f = fixture(() => result.promise); const config = f.api.config; let reads = 0;
  let noticeSignal: AbortSignal | undefined;
  f.api.config = async signal => {
    if (++reads === 2) {
      noticeSignal = signal;
      signal.addEventListener('abort', () => release.resolve(), {once: true});
      checking.resolve(); await release.promise;
    }
    return config(signal);
  };
  try {
    await f.voice.start(); await f.capture();
    await checking.promise;
    result.resolve({text: 'Lan phụ trách demo.'}); await tick(40);
    assert.equal(noticeSignal?.aborted, true);
    assert.deepEqual(f.spoken, ['Lan phụ trách demo.']);
    assert(!f.logs.includes('ack_playback_failed'));
  } finally {result.resolve({text: 'Lan phụ trách demo.'}); release.resolve(); await f.voice.stop();}
});

test('a slow recap announces once then automatically plays the verified result without another wake', async () => {
  const result = deferred<{text: string}>();
  const f = fixture(() => result.promise);
  try {
    await f.voice.start(); await f.capture('TINA ơi, tổng hợp toàn bộ quyết định trong cuộc họp.');
    await tick(1000);
    assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0]]);
    assert.equal(f.speechDeadlines[0], 6000, 'A 1.84s cached notice still needs time to open the meeting microphone.');
    assert(!f.reports.includes('completed'));
    result.resolve({text: 'Lan phụ trách demo.'}); await tick(40);
    assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0], 'Lan phụ trách demo.']);
    assert.equal(f.questions.length, 1);
    assert.deepEqual(f.reports, ['started', 'completed']);
  } finally {result.resolve({text: 'Lan phụ trách demo.'}); await f.voice.stop();}
});

test('Stop, departure and policy changes fence late recap results and do not repeat the notice', async () => {
  for (const change of ['stop', 'depart', 'policy']) {
    const result = deferred<{text: string}>(); const f = fixture(() => result.promise);
    try {
      await f.voice.start(); await f.capture('TINA ơi, tóm tắt cuộc họp.'); await tick(1000);
      assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0]]);
      if (change === 'stop') await f.voice.external({action: 'speak_stop'}, async () => {});
      else if (change === 'depart') await f.voice.stop();
      else f.setConfig({enabled: true, ready: true, revision: 2, wake_variants: []});
      result.resolve({text: 'Kết quả cũ phải bỏ.'}); await tick(40);
      assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0]]);
      assert(!f.reports.includes('completed'));
    } finally {result.resolve({text: 'Kết quả cũ phải bỏ.'}); await f.voice.stop();}
  }
});

test('a recap cancelled for a new question cannot speak its late result over the new turn', async () => {
  const old = deferred<{text: string}>(); let requests = 0;
  const f = fixture(() => ++requests === 1 ? old.promise : Promise.resolve({text: 'Câu trả lời mới.'}));
  try {
    await f.voice.start(); await f.capture('TINA ơi, tóm tắt cuộc họp.'); await tick(1000);
    await f.voice.external({action: 'speak_stop'}, async () => {});
    f.emit({event: 'state', state: 'LISTENING', generation: 1}); await tick(5);
    const start = Date.now() + 1; await tick(5);
    f.voice.hypothesis({channel: 0, speakerKey: 'ch-0:1', startMs: start, endMs: start + 10,
                       text: 'TINA ơi, ai phụ trách demo?', final: true});
    f.emit({event: 'activity', channel: 0, speech: false, endMs: start + 10, stamp: start + 20, generation: 1});
    await tick(450);
    assert.equal(requests, 2);
    old.resolve({text: 'Bản tổng hợp cũ.'}); await tick(40);
    assert.deepEqual(f.spoken, [VOICE_NOTICES.wait[0], 'Câu trả lời mới.']);
  } finally {old.resolve({text: 'Bản tổng hợp cũ.'}); await f.voice.stop();}
});

test('verified KWS alone authorizes a same-channel ASR question and fences duplicates/retired models', async () => {
  const f = acousticFixture();
  try {
    await f.voice.start(); f.emit({event: 'state', state: 'LISTENING'}); await tick(5);
    assert(!f.states.includes('LISTENING')); f.ready(); await tick(5);
    assert(f.states.includes('LISTENING'));
    const start = Date.now()+1; await tick(5);
    const h = {channel: 2, participant: 'transport-id', speakerKey: 's', startMs: start,
      endMs: start+100, text: 'tinh anh ơi, ai phụ trách demo?', final: true};
    f.voice.hypothesis({...h, channel: 3, text: 'TINA ơi câu hỏi không có KWS'});
    f.wake(start, {model: 'tina'}); f.wake(start, {model: 'e_tina'});
    assert(!f.states.includes('CAPTURING'));
    f.wake(start, {text: 'PRIVATE-AUDIO'}); f.wake(start);
    f.voice.hypothesis({...h, channel: 3}); assert.equal(f.questions.length, 0);
    f.voice.hypothesis(h);
    f.emit({event: 'activity', channel: 2, speech: false, endMs: start+100, stamp: start+100});
    await tick(450);
    assert.deepEqual(f.questions, ['ai phụ trách demo?']); assert.equal(h.text, 'tinh anh ơi, ai phụ trách demo?');
    assert(!f.logs.join(' ').includes('PRIVATE-AUDIO')); assert.match(f.speakerKeys[0]!, /^[0-9a-f]{64}$/);
    assert.equal(f.logs.filter(s => s.includes('"status":"wake"')).length, 1);
    const before = f.messages.filter(v => v.type === 'audio').length;
    f.wake(Date.now()); assert.equal(f.messages.filter(v => v.type === 'audio').length, before);
    assert(f.messages.some(v => v.state === 'SPEAKING')); assert(f.messages.some(v => v.state === 'QUIET'));
  } finally {await f.voice.stop();}
});

test('ASR arriving before KWS is replayed once, without any ASR name match', async () => {
  const f = acousticFixture();
  try {
    await f.voice.start(); f.emit({event: 'state', state: 'LISTENING'}); f.ready();
    const start = Date.now()+1; await tick(5);
    f.voice.hypothesis({channel: 2, participant: 'transport-id', speakerKey: 's', startMs: start,
      endMs: start+100, text: 'Ai phụ trách demo?', final: true});
    f.emit({event: 'activity', channel: 2, speech: false, endMs: start+100, stamp: start+100});
    assert.equal(f.questions.length, 0); f.wake(start); await tick(450);
    assert.deepEqual(f.endpoints.at(-1), {channel:2,endMs:start+100});
    assert.deepEqual(f.questions, ['Ai phụ trách demo?']);
  } finally {await f.voice.stop();}
});

test('a standalone KWS call acknowledges and accepts only its caller continuation', async () => {
  for (const name of ['tin anh ơi', 'TINA ơi ạ', 'ti nà ơi', 'hey tiên na']) {
    const f = acousticFixture();
    try {
      await f.voice.start(); f.emit({event: 'state', state: 'LISTENING'}); f.ready();
      const start = Date.now()+1; await tick(5); f.wake(start);
      f.voice.hypothesis({channel: 2, participant: 'transport-id', speakerKey: 's', startMs: start,
        endMs: start+100, text: name, final: true});
      f.emit({event: 'activity', channel: 2, speech: false, endMs: start+100, stamp: start+100});
      await tick(450); assert.deepEqual(f.spoken, ['Dạ, em nghe.']); assert.equal(f.questions.length, 0);
      f.emit({event: 'state', state: 'LISTENING'}); const next = Date.now()+1; await tick(5);
      f.voice.hypothesis({channel: 3, speakerKey: 'other', startMs: next, endMs: next+10, text: 'TINA ơi câu của người khác', final: true});
      f.voice.hypothesis({channel: 2, participant: 'transport-id', speakerKey: 's', startMs: next,
        endMs: next+10, text: 'Ai phụ trách demo?', final: true});
      f.emit({event: 'activity', channel: 2, speech: false, endMs: next+10, stamp: next+10});
      await tick(450); assert.deepEqual(f.questions, ['Ai phụ trách demo?']);
      assert.equal(f.spoken.filter(s => s === 'Dạ, em nghe.').length, 1);
    } finally {await f.voice.stop();}
  }
});

test('failed KWS refuses ASR-only activation and stale worker events cannot wake', async () => {
  const f = acousticFixture();
  try {
    await f.voice.start(); f.emit({event: 'state', state: 'LISTENING'});
    f.kws({status: 'ready', models: ['hey_tina', 'tina_oi'], generation: -1});
    assert(!f.states.includes('LISTENING')); f.ready(); f.fail(); await tick(10);
    assert.equal(f.states.at(-1), 'ERROR'); assert.equal(f.diagnostics.at(-1)?.code, 'kws_unavailable');
    await f.capture(); assert.equal(f.questions.length, 0);
    await f.voice.stop(); const count = f.logs.length; f.wake(Date.now()); assert.equal(f.logs.length, count);
  } finally {await f.voice.stop();}
});

test('independently identified speakers do not cancel or contaminate the caller during overlapping speech',async()=>{
  const f=acousticFixture();
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const start=Date.now()+1;await tick(5);
    f.voice.feed(3,new Float32Array(1024),start,'b',0);
    f.emit({event:'activity',channel:3,speech:true,stamp:start+64});
    f.wakeFor(2,'a',start);await tick(1);assert.equal(f.states.at(-1),'CAPTURING');
    f.emit({event:'activity',channel:3,speech:true,stamp:start+80});
    f.voice.hypothesis({channel:3,participant:'b',speakerKey:'b',startMs:start,endMs:start+100,text:'TINA ơi câu hỏi của B',final:true});
    assert.equal(f.states.at(-1),'CAPTURING');
    const h={channel:2,participant:'a',speakerKey:'a',startMs:start,endMs:start+100,text:'TINA ơi ai phụ trách demo?',final:true};
    f.voice.hypothesis(h);f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});
    await tick(450);assert.deepEqual(f.questions,['ai phụ trách demo?']);
    assert.equal(h.text,'TINA ơi ai phụ trách demo?');assert(!f.logs.includes('overlapping_channels'));
  }finally{await f.voice.stop();}
});

test('unknown, duplicate or stale channel identity still refuses ambiguous overlap',async()=>{
  for(const mode of ['unknown-other','unknown-caller','duplicate-id','stale-id']){
    const f=acousticFixture();
    try{
      await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
      const start=Date.now()+1;await tick(5);
      const other=mode==='unknown-other'?undefined:mode==='duplicate-id'?'a':'b';
      f.voice.feed(3,new Float32Array(1024),mode==='stale-id'?start-2000:start,other,0);
      f.emit({event:'activity',channel:3,speech:true,stamp:start+64});
      f.wakeFor(2,mode==='unknown-caller'?undefined:'a',start);await tick(10);
      assert.equal(f.states.at(-1),'QUIET',mode);assert.equal(f.questions.length,0);
      assert.equal(f.diagnostics.at(-1)?.code,'ambiguous_audio');
    }finally{await f.voice.stop();}
  }
  const f=acousticFixture();
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const start=Date.now()+1;await tick(5);f.wakeFor(2,'a',start);
    f.voice.feed(3,new Float32Array(1024),start,undefined,0);
    f.emit({event:'activity',channel:3,speech:true,stamp:start+64});await tick(10);
    assert.equal(f.states.at(-1),'QUIET');assert.equal(f.questions.length,0);
  }finally{await f.voice.stop();}
});

test('a fresh B wake claims A idle follow-up, but cannot steal a pending question or share A speaker key',async()=>{
  const f=acousticFixture();
  const h=(channel:number,participant:string,start:number,text:string)=>({channel,participant,speakerKey:participant,startMs:start,endMs:start+100,text,final:true});
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const first=Date.now()+1;await tick(5);f.wakeFor(2,'a',first);
    f.voice.hypothesis(h(2,'a',first,'TINA ơi ai làm demo?'));
    f.emit({event:'activity',channel:2,speech:false,endMs:first+100,stamp:first+100});await tick(450);
    f.emit({event:'state',state:'LISTENING'});
    const next=Date.now()+1;await tick(5);
    f.voice.hypothesis(h(3,'b',next,'TINA ơi không có KWS'));assert.equal(f.questions.length,1);
    f.wakeFor(3,undefined,next);assert.equal(f.states.at(-1),'LISTENING');
    f.wakeFor(3,'b',next,{generation:-1});assert.equal(f.states.at(-1),'LISTENING');
    f.wakeFor(3,'b',first);assert.equal(f.states.at(-1),'LISTENING','an old wake cannot replace A follow-up');
    f.wakeFor(3,'b',next);await tick(1);assert.equal(f.states.at(-1),'CAPTURING');
    f.wakeFor(4,'c',next);
    f.voice.hypothesis(h(2,'a',next,'Còn deadline của A?'));
    f.voice.hypothesis(h(3,'b',next,'hey TINA, ngân sách bao nhiêu?'));
    f.emit({event:'activity',channel:3,speech:false,endMs:next+100,stamp:next+100});await tick(450);
    assert.deepEqual(f.questions,['ai làm demo?','ngân sách bao nhiêu?']);
    assert.notEqual(f.speakerKeys[0],f.speakerKeys[1]);
    const accepted=f.logs.filter(s=>s.startsWith('{')).map(s=>JSON.parse(s)).filter(e=>e.type==='kws'&&e.status==='wake');
    assert.equal(accepted.length,2);assert.equal(accepted[1].handoff,true);
    f.emit({event:'state',state:'LISTENING'});
    const third=Date.now()+1;await tick(5);
    f.voice.hypothesis(h(3,'b',third,'Còn deadline?'));
    f.emit({event:'activity',channel:3,speech:false,endMs:third+100,stamp:third+100});await tick(450);
    assert.equal(f.questions.at(-1),'Còn deadline?');assert.equal(f.speakerKeys[1],f.speakerKeys[2]);
  }finally{await f.voice.stop();}
});

test('B wake cannot steal A unconfirmed follow-up draft or an answer still thinking',async()=>{
  const pending=deferred<{text:string}>();let requests=0;
  const f=acousticFixture(async()=>++requests===1?{text:'Lan làm demo.'}:pending.promise);
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const start=Date.now()+1;await tick(5);f.wakeFor(2,'a',start);
    f.voice.hypothesis({channel:2,participant:'a',speakerKey:'a',startMs:start,endMs:start+100,text:'TINA ơi ai làm?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});await tick(450);
    f.emit({event:'state',state:'LISTENING'});const next=Date.now()+1;await tick(5);
    const value={channel:2,participant:'a',speakerKey:'a',startMs:next,endMs:next+100,text:'Còn deadline?',final:false};
    f.voice.hypothesis(value);f.wakeFor(3,'b',next);
    f.voice.hypothesis({channel:3,participant:'b',speakerKey:'b',startMs:next,endMs:next+100,text:'TINA ơi câu của B',final:true});
    f.voice.hypothesis({...value,final:true});f.emit({event:'activity',channel:2,speech:false,endMs:next+100,stamp:next+100});
    await tick(450);assert.deepEqual(f.questions,['ai làm?','Còn deadline?']);
    assert.equal(f.states.at(-1),'THINKING');f.wakeFor(3,'b',Date.now());assert.equal(f.states.at(-1),'THINKING');
  }finally{pending.resolve({text:'Thứ Sáu.'});await f.voice.stop();}
});

test('completed KWS answer keeps a 5s same-person follow-up, including clarification, without another ack', async () => {
  let calls=0;
  const f=acousticFixture(async()=>++calls===1 ? {text:'Bạn hỏi demo hay production?',clarification:true} : {text:'Production giao thứ Sáu.'});
  try {
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const start=Date.now()+1;await tick(5);f.wake(start);
    f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:start,endMs:start+100,
      text:'TINA ơi deadline khi nào?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});await tick(450);
    assert.deepEqual(f.spoken,['Bạn hỏi demo hay production?']);
    f.emit({event:'state',state:'LISTENING'});
    const follow=Date.now()+1;await tick(5);
    const h={channel:2,participant:'transport-id',speakerKey:'next',startMs:follow,endMs:follow+10,text:'Production.',final:true};
    f.voice.hypothesis({...h,channel:3});f.voice.hypothesis({...h,participant:'other'});f.voice.hypothesis({...h,participant:undefined});
    assert.equal(f.questions.length,1);
    f.voice.hypothesis({...h,final:false});f.voice.hypothesis(h);
    f.emit({event:'activity',channel:2,speech:false,endMs:follow+10,stamp:follow+10});await tick(450);
    assert.deepEqual(f.questions,['deadline khi nào?','Production.']);
    assert.deepEqual(f.spoken,['Bạn hỏi demo hay production?','Production giao thứ Sáu.']);
    assert.equal(f.speakerKeys[0],f.speakerKeys[1]);
    await f.voice.external({action:'speak_stop'},async()=>{});
    f.emit({event:'state',state:'LISTENING',generation:1});
    const stopped=Date.now()+1;await tick(5);
    f.voice.hypothesis({...h,startMs:stopped,endMs:stopped+10,text:'Còn chi phí?'});
    await tick(350);assert.equal(f.questions.length,2);
  }finally{await f.voice.stop();}
});

test('same-person follow-up expires after five seconds and requires a new acoustic wake', async (t) => {
  const wallNow = Date.now.bind(Date);
  let advance = 0;
  t.mock.method(Date, 'now', () => wallNow() + advance);
  const f = acousticFixture();
  try {
    await f.voice.start(); f.emit({event:'state',state:'LISTENING'}); f.ready();
    const start=Date.now()+1; await tick(5); f.wake(start);
    f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:start,endMs:start+100,
      text:'TINA ơi ai phụ trách demo?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100}); await tick(450);
    assert.equal(f.questions.length,1);
    f.emit({event:'state',state:'LISTENING'});
    advance=5001;
    const next=Date.now()+1; await tick(5);
    const h={channel:2,participant:'transport-id',speakerKey:'next',startMs:next,endMs:next+100,
      text:'Còn hạn bàn giao?',final:true};
    f.voice.hypothesis(h);
    f.emit({event:'activity',channel:2,speech:false,endMs:h.endMs,stamp:h.endMs}); await tick(450);
    assert.equal(f.questions.length,1,'an expired follow-up cannot bypass KWS');
    f.wake(next); await tick(450);
    assert.equal(f.questions.length,2,'a fresh wake authorizes the next question');
  } finally { await f.voice.stop(); }
});

test('unknown identity and failed playback never open post-answer follow-up', async () => {
  for(const failed of [false,true]){
    const f=fixture(undefined,failed?{speak:async()=> 'failed',stop:async()=>{}}:undefined);
    try {
      await f.voice.start();f.emit({event:'state',state:'LISTENING'});
      const first=Date.now()+1;await tick(5);
      f.voice.hypothesis({channel:0,participant:failed?'p':undefined,speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai làm?',final:true});
      f.emit({event:'activity',channel:0,speech:false,endMs:first+10,stamp:first+10});await tick(450);
      f.emit({event:'state',state:'LISTENING'});
      const next=Date.now()+1;await tick(5);
      f.voice.hypothesis({channel:0,participant:failed?'p':undefined,speakerKey:'s',startMs:next,endMs:next+10,text:'Còn deadline?',final:true});
      f.emit({event:'activity',channel:0,speech:false,endMs:next+10,stamp:next+10});await tick(350);
      assert.equal(f.questions.length,1);
    }finally{await f.voice.stop();}
  }
});

test('new requests acknowledge once while brief follow-up waits and fast errors get one recovery notice', async () => {
  const pending=deferred<{text:string}>(),nextPending=deferred<{text:string}>();let requests=0;
  const f=acousticFixture(()=>++requests===1?pending.promise:nextPending.promise);
  try {
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
    const start=Date.now()+1;await tick(5);f.wake(start);
    f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:start,endMs:start+100,text:'TINA ơi ai làm?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});await tick(1350);
    assert.deepEqual(f.spoken,[VOICE_NOTICES.wait[0]]);pending.resolve({text:'Lan.'});await tick(40);
    f.emit({event:'state',state:'LISTENING'});const next=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:next,endMs:next+10,text:'Còn deadline?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:next+10,stamp:next+10});await tick(1350);
    assert.equal(f.spoken.filter(s=>VOICE_NOTICES.wait.some(phrase=>phrase===s)).length,1);
    nextPending.resolve({text:'Thứ Sáu.'});await tick(30);
    assert.equal(f.spoken.at(-1),'Thứ Sáu.');
  }finally{pending.resolve({text:'Lan.'});nextPending.resolve({text:'Thứ Sáu.'});await f.voice.stop();}
  const g=fixture(async()=>{throw new Error('no result');});
  try{await g.voice.start();await g.capture();await tick(1000);assert.deepEqual(g.spoken,[VOICE_SERVICE_ERROR]);assert.deepEqual(g.reports,[]);}
  finally{await g.voice.stop();}
});

test('no input ends the idle wait silently and distinguishes capture gaps from speech without ASR',async(t)=>{
  const wallNow=Date.now.bind(Date);let advance=0;t.mock.method(Date,'now',()=>wallNow()+advance);
  for (const mode of ['quiet','speech','missing']) {
    advance=0;const f=acousticFixture();
    try {
      await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
      const start=Date.now()+1;await tick(5);f.wake(start);
      f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:start,endMs:start+100,text:'TINA ơi ai làm?',final:true});
      f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});await tick(450);
      f.emit({event:'state',state:'LISTENING'});const count=f.spoken.length;advance=5001;
      if(mode!=='missing')f.voice.feed(2,new Float32Array(1024),Date.now()-64,'transport-id',4096);
      if(mode==='speech')f.emit({event:'activity',channel:2,speech:false,endMs:Date.now(),stamp:Date.now()});
      await tick(150);
      assert(f.diagnostics.some(d=>d.code===(mode==='quiet'?'no_input':mode==='speech'?'question_timeout':'services_unavailable')));
      assert.equal(f.spoken.length,count);
    }finally{await f.voice.stop();}
  }
});

test('paused clarification and service failures never arm an automatic same-person follow-up',async()=>{
  for(const reason of ['clarification_exhausted','llm_unavailable','draft_unavailable']){
    const f=acousticFixture(async()=>({text:'Em tạm dừng lượt này.',reason,evidence_available:false}));
    try{
      await f.voice.start();f.emit({event:'state',state:'LISTENING'});f.ready();
      const start=Date.now()+1;await tick(5);f.wake(start);
      f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:start,endMs:start+100,text:'TINA ơi ai làm?',final:true});
      f.emit({event:'activity',channel:2,speech:false,endMs:start+100,stamp:start+100});await tick(450);
      f.emit({event:'state',state:'LISTENING'});const after=Date.now()+1;await tick(5);
      f.voice.hypothesis({channel:2,participant:'transport-id',speakerKey:'s',startMs:after,endMs:after+100,text:'Lan',final:true});
      await tick(350);assert.equal(f.questions.length,1);
    }finally{await f.voice.stop();}
  }
});

test('recovery audio is attempted once and failed TTS cannot trigger another spoken error',async()=>{
  let plays=0;
  const f=fixture(async()=>{throw Error('service unavailable');},{async speak(){plays++;return 'failed';},async stop(){}});
  try{
    await f.voice.start();await f.capture();await tick(150);
    assert.equal(plays,1);assert(f.diagnostics.some(d=>d.code==='playback_failed'));assert.deepEqual(f.reports,[]);
  }finally{await f.voice.stop();}
  const g=fixture(async()=>{throw Error('service unavailable');});
  const config=g.api.config,checking=deferred<void>(),release=deferred<void>();let reads=0;
  g.api.config=async signal=>{if(++reads===2){checking.resolve();await release.promise;}return config(signal);};
  try{
    await g.voice.start();await g.capture();await checking.promise;
    await g.voice.external({action:'speak_stop'},async()=>{});release.resolve();await tick(30);
    assert.deepEqual(g.spoken,[]);
  }finally{release.resolve();await g.voice.stop();}
});

test('an explicit caller correction interrupts TTS, preserves completed sentences and opens the corrected turn', async()=>{
  const held=deferred<'stopped'>();let replies=0;
  const played:string[]=[];
  const f=fixture(async()=>({text:++replies===1?'Lan phụ trách demo. Hạn là thứ Sáu.':'Đã hiểu câu sửa.'}),{
    async speak(text,_,started){played.push(text);started?.();return text==='Hạn là thứ Sáu.'?held.promise:'completed';},
    async stop(){held.resolve('stopped');}
  });
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const first=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai làm?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:first+10,stamp:first+10});await tick(450);
    assert.deepEqual(played,['Lan phụ trách demo.','Hạn là thứ Sáu.']);
    assert.deepEqual(f.progress,[{state:'started',text:'Lan phụ trách demo.'}]);
    const start=Date.now()+1;await tick(5);
    const correction={channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+200,text:'Khoan, ý tôi là tuần sau.',final:true};
    for(const change of [{channel:3},{participant:'other'},{participant:undefined},{text:'ừ'},{text:'đúng rồi'}])f.voice.hypothesis({...correction,...change});
    f.emit({event:'activity',channel:3,speech:true,stamp:start+200});
    assert.equal(f.states.at(-1),'SPEAKING');
    f.voice.hypothesis(correction);await tick(30);
    assert.equal(f.states.at(-1),'QUIET');
    assert(f.progress.some(p=>p.state==='stopped'&&p.text==='Lan phụ trách demo.'));
    assert(!f.reports.includes('completed'));
    f.emit({event:'state',state:'LISTENING',generation:1});
    await tick(450);
    assert.deepEqual(f.questions,['ai làm?','ai làm?\nYêu cầu cập nhật: ý tôi là tuần sau.']);
    assert.deepEqual(f.endpoints.at(-1),{channel:2,endMs:start+200});
    assert.equal(played.at(-1),'Đã hiểu câu sửa.');
  }finally{held.resolve('stopped');await f.voice.stop();}
});

test('natural speaking correction keeps the goal and persists heard sentences before server cancellation',async()=>{
  const held=deferred<'stopped'>(),receipt=deferred<void>();let replies=0;
  const order:string[]=[],played:string[]=[],questions:string[]=[];
  let emit!:(v:Record<string,unknown>)=>void;
  const states:string[]=[];
  const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
    answer:async(q)=>{questions.push(q);return {text:++replies===1?'Lan phụ trách demo. Hạn là thứ Sáu.':'Sprint trước: Minh phụ trách.'};},
    state:async(s)=>{states.push(s);},cancelTurn:async()=>{order.push('server-cancel');}},
    {speak:async(text,_,started)=>{played.push(text);started?.();return text==='Hạn là thứ Sáu.'?held.promise:'completed';},
      stop:async()=>{order.push('mute');held.resolve('stopped');}},
    async(_,state,prefix)=>{if(state==='stopped'){order.push('prefix:'+prefix);await receipt.promise;}},
    onEvent=>{emit=onEvent;return {send:()=>true,close(){}};},()=>{});
  try{
    await voice.start();emit({event:'state',state:'LISTENING',generation:0});
    const first=Date.now()+1;await tick(5);
    voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai phụ trách demo?',final:true});
    emit({event:'activity',channel:2,speech:false,endMs:first+10,stamp:first+10,generation:0});await tick(450);
    assert.deepEqual(played,['Lan phụ trách demo.','Hạn là thứ Sáu.']);
    const start=Date.now()+1;await tick(5);
    const update={channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+400,text:'Không, ý tôi là sprint trước.',final:true};
    for(const change of [{participant:'other'},{participant:undefined},{channel:3},{text:'ừ đúng rồi'},{endMs:start+80}])
      voice.hypothesis({...update,...change});
    assert.equal(states.at(-1),'SPEAKING');
    voice.hypothesis(update);await tick(20);
    assert.deepEqual(order,['mute','prefix:Lan phụ trách demo.']);
    assert.equal(questions.length,1);
    receipt.resolve();await tick(20);
    assert.equal(order.at(-1),'server-cancel');
    emit({event:'state',state:'LISTENING',generation:1});await tick(450);
    assert.equal(questions[1],'ai phụ trách demo?\nYêu cầu cập nhật: Không, ý tôi là sprint trước.');
    assert.equal(played.at(-1),'Sprint trước: Minh phụ trách.');
    assert(!order.some(s=>s.includes('Hạn là thứ Sáu.')));
  }finally{receipt.resolve();held.resolve('stopped');await voice.stop();}
});

test('a short pause collects the same caller correction even while cancellation is pending',async()=>{
  const held=deferred<'stopped'>(),release=deferred<void>();let replies=0;
  const f=fixture(async()=>({text:++replies===1?'Lan phụ trách demo.':'Đã hiểu sprint trước.'}),{
    speak:async(_text,_,started)=>{started?.();return replies===1?held.promise:'completed';},stop:async()=>{held.resolve('stopped');}});
  f.api.cancelTurn=async()=>{await release.promise;};
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const first=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai phụ trách demo?',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:first+10,stamp:first+10});await tick(450);
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+200,text:'Khoan đã.',final:true});
    await tick(10);
    f.voice.hypothesis({channel:2,participant:'other',speakerKey:'s',startMs:start+210,endMs:start+650,text:'Ý tôi là dữ liệu riêng.',final:true});
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start+210,endMs:start+650,text:'Lan phụ trách demo.',final:true});
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start+210,endMs:start+650,text:'Ý tôi là sprint trước.',final:true});
    release.resolve();await tick(20);f.emit({event:'state',state:'LISTENING',generation:1});await tick(450);
    assert.equal(f.questions[1],'ai phụ trách demo?\nYêu cầu cập nhật: Ý tôi là sprint trước.');
    assert(!f.questions.join(' ').includes('dữ liệu riêng'));
  }finally{release.resolve();held.resolve('stopped');await f.voice.stop();}
});

test('a failed heard-prefix receipt still stops remotely but cannot resume with unreliable history',async()=>{
  const held=deferred<'stopped'>();let emit!:(v:Record<string,unknown>)=>void;
  let cancelled=0,calls=0;const states:string[]=[];
  const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
    answer:async()=>{calls++;return {text:'Lan phụ trách demo.'};},state:async(s)=>{states.push(s);},
    cancelTurn:async()=>{cancelled++;}},
    {speak:async(_text,_,started)=>{started?.();return held.promise;},stop:async()=>{held.resolve('stopped');}},
    async(_,state)=>{if(state==='stopped')throw new Error('Receipt unavailable');},
    onEvent=>{emit=onEvent;return {send:()=>true,close(){}};},()=>{});
  try{
    await voice.start();emit({event:'state',state:'LISTENING',generation:0});const first=Date.now()+1;await tick(5);
    voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai làm demo?',final:true});
    emit({event:'activity',channel:2,speech:false,endMs:first+10,stamp:first+10,generation:0});await tick(450);
    const next=Date.now()+1;await tick(5);
    voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:next,endMs:next+400,text:'Ý mình là sprint trước.',final:true});
    await tick(30);assert.equal(cancelled,1);assert.equal(states.at(-1),'ERROR');assert.equal(calls,1);
  }finally{held.resolve('stopped');await voice.stop();}
});

test('same-caller task refinement waits for cancellation and preserves the original goal without replaying old answers',async()=>{
  const old=deferred<{text:string}>(),fresh=deferred<{text:string}>(),cancelled=deferred<void>();let calls=0;
  const f=fixture(()=>calls++===0?old.promise:fresh.promise);
  const requests:Array<{id:string;signal:AbortSignal}>=[];
  const original=f.api.answer;
  f.api.answer=(q,id,rev,signal,speaker)=>{requests.push({id,signal});return original(q,id,rev,signal,speaker);};
  f.api.cancelTurn=async()=>{await cancelled.promise;};
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+10,text:'TINA ơi tổng hợp quyết định trong cuộc họp.',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+10,stamp:start+10});await tick(450);
    const update=Date.now()+1;await tick(5);
    const h={channel:2,participant:'p',speakerKey:'s',startMs:update,endMs:update+200,text:'Chỉ lấy phần backend thôi.',final:true};
    for(const patch of [{participant:'other'},{participant:undefined},{channel:3},{text:'đúng rồi'}])f.voice.hypothesis({...h,...patch});
    assert.equal(f.states.at(-1),'THINKING');assert.equal(requests.length,1);
    f.voice.hypothesis(h);await tick(20);
    assert(requests[0].signal.aborted);assert.equal(requests.length,1);
    old.resolve({text:'Câu trả lời cũ không được phát.'});await tick(20);assert.deepEqual(f.spoken,[]);
    cancelled.resolve();await tick(20);assert.equal(f.states.at(-1),'QUIET');
    f.emit({event:'state',state:'LISTENING',generation:1});await tick(450);
    assert.equal(f.questions[1],'tổng hợp quyết định trong cuộc họp.\nYêu cầu cập nhật: Chỉ lấy phần backend thôi.');
    assert.notEqual(requests[0].id,requests[1].id);assert.equal(f.speakerKeys[0],f.speakerKeys[1]);
    assert.equal(h.text,'Chỉ lấy phần backend thôi.');
    fresh.resolve({text:'Backend dùng PostgreSQL.'});await tick(50);
    assert.deepEqual(f.spoken,['Backend dùng PostgreSQL.']);
  }finally{cancelled.resolve();old.resolve({text:'old'});fresh.resolve({text:'new'});await f.voice.stop();}
});

test('successive refinements retain earlier restrictions and each late result stays fenced',async()=>{
  const results=[deferred<{text:string}>(),deferred<{text:string}>(),deferred<{text:string}>()];let calls=0;
  const f=fixture(()=>results[calls++].promise);
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+10,text:'TINA ơi tổng hợp quyết định cuộc họp.',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+10,stamp:start+10});await tick(450);
    for(const [index,text] of ['Chỉ lấy phần backend thôi.','Thêm người phụ trách và thời hạn.'].entries()){
      const stamp=Date.now()+1;await tick(5);
      f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:stamp,endMs:stamp+200,text,final:true});
      await tick(20);f.emit({event:'state',state:'LISTENING',generation:index+1});await tick(450);
    }
    assert.equal(f.questions.length,3);
    assert.equal(f.questions[2],'tổng hợp quyết định cuộc họp.\nYêu cầu cập nhật: Chỉ lấy phần backend thôi.\nYêu cầu cập nhật: Thêm người phụ trách và thời hạn.');
    results[2].resolve({text:'Backend: Lan phụ trách, hạn thứ Sáu.'});await tick(40);
    results[0].resolve({text:'Old first.'});results[1].resolve({text:'Old second.'});await tick(40);
    assert.deepEqual(f.spoken,['Backend: Lan phụ trách, hạn thứ Sáu.']);
  }finally{for(const result of results)result.resolve({text:'done'});await f.voice.stop();}
});

test('a failed cancellation never dispatches the replacement task or plays a late old answer',async()=>{
  const old=deferred<{text:string}>(),f=fixture(()=>old.promise);
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:start,endMs:start+10,text:'TINA ơi tổng hợp cuộc họp.',final:true});
    f.emit({event:'activity',channel:2,speech:false,endMs:start+10,stamp:start+10});await tick(450);
    f.api.cancelTurn=async()=>{throw new Error('Unavailable');};
    const update=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:2,participant:'p',speakerKey:'s',startMs:update,endMs:update+200,text:'Chỉ lấy phần backend thôi.',final:true});
    await tick(30);assert.equal(f.states.at(-1),'ERROR');
    old.resolve({text:'Late answer.'});await tick(30);
    assert.equal(f.questions.length,1);assert.deepEqual(f.spoken,[]);
  }finally{old.resolve({text:'old'});await f.voice.stop();}
});

test('explicit Stop cancels thinking; ordinary acknowledgments and late ASR cannot interrupt',async()=>{
  const pending=deferred<{text:string}>(),f=fixture(()=>pending.promise);
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});const first=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:1,participant:'p',speakerKey:'s',startMs:first,endMs:first+10,text:'TINA ơi ai làm?',final:true});
    f.emit({event:'activity',channel:1,speech:false,endMs:first+10,stamp:first+10});await tick(450);
    const start=Date.now()+1;await tick(5);
    const h={channel:1,participant:'p',speakerKey:'s',startMs:start,endMs:start+200,text:'Dừng lại.',final:true};
    f.voice.hypothesis({...h,text:'đúng rồi'});f.voice.hypothesis({...h,startMs:first-1000,endMs:first-500});
    assert.equal(f.states.at(-1),'THINKING');
    f.voice.hypothesis(h);await tick(20);assert.equal(f.states.at(-1),'QUIET');
    pending.resolve({text:'Câu trả lời bị hủy.'});await tick(950);
    assert.deepEqual(f.spoken,[]);assert.equal(f.questions.length,1);
  }finally{pending.resolve({text:'late'});await f.voice.stop();}
});

test('conversation scope uses hashed transport participant identity and omits unknown speakers', async () => {
  const f = fixture();
  try {
    await f.voice.start(); await f.capture();
    assert.deepEqual(f.speakerKeys, [undefined]);
  } finally { await f.voice.stop(); }
  const g = fixture();
  try {
    await g.voice.start(); g.emit({event:'state', state:'LISTENING'});
    const start = Date.now() + 1; await tick(5);
    g.voice.hypothesis({channel:0, speakerKey:'reused-channel', participant:'transport-id', startMs:start,
      endMs:start+10, text:'TINA ơi ai làm demo?', final:true});
    g.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20}); await tick(450);
    assert.match(g.speakerKeys[0]!, /^[0-9a-f]{64}$/);
    assert(!g.speakerKeys[0]!.includes('transport-id'));
    let sentHeaders: Headers | undefined;
    const api = voiceApi('http://voice.test','capability',async (_url, init) => {
      sentHeaders = new Headers(init?.headers); return Response.json({text:'Answer'});
    });
    await api.answer('Question', 'id', 1, new AbortController().signal, g.speakerKeys[0]);
    assert.equal(sentHeaders?.get('X-Voice-Speaker-Key'),g.speakerKeys[0]);
  } finally { await g.voice.stop(); }
});

test('TINA names are anchored, case-insensitive, and old greeting/substring calls do not activate', () => {
  for (const name of ['TINA', 'Tina', 'tina', 'TINA ơi', 'tina ƠI']) assert.equal(invocation(name + ', ai làm demo?'), 'ai làm demo?');
  for (const text of ['Hey TINA, hỏi nhé', 'Hi TINA', 'Tinas làm gì', 'retina', 'Tôi muốn hỏi TINA']) assert.equal(invocation(text), null);
  assert.equal(invocation('Ti Na ơi, ai làm?', ['ti na ơi']), 'ai làm?');
});
test('raw drafts need agreement, corrections are respected, duplicate/late windows cannot repeat a turn', () => {
  let now = 1000; const t = new VoiceTrigger(() => now); t.reset(0);
  const h = { channel: 0, speakerKey: 's', startMs: 100, endMs: 500, text: 'Tina ai làm?', final: false };
  assert.equal(t.feed(h), 'update'); assert.equal(t.active, false);
  assert.equal(t.feed({ ...h, text: 'Minh ai làm?' }), 'discard');
  t.reset(0); t.feed(h); assert.equal(t.feed({ ...h, text: 'Tina ai làm demo?' }), 'wake');
  now += 350; assert.equal(t.question(500), 'ai làm demo?');
  t.reset(1000); assert.equal(t.feed(h), 'ignore');
});
test('timed fresh speech can invoke after rearm despite an old channel onset and retained words', () => {
  let now = 5000;
  const t = new VoiceTrigger(() => now); t.reset(2000);
  const old = { text: 'TINA ơi câu hỏi cũ?', startMs: 100, endMs: 1000 };
  const fresh = { text: 'TINA ơi ai làm demo?', startMs: 3500, endMs: 4100 };
  const h = { channel: 0, speakerKey: 's', startMs: 0, endMs: 4200, speechStartMs: 100,
    text: old.text + ' ' + fresh.text, final: false, segments: [old, fresh] };
  const original = structuredClone(h);
  assert.equal(t.feed(h), 'update'); assert.equal(t.active, false);
  assert.equal(t.feed({ ...h, final: true }), 'wake');
  now += 350; assert.equal(t.question(4100), 'ai làm demo?');
  assert.equal(t.heard?.text, fresh.text); assert.deepEqual(h, original);
  t.reset(4500); assert.equal(t.feed(h), 'ignore'); assert.equal(t.reason, 'stale_asr');
  assert.equal(t.feed({ ...h, startMs: 4600, endMs: 5000, text: fresh.text, segments: undefined, final: true }), 'wake',
    'a wholly fresh source window cannot contain the old speech even if the channel onset is retained');
});
test('retained windows cannot relabel old, unaligned, overlapping or untimed words as a new invocation', () => {
  const t = new VoiceTrigger(() => 5000);
  const old = { text: 'TINA ơi câu hỏi cũ?', startMs: 100, endMs: 1000 };
  const fresh = { text: 'ai làm demo?', startMs: 3500, endMs: 4100 };
  const h = { channel: 0, speakerKey: 's', startMs: 0, endMs: 4200, speechStartMs: 100,
    text: old.text + ' ' + fresh.text, final: true, segments: [old, fresh] };
  t.reset(2000); assert.equal(t.feed(h), 'ignore'); assert.equal(t.reason, 'name_not_matched');
  for (const segments of [undefined, [old], [{ ...old, endMs: 3600 }, fresh],
    [{ ...old, startMs: NaN }, fresh], [old, { ...fresh, startMs: 1900 }],
    [old, { ...fresh, text: 'TINA ơi ai làm demo?' }], [old, { ...fresh, endMs: 5000 }]]) {
    t.reset(2000); assert.equal(t.feed({ ...h, segments }), 'ignore');
    assert.equal(t.reason, 'stale_asr'); assert.equal(t.active, false);
  }
});
test('the bot answers only the fresh timed question and diagnoses its prefix without rewriting raw ASR', async () => {
  const f = fixture();
  try {
    await f.voice.start(); f.emit({ event: 'state', state: 'LISTENING' });
    const start = Date.now() + 1; await tick(5);
    const h = { channel: 0, speakerKey: 's', startMs: start - 2000, endMs: start + 10,
      speechStartMs: start - 2000, text: 'Lời trước đó. Tina ơi, ai phụ trách demo?', final: true,
      segments: [{ text: 'Lời trước đó.', startMs: start - 2000, endMs: start - 1000 },
        { text: 'Tina ơi, ai phụ trách demo?', startMs: start, endMs: start + 10 }] };
    f.voice.hypothesis(h);
    f.emit({ event: 'activity', channel: 0, speech: false, endMs: start + 10, stamp: start + 20 });
    await tick(450);
    assert.deepEqual(f.questions, ['ai phụ trách demo?']);
    assert(f.diagnostics.some(d => d.heard_prefix === 'Tina ơi, ai'));
    assert.equal(h.text, 'Lời trước đó. Tina ơi, ai phụ trách demo?');
  } finally { await f.voice.stop(); }
});
test('window assembly replaces overlapping drafts only at verified source boundaries', () => {
  let now = 1000; const t = new VoiceTrigger(() => now); t.reset(0);
  t.feed({ channel: 0, speakerKey: 's', startMs: 100, endMs: 600, text: 'Tina ai làm? Hạn khi nào?', final: true,
    segments: [{ text: 'Tina ai làm?', startMs: 100, endMs: 400 }, { text: 'Hạn khi nào?', startMs: 400, endMs: 600 }] });
  t.feed({ channel: 0, speakerKey: 's', startMs: 400, endMs: 700, text: 'Hạn là khi nào?', final: false });
  now += 350; assert.equal(t.question(700), 'ai làm? Hạn là khi nào?');
  assert.equal(t.question(1200), null, 'new speech not yet covered must wait for ASR');
  assert.equal(t.feed({ channel: 0, speakerKey: 's', startMs: 500, endMs: 900, text: 'không rõ', final: false }), 'discard');
});
test('same-channel continuation is collected after a standalone name; other channels never supply the question', () => {
  let now = 1000; const t = new VoiceTrigger(() => now); t.reset(0);
  t.feed({ channel: 0, speakerKey: 'a', startMs: 100, endMs: 300, text: 'TINA ơi', final: true });
  assert.equal(t.feed({ channel: 1, speakerKey: 'b', startMs: 400, endMs: 600, text: 'Ai làm?', final: true }), 'ignore');
  t.feed({ channel: 0, speakerKey: 'c', startMs: 400, endMs: 700, text: 'Ai làm demo?', final: true });
  now += 350; assert.equal(t.question(700), 'Ai làm demo?');
});
test('question reuses existing ASR text and validated answer plays as ordered sentences', async () => {
  const f = fixture(); try { await f.voice.start(); await f.capture();
    assert.deepEqual(f.questions, ['ai phụ trách demo?']);
    assert.deepEqual(f.spoken, ['Lan phụ trách demo.', 'Hạn là thứ Sáu.']);
    assert.deepEqual(f.reports, ['started', 'completed']); assert.equal(f.states.at(-1), 'QUIET');
  } finally { await f.voice.stop(); }
});
test('Stop cancels thought, drops late answer and fences previously captured ASR results', async () => {
  const pending = deferred<{ text: string }>(); const f = fixture(() => pending.promise);
  try { await f.voice.start(); await f.capture(); await f.voice.external({ action: 'speak_stop' }, async () => {});
    pending.resolve({ text: 'late answer' }); await tick(20);
    assert.deepEqual(f.spoken, []);
    assert(!f.states.includes('SPEAKING'));
    const timing = f.logs.filter(v => v.startsWith('{')).map(v => JSON.parse(v)).at(-1);
    assert.equal(timing.outcome, 'stopped'); assert.equal(timing.stages_at_ms.answer_playback_started, undefined);
  } finally { pending.resolve({ text: 'late' }); await f.voice.stop(); }
});
test('revoked sources prevent answer playback; departure cancels all subsequent sentence playback', async () => {
  const pending = deferred<{ text: string }>(); const f = fixture(() => pending.promise);
  try { await f.voice.start(); await f.capture(); f.setConfig({ enabled: true, ready: true, revision: 2, wake_variants: [] });
    pending.resolve({ text: 'revoked answer' }); await tick(20);
    assert.deepEqual(f.spoken, []);
  } finally { pending.resolve({ text: 'late' }); await f.voice.stop(); }
});
test('optional participant identity does not drop per-channel VAD audio', async () => {
  const f = fixture(); try { await f.voice.start(); f.emit({ event: 'state', state: 'LISTENING' });
    f.voice.feed(3, new Float32Array(320), Date.now(), null);
    assert(f.sent.some(v => (v as {type: string}).type === 'audio'));
  } finally { await f.voice.stop(); }
});
test('Vietnamese sentence split preserves original response content and bounded chunks', () => {
  const text = 'Chi phí 1.5 triệu đồng. Lan làm demo! Hạn thứ Sáu?';
  assert.equal(speechSentences(text).join(' '), text);
  assert(speechSentences(('từ ').repeat(300)).every(part => part.length <= 360));
});


test('Stop during the first answer sentence prevents all following sentences', async () => {
  const held = deferred<'stopped'>(); const played: string[] = [];
  const f = fixture(undefined, { async speak(text, _, started) {
    played.push(text); started?.();
    return text === 'Lan phụ trách demo.' ? held.promise : 'completed';
  }, async stop() { held.resolve('stopped'); } });
  try {
    await f.voice.start(); await f.capture();
    assert.deepEqual(played, ['Lan phụ trách demo.']);
    await f.voice.external({ action: 'speak_stop' }, async () => {}); await tick(20);
    assert.equal(played.includes('Hạn là thứ Sáu.'), false);
  } finally { held.resolve('stopped'); await f.voice.stop(); }
});

test('late ASR replay after rearm cannot answer the same question again', async () => {
  const f = fixture();
  try {
    await f.voice.start(); await f.capture();
    f.emit({ event: 'state', state: 'LISTENING' });
    f.voice.hypothesis({channel:0,speakerKey:'ch-0:1',startMs:Date.now()-10000,endMs:Date.now()-9000,text:'TINA ơi ai phụ trách demo?',final:true});
    await tick(20); assert.equal(f.questions.length, 1);
  } finally { await f.voice.stop(); }
});


test('default Vietnamese ASR name aliases need no room variants and invoke only at the utterance prefix', () => {
  const aliases = ['ti na ơi', 'tiên na ơi', 'tinh anh ơi','tin anh ơi'];
  for (const name of aliases) {
    assert.equal(invocation(name), '');
    assert.equal(invocation(name + ', ai phụ trách demo?'), 'ai phụ trách demo?');
    assert.equal(invocation(name.toLocaleUpperCase('vi') + ', ai phụ trách demo?',[]), 'ai phụ trách demo?');
    assert.equal(invocation('Tôi gọi '+name),null);
    assert.equal(invocation(name+'abc hỏi nhé'),null);
  }
  for (const line of ['Anh ơi, ai phụ trách demo?', 'Tôi nói tiên na ơi', 'Tôi nhắn tin ơi']) assert.equal(invocation(line, aliases), null);
  for(const line of ['tin ơi, ai phụ trách demo?','TIN ƠI, ai phụ trách demo?'])assert.equal(invocation(line),'ai phụ trách demo?');
});

test('all default Vietnamese variants capture a question without a saved alias list',async()=>{
  for(const prefix of ['ti na ơi','tiên na ơi','tinh anh ơi','tin anh ơi']){
    const f=fixture();try{await f.voice.start();await f.capture(prefix+', ai phụ trách demo?');
      assert.deepEqual(f.questions,['ai phụ trách demo?']);
    }finally{await f.voice.stop();}
  }
});


test('diagnostics explain name mismatch with only three prefix words and never log the question', async () => {
  const f = fixture();
  try {
    await f.voice.start(); f.emit({event:'state',state:'LISTENING'});
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:0,speakerKey:'s',startMs:start,endMs:start+10,text:'tinh em ơi PRIVATE QUESTION BODY',final:true});
    await tick(20);
    const detail=f.diagnostics.at(-1)!;
    assert.equal(detail.code,'name_not_matched');assert.equal(detail.heard_prefix,'tinh em ơi');
    assert(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
    assert(!f.logs.join(' ').includes('tinh em')&&!f.logs.join(' ').includes('PRIVATE'));
    assert.equal(f.questions.length,0);
  }finally{await f.voice.stop();}
});

test('diagnostics distinguish waiting for speech to end from missing ASR tail', async () => {
  const f=fixture();
  try{
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:0,speakerKey:'s',startMs:start,endMs:start+10,text:'TINA ơi, ai làm?',final:true});
    await tick(20);assert.equal(f.diagnostics.at(-1)?.code,'waiting_speech_end');
    f.emit({event:'activity',channel:0,speech:false,endMs:start+500,stamp:start+500});
    await tick(120);assert.equal(f.diagnostics.at(-1)?.code,'waiting_asr_tail');
    assert.equal(f.questions.length,0);
  }finally{await f.voice.stop();}
});

test('missing evidence and upstream failure stay visible after the turn settles', async () => {
  const f=fixture(async()=>({text:'Chưa đủ thông tin.',evidence_available:false}));
  try{await f.voice.start();await f.capture();assert.equal(f.diagnostics.at(-1)?.code,'no_evidence');}
  finally{await f.voice.stop();}
  const g=fixture(async()=>{throw new Error('PRIVATE PROVIDER ERROR');});
  try{await g.voice.start();await g.capture();assert.equal(g.diagnostics.at(-1)?.code,'answer_failed');
    assert(!g.logs.join(' ').includes('PRIVATE'));}
  finally{await g.voice.stop();}
});

test('not-ready services emit a reason instead of presenting a listening worker', async () => {
  const f=fixture();f.setConfig({enabled:true,ready:false,revision:1,wake_variants:[]});
  try{await f.voice.start();await tick(20);assert.equal(f.diagnostics.at(-1)?.code,'services_unavailable');
    assert(!f.states.includes('LISTENING'));}
  finally{await f.voice.stop();}
});


test('a rejected native control stays ERROR and cannot proceed into a misleading THINKING state', async () => {
  let event!: (value: Record<string,unknown>) => void;
  const states:string[]=[],details:VoiceDiagnostic[]=[];let answered=0;
  const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
    answer:async()=>{answered++;return{text:'must not answer'};},state:async(state,_,detail)=>{states.push(state);if(detail)details.push(detail);}},
    {async speak(){throw new Error('must not speak');},async stop(){}},async()=>{},
    callback=>{event=callback;return{send:message=>(message as {type:string}).type!=='control',close(){}};},()=>{});
  try{
    await voice.start();event({event:'state',state:'LISTENING',generation:0});const start=Date.now()+1;await tick(5);
    voice.hypothesis({channel:0,speakerKey:'s',startMs:start,endMs:start+10,text:'Tina ơi, ai làm?',final:true});
    event({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+10,generation:0});await tick(450);
    assert.equal(states.at(-1),'ERROR');assert.equal(details.at(-1)?.code,'worker_failed');assert.equal(answered,0);
    assert(!states.includes('THINKING'));
  }finally{await voice.stop();}
});

test('fast answer timing has no redundant acknowledgment and includes no question or response text', async () => {
  const f = fixture();
  try {
    await f.voice.start(); f.emit({ event: 'state', state: 'LISTENING' });
    const start = Date.now() + 1; await tick(5);
    f.voice.hypothesis({ channel: 0, speakerKey: 's', startMs: start, endMs: start + 10,
      text: 'TINA ơi PRIVATE QUESTION', final: true, asrStartedAtMs: start, asrCompletedAtMs: start + 4 });
    f.emit({ event: 'activity', channel: 0, speech: false, endMs: start + 10, stamp: start + 20 });
    await tick(450);
    const timings = f.logs.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const last = timings.at(-1);
    assert.equal(last.type, 'voice_timing'); assert.equal(last.outcome, 'completed');
    assert.equal(last.durations_ms.asr_request, 4);
    assert.equal(last.stages_at_ms.speech_end, start + 10);
    for (const stage of ['wake_confirmed', 'vad_detected', 'asr_received', 'question_ready', 'answer_requested',
      'answer_received', 'answer_playback_started', 'turn_finished']) assert.equal(typeof last.stages_at_ms[stage], 'number');
    assert.equal(last.stages_at_ms.ack_playback_started, undefined);
    assert.equal(new Set(timings.map(t => t.request_id)).size, 1);
    assert(!JSON.stringify(timings).includes('PRIVATE')); assert(!JSON.stringify(timings).includes('Lan'));
  } finally { await f.voice.stop(); }
});

test('voice timing records first answer PCM separately from buffering, mic injection and waiting notices', async () => {
  let sequence=0;
  const snapshots:Array<{requestedAtMs:number;firstPcmAtMs:number;readyAtMs:number;playbackAtMs:number}>=[];
  const f=fixture(undefined,{
    async stop(){},async speak(){return 'completed';},
    prepare(){const base=Date.now()+sequence++*50;
      const timing={requestedAtMs:base,firstPcmAtMs:base+10,readyAtMs:base+15,playbackAtMs:base+20};
      snapshots.push(timing);
      return {ready:Promise.resolve(true),timing,cancel(){},async play(started){started?.(timing);return 'completed';}};
    },
  });
  try {
    await f.voice.start();await f.capture();
    const last=f.logs.filter(v=>v.startsWith('{')).map(v=>JSON.parse(v)).at(-1);
    assert.equal(last.stages_at_ms.answer_pcm_received,snapshots[0].firstPcmAtMs);
    assert.equal(last.stages_at_ms.answer_playback_started,snapshots[0].playbackAtMs);
    assert.equal(last.durations_ms.answer_first_pcm,10);
    assert.equal(last.durations_ms.answer_prebuffer,5);
    assert.equal(last.durations_ms.answer_mic_start_after_buffer,5);
    assert.equal(last.durations_ms.answer_pcm_after_end,Math.max(0,snapshots[0].firstPcmAtMs-last.stages_at_ms.speech_end));
    assert.equal(last.stages_at_ms.notice_playback_started,undefined);
    assert.equal(last.stages_at_ms.ack_playback_started,undefined);
    assert.equal(snapshots.length,2);
  }finally{await f.voice.stop();}
});

test('VAD short-call ingress crosses the bot adapter once and preserves canonical transcript', async () => {
  let emit!: (value: Record<string, unknown>) => void;
  let pipe: BotPipeline | undefined;
  let calls = 0; const questions: string[] = [], transcript: string[] = [];
  const voice = new MeetingVoice({ config: async () => ({ enabled: true, ready: true, revision: 1 }),
    answer: async question => { questions.push(question); return { text: 'Câu trả lời.' }; }, state: async () => {} },
    { async speak(_, __, started) { started?.(); return 'completed'; }, async stop() {} }, async () => {},
    callback => { emit = callback; return { send: () => true, close() {} }; }, () => {}, async () => true,
    (channel, end) => pipe?.requestEndpoint?.(channel, end));
  pipe = createBotPipeline({ platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij',
    botName: 'TINA', redisUrl: 'redis://localhost', transcribeEnabled: true },
    { async publish(segment) { if (segment.completed) transcript.push(segment.text); } },
    { config: { submitInterval: 3600 }, onHypothesis: value => voice.hypothesis(value),
      transcribe: async () => { calls++; return { text: 'TINA ơi ai làm demo?' }; } });
  try {
    await voice.start(); emit({ event: 'state', state: 'LISTENING', generation: 0 });
    const start = Date.now() + 1; await tick(5);
    pipe.feedAudio(0, 'Speaker', new Float32Array(8000).fill(.1), start, null, 0);
    const ended = { event: 'activity', channel: 0, speech: false, endMs: start + 500, stamp: start + 1000, generation: 0 };
    emit(ended); emit(ended); await tick(450);
    assert.equal(calls, 1, 'short speech must not wait for the regular two-second minimum');
    assert.deepEqual(questions, ['ai làm demo?']);
    await pipe.stop(); assert.equal(calls, 1); assert.deepEqual(transcript, ['TINA ơi ai làm demo?']);
    await voice.stop(); emit(ended); assert.equal(calls, 1, 'late VAD after departure cannot submit');
  } finally { await voice.stop(); await pipe.stop(); }
});

test('continuous low background does not block a fresh timed call or change its original transcript request', async () => {
  let emit!: (value: Record<string, unknown>) => void;
  let pipe: BotPipeline | undefined;
  let calls = 0; const questions: string[] = [], transcript: string[] = [];
  const text = 'Lời trước đó. TINA ơi ai làm demo?';
  const voice = new MeetingVoice({ config: async () => ({ enabled: true, ready: true, revision: 1 }),
    answer: async question => { questions.push(question); return { text: 'Câu trả lời.' }; }, state: async () => {} },
    { async speak(_, __, started) { started?.(); return 'completed'; }, async stop() {} }, async () => {},
    callback => { emit = callback; return { send: () => true, close() {} }; }, () => {}, async () => true,
    (channel, end) => pipe?.requestEndpoint?.(channel, end));
  pipe = createBotPipeline({ platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij',
    botName: 'TINA', redisUrl: 'redis://localhost', transcribeEnabled: true },
    { async publish(segment) { if (segment.completed) transcript.push(segment.text); } },
    { config: { submitInterval: 3600 }, onHypothesis: value => voice.hypothesis(value),
      transcribe: async pcm => { calls++; assert.equal(pcm.length, 56160); return { text,
        segments: [{ text: 'Lời trước đó.', start: 0, end: 1 }, { text: 'TINA ơi ai làm demo?', start: 3.5, end: 3.51 }] }; } });
  try {
    await voice.start(); emit({ event: 'state', state: 'LISTENING', generation: 0 });
    const start = Date.now() + 1; await tick(5);
    pipe.feedAudio(0, 'Speaker', new Float32Array(16000).fill(.1), start - 3500, null, 0);
    pipe.feedAudio(0, 'Speaker', new Float32Array(40000).fill(.001), start - 2500, null, 16000);
    pipe.feedAudio(0, 'Speaker', new Float32Array(160).fill(.1), start, null, 56000);
    emit({ event: 'activity', channel: 0, speech: false, endMs: start + 10, stamp: start + 20, generation: 0 });
    await tick(450);
    assert.equal(calls, 1); assert.deepEqual(questions, ['ai làm demo?']);
    await pipe.stop(); assert.equal(calls, 1); assert.deepEqual(transcript, [text]);
  } finally { await voice.stop(); await pipe.stop(); }
});

test('an ASR tail shorter than one capture frame is still required before answering', () => {
  let now = 1000; const trigger = new VoiceTrigger(() => now); trigger.reset(0);
  trigger.feed({ channel: 0, speakerKey: 's', startMs: 100, endMs: 700, text: 'TINA ơi ai làm?', final: true });
  now += 350;
  assert.equal(trigger.question(900), null, '200 ms can contain the last word');
  assert.equal(trigger.question(701), 'ai làm?');
});

test('fresh speech with retained pre-roll can wake after rearm, but previous speech cannot', () => {
  const trigger = new VoiceTrigger(() => 4000); trigger.reset(2000);
  const h = { channel: 0, speakerKey: 's', startMs: 1900, endMs: 2700, speechStartMs: 2100,
    text: 'TINA ơi ai làm?', final: true };
  assert.equal(trigger.feed(h), 'wake');
  trigger.reset(2000); assert.equal(trigger.feed({...h, speechStartMs: 1900}), 'ignore');
  trigger.reset(2000); assert.equal(trigger.feed({...h, speechStartMs: NaN}), 'ignore');
  trigger.reset(2000); assert.equal(trigger.feed({...h, speechStartMs: 2800}), 'ignore');
});

test('audio/ASR numbers reach status snapshots while question text stays outside them', async () => {
  const f=fixture();
  try {
    await f.voice.start();f.emit({event:'state',state:'LISTENING'});
    f.voice.feed(0,new Float32Array(1024).fill(.1),Date.now()-100,null,0);
    f.voice.asrDiagnostic({channel:0,request:1,stage:'started',at_ms:Date.now(),capture_age_ms:20});
    f.voice.asrDiagnostic({channel:0,request:1,stage:'completed',at_ms:Date.now(),roundtrip_ms:40,queue_ms:10});
    await f.capture('TINA ơi PRIVATE QUESTION');
    const channel=f.audio.flatMap(s=>s.channels).find(r=>r.queue_ms===10);
    assert.equal(channel?.frames,1);assert.equal(channel?.roundtrip_ms,40);
    assert(!JSON.stringify(f.audio).includes('PRIVATE'));assert(!JSON.stringify(f.audio).includes('pcm'));
  } finally {await f.voice.stop();}
});


test('one sentence is prefetched during playback and Stop or policy revocation prevents its playback', async () => {
  for(const stop of [true,false]){
    const first=deferred<'completed'|'stopped'>();const prepared:string[]=[],played:string[]=[],cancelled:string[]=[];
    const player:SpeakController={
      async speak(){return 'completed';},async stop(){first.resolve('stopped');},
      prepare(text){prepared.push(text);return{ready:Promise.resolve(true),cancel(){cancelled.push(text);},
        async play(notify){played.push(text);notify?.();return text.startsWith('Lan')?first.promise:'completed';}};}
    };
    const f=fixture(undefined,player);
    try{
      await f.voice.start();await f.capture();
      assert.deepEqual(prepared,['Lan phụ trách demo.','Hạn là thứ Sáu.']);
      assert.deepEqual(played,['Lan phụ trách demo.']);
      if(stop)await f.voice.external({action:'speak_stop'},async()=>{});
      else {f.setConfig({enabled:true,ready:true,revision:2,wake_variants:[]});first.resolve('completed');}
      await tick(30);
      assert.deepEqual(played,['Lan phụ trách demo.']);assert(cancelled.includes('Hạn là thứ Sáu.'));
      assert(!f.reports.includes('completed'));
    }finally{first.resolve('stopped');await f.voice.stop();}
  }
});

test('successful lookahead plays every sentence once in order with at most two prepared handles', async () => {
  const first=deferred<'completed'>();const prepared:string[]=[],played:string[]=[];
  let handles=0,maxHandles=0,players=0;
  const player:SpeakController={async speak(){return 'completed';},async stop(){first.resolve('completed');},
    prepare(text){prepared.push(text);handles++;maxHandles=Math.max(maxHandles,handles);let closed=false;
      const release=()=>{if(!closed){closed=true;handles--;}};
      return{ready:Promise.resolve(true),cancel:release,async play(notify){
        assert.equal(players,0);players++;played.push(text);notify?.();
        if(text.startsWith('Lan'))await first.promise;
        players--;release();return 'completed';
      }};
    }};
  const f=fixture(async()=>({text:'Lan phụ trách demo. Hạn là thứ Sáu. Minh kiểm thử.'}),player);
  try{
    await f.voice.start();await f.capture();assert.equal(prepared.length,2);assert.equal(played.length,1);
    first.resolve('completed');await tick(40);
    assert.deepEqual(played,['Lan phụ trách demo.','Hạn là thứ Sáu.','Minh kiểm thử.']);
    assert.deepEqual(prepared,played);assert.equal(maxHandles,2);assert.equal(handles,0);
    assert.deepEqual(f.reports,['started','completed']);
  }finally{first.resolve('completed');await f.voice.stop();}
});

test('a standalone name is acknowledged, then the same caller can ask without repeating the name', async () => {
  const f=fixture();
  try {
    await f.voice.start(); await f.capture('TINA ơi');
    assert.deepEqual(f.spoken,['Dạ, em nghe.']); assert.deepEqual(f.questions,[]);
    assert.equal(f.states.at(-1),'QUIET');
    f.emit({event:'state',state:'LISTENING'});
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:1,speakerKey:'other',startMs:start,endMs:start+10,text:'Câu hỏi người khác',final:true});
    assert.equal(f.questions.length,0);
    f.voice.hypothesis({channel:0,speakerKey:'ch-0:2',startMs:start,endMs:start+10,text:'ai phụ trách demo?',final:true});
    f.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20});await tick(450);
    assert.deepEqual(f.questions,['ai phụ trách demo?']);
    assert.deepEqual(f.spoken,['Dạ, em nghe.','Lan phụ trách demo.','Hạn là thứ Sáu.']);
  } finally {await f.voice.stop();}
});

test('a slow follow-up gets one waiting notice even after the wake acknowledgment',async()=>{
  const reply=deferred<{text:string}>(), f=fixture(()=>reply.promise);
  try {
    await f.voice.start();await f.capture('TINA ơi');
    f.emit({event:'state',state:'LISTENING'});
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:0,speakerKey:'ch-0:2',startMs:start,endMs:start+10,text:'Ai phụ trách demo?',final:true});
    f.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20});
    await tick(1500);assert.deepEqual(f.spoken,['Dạ, em nghe.']);
    await tick(3000);assert.deepEqual(f.spoken,['Dạ, em nghe.',VOICE_NOTICES.wait[0]]);
    await tick(1000);assert.equal(f.spoken.length,2);
    reply.resolve({text:'Lan phụ trách demo.'});await tick(50);
    assert.equal(f.spoken.at(-1),'Lan phụ trách demo.');
  } finally {reply.resolve({text:'Lan phụ trách demo.'});await f.voice.stop();}
});

test('continuation has a bounded source-clock and participant fence and preserves raw hypotheses',()=>{
  let now=1000;const t=new VoiceTrigger(()=>now);t.continueAfter(1000,{channel:2,participant:'p1'});
  const h={channel:2,speakerKey:'new-turn',participant:'p1',startMs:1100,endMs:1400,text:'Ai làm demo?',final:true};
  assert.equal(t.feed({...h,startMs:500,endMs:900}),'ignore');assert.equal(t.reason,'stale_asr');
  assert.equal(t.feed({...h,participant:'p2'}),'ignore');
  assert.equal(t.feed({...h,participant:null}),'ignore');
  assert.equal(t.feed({...h,channel:3}),'ignore');
  const before=structuredClone(h);assert.equal(t.feed(h),'wake');now=1800;
  assert.equal(t.question(1400),'Ai làm demo?');assert(t.answeringContinuation);assert.deepEqual(h,before);
  t.continueAfter(2000,{channel:2});now=12001;
  assert.equal(t.feed({...h,startMs:11500,endMs:12000,participant:null}),'ignore');
});

test('Stop or failed acknowledgment never leaves an armed continuation or dispatches a name-only LLM call',async()=>{
  const held=deferred<'completed'>();const player:SpeakController={async speak(){return held.promise;},async stop(){held.resolve('completed');}};
  const f=fixture(undefined,player);
  try {
    await f.voice.start();await f.capture('tin anh ơi');
    await f.voice.external({action:'speak_stop'},async()=>{});held.resolve('completed');await tick(20);
    f.emit({event:'state',state:'LISTENING',generation:1});
    const start=Date.now()+1;await tick(5);
    f.voice.hypothesis({channel:0,speakerKey:'s',startMs:start,endMs:start+10,text:'Ai làm demo?',final:true});
    f.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20,generation:1});await tick(350);
    assert.deepEqual(f.questions,[]);
  } finally {held.resolve('completed');await f.voice.stop();}
  const g=fixture(undefined,{async speak(){return 'failed';},async stop(){}});
  try {await g.voice.start();await g.capture('TINA ơi');assert.equal(g.diagnostics.at(-1)?.code,'playback_failed');assert.deepEqual(g.questions,[]);}
  finally {await g.voice.stop();}
});

test('an immediate follow-up spoken during acknowledgment cooldown is retained until quiet rearm', async()=>{
 const f=fixture();try{
  await f.voice.start();await f.capture('TINA ơi');
  assert.deepEqual(f.spoken,['Dạ, em nghe.']);
  const start=Date.now()+1;await tick(5);
  f.voice.hypothesis({channel:0,speakerKey:'ch-0:2',startMs:start,endMs:start+10,text:'ai phụ trách demo?',final:true});
  f.emit({event:'activity',channel:0,speech:false,endMs:start+10,stamp:start+20});
  await tick(350);assert.deepEqual(f.questions,[]);
  f.emit({event:'state',state:'LISTENING'});await tick(450);
  assert.deepEqual(f.questions,['ai phụ trách demo?']);assert.equal(f.spoken.filter(x=>x==='Dạ, em nghe.').length,1);
 }finally{await f.voice.stop();}
});

test('a pure echo of any fixed notice cannot consume the pending question slot',()=>{
 for(const notice of Object.values(VOICE_NOTICES).flat()){
  let now=2000;const t=new VoiceTrigger(()=>now);t.continueAfter(1000,{channel:0});
  const h={channel:0,speakerKey:'s',startMs:1100,endMs:1200,text:notice.toUpperCase().normalize('NFD'),final:true};
  assert.equal(t.feed(h),'ignore');assert(!t.active);
  assert.equal(t.feed({...h,startMs:1300,endMs:1500,text:'Ai làm demo?'}),'wake');
  now+=350;assert.equal(t.question(1500),'Ai làm demo?');
 }
});


test('failed optional acknowledgment does not discard a verified answer; Stop still fences late answers', async () => {
  for (const failure of ['failed', 'rejected', 'stopped'] as const) {
    const result = deferred<{text: string}>(), ackStarted = deferred<void>();
    const spoken: string[] = [];
    const f = fixture(() => result.promise, {
      async speak(text, _, started) {
        spoken.push(text);
        if (text === VOICE_NOTICES.wait[0]) {
          ackStarted.resolve();
          if (failure === 'rejected') throw Error('synthetic acknowledgment failure');
          return 'failed';
        }
        started?.(); return 'completed';
      }, async stop() {},
    });
    try {
      await f.voice.start(); await f.capture();
      await Promise.race([ackStarted.promise, tick(2000).then(() => { throw Error('Acknowledgment did not start'); })]);
      if (failure === 'stopped') await f.voice.external({action: 'speak_stop'}, async () => {});
      result.resolve({text: 'Lan phụ trách demo.'}); await tick(40);
      assert.deepEqual(spoken, failure === 'stopped' ? [VOICE_NOTICES.wait[0]] : [VOICE_NOTICES.wait[0], 'Lan phụ trách demo.']);
      assert.equal(f.reports.includes('completed'), failure !== 'stopped');
    } finally { result.resolve({text: 'Lan phụ trách demo.'}); await f.voice.stop(); }
  }
});

test('expired unplayed lookahead is retried once at playback time, respecting Stop and changed policy', async () => {
  for (const scenario of ['recovered', 'unavailable', 'stopped', 'revoked'] as const) {
    const first = deferred<'completed' | 'stopped'>();
    const prepared: string[] = [], played: string[] = [];
    let nextAttempts = 0;
    const player: SpeakController = {
      async speak() { throw Error('Unexpected unprepared playback'); },
      async stop() { first.resolve('stopped'); },
      prepare(text) {
        prepared.push(text);
        const firstSentence = text.startsWith('Lan');
        const ready = firstSentence || ++nextAttempts === 2 && scenario === 'recovered';
        return {ready: Promise.resolve(ready), cancel() {}, async play(started) {
          if (!ready) return 'failed';
          played.push(text); started?.();
          return firstSentence ? first.promise : 'completed';
        }};
      },
    };
    const f = fixture(undefined, player);
    try {
      await f.voice.start(); await f.capture();
      assert.deepEqual(prepared, ['Lan phụ trách demo.', 'Hạn là thứ Sáu.']);
      assert.deepEqual(played, ['Lan phụ trách demo.']);
      if (scenario === 'stopped') await f.voice.external({action: 'speak_stop'}, async () => {});
      if (scenario === 'revoked') f.setConfig({enabled: true, ready: true, revision: 2, wake_variants: []});
      first.resolve('completed'); await tick(40);
      assert.equal(nextAttempts, ['recovered', 'unavailable'].includes(scenario) ? 2 : 1);
      assert.deepEqual(played, scenario === 'recovered' ? ['Lan phụ trách demo.', 'Hạn là thứ Sáu.'] : ['Lan phụ trách demo.']);
      assert.equal(f.reports.includes('completed'), scenario === 'recovered');
      if (scenario === 'unavailable') assert(f.reports.includes('failed'));
    } finally { first.resolve('stopped'); await f.voice.stop(); }
  }
});

test('buffered lookahead failure is retried even during mic setup, but started audio is never retried', async () => {
  for (const scenario of ['buffered-failure', 'started-failure'] as const) {
    const first = deferred<'completed'>();
    let attempts = 0;
    const played: string[] = [];
    const f = fixture(undefined, {
      async speak() { throw Error('prepared playback required'); }, async stop() { first.resolve('completed'); },
      prepare(text) {
        const initial = text.startsWith('Lan'), number = initial ? 0 : ++attempts;
        let failed = false;
        return {ready: Promise.resolve(true), get failedBeforePlayback() { return failed; }, cancel() {}, async play(started) {
          if (!initial && number === 1) {
            if (scenario === 'started-failure') { played.push(text); started?.(); }
            else failed = true;
            return 'failed';
          }
          played.push(text); started?.(); if (initial) await first.promise;
          return 'completed';
        }};
      },
    });
    try {
      await f.voice.start(); await f.capture(); first.resolve('completed'); await tick(40);
      assert.equal(attempts, scenario === 'buffered-failure' ? 2 : 1);
      assert.deepEqual(played, ['Lan phụ trách demo.', 'Hạn là thứ Sáu.']);
      assert.equal(f.reports.includes('completed'), scenario === 'buffered-failure');
    } finally { first.resolve('completed'); await f.voice.stop(); }
  }
});

test('question waiting notices receive six seconds and short name acknowledgments retain three', async () => {
  const ready = deferred<void>(), answer = deferred<{text: string}>();
  const deadlines: Array<number | undefined> = [], spoken: string[] = [];
  const player: SpeakController = {async stop() {}, async speak(text, _voice, started, timeout) {
    spoken.push(text);
    if (isFixedVoiceNotice(text)) { deadlines.push(timeout); ready.resolve(); return 'failed'; }
    started?.(); return 'completed';
  }};
  const f = fixture(() => answer.promise, player);
  try {
    await f.voice.start(); await f.capture(); await ready.promise;
    answer.resolve({text: 'Lan phụ trách demo.'}); await tick(30);
    assert.deepEqual(deadlines, [6000]); assert(spoken.includes('Lan phụ trách demo.'));
  } finally { answer.resolve({text: 'Lan phụ trách demo.'}); await f.voice.stop(); }
  const g = fixture(undefined, player);
  try { await g.voice.start(); await g.capture('TINA ơi'); assert.deepEqual(deadlines, [6000, 3000]); }
  finally { await g.voice.stop(); }
});

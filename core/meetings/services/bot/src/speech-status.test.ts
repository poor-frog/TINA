import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { createSpeechHandler,createSpeechReporter } from './speech-status.js';
import { createTtsPlayback } from './tts-playback.js';
import { createSpeakController } from './capture-bridge.js';
import { parseAct } from './contracts.js';
import type { Invocation } from './config.js';

const id = '00000000-0000-4000-8000-000000000001';

test('configured prebuffer waits for enough PCM and sends only the signed profile',async()=>{
  let response!:import('node:http').ServerResponse;let body='';
  const server=createServer((request,res)=>{request.on('data',chunk=>body+=chunk);request.on('end',()=>{response=res;res.write(Buffer.alloc(9600));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const old=process.env.TTS_SERVICE_URL;process.env.TTS_SERVICE_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback=createTtsPlayback(()=>{},{setMute(){},prebufferMs:300,profile:()=> 'signed-profile'});
  const prepared=playback.prepare!('synthetic');let ready=false;void prepared.ready.then(value=>{ready=value;});
  try{
    const limit=Date.now()+2000;
    while(prepared.timing?.firstPcmAtMs===undefined&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,5));
    assert(prepared.timing?.firstPcmAtMs);assert.equal(ready,false);
    assert.equal(JSON.parse(body).profile,'signed-profile');
    response.write(Buffer.alloc(6000));assert.equal(await prepared.ready,true);
  }finally{prepared.cancel();response?.destroy();playback.stop();if(old===undefined)delete process.env.TTS_SERVICE_URL;else process.env.TTS_SERVICE_URL=old;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('speech timing separates first PCM, prebuffer and actual player input; Stop fences a delayed write', async () => {
  const previous=process.env.TTS_SERVICE_URL;
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>res.end(Buffer.alloc(8000)));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.TTS_SERVICE_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let writeDone:((error?:Error|null)=>void)|undefined,spawned=false,starts=0;
  const playback=createTtsPlayback(()=>{},{setMute(){},spawnProcess(){
    const child=new EventEmitter() as unknown as ChildProcess;
    const stdin=new Writable({write(_chunk,_encoding,done){writeDone=done;}});
    Object.assign(child,{stdin,stderr:new PassThrough(),kill(){child.emit('exit',null);return true;}});
    stdin.once('finish',()=>setImmediate(()=>child.emit('exit',0)));
    setImmediate(()=>{spawned=true;child.emit('spawn');});return child;
  }});
  try {
    for(const stop of [false,true]){
      writeDone=undefined;spawned=false;
      const pending=playback.prepare!('PRIVATE response');assert.equal(await pending.ready,true);
      const timing=(pending as any).timing;
      assert.equal(typeof timing.requestedAtMs,'number');assert(timing.firstPcmAtMs>=timing.requestedAtMs);
      assert(timing.readyAtMs>=timing.firstPcmAtMs);assert.equal(timing.playbackAtMs,undefined);
      const before=starts,playing=pending.play(()=>{starts++;});
      for(let i=0;i<100&&(!spawned||!writeDone);i++)await new Promise(r=>setTimeout(r,2));
      assert(spawned&&writeDone);assert.equal(starts,before,'spawn is not a playback receipt');
      if(stop)playback.stop();
      writeDone!();assert.equal(await playing,stop?'stopped':'completed');
      assert.equal(starts,before+(stop?0:1));
      if(!stop)assert((pending as any).timing.playbackAtMs>=timing.readyAtMs);
    }
  } finally {playback.stop();if(previous===undefined)delete process.env.TTS_SERVICE_URL;else process.env.TTS_SERVICE_URL=previous;
    await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('played text receipts stay ordered and never leak into the callback URL',async()=>{
  const bodies:unknown[]=[],urls:string[]=[];
  const report=createSpeechReporter({meetingApiCallbackUrl:'http://callback.test/lifecycle',internalSecret:'test',meeting_id:1,connectionId:'s'} as Invocation,
    async(url,init)=>{urls.push(String(url));bodies.push(JSON.parse(String(init?.body)));return new Response('{}');});
  await report(id,'started');await report(id,'started','Lan phụ trách.');await report(id,'stopped','Lan phụ trách.');
  assert.deepEqual(bodies.map((b:any)=>b.played_text),[undefined,'Lan phụ trách.','Lan phụ trách.']);
  assert(urls.every(url=>url==='http://callback.test/bots/internal/callback/speech'));
});

test('tracked command requires UUID and text; legacy acts remain accepted', () => {
  assert(parseAct({ action: 'speak', text: 'legacy' }));
  assert.equal(parseAct({ action: 'speech_speak', command_id: 'bad', text: 'hello' }), null);
  assert.equal(parseAct({ action: 'speech_speak', command_id: id, text: '' }), null);
  assert(parseAct({ action: 'speech_stop', command_id: id }));
});

test('stop before a delayed Speak tombstones its identity', async () => {
  let spoken = 0;
  const receipts: string[] = [];
  const handler = createSpeechHandler({ async speak() { spoken++; }, async stop() {} },
    async (_, state) => { receipts.push(state); });
  await handler({ action: 'speech_stop', command_id: id });
  await handler({ action: 'speech_speak', command_id: id, text: 'late result' });
  assert.equal(spoken, 0);
  assert.deepEqual(receipts, ['stopped', 'stopped']);
});

test('completion waits for the real playback promise and preserves started ordering', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const receipts: string[] = [];
  const handler = createSpeechHandler({ async speak(_, __, started) {
    started?.(); await barrier; return 'completed';
  }, async stop() {} }, async (_, state) => { receipts.push(state); });
  const speaking = handler({ action: 'speech_speak', command_id: id, text: 'synthetic' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(receipts, ['started']);
  release(); await speaking;
  assert.deepEqual(receipts, ['started', 'completed']);
});

test('cancellation survives more than 128 later Stops for the core receipt lifetime', async () => {
  let spoken = 0, clock = 0;
  const handler = createSpeechHandler({ async speak() { spoken++; }, async stop() {} },
    async () => {}, () => clock);
  await handler({ action: 'speech_stop', command_id: id });
  for (let i = 2; i < 132; i++) {
    await handler({ action: 'speech_stop', command_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  }
  clock = 599_999;
  await handler({ action: 'speech_speak', command_id: id, text: 'cancelled' });
  assert.equal(spoken, 0);
  clock = 600_001;
  await handler({ action: 'speech_speak', command_id: id, text: 'expired' });
  assert.equal(spoken, 1);
});

test('Stop during delayed microphone UI never starts a late TTS request', async () => {
  let release!: (value: boolean) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  const page = { evaluate: async (_fn: unknown, args: { desiredOn: boolean }) => {
    if (!args.desiredOn) return false;
    entered(); return new Promise<boolean>(resolve => { release = resolve; });
  } };
  const controller = createSpeakController(page as never,
    { platform: 'google_meet', voiceAgentEnabled: true } as Invocation,
    () => ({ async speak() { requests++; return 'completed'; }, stop() {} }));
  const speaking = controller.speak('synthetic', 'auto', () => {});
  await started;
  const stopping = controller.stop();
  release(true);
  assert.equal(await speaking, 'stopped');
  await stopping;
  assert.equal(requests, 0);
});

test('HTTP errors, empty PCM and nonzero player exits cannot report completed', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let status = 503, pcm = Buffer.alloc(20), playerCode = 0, starts = 0;
  let submitted: {input: string; meeting_id: number} | undefined;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.once('end', () => { submitted = JSON.parse(body); res.writeHead(status); res.end(pcm); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, { meetingId: 14, setMute() {}, spawnProcess() {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdin: new PassThrough(), stderr: new PassThrough(),
      kill() { child.emit('exit', null); return true; } });
    child.stdin!.on('finish', () => { setImmediate(() => child.emit('exit', playerCode)); });
    setImmediate(() => child.emit('spawn'));
    return child;
  } });
  try {
    assert.equal(await playback.speak('test'), 'failed');
    status = 200; pcm = Buffer.alloc(0);
    assert.equal(await playback.speak('test'), 'failed');
    pcm = Buffer.alloc(200); playerCode = 1;
    assert.equal(await playback.speak('test'), 'failed');
    playerCode = 0;
    assert.equal(await playback.speak('test', 'auto', () => { starts++; }), 'completed');
    assert.equal(starts, 1);
    assert.deepEqual(submitted, { model: 'tts-1', input: 'test', voice: 'auto', response_format: 'pcm', meeting_id: 14 });
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('partial unmute failure restores mute and never starts the player', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  const mutes: boolean[] = [];
  let spawned = 0;
  const server = createServer((req, res) => { req.resume(); res.end(Buffer.alloc(20)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, {
    setMute(muted) { mutes.push(muted); if (!muted) throw new Error('partial failure'); },
    spawnProcess() { spawned++; throw new Error('must not spawn'); },
  });
  try {
    assert.equal(await playback.speak('test'), 'failed');
    assert.deepEqual(mutes, [false, true]);
    assert.equal(spawned, 0);
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('total deadline bounds a stalled synthesis and a stalled player, restoring mute', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let sendAudio = false, killed = 0;
  const mutes: boolean[] = [];
  const server = createServer((req, res) => { req.resume(); if (sendAudio) res.end(Buffer.alloc(20)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, { requestTimeoutMs: 100,
    setMute(muted) { mutes.push(muted); },
    spawnProcess() {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdin: new PassThrough(), stderr: new PassThrough(),
        kill() { killed++; child.emit('exit', null); return true; } });
      return child;
    },
  });
  try {
    assert.equal(await playback.speak('stalled synthesis'), 'failed');
    assert.equal(mutes.at(-1), true);
    sendAudio = true;
    assert.equal(await playback.speak('stalled player'), 'failed');
    assert.equal(killed, 1);
    assert(mutes.includes(false));
    assert.equal(mutes.at(-1), true);
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test('streaming starts before synthesis ends; lookahead never plays and its failure never mutes the active sentence', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let firstResponse: import('node:http').ServerResponse | undefined;
  const bodies: string[] = [], mutes: boolean[] = [];
  const server = createServer((req, res) => {
    let data='';req.on('data',c=>{data+=c;});req.on('end',()=>{
      const text=JSON.parse(data).input;bodies.push(text);
      if(text==='first'){firstResponse=res;res.write(Buffer.alloc(8000));}
      else{res.writeHead(503);res.end();}
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.TTS_SERVICE_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  const tts=createTtsPlayback(()=>{},{setMute:value=>{mutes.push(value);},spawnProcess(){
    const p=new EventEmitter() as unknown as ChildProcess;
    Object.assign(p,{stdin:new PassThrough(),stderr:new PassThrough(),kill(){p.emit('exit',null);return true;}});
    p.stdin!.on('finish',()=>setImmediate(()=>p.emit('exit',0)));setImmediate(()=>p.emit('spawn'));return p;
  }});
  try{
    const first=tts.prepare!('first');assert.equal(await first.ready,true);
    const playing=first.play(started);await began;
    assert.equal(firstResponse?.writableEnded,false);
    const next=tts.prepare!('next');assert.equal(await next.ready,false);
    assert.deepEqual(mutes,[false], 'failed lookahead cannot mute the current audio');
    assert.deepEqual(bodies,['first','next']);
    firstResponse!.end(Buffer.alloc(8000));assert.equal(await playing,'completed');
    assert.equal(mutes.at(-1),true);
  }finally{tts.stop();firstResponse?.end();if(previous===undefined)delete process.env.TTS_SERVICE_URL;else process.env.TTS_SERVICE_URL=previous;
    await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Stop cancels both streams and a late or truncated prefetched response cannot play', async () => {
  const previous=process.env.TTS_SERVICE_URL;const responses:import('node:http').ServerResponse[]=[];
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{responses.push(res);res.write(Buffer.alloc(8000));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.TTS_SERVICE_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let starts=0;
  const tts=createTtsPlayback(()=>{},{setMute(){},spawnProcess(){
    const p=new EventEmitter() as unknown as ChildProcess;
    Object.assign(p,{stdin:new PassThrough(),stderr:new PassThrough(),kill(){p.emit('exit',null);return true;}});
    setImmediate(()=>p.emit('spawn'));return p;
  }});
  try{
    const first=tts.prepare!('first');await first.ready;const playing=first.play(()=>{starts++;});
    const next=tts.prepare!('next');await next.ready;
    const excess=tts.prepare!('excess');assert.equal(await excess.ready,false);assert.equal(responses.length,2);
    tts.stop();assert.equal(await playing,'stopped');
    for(const response of responses)response.end(Buffer.alloc(8000));
    assert.equal(await next.play(()=>{starts++;}),'stopped');assert(starts<=1);
    const cut=tts.prepare!('cut');await cut.ready;responses.at(-1)!.destroy();
    assert.equal(await cut.play(),'failed');
  }finally{tts.stop();for(const r of responses)r.end();if(previous===undefined)delete process.env.TTS_SERVICE_URL;else process.env.TTS_SERVICE_URL=previous;
    await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('prepared audio waits before opening the meeting mic and mic refusal cancels preparation', async () => {
  for(const mode of ['stop-before-ready','unknown-mic']){
    let release!:(value:boolean)=>void,created=false,plays=0,cancels=0;const mic:boolean[]=[];
    const ready=new Promise<boolean>(resolve=>{release=resolve;});
    const page={async evaluate(_fn:unknown,args:{desiredOn:boolean}){mic.push(args.desiredOn);return mode==='unknown-mic'?undefined:args.desiredOn;}};
    const controller=createSpeakController(page as never,{platform:'google_meet',voiceAgentEnabled:true} as Invocation,()=>({
      async speak(){throw Error('prepared path required');},stop(){if(created)release(false);},
      prepare(){created=true;return{ready,cancel(){cancels++;},async play(){plays++;return 'completed';}};}
    }));
    const speaking=controller.speak('synthetic');
    await Promise.resolve();assert(!mic.includes(true));
    if(mode==='stop-before-ready'){await controller.stop();assert.equal(await speaking,'stopped');}
    else{release(true);assert.equal(await speaking,'failed');}
    assert.equal(plays,0);assert.equal(cancels,1);
  }
});

test('pilot PCM uses only the scoped voice capability and binds revision/turn',async()=>{
  let received: import('node:http').IncomingHttpHeaders|undefined;
  const server=createServer((req,res)=>{received=req.headers;req.resume();req.once('end',()=>{res.writeHead(200);res.end(Buffer.alloc(4800));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const tts=createTtsPlayback(()=>{},{meetingId:1,setMute(){},service:()=>({
    baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/bots/1/session`,token:'scoped-fixture',revision:4,requestId:'00000000-0000-4000-8000-000000000001'}),
    spawnProcess(){const child=new EventEmitter() as unknown as ChildProcess;
      Object.assign(child,{stdin:new PassThrough(),stderr:new PassThrough(),kill(){child.emit('exit',null);return true;}});
      child.stdin!.on('finish',()=>setImmediate(()=>child.emit('exit',0)));setImmediate(()=>child.emit('spawn'));return child;}});
  try{
    assert.equal(await tts.speak('Dạ, em nghe.'),'completed');
    assert.equal(received?.authorization,'Bearer scoped-fixture');assert.equal(received?.['x-voice-revision'],'4');
    assert.equal(received?.['x-api-key'],undefined);assert.equal(received?.['x-voice-request-id'],'00000000-0000-4000-8000-000000000001');
  }finally{tts.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a short per-call TTS deadline ends stalled acknowledgment without shortening later speech', async () => {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { if (JSON.parse(body).input === 'main') setTimeout(() => res.end(Buffer.alloc(20)), 80); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const playback = createTtsPlayback(() => {}, {setMute() {}, requestTimeoutMs: 3000,
    service: () => ({baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'synthetic', revision: 1, requestId: id})});
  try {
    const ack = playback.prepare!('ack', 'auto', 40);
    assert.equal(await ack.ready, false); assert.equal(ack.failedBeforePlayback, true);
    const main = playback.prepare!('main'); assert.equal(await main.ready, true); main.cancel();
  } finally { playback.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the speech controller forwards the per-call deadline to the owned TTS preparation', async () => {
  const deadlines: Array<number | undefined> = [];
  const controller = createSpeakController({async evaluate(_fn: unknown, args: {desiredOn: boolean}) { return args.desiredOn; }} as never,
    {platform: 'google_meet', voiceAgentEnabled: true} as Invocation, () => ({
      async speak() { throw Error('prepared path required'); }, stop() {},
      prepare(_text, _voice, deadline) { deadlines.push(deadline); return {ready: Promise.resolve(false), cancel() {}, async play() { return 'failed'; }}; },
    }));
  assert.equal(await controller.speak('ack', 'auto', undefined, 3000), 'failed');
  assert.deepEqual(deadlines, [3000]);
});

test('buffered stream failure is observable before playback even though ready remains true', async () => {
  let response: import('node:http').ServerResponse | undefined, spawned = 0;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { response = res; res.write(Buffer.alloc(8000)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const playback = createTtsPlayback(() => {}, {setMute() {}, spawnProcess() { spawned++; throw Error('must not spawn'); },
    service: () => ({baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'synthetic', revision: 1, requestId: id})});
  try {
    const pending = playback.prepare!('next'); assert.equal(await pending.ready, true);
    response!.destroy();
    const deadline = Date.now() + 1000;
    while (!pending.failedBeforePlayback && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pending.failedBeforePlayback, true); assert.equal(await pending.ready, true);
    assert.equal(await pending.play(), 'failed'); assert.equal(spawned, 0);
  } finally { playback.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('prebufferMs above 500ms does not deadlock on PassThrough backpressure', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let response: import('node:http').ServerResponse | undefined;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      response = res;
      res.writeHead(200, { 'X-Audio-Sample-Rate': '24000', 'X-Audio-Channels': '1' });
      // 800ms prebuffer = 38400 bytes (> default 24000 PassThrough highWaterMark); write 42000 bytes without ending stream.
      for (let i = 0; i < 10; i++) res.write(Buffer.alloc(4200));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, {
    prebufferMs: 800,
    requestTimeoutMs: 2000,
    setMute() {},
    spawnProcess() {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdin: new PassThrough(), stderr: new PassThrough(),
        kill() { child.emit('exit', null); return true; } });
      child.stdin!.on('finish', () => setImmediate(() => child.emit('exit', 0)));
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  try {
    const prepared = playback.prepare!('long prebuffer test');
    assert.equal(await prepared.ready, true, '800ms prebuffer must become ready before stream ends');
    const playing = prepared.play();
    response!.end(Buffer.alloc(4800));
    assert.equal(await playing, 'completed');
  } finally {
    await playback.stop();
    response?.destroy();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('async setMute keeps event loop responsive and stop during in-flight unmute fences playback', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => res.end(Buffer.alloc(8000))); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mutes: boolean[] = [];
  let releaseUnmute!: () => void;
  let unmuteEntered!: () => void;
  const unmuteStarted = new Promise<void>(resolve => { unmuteEntered = resolve; });
  let spawned = 0;
  const playback = createTtsPlayback(() => {}, {
    async setMute(muted) {
      mutes.push(muted);
      if (!muted) {
        unmuteEntered();
        await new Promise<void>(resolve => { releaseUnmute = resolve; });
      }
    },
    spawnProcess() {
      spawned++;
      throw new Error('must not spawn player after stop during async unmute');
    },
  });
  try {
    const prepared = playback.prepare!('async mute fence');
    assert.equal(await prepared.ready, true);
    const playing = prepared.play();
    await unmuteStarted;
    // Event loop remains responsive while unmute is in flight.
    let timerFired = false;
    await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 10));
    assert.equal(timerFired, true);
    // Stop while unmute is still pending: mute(true) must serialize behind mute(false) and fence spawnProcess.
    const stopping = playback.stop();
    assert.deepEqual(mutes, [false], 're-mute must stay serialized behind pending unmute');
    releaseUnmute();
    await stopping;
    assert.equal(await playing, 'stopped');
    assert.equal(spawned, 0);
    assert.deepEqual(mutes, [false, true]);
  } finally {
    await playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

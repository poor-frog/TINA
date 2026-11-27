import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NoiseSuppressor,livekitNoiseFactory,type NoiseFactory} from './noise-suppression.js';
const frame=(index:number)=>({channel:0,pcm:new Float32Array(1024).fill(index/100),stamp:1800000000000+index*64,startSample:index*1024});

test('LiveKit transport uses private handshake, queues frames and fails open exactly once',async()=>{
  const original=globalThis.WebSocket;let socket:any;let failed=0;const received:any[]=[];
  class FakeSocket {
    static OPEN=1;static CONNECTING=0;readyState=0;bufferedAmount=0;
    events=new Map<string,Function>();sent:string[]=[];
    constructor(readonly url:URL,readonly protocols:string[]){socket=this;}
    addEventListener(name:string,fn:Function){this.events.set(name,fn);}
    send(line:string){this.sent.push(line);}
    close(){this.readyState=3;this.events.get('close')?.();}
  }
  try{
    globalThis.WebSocket=FakeSocket as any;
    const worker=livekitNoiseFactory('http://agents:8080/audio/1/session','signed-cap')(e=>received.push(e),()=>failed++);
    assert.equal(String(socket.url),'ws://agents:8080/audio/1/session/noise');
    assert.deepEqual(socket.protocols,['tina-audio-v1','cap.signed-cap']);
    assert(worker.send({type:'audio',seq:1}));assert.equal(socket.sent.length,0);
    socket.readyState=1;socket.events.get('open')();assert.equal(JSON.parse(socket.sent[0]).seq,1);
    socket.events.get('message')({data:'{"ready":true}'});assert.deepEqual(received,[{ready:true}]);
    socket.events.get('error')();socket.events.get('close')();assert.equal(failed,1);
    assert.equal(worker.send({type:'audio'}),false);worker.close();
  }finally{globalThis.WebSocket=original;}
});

test('off is exact immediate bypass without starting a process',async()=>{
  const ns=new NoiseSuppressor(()=>{throw Error('must not start');},()=>{});const value=frame(1);let out:Float32Array|undefined;
  ns.feed(value,pcm=>{out=pcm;});assert.equal(out,value.pcm);await ns.close();
  ns.setEnabled(true);ns.feed({...value,channel:-1},pcm=>{out=pcm;});assert.equal(out,value.pcm);
  assert.equal(ns.state,'starting','invalid capture is left to the existing pipeline without spawning NS');await ns.close();
});

test('failed/disabled filtering drains unacknowledged raw frames once and fences late output',async()=>{
  let emit!:(event:any)=>void;let fail!:()=>void;const sent:any[]=[],got:Float32Array[]=[];
  const factory:NoiseFactory=(event,failed)=>{emit=event;fail=failed;return{send:v=>{sent.push(v);return true;},close(){}};};
  const ns=new NoiseSuppressor(factory,()=>{});ns.setEnabled(true);
  const a=frame(1),b=frame(2);ns.feed(a,pcm=>got.push(pcm));ns.feed(b,pcm=>got.push(pcm));
  const processed=new Float32Array(1024).fill(.005);
  emit({ready:true});emit({seq:sent[0].seq,audio:Buffer.from(processed.buffer).toString('base64')});
  fail();emit({seq:sent[1].seq,audio:sent[1].audio});
  assert.equal(got.length,2);assert.deepEqual(got[0],processed);assert.equal(got[1],b.pcm);assert.equal(ns.state,'failed');
  ns.setEnabled(false);assert.equal(got.length,2);await ns.close();
});

test('capture overload fails open with every frame accounted for',async()=>{
  const got:number[]=[],ns=new NoiseSuppressor(()=>({send:()=>true,close(){}}),()=>{});ns.setEnabled(true);
  for(let i=0;i<70;i++)ns.feed(frame(i),()=>got.push(i));
  assert.deepEqual(got,Array.from({length:70},(_,i)=>i));assert.equal(ns.state,'failed');await ns.close();
});

test('graceful close flushes a final original frame before consumer shutdown',async()=>{
  let emit!:(event:any)=>void;const sent:any[]=[];let result:Float32Array|undefined;
  const ns=new NoiseSuppressor(event=>{emit=event;return{close(){},send(v:any){if(v.type==='flush')for(const item of sent)emit({seq:item.seq,audio:item.audio});else sent.push(v);return true;}};},()=>{});
  ns.setEnabled(true);ns.feed(frame(1),pcm=>result=pcm);assert.equal(result,undefined);
  await ns.close();assert.deepEqual(result,frame(1).pcm);
});

test('transient failures retry after cooldown without duplicating raw frames or accepting old replies',async()=>{
  const originalNow=Date.now;let now=1000;
  const workers:Array<{emit:(event:any)=>void;fail:()=>void;sent:any[]}>=[];
  const got:number[]=[];
  const ns=new NoiseSuppressor((emit,fail)=>{
    const worker={emit,fail,sent:[] as any[]};workers.push(worker);
    return {send(value){worker.sent.push(value);return true;},close(){}};
  },()=>{});
  try{
    Date.now=()=>now;ns.setEnabled(true);
    ns.feed(frame(1),()=>got.push(1));workers[0].fail();
    for(let i=2;i<=4;i++)ns.feed(frame(i),()=>got.push(i));
    assert.equal(workers.length,1);assert.deepEqual(got,[1,2,3,4]);
    now+=5000;ns.feed(frame(5),()=>got.push(5));
    assert.equal(workers.length,2);assert.equal(ns.state,'starting');
    workers[0].emit({ready:true});
    workers[0].emit({seq:workers[0].sent[0].seq,audio:workers[0].sent[0].audio});
    assert.deepEqual(got,[1,2,3,4]);assert.equal(ns.state,'starting');
    workers[1].emit({ready:true});const sent=workers[1].sent[0];
    workers[1].emit({seq:sent.seq,audio:sent.audio});
    assert.deepEqual(got,[1,2,3,4,5]);assert.equal(ns.state,'low');
    workers[1].fail();ns.setEnabled(false);now+=5000;
    ns.feed(frame(6),()=>got.push(6));assert.equal(workers.length,2);
    assert.deepEqual(got,[1,2,3,4,5,6]);
  }finally{await ns.close();Date.now=originalNow;}
});

test('startup grace timeout tolerates cold-start longer than steady-state frame timeout',async()=>{
  let emit!:(event:any)=>void;const sent:any[]=[];const got:number[]=[];
  const ns=new NoiseSuppressor(e=>{emit=e;return{send(v:any){sent.push(v);return true;},close(){}};},()=>{},60,400);
  try{
    ns.setEnabled(true);
    ns.feed(frame(1),()=>got.push(1));
    await new Promise(r=>setTimeout(r,150));
    assert.equal(ns.state,'starting','cold-start must survive past steady-state 60ms frame timeout');
    emit({ready:true});
    emit({seq:sent[0].seq,audio:sent[0].audio});
    assert.equal(ns.state,'low');assert.deepEqual(got,[1]);
    // Once steady-state ('low'), a stalled frame beyond 60ms drains and fails open.
    ns.feed(frame(2),()=>got.push(2));
    await new Promise(r=>setTimeout(r,200));
    assert.equal(ns.state,'failed');assert.deepEqual(got,[1,2]);
  }finally{await ns.close();}
});

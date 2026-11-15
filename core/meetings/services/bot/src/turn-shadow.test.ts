import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnShadow } from './turn-shadow.js';
import { VoiceTrigger } from './voice-trigger.js';
import type { WorkerFactory } from './meeting-voice.js';

function fixture(){
  let emit!:(value:Record<string,unknown>)=>void,failed!:()=>void;
  const sent:Record<string,unknown>[]=[],logs:string[]=[];let closed=0;
  const factory:WorkerFactory=(event,fail)=>{emit=event;failed=fail;return{
    send(value){sent.push(value as Record<string,unknown>);return true;},close(){closed++;}};};
  const shadow=new TurnShadow(factory,value=>logs.push(value));shadow.start();
  const ready=()=>emit({event:'turn-ready'});
  const result=()=>emit({event:'turn-result',id:sent.at(-1)?.id,smart_probability:.8,namo_probability:.9,smart_ms:20,namo_ms:30});
  return {shadow,ready,result,failed,sent,logs,emit,closed:()=>closed};
}

test('shadow observes bounded same-caller audio without exposing question or audio in logs',()=>{
  const f=fixture();
  try{
    for(let i=0;i<20;i++)f.shadow.feed(1,new Float32Array(16000).fill(.1),i*1000,'caller',i*16000);
    f.shadow.observe('private question',{channel:1,participant:'caller',startMs:10000},20000,'request');
    assert.equal(f.sent.length,0);f.ready();
    f.shadow.observe('private question',{channel:1,participant:'caller',startMs:10000},20000,'request');
    assert.equal(f.sent.length,1);
    assert.equal(Buffer.from(f.sent[0].audio as string,'base64').length,128000*4);
    f.result();
    assert(f.logs.some(l=>JSON.parse(l).status==='observed'));
    assert(!f.logs.join('').includes('private question'));assert(!f.logs.join('').includes('audio'));
    f.shadow.observe('private question',{channel:1,participant:'caller',startMs:10000},20000,'request');
    assert.equal(f.sent.length,1);
  }finally{f.shadow.close();}
});

test('unknown/conflicting caller cannot borrow another channel audio',()=>{
  const f=fixture();f.ready();
  try{
    f.shadow.feed(1,new Float32Array(16000),1000,'alice',0);
    f.shadow.observe('question',{channel:1,participant:'bob'},2000,'request');
    f.shadow.observe('question',{channel:2,participant:'alice'},2000,'request');
    assert.equal(f.sent.length,0);
  }finally{f.shadow.close();}
});

test('Stop, source discontinuity and resumed speech fence late observations',()=>{
  for(const action of ['cancel','gap','resume'] as const){
    const f=fixture();f.ready();
    try{
      f.shadow.feed(1,new Float32Array(16000),1000,'alice',0);
      f.shadow.observe('question',{channel:1,participant:'alice'},2000,'request');
      if(action==='cancel')f.shadow.cancel();
      else if(action==='resume')f.shadow.resume(1);
      else f.shadow.feed(1,new Float32Array(16000),2100,'bob',32000);
      f.result();
      assert(!f.logs.some(l=>JSON.parse(l).status==='observed'));
    }finally{f.shadow.close();}
  }
});

test('optional inference failure and invalid score close only the observer',()=>{
  const f=fixture();f.ready();
  f.shadow.feed(1,new Float32Array(16000),1000,'alice');
  f.shadow.observe('question',{channel:1,participant:'alice'},2000,'request');
  f.emit({event:'turn-result',id:f.sent[0].id,smart_probability:NaN,namo_probability:.5,smart_ms:1,namo_ms:1});
  assert.equal(f.closed(),1);assert(f.logs.some(l=>JSON.parse(l).status==='invalid_result'));
  f.shadow.close();
});

test('observation may inspect an unfinished phrase without bypassing the baseline pause or ASR tail check',()=>{
  let now=1500;
  const trigger=new VoiceTrigger(()=>now);trigger.reset(0);
  trigger.feed({channel:1,speakerKey:'caller',startMs:1,endMs:1000,
    text:'TINA ơi, giúp tôi phần backend và',final:true});
  now+=350;
  assert.equal(trigger.question(1000),null);
  assert.equal(trigger.question(1000,true),'giúp tôi phần backend và');
  assert.equal(trigger.question(1200,true),null);
});

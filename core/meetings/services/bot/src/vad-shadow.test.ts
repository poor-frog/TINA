import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VadShadow} from './vad-shadow.js';

test('remote VAD compares source-clock events and endpoint candidates without changing primary turn',()=>{
  let emit!:(event:Record<string,unknown>)=>void;let failed!:()=>void;const sent:any[]=[],logs:any[]=[];
  const observer=new VadShadow((event,fail)=>{emit=event;failed=fail;return{send(value){sent.push(value);return true;},close(){}};},value=>logs.push(value));
  observer.start();emit({event:'vad-ready'});observer.control('CAPTURING',2);
  const event={event:'activity',generation:2,channel:1,speech:false,endMs:1064,stamp:1864};
  observer.activity(event);emit(event);
  assert.equal(logs.at(-1).agreement,true);
  observer.observe('request-a',1,1064,1064,true);
  const candidate=sent.at(-1);assert.equal(candidate.type,'endpoint');assert.equal(candidate.local_ready,true);
  emit({event:'endpoint',id:candidate.id,generation:2,channel:1,ready:false,end_ms:1064});
  assert.equal(logs.at(-1).agreement,false);assert.equal(logs.at(-1).local_ready,true);
  const length=logs.length;emit({...event,generation:1});assert.equal(logs.length,length);
  failed();assert.equal(logs.at(-1).status,'unavailable');observer.close();
  observer.start();emit({event:'vad-ready'});
  assert.equal(sent.at(-1).generation,0);assert.equal(sent.at(-1).state,'OFF');observer.close();
});

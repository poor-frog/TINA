import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {MeetingVoice} from './meeting-voice.js';
import {VoiceInterruption} from './voice-interruption.js';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function raceStop(){
 let event;const held=deferred(),reportEntered=deferred(),releaseReport=deferred();let stopped=0;
 const questions=[];const states=[];
 const v=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),answer:async question=>{questions.push(question);return{text:questions.length===1?'Lan phụ trách demo. Hạn thứ Sáu.':'Đã sửa.'};},state:async s=>states.push(s)},
 {speak:async(text,_,started)=>{started?.();return text==='Hạn thứ Sáu.'?held.promise:'completed';},stop:async()=>held.resolve('stopped')},
 async(_,state)=>{if(state==='stopped'&&++stopped===1){reportEntered.resolve();await releaseReport.promise;}},
 cb=>{event=cb;return{send:()=>true,close(){}}},()=>{});
 try{
  await v.start();event({event:'state',state:'LISTENING',generation:0});
  const t=Date.now()+1;await wait(5);
  v.hypothesis({channel:1,participant:'p',speakerKey:'s',startMs:t,endMs:t+10,text:'TINA ơi ai làm demo?',final:true});
  event({event:'activity',channel:1,speech:false,endMs:t+10,stamp:t+10,generation:0});await wait(450);
  assert.equal(states.at(-1),'SPEAKING');
  const command=Date.now()+1;await wait(5);
  v.hypothesis({channel:1,participant:'p',speakerKey:'s',startMs:command,endMs:command+200,text:'Khoan, ý tôi là tuần sau.',final:true});
  await reportEntered.promise;
  await v.external({action:'speak_stop'},async()=>{});
  const before=questions.length;
  releaseReport.resolve();await wait(20);
  const revived=!!v.waitingCaller;
  event({event:'state',state:'LISTENING',generation:2});await wait(450);
  assert.equal(revived,false);assert.equal(questions.length,before);
 }finally{releaseReport.resolve();held.resolve('stopped');await v.stop();}
}
async function metadataOverlap(){
 let vad,kws;const states=[];
 const v=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),answer:async()=>({text:'unused'}),state:async s=>states.push(s)},
 {speak:async()=> 'completed',stop:async()=>{}},async()=>{},cb=>{vad=cb;return{send:()=>true,close(){}}},()=>{},undefined,undefined,
 cb=>{kws=cb;return{send:()=>true,close(){}}});
 try{
  await v.start();vad({event:'state',state:'LISTENING',generation:0});kws({event:'kws',status:'ready',models:['hey_tina','tina_oi'],generation:0});
  const t=Date.now()+1;await wait(5);
  v.feed(1,new Float32Array(1024),t,'a',0);v.feed(2,new Float32Array(1024),t,'b',0);
  kws({event:'kws',status:'wake',model:'tina_oi',channel:1,participant:'a',score:.9,source_start_ms:t,source_frame_end_ms:t+32,processing_ms:1,generation:0});await wait(2);
  const before=states.at(-1);
  v.feed(1,new Float32Array(1024),t+64,undefined,1024);v.feed(2,new Float32Array(1024),t+64,undefined,1024);
  vad({event:'activity',channel:2,speech:true,stamp:t+128,generation:0});await wait(10);
  assert.equal(before,'CAPTURING');assert.equal(states.at(-1),'CAPTURING');
  v.feed(2,new Float32Array(1024),t+128,undefined,0);
  vad({event:'activity',channel:2,speech:true,stamp:t+192,generation:0});await wait(10);
  assert.equal(states.at(-1),'QUIET');
 }finally{await v.stop();}
}
test('a newer Stop fences a pending interruption receipt',raceStop);
test('continuous tracks retain missing metadata, decoder resets discard it',metadataOverlap);

test('LiveKit proxy stays room scoped and native state/stop remain authoritative',async()=>{
 const {voiceApi}=await import('./meeting-voice.js');
 const calls=[];let engine='livekit';
 const proxy=voiceApi('http://meeting.test/bots/voice/1/session','scope-token',async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/config'))return Response.json({enabled:true,ready:true,revision:3,engine,
    agent_url:engine==='livekit'?'http://pilot.test/bots/1/session':null});
  return Response.json(url.endsWith('/answer')?{text:'Answer.',reason:'answered'}:{});
 });
 await proxy.config(new AbortController().signal);
 await proxy.state('CAPTURING','00000000-0000-4000-8000-000000000001');
 assert.equal(proxy.speechService().baseUrl,'http://pilot.test/bots/1/session');
 await proxy.answer('Question','00000000-0000-4000-8000-000000000001',3,new AbortController().signal,'a'.repeat(64));
 assert.equal(calls.at(-1).url,'http://pilot.test/bots/1/session/answer');
 assert.equal(calls.at(-1).options.headers['X-Voice-Speaker-Key'],'a'.repeat(64));
 assert.equal(proxy.speechService('Dạ, em nghe.'),undefined,'cached acknowledgment bypasses the busy Agents LLM session');
 assert.equal(proxy.speechService('Lan phụ trách demo.').baseUrl,'http://pilot.test/bots/1/session');
 await proxy.state('QUIET','00000000-0000-4000-8000-000000000001');
 assert(calls.some(c=>c.url==='http://pilot.test/bots/1/session/turn'&&c.options.method==='DELETE'));
 assert.equal(calls.at(-1).url,'http://meeting.test/bots/voice/1/session/state');
 assert.equal(proxy.speechService(),undefined);
 engine='tina';await proxy.config(new AbortController().signal);
 await proxy.answer('Next','00000000-0000-4000-8000-000000000002',3,new AbortController().signal);
 assert.equal(calls.at(-1).url,'http://meeting.test/bots/voice/1/session/answer');
});

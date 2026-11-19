// Native KWS/VAD over synthetic PCM; ASR, answer generation and playback are explicit fakes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {MeetingVoice,nativeVoiceWorker,nativeKwsWorker} from '/app/core/meetings/services/bot/dist/meeting-voice.js';

const bytes=readFileSync(process.argv[2]);
const audio=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert(audio.length>=16000&&audio.every(Number.isFinite));
const states=[],logs=[],played=[],receipts=[],questions=[],endpoints=[];
let position=0,anchor,release;
const held=new Promise(resolve=>{release=resolve;});
const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
  answer:async question=>{questions.push(question);return{text:questions.length===1?'Lan phụ trách demo. Hạn thứ Sáu.':'Đã nhận câu sửa.'};},
  state:async state=>{states.push(state);}},
  {speak:async(text,_,started)=>{played.push(text);started?.();return text==='Hạn thứ Sáu.'?held:'completed';},
   stop:async()=>{release('stopped');}},
  async(id,state,text)=>{receipts.push({id,state,text});},nativeVoiceWorker,line=>logs.push(line),async()=>true,
  (channel,end)=>endpoints.push({channel,end,state:states.at(-1)}),nativeKwsWorker);
async function wait(check){const until=Date.now()+20000;while(!check()){assert(Date.now()<until,'turn smoke timeout');await delay(25);}}
function feed(pcm){
  const stamp=anchor+position/16;
  voice.feed(11,pcm,stamp,'caller',position);voice.feed(12,new Float32Array(pcm.length),stamp,'other',position);
  position+=pcm.length;
}
async function silence(count){for(let i=0;i<count;i++){feed(new Float32Array(1024));await delay(64);}}
async function replay(){for(let i=0;i<audio.length;i+=1024){feed(audio.slice(i,i+1024));await delay(64);}}
try{
  await voice.start();await wait(()=>states.at(-1)==='LISTENING');anchor=Date.now()+1;
  await replay();await wait(()=>states.at(-1)==='CAPTURING');
  voice.hypothesis({channel:11,participant:'caller',speakerKey:'s',startMs:anchor,endMs:anchor+position/16,
    text:'TINA ơi ai phụ trách demo?',final:true});
  await silence(24);await wait(()=>played.includes('Hạn thứ Sáu.'));
  assert(receipts.some(r=>r.state==='started'&&r.text==='Lan phụ trách demo.'));
  anchor=Date.now()+1-position/16;const start=anchor+position/16;
  await replay();await silence(16);
  assert(endpoints.some(e=>e.state==='SPEAKING'&&typeof e.end==='number'),'busy native VAD did not supply an ASR endpoint');
  const end=anchor+position/16;
  const h={channel:11,participant:'caller',speakerKey:'interrupt',startMs:start,endMs:end,text:'Khoan, ý tôi là tuần sau.',final:true};
  voice.hypothesis({...h,channel:12,participant:'other'});
  voice.hypothesis({...h,text:'đúng rồi'});assert.equal(states.at(-1),'SPEAKING');
  voice.hypothesis(h);await wait(()=>states.at(-1)==='QUIET');
  await silence(24);await wait(()=>questions.length===2&&played.includes('Đã nhận câu sửa.'));
  assert.deepEqual(questions,['ai phụ trách demo?','ý tôi là tuần sau.']);
  assert(receipts.some(r=>r.state==='stopped'&&r.text==='Lan phụ trách demo.'));
  assert(!receipts.some(r=>r.state==='started'&&r.text?.includes('Hạn thứ Sáu.')));
  assert(!states.includes('ERROR'));
  console.log(JSON.stringify({native_kws:true,native_vad_during_playback:true,explicit_caller_correction:true,
    other_speaker_and_backchannel_ignored:true,completed_sentence_prefix_only:true,correction_without_new_wake:true,
    fake_asr_answer_and_playback:true,live_meeting:false}));
}finally{release('stopped');await voice.stop();}

// Real native KWS/VAD with two synthetic channels; ASR/API/playback are explicit fakes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {MeetingVoice,nativeVoiceWorker,nativeKwsWorker} from '/app/core/meetings/services/bot/dist/meeting-voice.js';

const bytes=readFileSync(process.argv[2]);
const audio=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert(audio.length>0&&audio.every(Number.isFinite));
const states=[],logs=[],questions=[],speakers=[];
let anchor,position=0,playbacks=0;
const voice=new MeetingVoice({config:async()=>({enabled:true,ready:true,revision:1}),
  answer:async(question,_id,_revision,_signal,speaker)=>{
    questions.push(question);speakers.push(speaker);return{text:'Câu trả lời thử.'};},
  state:async state=>{states.push(state);}},
  {speak:async()=>{playbacks++;return 'completed';},stop:async()=>{}},async()=>{},nativeVoiceWorker,
  s=>logs.push(s),async()=>true,undefined,nativeKwsWorker);
async function wait(check){const until=Date.now()+20000;while(!check()){assert(Date.now()<until,'multiparty smoke timeout');await delay(25);}}
function feed(a,b){
  const stamp=anchor+position/16;
  voice.feed(11,a,stamp,'a',position);voice.feed(12,b,stamp,'b',position);position+=a.length;
}
async function replay(overlap){for(let i=0;i<audio.length;i+=1024){
  const pcm=audio.slice(i,i+1024);feed(overlap?pcm:new Float32Array(pcm.length),pcm);await delay(64);
}}
async function silence(){for(let i=0;i<26;i++){feed(new Float32Array(1024),new Float32Array(1024));await delay(64);}}
function events(){return logs.filter(s=>s.startsWith('{')).map(s=>JSON.parse(s)).filter(e=>e.type==='kws'&&e.status==='wake');}
try{
  await voice.start();await wait(()=>states.at(-1)==='LISTENING');anchor=Date.now()+1;
  await replay(true);await wait(()=>states.at(-1)==='CAPTURING');
  const first=events()[0];assert.equal(first.channel,11,'first native caller must retain the room turn');
  const h={startMs:anchor,endMs:anchor+position/16,final:true};
  voice.hypothesis({...h,channel:12,participant:'b',speakerKey:'b',text:'TINA ơi câu của B'});
  voice.hypothesis({...h,channel:11,participant:'a',speakerKey:'a',text:'TINA ơi ai làm demo?'});
  await silence();await wait(()=>questions.length===1&&states.at(-1)==='LISTENING');
  assert.deepEqual(questions,['ai làm demo?']);
  anchor=Date.now()+1-position/16;const secondStart=anchor+position/16;
  await replay(false);await wait(()=>events().length===2);
  assert.equal(events()[1].channel,12);assert.equal(events()[1].handoff,true);
  const next={startMs:secondStart,endMs:anchor+position/16,final:true};
  voice.hypothesis({...next,channel:11,participant:'a',speakerKey:'a',text:'Còn deadline của A?'});
  voice.hypothesis({...next,channel:12,participant:'b',speakerKey:'b',text:'TINA ơi ngân sách bao nhiêu?'});
  await silence();await wait(()=>questions.length===2&&states.at(-1)==='LISTENING');
  assert.deepEqual(questions,['ai làm demo?','ngân sách bao nhiêu?']);
  assert.notEqual(speakers[0],speakers[1]);assert(speakers.every(s=>/^[a-f0-9]{64}$/.test(s)));
  const after=Date.now()+1;await delay(5);
  voice.hypothesis({channel:11,participant:'a',speakerKey:'a',startMs:after,endMs:after+10,text:'Còn deadline?',final:true});
  await delay(350);assert.equal(questions.length,2);
  assert(!states.includes('ERROR'));assert.equal(playbacks,2);
  console.log(JSON.stringify({native_two_channel_kws_vad:true,independent_overlap_keeps_caller:true,
    fresh_b_wake_takes_idle_a_followup:true,a_followup_cannot_enter_b_turn:true,speaker_keys_distinct:true,
    accepted_turns:questions.length,fake_asr_api_playback:true,live_meeting:false}));
}finally{await voice.stop();}

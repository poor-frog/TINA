import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {LiveKitStt} from '/app/core/meetings/services/bot/dist/livekit-stt.js';
import {createBotPipeline,createTranscribe} from '/app/core/meetings/services/bot/dist/pipeline.js';

const target={meeting:1,session:'synthetic',url:'http://backend',model:'selected',token:'synthetic'};
const payload=Buffer.from(JSON.stringify(target)).toString('base64url');
const cap=payload+'.'+createHmac('sha256','synthetic-stream-smoke').update('tina-audio.v1:'+payload).digest('hex');
const base='http://127.0.0.1:8081/audio/1/synthetic';
const events=[],canonical=new Map(),expected=new Set();
const stream=new LiveKitStt(base,cap,event=>events.push(event));
const inv={platform:'google_meet',transcriptionServiceUrl:base,transcriptionServiceToken:cap,transcriptionModel:'selected',language:'en'};
const pipeline=createBotPipeline(inv,{
  publish:async segment=>canonical.set(segment.segment_id,segment),
  retract:async ids=>{for(const id of ids)canonical.delete(id);},
},{stream,transcribe:createTranscribe(inv,{windowRequest:stream.requestWindow}),
  config:{submitInterval:.1,minAudioDuration:.1}});
const t0=Date.now();
for(let i=0;i<600;i++){
  for(let channel=0;channel<2;channel++){
    const value=Math.fround((1+i+channel*1000)/2000);
    expected.add('token'+Math.round(value*32767));
    pipeline.feedAudio(channel,channel?'Huy':'Lan',new Float32Array(1024).fill(value),t0+i*64,'participant-'+channel,i*1024);
  }
  await new Promise(resolve=>setTimeout(resolve,8));
}
await pipeline.stop();
const rows=[...canonical.values()];assert(rows.every(row=>row.completed));
const words=rows.flatMap(row=>row.text.trim().split(/\s+/));
assert.deepEqual(new Set(words),expected);assert.equal(words.length,expected.size);
assert.deepEqual(new Set(rows.map(row=>row.speaker)),new Set(['Lan','Huy']));
assert(events.includes('ready'));assert(!events.some(event=>/fallback|failed|backpressure/.test(event)),events.join(','));
const stats=await (await fetch('http://127.0.0.1:8081/proof/stats')).json();
console.log(JSON.stringify({tcp_stream:true,channels:2,frames:1200,audio_seconds_per_channel:38.4,final_words:words.length,
  lost_or_duplicate:0,asr_windows:stats.requests,http_fallback:false,tail_finalized:true}));

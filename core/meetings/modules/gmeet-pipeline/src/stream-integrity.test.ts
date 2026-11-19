/** PCM markers verify transport/confirmation, not acoustic model accuracy. No meeting data. */
import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {AudioTimelinePool,GmeetCompatibleBuffer} from '@tina/transcribe-buffer';
import {SpeakerStreamManager} from './speaker-streams.js';
import {createGmeetPipeline, type VoiceHypothesis} from './gmeet-pipeline.js';
import type {TranscriptionResult} from '@tina/transcribe-whisper';
import {setLogger} from './log.js';

setLogger(()=>{});
const SR=16000, FRAME=1024, EPOCH=1800000000000;
const marker=(id:number)=>Math.fround(.1+id/1000000);
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function recognize(pcm:Float32Array):TranscriptionResult {
  const segments:Array<{text:string;start:number;end:number}>=[];
  for(let start=0;start<pcm.length;){
    let end=start+1;while(end<pcm.length&&pcm[end]===pcm[start])end++;
    segments.push({text:`mốc${Math.round((pcm[start]-.1)*1000000)}`,start:start/SR,end:end/SR});start=end;
  }
  return {text:segments.map(s=>s.text).join(' '),segments,language:'vi',duration:pcm.length/SR};
}
function fixture(held=false,coarse=false){
  let sample=0,active=0,maxActive=0;
  const requests:Float32Array[]=[],pending:Array<()=>void>=[],hypotheses:VoiceHypothesis[]=[],finals:string[]=[],errors:unknown[]=[];
  const pipe=createGmeetPipeline({transcribe:async pcm=>{
    requests.push(pcm);maxActive=Math.max(maxActive,++active);
    if(held)await new Promise<void>(resolve=>pending.push(resolve));
    active--;const result=recognize(pcm);
    return coarse?{...result,segments:[{text:result.text,start:0,end:pcm.length/SR}]}:result;
  },onHypothesis:h=>hypotheses.push(h),onError:e=>errors.push(e),
    sink:{segment:s=>finals.push(s.text),finalize(){}}});
  return {pipe,requests,pending,hypotheses,finals,errors,maxActive:()=>maxActive,
    async close(){
      let done=false;const closing=pipe.dispose().then(()=>{done=true;});
      for(let i=0;i<20&&!done;i++){for(const release of pending.splice(0))release();await drain();}
      assert(done,'final ASR drain did not settle');await closing;
    },
    feed(count:number){for(let i=0;i<count;i++){
      pipe.feedAudio(0,'Speaker',new Float32Array(FRAME).fill(marker(sample/FRAME+1)),EPOCH+sample/SR*1000,'person',sample);
      sample+=FRAME;
    }},words:()=>finals.join(' ').split(/\s+/).filter(Boolean)};
}

test('64ms frames preserve short utterances and partial final frames through end-of-stream',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});
  try{
    for(const samples of [1,160,1023,1024,1025,9600]){
      const f=fixture();
      f.pipe.feedAudio(0,'Speaker',new Float32Array(samples).fill(marker(1)),EPOCH,'person',0);
      try{await f.pipe.dispose();
        assert.deepEqual(f.requests.map(p=>p.length),[samples]);assert.deepEqual(f.words(),['mốc1']);
        assert.deepEqual(f.errors,[]);
      }finally{await f.pipe.dispose();}
    }
  }finally{mock.timers.reset();}
});

test('a deferred endpoint resubmits the exact PCM tail once and never duplicates final words',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});const f=fixture(true);
  try{
    f.feed(33);mock.timers.tick(2112);assert.equal(f.requests.length,1);
    f.feed(5);mock.timers.tick(320);
    f.pipe.requestEndpoint(0,EPOCH+2432);f.pipe.requestEndpoint(0,EPOCH+2432);
    f.pending.shift()!();await drain();
    assert.deepEqual(f.requests.map(p=>p.length),[33*FRAME,38*FRAME]);
    assert.deepEqual([...f.requests[1].subarray(0,33*FRAME)],[...f.requests[0]]);
    assert.equal(f.requests[1].at(-1),marker(38));
    f.pending.shift()!();await drain();
    await f.close();
    assert.deepEqual(f.words(),Array.from({length:38},(_,i)=>`mốc${i+1}`));
    assert.equal(f.maxActive(),1);assert.deepEqual(f.errors,[]);
    assert.equal(f.hypotheses.at(-1)?.final,true);
  }finally{await f.close();mock.timers.reset();}
});

test('30s hard-cap keeps its boundary sample and final partial frame exactly once',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});const f=fixture(true);
  try{
    // 29.952s plus 768 samples is exactly the existing 30-second live window.
    f.feed(468);mock.timers.tick(29952);
    f.pipe.feedAudio(0,'Speaker',new Float32Array(768).fill(marker(469)),EPOCH+29952,'person',468*FRAME);
    // Force a close while the earlier 29.952s request is still pending.
    const closing=f.pipe.flush();f.pending.shift()!();await drain();
    assert.equal(f.requests.at(-1)?.length,SR*30);assert.equal(f.requests.at(-1)?.at(-1),marker(469));
    f.pending.shift()!();await drain();await closing;
    await f.close();
    assert.deepEqual(f.words(),Array.from({length:469},(_,i)=>`mốc${i+1}`));
    assert.equal(f.maxActive(),1);assert.deepEqual(f.errors,[]);
  }finally{await f.close();mock.timers.reset();}
});

test('speaker rotations keep short tails attributed without duplicated samples or stale turns',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});
  const finals:Array<{speaker:string;text:string}>=[],timeline=new AudioTimelinePool();
  const pipe=createGmeetPipeline({timeline,transcribe:async pcm=>recognize(pcm),onError:e=>{throw e;},
    sink:{segment:s=>finals.push({speaker:s.speaker,text:s.text}),finalize(){}}});
  try{
    for(let i=0;i<100;i++){
      pipe.feedAudio(0,`Person ${i}`,new Float32Array(FRAME).fill(marker(i+1)),EPOCH+i*64,`person-${i}`,i*FRAME);
      mock.timers.tick(64);await drain();
    }
    await pipe.dispose();
    assert.deepEqual(finals,Array.from({length:100},(_,i)=>({speaker:`Person ${i}`,text:`mốc${i+1}`})));
    assert.equal(timeline.stats.sources,0);
  }finally{await pipe.dispose();mock.timers.reset();}
});

test('stalled ASR reports live-window overflow and never promotes a stale pre-overflow transcript',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});const f=fixture(true);
  try{
    f.feed(33);mock.timers.tick(2112);
    for(let i=0;i<500;i++){f.feed(1);mock.timers.tick(64);}
    assert(f.errors.some((e:any)=>e.kind==='overflow'));
    f.pending.shift()!();await drain();
    assert.equal(f.hypotheses.length,0,'stale result cannot become voice input');
    await f.close();
    assert(!f.words().includes('mốc1'),'overflow is explicit data loss, not successful recovery');
  }finally{await f.close();mock.timers.reset();}
});

test('growing single-segment ASR rolls over before 30s without losing or repeating the tail',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});const f=fixture(false,true);
  try{
    for(let i=0;i<5000;i++){f.feed(1);mock.timers.tick(64);await drain();}
    await f.close();
    assert.deepEqual(f.errors,[]);
    assert.deepEqual(f.words(),Array.from({length:5000},(_,i)=>`mốc${i+1}`));
    assert(f.requests.every(p=>p.length<=SR*30));assert.equal(f.maxActive(),1);
  }finally{await f.close();mock.timers.reset();}
});

test('coarse rollover stays lossless for shared and stamped buffers with delayed cap responses',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});
  try{
    for(const create of [()=>new SpeakerStreamManager({maxRetainedDuration:30}),
      ()=>new SpeakerStreamManager({maxRetainedDuration:30,callbackStampedFrames:true}),
      ()=>new GmeetCompatibleBuffer({maxRetainedDuration:30})]){
      const manager=create(),finals:string[]=[],held:Array<()=>void>=[];
      let clock=0,capHeld=false,overflows=0;
      manager.addSpeaker('channel','Speaker');manager.onOverflow=()=>{overflows++;};
      manager.onSegmentConfirmed=(_id,_name,text)=>finals.push(text);
      manager.onSegmentReady=(id,_name,pcm)=>{
        assert(pcm.length<=SR*30);
        const result=recognize(pcm),reply=()=>manager.handleTranscriptionResult(id,result.text,pcm.length/SR,
          [{text:result.text,start:0,end:pcm.length/SR}],'vi');
        // The rollover request has a shorter cut than the previous growing window.
        if(pcm.length>=SR*24&&pcm.length<SR*26&&!capHeld){held.push(reply);capHeld=true;}
        else queueMicrotask(reply);
      };
      try{
        for(let i=0;i<1000;i++){
          manager.feedAudio('channel',new Float32Array(FRAME).fill(marker(i+1)),EPOCH+i*64);
          mock.timers.tick(64);await drain();clock++;
          if(held.length&&clock%8===0){held.shift()!();await drain();}
        }
        for(const release of held.splice(0))release();await drain();
        await manager.flushSpeaker('channel',true);await drain();
        assert.deepEqual(finals.join(' ').split(/\s+/),Array.from({length:1000},(_,i)=>`mốc${i+1}`));
        assert.equal(overflows,0);
      }finally{manager.removeAll();}
    }
  }finally{mock.timers.reset();}
});

test('manual replay cadence uses the same coarse rollover without increasing retained audio',async()=>{
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});
  const manager=new GmeetCompatibleBuffer({maxRetainedDuration:30,scheduleSubmissions:false});
  const finals:string[]=[];let overflow=0;
  manager.addSpeaker('channel','Speaker');manager.onOverflow=()=>{overflow++;};
  manager.onSegmentConfirmed=(_id,_name,text)=>finals.push(text);
  manager.onSegmentReady=(id,_name,pcm)=>{
    const result=recognize(pcm);assert(pcm.length<=SR*30);
    queueMicrotask(()=>manager.handleTranscriptionResult(id,result.text,pcm.length/SR,
      [{text:result.text,start:0,end:pcm.length/SR}],'vi'));
  };
  try{
    for(let i=0;i<2000;i++){
      manager.feedAudio('channel',new Float32Array(FRAME).fill(marker(i+1)),EPOCH+i*64);
      mock.timers.tick(64);await manager.requestTranscription('channel');await drain();
    }
    await manager.flushSpeaker('channel',true);await drain();
    assert.equal(overflow,0);
    assert.deepEqual(finals.join(' ').split(/\s+/),Array.from({length:2000},(_,i)=>`mốc${i+1}`));
  }finally{manager.removeAll();mock.timers.reset();}
});

test('long continuous 64ms sessions preserve every marker with bounded retained PCM and heap',async()=>{
  const seconds=Number(process.env.TINA_ASR_SOAK_SECONDS||120);
  assert(Number.isInteger(seconds)&&seconds>=120&&seconds<=7200);
  const channels=3,totalFrames=Math.ceil(seconds*SR/FRAME),timeline=new AudioTimelinePool();
  const coarse=process.env.TINA_ASR_SOAK_COARSE==='1';
  const next=Array(channels).fill(1),samples:Array<Record<string,number>>=[];
  let requests=0,maxWindow=0,active=0,maxActive=0,finalCount=0;
  mock.timers.enable({apis:['Date','setInterval'],now:EPOCH});
  const pipe=createGmeetPipeline({timeline,sessionId:'soak',transcribe:async pcm=>{
    maxActive=Math.max(maxActive,++active);requests++;maxWindow=Math.max(maxWindow,pcm.length);
    assert(pcm.length<=SR*30);await Promise.resolve();active--;
    const result=recognize(pcm);
    return coarse?{...result,segments:[{text:result.text,start:0,end:pcm.length/SR}]}:result;
  },onError:e=>{throw e;},sink:{segment:s=>{
    const channel=Number(s.speaker_key!.split(':')[0].slice(3));finalCount++;
    for(const word of s.text.split(/\s+/)){assert.equal(word,`mốc${next[channel]}`);next[channel]++;}
  },finalize(){}}});
  const sample=(elapsed:number)=>{
    global.gc?.();const m=process.memoryUsage();
    samples.push({seconds:elapsed,heap:m.heapUsed,arrayBuffers:m.arrayBuffers,rss:m.rss,ringBytes:timeline.stats.bytes});
  };
  try{
    for(let frame=0;frame<totalFrames;frame++){
      for(let ch=0;ch<channels;ch++)pipe.feedAudio(ch,`Speaker ${ch}`,new Float32Array(FRAME).fill(marker(frame+1)),
        EPOCH+frame*64,`person-${ch}`,frame*FRAME);
      mock.timers.tick(64);await drain();
      if((frame+1)%1875===0){await new Promise<void>(r=>setImmediate(r));sample((frame+1)*.064);}
    }
    await pipe.dispose();sample(totalFrames*.064);
    assert.deepEqual(next,Array(channels).fill(totalFrames+1));assert.equal(timeline.stats.bytes,0);
    assert(maxActive<=channels);assert(samples.every(s=>s.ringBytes<=channels*1980000));
    const steady=samples.filter(s=>s.seconds>=120&&s.ringBytes>0);
    if(global.gc&&steady.length>1){
      assert(Math.max(...steady.map(s=>s.heap))-steady[0].heap<16*1024*1024,'retained heap grew beyond 16 MiB');
      assert(Math.max(...steady.map(s=>s.arrayBuffers))-steady[0].arrayBuffers<16*1024*1024,'retained PCM grew beyond 16 MiB');
    }
    console.log(JSON.stringify({kind:'synthetic_asr_soak',seconds:totalFrames*.064,channels,frame_ms:64,
      requests,max_window_samples:maxWindow,max_active:maxActive,final_segments:finalCount,markers_per_channel:totalFrames,
      gc_available:!!global.gc,memory:samples,segmentation:coarse?'single-growing-segment':'per-marker',acoustic_model:false}));
  }finally{await pipe.dispose();mock.timers.reset();}
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TranscriptionClient} from '@tina/transcribe-whisper';
import {LiveKitStt,extractWavPcm} from './livekit-stt.js';
import {createBotPipeline} from './pipeline.js';

test('continuous frames are sent once; overlapping ASR windows carry references and retain quality filters',async()=>{
  const original=globalThis.WebSocket;let socket:any;const sent:any[]=[];
  class Socket {
    static OPEN=1;static CONNECTING=0;readyState=0;bufferedAmount=0;events=new Map<string,Function>();
    constructor(readonly url:URL,readonly protocols:string[]){socket=this;}
    addEventListener(name:string,fn:Function){this.events.set(name,fn);}
    send(line:string){
      const value=JSON.parse(line);sent.push(value);
      if(value.type==='window')queueMicrotask(()=>this.events.get('message')?.({data:JSON.stringify({type:'draft',id:value.id,
        result:{text:'Lan làm demo. lỗi',language:'vi',duration:.064,segments:[
          {text:'Lan làm demo.',start:0,end:.064,avg_logprob:0},{text:'lỗi',start:0,end:.064,avg_logprob:-10}]},server_timing:'asr_queue;dur=4'})}));
    }
    close(){this.readyState=3;this.events.get('close')?.();}
  }
  try{
    globalThis.WebSocket=Socket as any;
    const stream=new LiveKitStt('http://agents/audio/1/session','signed-cap',()=>{});
    const pcm=new Float32Array(1024).fill(.1);
    stream.feed('ch-1:1',pcm,1000);
    socket.readyState=1;socket.events.get('open')?.();socket.events.get('message')({data:'{"ready":true}'});
    const client=new TranscriptionClient({serviceUrl:'http://unused',model:'viegem',windowRequest:stream.requestWindow});
    const timing={stream:{id:'ch-1:1',start_ms:1000}};
    const result=await client.transcribe(pcm,'vi',undefined,timing);
    assert.equal(result.text,'Lan làm demo.');assert.equal(result.queue_ms,4);
    await client.transcribe(pcm,'vi',undefined,timing);
    assert.equal(sent.filter(v=>v.type==='audio').length,1);
    const windows=sent.filter(v=>v.type==='window');assert.equal(windows.length,2);
    assert.equal(windows[0].samples,1024);assert.equal(windows[0].stream,'ch-1:1');assert.equal(windows[0].audio,undefined);
    assert.equal(windows[0].sha256.length,64);
    assert.equal(String(socket.url),'ws://agents/audio/1/session/stt');
    assert.deepEqual(socket.protocols,['tina-audio-v1','cap.signed-cap']);
    stream.closeTurn('ch-1:1');assert.equal(sent.at(-1).type,'close_turn');stream.close();
  }finally{globalThis.WebSocket=original;}
});

test('missing cache or disconnected stream falls back to the exact HTTP window once',async()=>{
  const original=globalThis.WebSocket,fetch=globalThis.fetch;let socket:any;let calls=0;
  class Socket {
    static OPEN=1;readyState=1;bufferedAmount=0;events=new Map<string,Function>();
    constructor(){socket=this;}
    addEventListener(name:string,fn:Function){this.events.set(name,fn);}
    send(line:string){const v=JSON.parse(line);if(v.type==='window')queueMicrotask(()=>this.events.get('message')?.({data:JSON.stringify({id:v.id,status:409})}));}
    close(){this.events.get('close')?.();}
  }
  try{
    globalThis.WebSocket=Socket as any;
    globalThis.fetch=async(_url,options)=>{
      calls++;assert(Buffer.isBuffer(options?.body));assert(options!.body.includes(Buffer.alloc(2048)));
      return new Response(JSON.stringify({text:'tail retained',segments:[],language:'vi'}));
    };
    const stream=new LiveKitStt('http://agents/audio/1/session','cap',()=>{}),pcm=new Float32Array(1024);
    const client=new TranscriptionClient({serviceUrl:'http://fallback',windowRequest:stream.requestWindow,maxRetries:0});
    stream.feed('ch-0:1',pcm,1000);socket.events.get('message')({data:'{"ready":true}'});
    assert.equal((await client.transcribe(pcm,'vi',undefined,{stream:{id:'ch-0:1',start_ms:1000}})).text,'tail retained');
    assert.equal(calls,1);
    socket.close();
    assert.equal((await client.transcribe(pcm,'vi',undefined,{stream:{id:'ch-0:1',start_ms:1000}})).text,'tail retained');
    assert.equal(calls,2);stream.close();
  }finally{globalThis.WebSocket=original;globalThis.fetch=fetch;}
});

test('stream callbacks precede recognition and final LocalAgreement keeps original speaker and tail',async()=>{
  const feeds:any[]=[],published:any[]=[],closed:string[]=[];
  const pipeline=createBotPipeline({platform:'google_meet'} as any,{publish:async row=>{published.push(row);}}, {
    stream:{feed:(id,pcm,stamp)=>feeds.push({id,pcm,stamp}),closeTurn:id=>closed.push(id),close:()=>closed.push('all')},
    config:{minAudioDuration:.02,submitInterval:3600,confirmThreshold:1},
    transcribe:async(pcm,_prompt,timing)=>{
      assert(feeds.some(frame=>frame.id===timing?.stream?.id&&frame.stamp===timing?.stream?.start_ms));
      return {text:'Lan làm demo.',language:'vi',duration:pcm.length/16000,segments:[{text:'Lan làm demo.',start:0,end:pcm.length/16000}]};
    },
  });
  pipeline.feedAudio(1,'Lan',new Float32Array(777).fill(.1),1800000000000,'participant',0);
  await pipeline.stop();
  assert.equal(feeds.length,1);assert.equal(feeds[0].pcm.length,777);
  assert(published.some(row=>row.completed&&row.speaker==='Lan'&&row.text==='Lan làm demo.'));
  assert.equal(closed.at(-1),'all');
});

test('extractWavPcm locates data chunk past extra RIFF metadata chunks',()=>{
  const pcm=Buffer.from([1,2,3,4,5,6,7,8]);
  const fmt=Buffer.alloc(24);fmt.write('fmt ',0,'ascii');fmt.writeUInt32LE(16,4);fmt.writeUInt16LE(1,8);fmt.writeUInt16LE(1,10);fmt.writeUInt32LE(16000,12);fmt.writeUInt32LE(32000,16);fmt.writeUInt16LE(2,20);fmt.writeUInt16LE(16,22);
  const list=Buffer.alloc(16);list.write('LIST',0,'ascii');list.writeUInt32LE(8,4);list.write('INFOtest',8,'ascii');
  const data=Buffer.alloc(8+pcm.length);data.write('data',0,'ascii');data.writeUInt32LE(pcm.length,4);pcm.copy(data,8);
  const riff=Buffer.alloc(12);riff.write('RIFF',0,'ascii');riff.writeUInt32LE(4+fmt.length+list.length+data.length,4);riff.write('WAVE',8,'ascii');
  const wav=Buffer.concat([riff,fmt,list,data]);
  assert.deepEqual(extractWavPcm(wav),pcm);
});

test('window request times out internally on a silent open socket and falls back to HTTP',async()=>{
  const original=globalThis.WebSocket,fetch=globalThis.fetch;let socket:any;const sent:any[]=[];let httpCalls=0;
  class SilentSocket {
    static OPEN=1;readyState=1;bufferedAmount=0;events=new Map<string,Function>();
    constructor(){socket=this;}
    addEventListener(name:string,fn:Function){this.events.set(name,fn);}
    send(line:string){sent.push(JSON.parse(line));}
    close(){this.events.get('close')?.();}
  }
  try{
    globalThis.WebSocket=SilentSocket as any;
    globalThis.fetch=async()=>{httpCalls++;return new Response(JSON.stringify({text:'fallback ok',segments:[],language:'vi'}));};
    const stream=new LiveKitStt('http://agents/audio/1/session','cap',()=>{},40);
    const pcm=new Float32Array(1024).fill(.1);
    const client=new TranscriptionClient({serviceUrl:'http://fallback',windowRequest:stream.requestWindow,maxRetries:0});
    stream.feed('ch-0:1',pcm,1000);socket.events.get('message')({data:'{"ready":true}'});
    const res=await client.transcribe(pcm,'vi',undefined,{stream:{id:'ch-0:1',start_ms:1000}});
    assert.equal(res.text,'fallback ok');
    assert.equal(httpCalls,1);
    assert(sent.some(m=>m.type==='cancel'),'timeout must cancel the stuck window request on the server');
    stream.close();
  }finally{globalThis.WebSocket=original;globalThis.fetch=fetch;}
});

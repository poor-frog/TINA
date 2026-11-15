import {randomUUID} from 'node:crypto';
import type {WorkerFactory,VoiceWorker} from './meeting-voice.js';

export function livekitVadFactory(base:string,token:string):WorkerFactory {
  return (event,failed)=>{
    const url=new URL(base+'/vad');url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url,['tina-audio-v1','cap.'+token]);
    let closed=false,bytes=0;const queued:string[]=[];
    const timer=setTimeout(()=>fail(),20000);timer.unref();
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);queued.length=0;socket.close();};
    const fail=()=>{if(!closed){close();failed();}};
    socket.addEventListener('error',fail);socket.addEventListener('close',fail);
    socket.addEventListener('open',()=>{if(closed)return;try{for(const line of queued)socket.send(line);queued.length=0;bytes=0;}catch{fail();}});
    socket.addEventListener('message',message=>{
      if(closed)return;
      try{
        if(typeof message.data!=='string'||message.data.length>20000)throw Error();
        const value=JSON.parse(message.data);
        if(value.event==='vad-ready')clearTimeout(timer);
        event(value);
      }catch{fail();}
    });
    return {close,send(value){
      if(closed)return false;
      const line=JSON.stringify(value);
      if(queued.length>=64||bytes+line.length>512000||socket.bufferedAmount>512000){fail();return false;}
      try{
        if(socket.readyState===WebSocket.OPEN)socket.send(line);
        else if(socket.readyState===WebSocket.CONNECTING){queued.push(line);bytes+=line.length;}
        else return false;
        return true;
      }catch{fail();return false;}
    }};
  };
}

/** Observe only. Remote events never enter the primary voice controller. */
export class VadShadow {
  private worker?:VoiceWorker;
  private serial=0;
  private ready=false;
  private disabled=false;
  private generation=0;
  private phase='OFF';
  private local=new Map<string,Record<string,unknown>>();
  private remote=new Map<string,Record<string,unknown>>();
  private pending?:{id:string;request:string;channel:number;local:boolean;at:number};
  private timer?:ReturnType<typeof setTimeout>;
  private lastKey?:string;
  constructor(private factory:WorkerFactory,private log:(value:Record<string,unknown>)=>void=
    value=>console.log(JSON.stringify({type:'livekit_vad_shadow',...value,at_ms:Date.now()}))){}
  private record(value:Record<string,unknown>){try{this.log(value);}catch{ /* Diagnostics cannot control a voice turn. */ }}
  start(){
    if(this.worker||this.disabled)return;
    const serial=++this.serial;
    try{this.worker=this.factory(event=>{
      if(serial!==this.serial)return;
      if(event.event==='vad-ready'){
        this.ready=true;this.record({status:'ready'});this.control(this.phase,this.generation);return;
      }
      if(event.generation!==this.generation)return;
      if(event.event==='activity')this.compare(event,this.remote);
      else if(event.event==='endpoint'&&this.pending&&this.pending.id===event.id&&event.channel===this.pending.channel&&typeof event.ready==='boolean'){
        const pending=this.pending;this.pending=undefined;clearTimeout(this.timer);
        this.record({status:'endpoint',request_id:pending.request,channel:pending.channel,
          local_ready:pending.local,remote_ready:event.ready,agreement:pending.local===event.ready,elapsed_ms:Date.now()-pending.at});
      }
    },()=>{if(serial===this.serial)this.disable('unavailable');});}
    catch{this.disable('unavailable');}
  }
  private disable(status:string){
    this.serial++;this.disabled=true;this.ready=false;clearTimeout(this.timer);this.pending=undefined;
    const worker=this.worker;this.worker=undefined;worker?.close();this.local.clear();this.remote.clear();this.record({status});
  }
  private send(value:object){try{if(this.worker?.send(value)===false)this.disable('backpressure');}catch{this.disable('unavailable');}}
  control(state:string,generation:number){
    if(this.generation!==generation){this.local.clear();this.remote.clear();this.pending=undefined;this.lastKey=undefined;clearTimeout(this.timer);}
    this.generation=generation;this.phase=state;
    this.send({type:'control',state,generation});
  }
  feed(value:object){if(this.worker)this.send(value);}
  activity(event:Record<string,unknown>){if(event.generation===this.generation)this.compare(event,this.local);}
  private compare(event:Record<string,unknown>,target:Map<string,Record<string,unknown>>){
    if(!this.ready||!Number.isInteger(event.channel)||typeof event.stamp!=='number'||!Number.isFinite(event.stamp)||typeof event.speech!=='boolean')return;
    const key=`${event.channel}:${event.stamp}`;target.set(key,event);
    while(target.size>128)target.delete(target.keys().next().value!);
    const local=this.local.get(key),remote=this.remote.get(key);
    if(!local||!remote)return;
    this.local.delete(key);this.remote.delete(key);
    const delta=typeof local.endMs==='number'&&typeof remote.endMs==='number'?remote.endMs-local.endMs:undefined;
    this.record({status:'activity',channel:event.channel,source_stamp_ms:event.stamp,
      local_speech:local.speech,remote_speech:remote.speech,end_delta_ms:delta,
      agreement:local.speech===remote.speech&&(delta===undefined?local.endMs===remote.endMs:Math.abs(delta)<=2)});
  }
  observe(request:string,channel:number,end:number,asrEnd:number|undefined,localReady:boolean){
    if(!this.ready||this.pending||this.phase!=='CAPTURING')return;
    const key=JSON.stringify([request,channel,end,asrEnd,localReady]);if(key===this.lastKey)return;
    this.lastKey=key;
    const pending={id:randomUUID(),request,channel,local:localReady,at:Date.now()};this.pending=pending;
    this.send({type:'endpoint',id:pending.id,generation:this.generation,channel,end_ms:end,asr_end_ms:asrEnd,local_ready:localReady});
    this.timer=setTimeout(()=>{if(this.pending===pending){this.pending=undefined;this.record({status:'endpoint_timeout'});}},1500);this.timer.unref();
  }
  close(){this.disable('off');this.disabled=false;this.generation=0;this.phase='OFF';this.lastKey=undefined;}
}

import { spawn } from 'node:child_process';

export type NoiseState = 'off' | 'starting' | 'low' | 'failed';
export interface NoiseFrame { channel:number; pcm:Float32Array; stamp:number; participant?:string|null; startSample?:number }
interface Worker { send(value:object):boolean; close():void }
type Event = {ready?:boolean;seq?:number;audio?:string};
export type NoiseFactory = (event:(value:Event)=>void, failed:()=>void) => Worker;

/** Private LiveKit audio preprocessing. Credentials travel in handshake headers, never URL query. */
export function livekitNoiseFactory(base:string,token:string):NoiseFactory {
  return (event,failed)=>{
    const url=new URL(base+'/noise');url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url,['tina-audio-v1','cap.'+token]);
    let closed=false;const queued:string[]=[];
    const close=()=>{if(closed)return;closed=true;queued.length=0;socket.close();};
    const fail=()=>{if(!closed){close();failed();}};
    socket.addEventListener('error',fail);socket.addEventListener('close',fail);
    socket.addEventListener('open',()=>{
      if(closed)return;
      try{for(const line of queued)socket.send(line);queued.length=0;}catch{fail();}
    });
    socket.addEventListener('message',message=>{
      if(closed)return;
      try{
        if(typeof message.data!=='string'||message.data.length>100000)throw Error('Invalid filter reply');
        event(JSON.parse(message.data));
      }catch{fail();}
    });
    return {close,send(value){
      if(closed||queued.length>=64||socket.bufferedAmount>128000)return false;
      const line=JSON.stringify(value);
      if(socket.readyState===WebSocket.OPEN)socket.send(line);
      else if(socket.readyState===WebSocket.CONNECTING)queued.push(line);
      else return false;
      return true;
    }};
  };
}

function safeStderrErrorClass(chunk:string):string|undefined {
  for(const line of chunk.split('\n')){
    const m=/^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(line.trim());
    if(m)return m[1];
  }
  return undefined;
}

export const nativeNoiseWorker: NoiseFactory = (event, failed) => {
  const child=spawn(process.env.TINA_VOICE_PYTHON||'/opt/tina-voice/bin/python', ['-m','tina_meeting_voice.denoise_worker'],
    {stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1'}});
  let closed=false,buffer='',lastErrClass:string|undefined,stderrBytes=0;
  const close=()=>{if(closed)return;closed=true;child.stdin.end();child.kill('SIGKILL');};
  const fail=(reason?:string)=>{
    if(!closed){
      if(reason)console.error(JSON.stringify({type:'denoise_worker_failed',reason,error_class:lastErrClass,stderr_bytes:stderrBytes,at_ms:Date.now()}));
      close();failed();
    }
  };
  child.on('error',()=>fail('spawn_error'));
  child.on('exit',(code,sig)=>fail(`exit:${code??'null'}:${sig??'none'}`));
  child.stdin.on('error',()=>fail('stdin_error'));
  child.stderr.on('data',(chunk:Buffer)=>{
    stderrBytes+=chunk.length;
    const cls=safeStderrErrorClass(chunk.toString('utf8'));
    if(cls)lastErrClass=cls;
  });
  child.stdout.on('data',(chunk:Buffer)=>{
    buffer+=chunk.toString('utf8');if(buffer.length>1_000_000){fail('output_overflow');return;}
    let index:number;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      try{event(JSON.parse(line));}catch{fail('invalid_output');return;}}
  });
  return {close,send(value){if(closed||child.stdin.writableLength>128000)return false;
    child.stdin.write(JSON.stringify(value)+'\n');return true;}};
};

/** Off is an exact synchronous bypass. Failure drains only unacknowledged raw frames, once. */
export class NoiseSuppressor {
  state:NoiseState='off';
  private enabled=false;
  private worker?:Worker;
  private generation=0;
  private seq=0;
  private retryAt=0;
  private timer?:ReturnType<typeof setInterval>;
  private finish?:()=>void;
  private pending=new Map<number,{frame:NoiseFrame;deliver:(pcm:Float32Array)=>void;at:number}>();
  constructor(private factory:NoiseFactory=nativeNoiseWorker,
    private log:(state:NoiseState)=>void=state=>console.log(JSON.stringify({type:'noise_suppression',state,at_ms:Date.now()})),
    private frameTimeoutMs=1500, private startupTimeoutMs=5000){}
  private mode(state:NoiseState){if(this.state!==state){this.state=state;try{this.log(state);}catch{ /* Metrics cannot block audio. */ }}}
  private drain(state:NoiseState){
    this.retryAt=state==='failed'?Date.now()+5000:0;
    this.generation++;this.worker?.close();this.worker=undefined;clearInterval(this.timer);this.mode(state);
    const frames=[...this.pending.values()];this.pending.clear();
    for(const item of frames){try{item.deliver(item.frame.pcm);}catch{console.error('[bot] audio delivery failed');}}
    this.finish?.();this.finish=undefined;
  }
  setEnabled(enabled:boolean){
    if(enabled===this.enabled)return;
    this.enabled=enabled;
    if(!enabled)this.drain('off');else this.mode('starting');
  }
  feed(frame:NoiseFrame,deliver:(pcm:Float32Array)=>void){
    if(!this.enabled||this.state==='failed'&&Date.now()<this.retryAt){deliver(frame.pcm);return;}
    if(!Number.isInteger(frame.channel)||frame.channel<0||frame.channel>=65536||!Number.isFinite(frame.stamp)
      ||!frame.pcm.length||frame.pcm.length>16000||!frame.pcm.every(Number.isFinite)){deliver(frame.pcm);return;}
    if(!this.worker){
      this.mode('starting');
      const generation=++this.generation;
      try { this.worker=this.factory(event=>{
        if(generation!==this.generation)return;
        if(event.ready===true){this.mode('low');return;}
        const item=this.pending.get(event.seq!);
        if(!item||typeof event.audio!=='string'||event.audio.length>90000){this.drain('failed');return;}
        const bytes=Buffer.from(event.audio,'base64');
        if(bytes.length!==item.frame.pcm.byteLength){this.drain('failed');return;}
        const pcm=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
        if(!pcm.every(Number.isFinite)){this.drain('failed');return;}
        // The native worker emits complete original frames in source order on each channel.
        const previous=[...this.pending.values()].find(row=>row.frame.channel===item.frame.channel);
        if(previous!==item){this.drain('failed');return;}
        this.pending.delete(event.seq!);item.deliver(pcm);
        if(!this.pending.size){this.finish?.();this.finish=undefined;}
      },()=>{if(generation===this.generation)this.drain('failed');}); }
      catch { this.drain('failed');deliver(frame.pcm);return; }
      this.timer=setInterval(()=>{
        const limit=this.state==='starting'?this.startupTimeoutMs:this.frameTimeoutMs;
        if([...this.pending.values()].some(item=>Date.now()-item.at>limit))this.drain('failed');
      },100);this.timer.unref();
    }
    if(this.pending.size>=64){this.drain('failed');deliver(frame.pcm);return;}
    const seq=++this.seq;this.pending.set(seq,{frame,deliver,at:Date.now()});
    try { if(!this.worker.send({type:'audio',seq,channel:frame.channel,stamp:frame.stamp,startSample:frame.startSample,
      participant:typeof frame.participant==='string'&&frame.participant.length<=512?frame.participant:null,
      audio:Buffer.from(frame.pcm.buffer,frame.pcm.byteOffset,frame.pcm.byteLength).toString('base64')}))this.drain('failed'); }
    catch {this.drain('failed');}
  }
  async close(){
    if(this.worker&&this.pending.size){
      let timer:ReturnType<typeof setTimeout>|undefined;
      await new Promise<void>(resolve=>{
        this.finish=resolve;timer=setTimeout(resolve,2000);
        try{if(!this.worker?.send({type:'flush'}))this.drain('failed');}catch{this.drain('failed');}
      });clearTimeout(timer);
    }
    this.enabled=false;this.drain('off');
  }
}

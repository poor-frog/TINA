import {createHash} from 'node:crypto';
import {encodePcm16,type TranscriptionWindowRequest} from '@tina/transcribe-whisper';

/** Extract raw PCM payload from a RIFF/WAVE buffer without assuming a fixed 44-byte header. */
export function extractWavPcm(wav:Buffer):Buffer {
  if(wav.length>=12&&wav.subarray(0,4).toString('ascii')==='RIFF'&&wav.subarray(8,12).toString('ascii')==='WAVE'){
    let offset=12;
    while(offset+8<=wav.length){
      const chunkId=wav.subarray(offset,offset+4).toString('ascii');
      const size=wav.readUInt32LE(offset+4);
      const start=offset+8;
      if(chunkId==='data')return wav.subarray(start,Math.min(wav.length,start+size));
      offset=start+size+(size%2);
    }
  }
  return wav.subarray(44);
}

/** Continuous per-turn audio; the existing client still owns quality filtering and HTTP fallback. */
export class LiveKitStt {
  private socket?:WebSocket;
  private ready?:Promise<boolean>;
  private opened?: (ready:boolean)=>void;
  private queued:string[]=[];
  private queuedBytes=0;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:()=>void}>();
  private retryAt=0;
  private closed=false;
  private timer?:ReturnType<typeof setTimeout>;
  private reported=new Set<string>();
  constructor(private base:string,private token:string,
    private log:(event:string)=>void=event=>console.log(JSON.stringify({type:'asr_stream',event,at_ms:Date.now()})),
    private windowTimeoutMs=95_000){}

  private report(event:string){if(!this.reported.has(event)){this.reported.add(event);this.log(event);}}
  private fail(){
    const socket=this.socket;this.socket=undefined;this.queued=[];this.queuedBytes=0;clearTimeout(this.timer);
    this.opened?.(false);this.opened=undefined;this.ready=undefined;this.retryAt=Date.now()+1000;
    for(const pending of this.pending.values())pending.reject();
    this.pending.clear();socket?.close();
  }
  private connect(){
    if(this.socket||this.closed||Date.now()<this.retryAt)return;
    try{
      const url=new URL(this.base+'/stt');url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=new WebSocket(url,['tina-audio-v1','cap.'+this.token]);this.socket=socket;
      this.ready=new Promise(resolve=>{this.opened=resolve;});
      this.timer=setTimeout(()=>{if(this.socket===socket)this.fail();},3000);this.timer.unref();
      const failed=()=>{if(this.socket===socket){this.report('connection_failed');this.fail();}};
      socket.addEventListener('error',failed);socket.addEventListener('close',failed);
      socket.addEventListener('message',message=>{
        if(this.socket!==socket)return;
        try{
          if(typeof message.data!=='string'||message.data.length>512000)throw Error();
          const value=JSON.parse(message.data);
          if(value.ready===true){
            clearTimeout(this.timer);
            for(const line of this.queued)socket.send(line);
            this.queued=[];this.queuedBytes=0;this.opened?.(true);this.opened=undefined;this.reported.clear();this.report('ready');return;
          }
          const pending=this.pending.get(value.id);
          if(pending){this.pending.delete(value.id);pending.resolve(value);}
        }catch{failed();}
      });
    }catch{this.report('connection_failed');this.fail();}
  }
  private send(value:object):boolean {
    if(!this.socket)return false;
    const line=JSON.stringify(value);
    if(this.queued.length>=128||this.queuedBytes+line.length>512000||this.socket.bufferedAmount>512000){this.report('backpressure');this.fail();return false;}
    if(this.opened){this.queued.push(line);this.queuedBytes+=line.length;return true;}
    try{this.socket.send(line);return true;}catch{this.fail();return false;}
  }
  feed(stream:string,pcm:Float32Array,stamp:number){
    if(!pcm.length||pcm.length>16000||!Number.isFinite(stamp)||!pcm.every(Number.isFinite))return;
    this.connect();
    this.send({type:'audio',stream,stamp,audio:encodePcm16(pcm).toString('base64')});
  }
  closeTurn(stream:string){this.send({type:'close_turn',stream});}
  requestWindow:TranscriptionWindowRequest=async({wav,fields,timing,headers,signal})=>{
    if(!timing?.stream||!this.ready)return undefined;
    if(!await this.ready||signal.aborted)return undefined;
    const id=headers['X-ASR-Request-ID'];
    let abort:()=>void=()=>{};
    let windowTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      const reply=await new Promise<any>((resolve,reject)=>{
        abort=()=>{this.pending.delete(id);this.send({type:'cancel',id});reject(Object.assign(Error('ASR cancelled'),{name:'AbortError'}));};
        this.pending.set(id,{resolve,reject:()=>reject(Error('ASR stream disconnected'))});
        signal.addEventListener('abort',abort,{once:true});
        windowTimer=setTimeout(()=>{
          if(this.pending.delete(id)){
            this.send({type:'cancel',id});
            reject(Error('ASR stream window timeout'));
          }
        },this.windowTimeoutMs);
        windowTimer.unref();
        const pcm=extractWavPcm(wav);
        if(!this.send({type:'window',id,stream:timing.stream!.id,start_ms:timing.stream!.start_ms,
          samples:pcm.length/2,sha256:createHash('sha256').update(pcm).digest('hex'),fields,capture_ms:timing.capture_ms})){
          this.pending.delete(id);reject(Error('ASR stream unavailable'));
        }
      });
      if(reply.status===409){this.report('window_fallback');return undefined;}
      if(reply.type==='draft'&&reply.result&&typeof reply.result.text==='string'){
        return new Response(JSON.stringify(reply.result),{headers:{'Content-Type':'application/json','Server-Timing':reply.server_timing||''}});
      }
      if(Number.isInteger(reply.status)&&reply.status>=400&&reply.status<=599)
        return new Response(JSON.stringify({detail:'ASR backend rejected request'+(reply.status===400?' verbose_json':'')}),{status:reply.status});
      throw Error('Invalid STT stream response');
    }catch(error){
      if(signal.aborted)throw error;
      this.report('http_fallback');return undefined;
    }finally{clearTimeout(windowTimer);signal.removeEventListener('abort',abort);}
  };
  close(){this.closed=true;this.fail();}
}

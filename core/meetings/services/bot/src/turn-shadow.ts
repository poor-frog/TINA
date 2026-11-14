/** Content-free observations only: model scores never change voice turn boundaries. */
import { randomUUID } from 'node:crypto';
import type { VoiceWorker, WorkerFactory } from './meeting-voice.js';

type AudioRow = {participant?: string | null; end: number; nextSample?: number;
  blocks: Float32Array[]; samples: number};

export class TurnShadow {
  private worker?: VoiceWorker;
  private ready = false;
  private serial = 0;
  private rows = new Map<number, AudioRow>();
  private pending?: {id: string; request: string; channel: number; started: number; endMs: number; epoch: number};
  private lastKey?: string;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private factory: WorkerFactory, private log: (value: string) => void,
    private now: () => number = Date.now) {}

  private record(value: object) {
    try { this.log(JSON.stringify({type:'voice_turn_shadow',mode:'shadow',...value})); }
    catch { /* Observations cannot affect capture or voice. */ }
  }
  start() {
    if (this.worker) return;
    const serial = ++this.serial;
    try {
      this.worker = this.factory(event => {
        if (serial !== this.serial) return;
        if (event.event === 'turn-ready') { this.ready = true; this.record({status:'ready'}); return; }
        const pending = this.pending;
        if (event.event !== 'turn-result' || !pending || event.id !== pending.id) return;
        clearTimeout(this.timer); this.pending = undefined;
        if (pending.epoch !== this.epoch) return;
        const values = [event.smart_probability,event.namo_probability,event.smart_ms,event.namo_ms];
        if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            || (event.smart_probability as number)>1 || (event.namo_probability as number)>1) {
          this.disable('invalid_result'); return;
        }
        this.record({status:'observed',request_id:pending.request,channel:pending.channel,
          speech_end_ms:pending.endMs,candidate_at_ms:pending.started,
          smart_probability:event.smart_probability,namo_probability:event.namo_probability,
          smart_ms:event.smart_ms,namo_ms:event.namo_ms,elapsed_ms:this.now()-pending.started,
          agree:(event.smart_probability as number>=.5)===(event.namo_probability as number>=.5)});
      }, () => { if (serial === this.serial) this.disable('unavailable'); });
    } catch { this.disable('unavailable'); }
  }
  private disable(reason: string) {
    const worker=this.worker; this.worker=undefined; this.serial++; this.ready=false;
    clearTimeout(this.timer); this.pending=undefined; worker?.close();
    this.clearAudio();
    this.record({status:reason});
  }
  feed(channel: number, pcm: Float32Array, stamp: number, participant?: string | null, startSample?: number) {
    if (!this.worker || !Number.isInteger(channel) || channel<0 || channel>=65536
        || !Number.isFinite(stamp) || !pcm.length || pcm.length>16000 || !pcm.every(Number.isFinite)) return;
    for (const [key,row] of this.rows) if(stamp-row.end>20000) this.rows.delete(key);
    let row=this.rows.get(channel);
    if (row && (Math.abs(stamp-row.end)>80 || participant && row.participant && participant!==row.participant
        || startSample!==undefined && row.nextSample!==undefined && startSample!==row.nextSample)) {
      this.rows.delete(channel); row=undefined;
      if(this.pending?.channel===channel) this.epoch++;
    }
    if (!row) {
      if(this.rows.size>=32)return;
      row={participant,end:stamp,blocks:[],samples:0}; this.rows.set(channel,row);
    }
    row.participant=participant??row.participant; row.end=stamp+pcm.length/16;
    row.nextSample=startSample===undefined?undefined:startSample+pcm.length;
    row.blocks.push(pcm.slice()); row.samples+=pcm.length;
    while(row.samples>128000) {
      const first=row.blocks[0], excess=row.samples-128000;
      if(excess>=first.length){row.blocks.shift();row.samples-=first.length;}
      else {row.blocks[0]=first.slice(excess);row.samples-=excess;}
    }
  }
  observe(text: string, caller: {channel:number;participant?:string|null;startMs?:number}, endMs: number, request: string) {
    if(!this.ready || this.pending || !text || text.length>2000 || !Number.isFinite(endMs))return;
    const row=this.rows.get(caller.channel);
    if(!row || !row.samples || caller.participant && row.participant!==caller.participant
        || row.end<endMs-2 || row.end-endMs>3000)return;
    // A key is retained privately for deduplication; it is never included in diagnostics.
    const key=JSON.stringify([request,caller.channel,caller.participant,endMs,text]);
    if(key===this.lastKey)return;
    const audio=new Float32Array(row.samples);let at=0;
    for(const block of row.blocks){audio.set(block,at);at+=block.length;}
    const sourceStart=row.end-row.samples/16;
    const offset=Math.max(0,Math.floor(((caller.startMs??sourceStart)-500-sourceStart)*16));
    if(offset>=audio.length)return;
    const selected=audio.subarray(offset);
    const pending={id:randomUUID(),request,channel:caller.channel,started:this.now(),endMs,epoch:this.epoch};
    this.pending=pending;this.lastKey=key;
    try {
      if(this.worker?.send({id:pending.id,text,audio:Buffer.from(selected.buffer,selected.byteOffset,selected.byteLength).toString('base64')})!==true) {
        this.disable('unavailable');return;
      }
      // A slow optional model is retired; VAD/ASR and turn control keep running independently.
      this.timer=setTimeout(()=>this.disable('timeout'),1500);this.timer.unref();
    }catch {this.disable('unavailable');}
  }
  clearAudio(){this.rows.clear();this.lastKey=undefined;}
  resume(channel:number){if(this.pending?.channel===channel){this.epoch++;this.lastKey=undefined;}}
  cancel(){this.epoch++;this.clearAudio();}
  close(){this.cancel();this.serial++;this.ready=false;clearTimeout(this.timer);
    this.worker?.close();this.worker=undefined;this.pending=undefined;}
}

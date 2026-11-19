/** Caller-bound speech corrections; backchannels and playback echoes never grant a new turn. */
import {VoiceTrigger, invocation, type VoiceHypothesis} from './voice-trigger.js';

const refinement = /^(?:ý (?:tôi|mình) là|không[\s,]+(?:phải|ý (?:tôi|mình) là)|i mean|bổ sung|thêm|đổi(?: lại)?|sửa(?: lại)?|chỉ (?:lấy|cần|tập trung|tổng hợp|tóm tắt|giữ|xem|đọc|tìm|phần)|only (?:include|summarize|keep|show|read|search)|also (?:include|add)|instead)(?=$|[^\p{L}\p{N}_])/iu;
export const isVoiceRefinement = (text:string) => refinement.test(text);
const normalized = (text:string) => ' '+text.normalize('NFKC').toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';

export function mergeVoiceRefinement(original: string, update: string): string | null {
  // Public queries must be restated explicitly; never turn private task context into a web query.
  if (/^(?:tìm(?: kiếm)? (?:trên )?web|tra cứu web|search (?:the )?web|kiến thức chung|general knowledge|what is|what are|define)\b/iu.test(original)
      || /là gì\s*[?.!]*$/iu.test(original)) return null;
  const question = `${original}\nYêu cầu cập nhật: ${update}`;
  return question.length <= 2000 ? question : null;
}

export class VoiceInterruption {
  private trigger: VoiceTrigger;
  private expires: number;
  private playback: Array<{text:string;at:number}> = [];
  constructor(private caller: {channel:number;participant:string}, private after:number,
    private now:()=>number=Date.now) {
    this.trigger=new VoiceTrigger(now,[],true);
    this.expires=now()+330000;this.reset();
  }
  private reset(){this.trigger.continueAfter(this.after,this.caller,this.expires);}
  observePlayback(spoken:string) {
    const now=this.now();
    this.playback=this.playback.filter(row=>now-row.at<1800);
    if(spoken.trim()) {
      const text=normalized(spoken),previous=this.playback.find(row=>row.text===text);
      if(previous)previous.at=now;
      else this.playback.push({text,at:now});
      this.playback=this.playback.slice(-3);
    }
  }
  isPlaybackEcho(text:string) {
    return this.playback.some(row=>this.now()-row.at<1800 && (row.text===normalized(text)
      || text.trim().split(/\s+/u).length>=3 && row.text.includes(normalized(text))));
  }
  feed(value:VoiceHypothesis, spoken:string, allowRefinement=false, speaking=false) {
    this.observePlayback(spoken);
    const result=this.trigger.feed(value),fresh=this.trigger.heard;
    if(!fresh||!['wake','update'].includes(result))return null;
    const text=invocation(fresh.text,['hey TINA','hey ti na'])??fresh.text.trim();
    const match=/^(dừng lại|ngừng lại|dừng|ngừng|khoan(?: đã| một chút)?|đợi(?: đã| chút| một chút)?|chờ(?: đã| chút| một chút)?|ý tôi là|stop|wait|i mean)(?=$|[^\p{L}\p{N}_])[\s,.!?:;…—–-]*/iu.exec(text);
    const refining = allowRefinement && refinement.test(text);
    const asking=speaking && /^(?:cho (?:tôi|mình) hỏi|let me ask)(?=$|[^\p{L}\p{N}_])/iu.test(text);
    const echo = this.isPlaybackEcho(text);
    // shortcut: lexical intent and ASR timing, calibrate on held-out meeting audio before accepting arbitrary speech.
    const soft=speaking && !match;
    if((!match&&!refining&&!asking)||fresh.endMs-Math.max(fresh.startMs,fresh.speechStartMs??fresh.startMs)<(soft?350:150)
        || soft && (text.split(/\s+/u).length<3 || !fresh.final)
        ||echo){this.reset();return null;}
    if(result!=='wake')return null;
    const correction=refining||match && /^(ý tôi là|i mean)$/iu.test(match[1]);
    const question=correction||asking?text:text.slice(match![0].length).trim();
    return {value:fresh,question,resume:!!question||!/^(dừng lại|ngừng lại|dừng|ngừng|stop)$/iu.test(match![1]),
      refinement:allowRefinement && refinement.test(question)};
  }
}

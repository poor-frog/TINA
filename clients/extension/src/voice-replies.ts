/** Client view of core meeting-voice.v1; never converted into ASR transcript segments. */
export interface VoiceReply { request_id: string; text: string; played_text?:string; state: string; created_at_ms: number;
  source_count?:number;answer_kind?:'meeting'|'general'|'web'|'assistant';links?:Array<{url:string;title:string}> }
export const replyLabel: Record<string, string> = { queued: 'Đang chuẩn bị đọc', started: 'Đang đọc', completed: 'Đã đọc', stopped: 'Đã dừng', failed: 'Phát thất bại', unconfirmed: 'Chưa xác nhận phát xong' };
export function voiceReplies(value: unknown): VoiceReply[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Unsupported voice replies.');
  const rows = new Map<string, VoiceReply>();
  for (const item of value) {
    if (!item || typeof item.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.request_id)
        || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000
        || typeof item.state !== 'string' || !Object.prototype.hasOwnProperty.call(replyLabel, item.state) || !Number.isSafeInteger(item.created_at_ms)
        || item.created_at_ms < 0 || item.created_at_ms > 8.64e15) throw new Error('Unsupported voice reply.');
    if(item.played_text!=null&&(typeof item.played_text!=='string'||item.played_text.length>4000
      ||!item.text.trim().replace(/\s+/gu,' ').startsWith(item.played_text)))throw new Error('Unsupported played text.');
    if(item.answer_kind!=null&&!['meeting','general','web','assistant'].includes(item.answer_kind))throw new Error('Unsupported answer kind.');
    if(item.links!=null&&(!Array.isArray(item.links)||item.links.length>6||item.links.some((link:unknown)=>{
      if(!link||typeof link!=='object')return true;
      const row=link as Record<string,unknown>;
      if(typeof row.url!=='string'||row.url.length>4096||typeof row.title!=='string'||row.title.length>300)return true;
      try{const url=new URL(row.url);return !['http:','https:'].includes(url.protocol)||!!url.username||!!url.password;}catch{return true;}
    })))throw new Error('Unsupported public sources.');
    if(item.source_count!=null&&(!Number.isSafeInteger(item.source_count)||item.source_count<0||item.source_count>32))throw new Error('Unsupported source count.');
    rows.set(item.request_id, { request_id: item.request_id, text: item.text, state: item.state, created_at_ms: item.created_at_ms,
      ...(item.source_count==null?{}:{source_count:item.source_count}),
      ...(item.played_text==null?{}:{played_text:item.played_text}),
      ...(item.answer_kind==null?{}:{answer_kind:item.answer_kind}),...(item.links==null?{}:{links:item.links}) });
  }
  return [...rows.values()].sort((a, b) => a.created_at_ms - b.created_at_ms);
}

export interface VoiceSource {
  id: string; kind: 'transcript' | 'document' | 'calculation'; quote: string; segment_id?: string; speaker_name?: string | null;
  start_ms?: number | null; end_ms?: number | null; path?: string; paragraph?: number;
  calculation_query?: string;
  meeting_id?: number; meeting_title?: string | null; meeting_start_time?: string | null;
}
export interface VoiceSources { sources: VoiceSource[]; unavailable: number }
export function voiceSources(value: unknown): VoiceSources {
  if (!value || typeof value !== 'object') throw new Error('Unsupported voice sources.');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.sources) || body.sources.length > 32 || !Number.isSafeInteger(body.unavailable)
      || (body.unavailable as number) < 0 || (body.unavailable as number) > 32) throw new Error('Unsupported voice sources.');
  for (const row of body.sources) {
    if (!row || typeof row.id !== 'string' || !/^ctx-[0-9a-f]{64}$/.test(row.id) || !['transcript', 'document', 'calculation'].includes(row.kind) || typeof row.quote !== 'string' || !row.quote || row.quote.length > 1200
        || row.speaker_name != null && (typeof row.speaker_name !== 'string' || row.speaker_name.length > 512)
        || row.meeting_id != null && (!Number.isSafeInteger(row.meeting_id)||row.meeting_id<=0)
        || row.meeting_title != null && (typeof row.meeting_title!=='string'||row.meeting_title.length>300)
        || row.meeting_start_time != null && (typeof row.meeting_start_time!=='string'||row.meeting_start_time.length>64)
        || ['start_ms', 'end_ms'].some(key => row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)))
      throw new Error('Unsupported voice source.');
    if (row.kind === 'document' && (typeof row.path !== 'string' || row.path.length > 512 || !row.path.endsWith('.md')
        || row.path.startsWith('/') || row.path.split('/').includes('..')
        || row.paragraph != null && (!Number.isSafeInteger(row.paragraph) || row.paragraph < 0))
        || row.kind === 'transcript' && (typeof row.segment_id !== 'string' || !row.segment_id || row.segment_id.length > 512)
        || row.kind === 'calculation' && (typeof row.calculation_query !== 'string' || !row.calculation_query || row.calculation_query.length > 200))
      throw new Error('Unsupported voice source identity.');
  }
  return body as unknown as VoiceSources;
}

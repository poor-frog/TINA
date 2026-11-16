/** Pure, bounded assembly of ASR-addressed turns; source clocks fence repeats/late results. */
export interface VoiceHypothesis {
  channel: number; speakerKey: string; participant?: string | null;
  startMs: number; endMs: number; text: string; final: boolean;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
  asrStartedAtMs?: number; asrCompletedAtMs?: number;
  speechStartMs?: number;
}
export const VOICE_NAMES = ['TINA', 'Tina', 'TINA ơi', 'tin ơi', 'ti na ơi', 'tiên na ơi', 'tinh anh ơi','tin anh ơi'] as const;
export const VOICE_NOTICES = {
  wake: ['Dạ, em nghe.', 'Em đây, bạn nói đi.', 'Dạ, bạn cứ nói nhé.', 'Dạ, em đây.'],
  wait: ['Đợi em chút nhé.', 'Em đang xử lý yêu cầu nhé.', 'Em cần thêm một chút thời gian nhé.', 'Chờ em một lát nhé.'],
  summary: ['Em đang tổng hợp, bạn chờ một chút nhé.', 'Em đang tổng hợp thông tin nhé.', 'Em tổng hợp lại một chút nhé.', 'Em gom lại các ý chính nhé.'],
} as const;
export const VOICE_PROGRESS_NOTICES = {
  searching_transcript: 'Em đang tìm trong nội dung cuộc họp nhé.',
  reading_documents: 'Em đang tìm trong tài liệu được chia sẻ nhé.',
  searching_web: 'Em đang tìm thông tin trên web nhé.',
  reading_context: 'Em đang đọc kỹ phần liên quan nhé.',
  drafting: 'Em đang soạn bản nháp nhé.',
  answering: VOICE_NOTICES.summary[1],
} as const;
export function voiceProgressNotice(value: unknown, requestId: string, revision: number, now = Date.now()): string | undefined {
  if (!value || typeof value !== 'object') return;
  const progress = value as Record<string, unknown>;
  if (progress.request_id !== requestId || progress.revision !== revision
      || typeof progress.observed_at_ms !== 'number' || !Number.isSafeInteger(progress.observed_at_ms)
      || now - progress.observed_at_ms < 0 || now - progress.observed_at_ms >= 15_000
      || typeof progress.stage !== 'string' || !Object.hasOwn(VOICE_PROGRESS_NOTICES, progress.stage)) return;
  return VOICE_PROGRESS_NOTICES[progress.stage as keyof typeof VOICE_PROGRESS_NOTICES];
}
export const SUMMARY_NOTICE = VOICE_NOTICES.summary[0];
export const VOICE_SERVICE_ERROR = 'Em chưa lấy được câu trả lời lúc này. Bạn có thể xem trạng thái trên TINA Terminal.';
const fixedNotices = new Set<string>([...Object.values(VOICE_NOTICES).flat(), ...Object.values(VOICE_PROGRESS_NOTICES),
  VOICE_SERVICE_ERROR, 'Để em kiểm tra nhé.', 'Em đang kiểm tra thông tin nhé.']);
export function isFixedVoiceNotice(text?: string): boolean { return text !== undefined && fixedNotices.has(text); }
const echoKey = (text: string) => text.normalize('NFKC').toLocaleLowerCase('vi').replace(/[^\p{L}]/gu, '');
const noticeEchoes = new Set([...fixedNotices].map(echoKey));
export function summaryWaitNotice(question: string): string | undefined {
  // Notice only; the source-authorized server still decides whether this is a whole-meeting recap.
  if (/(?:cách|phương pháp|làm sao để|how to)\s+(?:tóm tắt|tổng kết|summari[sz]e)|(?:\d+|vài|mấy)\s*(?:phút|giờ)|gần đây|vừa rồi|vừa nói|recent|last\s+\d+/iu.test(question)) return;
  if (/(?:tóm tắt|tổng kết|tổng hợp|điểm lại).*(?:cuộc họp|meeting)|(?:tóm tắt|tổng kết|tổng hợp).*từ đầu.*(?:đến giờ|đến nay)|\b(?:summari[sz]e|recap|summary of)\s+(?:(?:the|this|whole|entire|our)\s+)*meeting\b/iu.test(question)) return SUMMARY_NOTICE;
}
export function invocation(text: string, variants: string[] = []): string | null {
  const value = text.normalize('NFKC').trim();
  for (const name of [...VOICE_NAMES, ...variants].sort((a, b) => b.length - a.length)) {
    const escaped = name.trim().normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) continue;
    const match = new RegExp(`^${escaped}(?=$|[^\\p{L}\\p{N}_])(?:[\\s,.!?:;…—–-]*)`, 'iu').exec(value);
    if (match) {
      const rest = value.slice(match[0].length).trim();
      // A vocative/polite particle alone is still a name call, not a question.
      return /^(?:(?:ạ|à|ơi)[\s,.!?:;…—–-]*)+$/iu.test(rest) ? '' : rest;
    }
  }
  return null;
}
export function speechSentences(text: string): string[] {
  // Intl handles Vietnamese sentence boundaries and keeps decimal/abbreviation context.
  const sentences = [...new Intl.Segmenter('vi', { granularity: 'sentence' }).segment(text)].map(s => s.segment.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const sentence of sentences) {
    let current = '';
    for (const word of sentence.split(/\s+/u)) {
      if (current && current.length + word.length + 1 > 360) { parts.push(current); current = ''; }
      current += (current ? ' ' : '') + word;
    }
    if (current) parts.push(current);
  }
  return parts;
}

export function turnPauseMs(text: string): number {
  const value = text.normalize('NFKC').trim();
  // shortcut: lexical pause cues only; replace after a held-out Vietnamese turn-ending evaluation.
  const unfinished = /(?:…|\.{2,}|[,;:])$/u.test(value)
    || /(?:^|\s)(?:và|nhưng|nếu|vì|để|về|của|phần|giúp tôi|cho tôi|ý tôi là|and|but|because|about|with|i mean)\s*[.!]?$/iu.test(value);
  return unfinished ? 2000 : 0;
}
interface Candidate { parts: VoiceHypothesis[]; confirmed: boolean; matches: number; seen: number; started: number; direct?: boolean; acoustic?: boolean; }
export interface AcousticWake { channel: number; participant?: string | null; startMs: number; endMs: number; }
export class VoiceTrigger {
  private candidate?: Candidate;
  private acoustic?: AcousticWake & {started: number};
  private after = 0;
  private continuation?: {channel: number; participant?: string | null; expires: number; after: number; speechStarted?: number};
  heard?: VoiceHypothesis;
  reason: 'waiting' | 'invalid_asr' | 'stale_asr' | 'name_not_matched' | 'name_unconfirmed' | 'ambiguous_window' | 'other_channel' = 'waiting';
  constructor(private now: () => number = Date.now, private variants: string[] = [], private acousticOnly = false) {}
  reset(after = this.now(), variants = this.variants) { this.after = after; this.variants = variants; this.candidate = undefined; this.acoustic = undefined; this.heard = undefined; this.continuation = undefined; }
  wake(value: AcousticWake) {
    if (!Number.isInteger(value.channel) || value.channel < 0 || value.channel >= 65536
        || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.endMs <= value.startMs
        || value.endMs < this.after || value.endMs > this.now() + 1000) return false;
    const after = Math.max(this.after, value.startMs);
    this.reset(after); this.acoustic = {...value, startMs: after, started: this.now()};
    return true;
  }
  continueAfter(after: number, caller: {channel: number; participant?: string | null}, expires = this.now() + 10000) {
    this.reset(after); this.continuation = {...caller, expires, after};
  }
  get answeringContinuation() { return this.candidate?.direct === true && !this.candidate.acoustic; }
  get hasContinuation() { return this.continuation !== undefined
    && this.now() < (this.continuation.speechStarted === undefined ? this.continuation.expires : this.continuation.speechStarted + 20_000); }
  continuationSpeech(channel: number, participant: string | null | undefined, stamp: number) {
    const c = this.continuation;
    if (!c || c.speechStarted !== undefined || this.now() >= c.expires
        || !Number.isFinite(stamp) || stamp < c.after || stamp >= c.expires || stamp > this.now() + 1000
        || channel !== c.channel || !c.participant || participant !== c.participant) return false;
    c.speechStarted = this.now();
    return true;
  }
  get continuationCaller() { return this.hasContinuation ? {...this.continuation!} : undefined; }
  takeExpiredContinuation() {
    if (this.candidate || !this.continuation || this.hasContinuation) return;
    const value=this.continuation;this.continuation=undefined;return value;
  }
  get acceptAfter() { return this.after; }
  get caller() {
    const first = this.candidate?.parts[0];
    return first ? {...first, participant: first.participant ?? this.acoustic?.participant} : this.acoustic;
  }
  get channel() { return this.candidate?.parts.at(-1)?.channel ?? this.acoustic?.channel; }
  get startMs() { return this.candidate?.parts[0]?.startMs ?? this.acoustic?.startMs; }
  get endMs() { return this.candidate?.parts.at(-1)?.endMs; }
  get active() { return this.candidate?.confirmed === true || this.acoustic !== undefined; }
  get pending() { return this.candidate !== undefined || this.acoustic !== undefined; }
  feed(value: VoiceHypothesis): 'wake' | 'update' | 'ignore' | 'discard' {
    this.reason = 'waiting';
    this.heard = undefined;
    const speechStart = Math.max(value.startMs, value.speechStartMs ?? value.startMs);
    if (!Number.isInteger(value.channel) || value.channel < 0 || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
        || !Number.isFinite(speechStart) || speechStart > value.endMs
        || value.endMs <= value.startMs || value.endMs > this.now() + 1000
        || typeof value.text !== 'string' || value.text.length > 4000) {
      this.reason = 'invalid_asr'; return 'ignore';
    }
    if (speechStart < this.after) {
      // Background PCM can keep the channel onset old; only timed ASR speech intervals prove fresh words.
      const segments = value.segments;
      const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ');
      const valid = segments && segments.length <= 256 && segments.every((s, i) =>
        typeof s.text === 'string' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs)
        && s.startMs >= value.startMs && s.endMs <= value.endMs + 2 && s.endMs > s.startMs
        && (!i || s.startMs >= segments[i - 1].endMs - 2))
        && normalize(segments.map(s => s.text).join(' ')) === normalize(value.text);
      const fresh = valid ? segments.filter(s => s.startMs >= this.after) : [];
      if (!fresh.length) { this.reason = 'stale_asr'; return 'ignore'; }
      value = { ...value, startMs: fresh[0].startMs, speechStartMs: fresh[0].startMs,
        text: fresh.map(s => s.text).join(' '), segments: fresh };
    }
    this.heard = value;
    const text = value.text.trim();
    if (!text) return 'ignore';
    if (this.acoustic && (value.channel !== this.acoustic.channel
        || this.acoustic.participant && value.participant && value.participant !== this.acoustic.participant)) {
      this.reason = 'other_channel'; return 'ignore';
    }
    if (this.acoustic && value.endMs < this.acoustic.endMs - 800) {
      this.reason = 'stale_asr'; return 'ignore';
    }
    let c = this.candidate;
    if (c && (this.expired() || (!this.acousticOnly && !c.confirmed && value.channel !== c.parts[0].channel && invocation(text, this.variants) !== null))) {
      this.candidate = undefined; c = undefined;
    }
    const acoustic = this.acoustic !== undefined;
    if (!c) {
      if (this.acousticOnly && !acoustic && (!this.hasContinuation || value.channel !== this.continuation!.channel
          || this.continuation!.participant && value.participant !== this.continuation!.participant)) {
        this.reason = 'name_not_matched'; return 'ignore';
      }
      const direct = acoustic || invocation(text, this.variants) === null;
      if (direct && this.continuation && noticeEchoes.has(echoKey(text))) return 'ignore';
      if (direct && !acoustic && (!this.continuation || !this.hasContinuation
          || value.channel !== this.continuation.channel
          || (this.continuation.participant && value.participant !== this.continuation.participant))) {
        this.reason = 'name_not_matched'; return 'ignore';
      }
      const started = this.continuation?.speechStarted;
      this.continuation = undefined;
      this.candidate = { parts: [{ ...value, text }], confirmed: value.final, matches: 1, seen: this.now(),
        started: this.acoustic?.started ?? started ?? this.now(), direct, acoustic };
      this.reason = value.final ? 'waiting' : 'name_unconfirmed';
      return value.final ? 'wake' : 'update';
    }
    const first = c.parts[0], last = c.parts.at(-1)!;
    if (value.channel !== first.channel) { this.reason = 'other_channel'; return 'ignore'; }
    if ((value.participant && last.participant && value.participant !== last.participant)
        || value.startMs < last.startMs || this.now() - c.started > 20_000 || value.startMs - last.endMs > 5000) return this.discard();
    if (value.startMs === last.startMs) {
      if (value.endMs < last.endMs) return 'ignore';
      if (!c.direct && c.parts.length === 1 && invocation(text, this.variants) === null) return this.discard('name_not_matched');
      last.text = text; last.endMs = value.endMs; last.segments = value.segments; last.final = value.final;
    } else {
      if (value.startMs < last.endMs - 2) {
        const prefix = last.segments?.filter(s => s.endMs <= value.startMs + 2);
        const boundary = prefix?.at(-1)?.endMs;
        if (!prefix?.length || boundary === undefined || Math.abs(boundary - value.startMs) > 2) return this.discard();
        last.text = prefix.map(s => s.text).join(' '); last.endMs = boundary;
      }
      if (c.parts.length >= 24) return this.discard();
      c.parts.push({ ...value, text });
    }
    c.matches++; c.seen = this.now();
    if (!c.confirmed && (value.final || c.matches >= 2)) { c.confirmed = true; return 'wake'; }
    return 'update';
  }
  private discard(reason: 'ambiguous_window' | 'name_not_matched' = 'ambiguous_window'): 'discard' { this.reset(this.now()); this.reason = reason; return 'discard'; }
  private questionText(c: Candidate): string | null {
    const text=c.parts.map(p=>p.text).join(' ').trim();
    if(!c.acoustic)return c.direct?text:invocation(text,this.variants);
    // ASR may split the wake phrase across windows; clean only the assembled question copy.
    const names=[...this.variants,'hây ti na','ti na','ti nà ơi','ti nà','tiên na','anh ơi'];
    return invocation(text,names)??invocation(text.replace(/^(?:hey|hây)[\s,.!?:;…—–-]+/iu,''),names)??text;
  }
  question(quietEndMs: number | undefined, observeBeforeLexicalPause = false): string | null {
    const c = this.candidate;
    if (!c || !c.confirmed || quietEndMs === undefined) return null;
    const last = c.parts.at(-1)!;
    // Both clocks come from capture samples; only rounding slack is safe for a short final word.
    if (last.endMs < quietEndMs - 2 || this.now() - c.seen < 300) return null;
    const question = this.questionText(c);
    const pause = question ? turnPauseMs(question) : 0;
    if (!observeBeforeLexicalPause && pause > 0 && this.now() - quietEndMs < pause) return null;
    return question !== null && question.length <= 2000 ? question : null;
  }
  expired() {
    const c = this.candidate;
    if (!c) return this.acoustic !== undefined && this.now() - this.acoustic.started > 20_000;
    const text = this.questionText(c);
    return this.now() - c.started > (text ? 20_000 : 5000);
  }
}

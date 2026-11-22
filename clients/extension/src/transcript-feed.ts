import { groupSegments, type TranscriptSegment } from './transcript-rendering';
import { translationSegments, type TranscriptLanguage, type TranslationGroup, type PhraseTranslation } from './translation';
import { replyLabel, type VoiceReply, type VoiceSources } from './voice-replies';
import {formatTranscript} from '../../../packages/transcript-rendering/src/format';

type Segment = TranscriptSegment & { speaker_key?: string; translation?: PhraseTranslation };
interface PinControls {
  available: (source: Segment) => boolean;
  pinned: (id: string) => boolean;
  busy: (id: string) => boolean;
  toggle: (source: Segment) => void;
}
const identity = (s: Segment): string => s.segment_id || `${s.speaker_key || s.speaker || ''}:${s.absolute_start_time}`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; return el;
}
function text(el: HTMLElement, value: string): void { if (el.textContent !== value) el.textContent = value; }
function reconcile(parent: HTMLElement, children: HTMLElement[]): void {
  children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null); });
  while (parent.children.length > children.length) parent.lastElementChild!.remove();
}

/** Update only changed text; keep the reader's scroll anchor through live revisions. */
export function createTranscriptFeed(feed: HTMLElement, root: HTMLElement, latest: HTMLButtonElement, evidence?: {
  load: (requestId: string, signal: AbortSignal) => Promise<VoiceSources>;
  url: (requestId: string, sourceId: string) => string;
}) {
  const rows = new Map<string, ReturnType<typeof createTurn>>();
  const spans = new Map<string, HTMLSpanElement>();
  const pinRows = new Map<string, { row: HTMLSpanElement; button: HTMLButtonElement; source: Segment }>();
  const translations = new Map<string, HTMLSpanElement>();
  const originals = new Map<string, HTMLSpanElement>();
  const replyRows = new Map<string, { row: HTMLElement; time: HTMLTimeElement; state: HTMLElement; copy: HTMLElement; note: HTMLElement; sources:HTMLElement }>();
  let following = true;
  let highlighted: HTMLSpanElement | undefined;
  let sourceAbort: AbortController | undefined, sourceTimer: ReturnType<typeof setTimeout> | undefined;
  let openSources: HTMLDetailsElement | undefined;
  function clearSources() { sourceAbort?.abort(); clearTimeout(sourceTimer); }
  function sourceDetails(reply: VoiceReply) {
    const details = element('details', 'voice-evidence');
    const summary = element('summary', 'voice-source-toggle'); text(summary, `Nguồn · ${reply.source_count}`);
    const content = element('div', 'voice-source-quotes'); details.append(summary, content);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (!details.open) { if (openSources === details) { clearSources(); openSources = undefined; } content.replaceChildren(); return; }
      clearSources(); if (openSources && openSources !== details) openSources.open = false;
      openSources = details; sourceAbort = new AbortController(); const signal = sourceAbort.signal;
      async function refresh() {
        try {
          const result = await evidence!.load(reply.request_id, signal);
          if (signal.aborted || !details.isConnected) return;
          const children: HTMLElement[] = [];
          if (result.unavailable) { const note = element('p', 'turn-time'); note.setAttribute('role', 'status'); text(note, `${result.unavailable} nguồn đã thay đổi hoặc không còn được chia sẻ.`); children.push(note); }
          for (const source of result.sources) {
            const card = element('div', 'voice-source-quote'), label = element('div', 'turn-time');
            const ms = source.start_ms;
            const time = ms == null ? '' : ms > 1e12 ? new Date(ms).toLocaleTimeString('vi-VN') : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
            text(label, source.kind === 'calculation' ? 'Phép tính được kiểm tra' : source.kind === 'transcript' ? `${source.speaker_name || 'Người nói'} · ${time}` : `${source.path} · đoạn ${(source.paragraph ?? 0) + 1}`);
            if(source.meeting_id)text(label,`${source.meeting_title||`Cuộc họp ${source.meeting_id}`} · ${source.meeting_start_time||''} · ${label.textContent}`);
            const quote = element('blockquote', 'turn-copy'); text(quote, source.quote);
            const link = element('a', 'voice-source'); link.href = evidence!.url(reply.request_id, source.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; text(link, 'Mở nguồn trong Terminal ↗');
            if(source.kind==='transcript'&&source.meeting_id){const url=new URL(link.href);url.pathname=`/meetings/${source.meeting_id}`;url.search='';url.hash='';link.href=url.href;text(link,'Mở cuộc họp nguồn trong Terminal ↗');}
            card.append(label, quote, link); children.push(card);
          }
          if (!children.length) { const empty = element('p', 'turn-time'); text(empty, 'Câu trả lời này chưa lưu nguồn trích dẫn.'); children.push(empty); }
          content.replaceChildren(...children);
        } catch { if (!signal.aborted) { content.replaceChildren(); const error = element('p', 'turn-time'); error.setAttribute('role', 'status'); text(error, 'Chưa kiểm tra được nguồn. Đang thử lại…'); content.append(error); } }
        finally { if (!signal.aborted) sourceTimer = setTimeout(refresh, 5000); }
      }
      text(content, 'Đang kiểm tra nguồn…'); void refresh();
    });
    return details;
  }
  function createTurn() {
    const row = element('article', 'transcript-turn'); row.setAttribute('role', 'listitem');
    const header = element('header', 'turn-header');
    const avatar = element('span', 'speaker-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const initial = element('span', 'speaker-initial'); avatar.append(initial);
    const name = element('strong', 'speaker-name'), time = element('time', 'turn-time');
    const confirmed = element('p', 'turn-copy'), draft = element('div', 'turn-draft');
    const label = element('span', 'draft-label'), pending = element('p', 'turn-copy');
    header.append(avatar, name, time); draft.append(label, pending); row.append(header, confirmed, draft);
    return { row, avatar, initial, photo: undefined as HTMLImageElement | undefined, name, time, confirmed, draft, label, pending };
  }
  function updateLatest() { latest.hidden = following || !root.children.length; }
  function scrollToLatest() { following = true; latest.hidden = true; feed.scrollTop = feed.scrollHeight; }
  feed.addEventListener('scroll', () => {
    if (!feed.clientHeight) return;
    following = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 48; updateLatest();
  }, { passive: true });
  latest.addEventListener('click', scrollToLatest);
  return {
    reset() { clearSources(); openSources = undefined; highlighted = undefined; rows.clear(); spans.clear(); pinRows.clear(); translations.clear(); originals.clear(); replyRows.clear(); root.replaceChildren(); following = true; latest.hidden = true; feed.scrollTop = 0; },
    reveal() { if (following) scrollToLatest(); },
    focusSegment(id: string): boolean {
      const span = spans.get(id);
      if (!span?.isConnected) return false;
      highlighted?.classList.remove('transcript-source-target');
      highlighted = span;
      following = false;
      span.classList.add('transcript-source-target');
      span.tabIndex = -1;
      span.focus({ preventScroll: true });
      const rect = span.getBoundingClientRect();
      feed.scrollTop += rect.top - feed.getBoundingClientRect().top - (feed.clientHeight - rect.height) / 2;
      updateLatest();
      return true;
    },
    render(segments: Segment[], draftLabel: string, language: TranscriptLanguage = 'vi', translationGroups: TranslationGroup[] = [], paused = false, replies: VoiceReply[] = [], pins?: PinControls, photoFor?: (segment: TranscriptSegment) => string | undefined) {
      const selection = document.getSelection?.();
      const selected = selection?.rangeCount && feed.contains(selection.anchorNode) && feed.contains(selection.focusNode)
        ? { anchor: selection.anchorNode!, anchorOffset: selection.anchorOffset, focus: selection.focusNode!, focusOffset: selection.focusOffset } : null;
      const oldTop = feed.scrollTop;
      const anchor = !following && feed.clientHeight ? Array.from(root.children).find(row => row.getBoundingClientRect().bottom > feed.getBoundingClientRect().top) : undefined;
      const anchorTop = anchor?.getBoundingClientRect().top;
      const displayed = language === 'vi' ? segments : translationSegments(segments, translationGroups);
      const pinSources = pins ? new Map(segments.filter(pins.available).map(segment => [segment.segment_id, segment])) : undefined;
      const groups = groupSegments(displayed, { getGroupKey: s => (photoFor && s.speaker_id) || (s as Segment).speaker_key || s.speaker || 'unknown' });
      const activeRows = new Set<string>(), activeSpans = new Set<string>();
      const ordered = groups.map(group => {
        const key = identity(group.segments[0]); activeRows.add(key);
        let turn = rows.get(key); if (!turn) { turn = createTurn(); rows.set(key, turn); }
        const speaker = group.segments[0];
        const name = speaker.speaker || 'Unknown speaker';
        text(turn.name, name);
        text(turn.initial, name === 'Unknown speaker' ? '?' : Array.from(name)[0].toUpperCase());
        const url = photoFor?.(speaker);
        if (turn.photo?.src !== url) {
          turn.photo?.remove();
          turn.photo = undefined;
          if (url) {
            const image = element('img', 'speaker-photo');
            image.alt = '';
            image.referrerPolicy = 'no-referrer';
            image.hidden = true;
            image.addEventListener('load', () => { image.hidden = false; }, { once: true });
            image.src = url;
            turn.photo = image;
            turn.avatar.append(image);
          }
        }
        const date = new Date(group.startTime);
        text(turn.time, Number.isFinite(date.getTime()) ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
        if (turn.time.dateTime !== group.startTime) turn.time.dateTime = group.startTime;
        turn.row.dataset.sourceTime = String(date.getTime());
        const confirmed: HTMLElement[] = [], pending: HTMLElement[] = [];
        for (const segment of group.segments) {
          const id = identity(segment); activeSpans.add(id);
          let span = spans.get(id); if (!span) { span = element('span', 'transcript-segment'); spans.set(id, span); }
          const display=formatTranscript(segment.text,segment.completed!==false,segment.translation?.sourceParts);
          if(display.changes.length){span.dataset.asrFormat=display.version;span.dataset.asrFormatChanges=JSON.stringify(display.changes);}
          else {delete span.dataset.asrFormat;delete span.dataset.asrFormatChanges;}
          if (language === 'vi') {
            if(span.classList.contains('segment-bilingual'))span.replaceChildren();
            text(span, display.text.trim() + ' ');
            originals.delete(id); translations.delete(id);
            span.classList.remove('segment-bilingual');
          } else {
            let original = originals.get(id), english = translations.get(id);
            if (!original || !english) {
              original = element('span', 'segment-original'); english = element('span', 'segment-english'); english.lang = 'en';
              originals.set(id, original); translations.set(id, english); span.replaceChildren(original, english);
            }
            span.classList.add('segment-bilingual');
            const result = segment.translation?.text;
            let pendingTranslation = segment.completed === false ? 'Chờ đoạn nói hoàn tất…' : paused ? 'Chưa dịch được · bản gốc vẫn được giữ' : segment.translation?.ready ? 'Đang dịch…' : 'Đang gom câu…';
            if (segment.completed !== false && segment.translation?.status === 'failed') pendingTranslation = 'Chưa dịch được đoạn này · bấm Thử lại';
            if (segment.completed !== false && segment.translation?.status === 'retrying') pendingTranslation = 'Đoạn này đang chờ thử lại…';
            text(original, display.text.trim()); original.hidden = language === 'en' && !!result;
            text(english, `EN  ${result || pendingTranslation}`);
          }
          const sourceId = segment.translation?.sourceIds?.find(sourceId => pinSources?.has(sourceId)) ?? segment.segment_id;
          const source = pinSources?.get(sourceId);
          let content: HTMLElement = span;
          if (pins && source?.segment_id) {
            let item = pinRows.get(id);
            if (!item) {
              const row = element('span', 'pinnable-segment');
              const button = element('button', 'note-pin-toggle');
              button.type = 'button';
              button.setAttribute('aria-label', 'Ghim đoạn transcript');
              const svgNamespace = 'http://www.w3.org/2000/svg';
              const icon = document.createElementNS(svgNamespace, 'svg');
              icon.setAttribute('viewBox', '0 0 24 24');
              icon.setAttribute('aria-hidden', 'true');
              const head = document.createElementNS(svgNamespace, 'path');
              head.setAttribute('d', 'M9 3h6v2l-1 1v4l3 3v2H7v-2l3-3V6L9 5z');
              const point = document.createElementNS(svgNamespace, 'path');
              point.setAttribute('d', 'M12 15v6');
              icon.append(head, point);
              button.append(icon);
              item = { row, button, source };
              const action = item;
              button.addEventListener('click', () => pins.toggle(action.source));
              pinRows.set(id, item);
            }
            item.source = source;
            if (span.parentElement !== item.row) item.row.replaceChildren(span, item.button);
            const pinned = pins.pinned(source.segment_id);
            item.button.setAttribute('aria-pressed', String(pinned));
            item.button.title = pinned ? 'Bỏ ghim' : 'Ghim';
            item.button.disabled = pins.busy(source.segment_id);
            content = item.row;
          }
          (segment.completed === false ? pending : confirmed).push(content);
        }
        reconcile(turn.confirmed, confirmed); reconcile(turn.pending, pending);
        turn.confirmed.hidden = !confirmed.length; turn.draft.hidden = !pending.length;
        text(turn.label, draftLabel);
        return turn.row;
      });
      const activeReplies = new Set<string>();
      for (const reply of replies) {
        activeReplies.add(reply.request_id);
        let item = replyRows.get(reply.request_id);
        if (!item) {
          const row = element('article', 'transcript-turn voice-reply'); row.setAttribute('aria-label', 'TINA trả lời'); row.setAttribute('role', 'listitem');
          const header = element('header', 'turn-header'), name = element('strong', 'speaker-name'); text(name, 'TINA trả lời');
          const state = element('span', 'turn-time'); state.setAttribute('role', 'status');
          const time = element('time', 'turn-time'), copy = element('p', 'turn-copy'), note = element('p', 'turn-time');
          const sources=element('div','voice-sources');
          header.append(name, state, time); row.append(header, copy, sources, note);
          item = { row, state, time, copy, note, sources }; replyRows.set(reply.request_id, item);
        }
        const partial=reply.state==='stopped'&&reply.played_text!==undefined;
        text(item.state, replyLabel[reply.state]+(reply.answer_kind==='web'?' · Web':reply.answer_kind==='general'?' · Kiến thức chung':reply.answer_kind==='assistant'?' · Trợ lý':'')); text(item.copy, partial ? reply.played_text||'Chưa có câu nào được phát trọn vẹn.' : reply.text);
        const signature=JSON.stringify([reply.links||[],reply.source_count||0]);
        if(item.sources.dataset.links!==signature){
          item.sources.replaceChildren(...(reply.links||[]).map(link=>{const a=element('a','voice-source');a.href=link.url;a.target='_blank';a.rel='noopener noreferrer';text(a,link.title);a.style.marginRight='10px';return a;}));
          if (reply.source_count && evidence) item.sources.append(sourceDetails(reply));
          item.sources.dataset.links=signature;
        }
        const date = new Date(reply.created_at_ms); item.time.dateTime = date.toISOString();
        item.row.dataset.sourceTime = String(reply.created_at_ms);
        text(item.time, date.toLocaleTimeString('vi-VN'));
        text(item.note, partial?'Chỉ hiển thị các câu đã phát trọn vẹn.': ['stopped', 'failed', 'unconfirmed'].includes(reply.state) ? 'TINA có thể chưa đọc hết nội dung này.' : '');
        item.note.hidden = !item.note.textContent;
        ordered.push(item.row);
      }
      for (const id of replyRows.keys()) if (!activeReplies.has(id)) {
        if (openSources && replyRows.get(id)!.row.contains(openSources)) { clearSources(); openSources = undefined; }
        replyRows.delete(id);
      }
      ordered.sort((a, b) => Number(a.dataset.sourceTime) - Number(b.dataset.sourceTime));
      reconcile(root, ordered);
      for (const key of rows.keys()) if (!activeRows.has(key)) rows.delete(key);
      for (const key of spans.keys()) if (!activeSpans.has(key)) { spans.delete(key); originals.delete(key); translations.delete(key); }
      for (const key of pinRows.keys()) if (!activeSpans.has(key)) pinRows.delete(key);
      updateLatest();
      const anchoredTop = anchor?.isConnected && anchorTop !== undefined ? oldTop + anchor.getBoundingClientRect().top - anchorTop : oldTop;
      // Moving an unchanged span between paragraph groups clears Chrome's selection.
      if (selected?.anchor.isConnected && selected.focus.isConnected && selection &&
          (selection.anchorNode !== selected.anchor || selection.anchorOffset !== selected.anchorOffset || selection.focusNode !== selected.focus || selection.focusOffset !== selected.focusOffset)) {
        const offset = (node: Node, value: number) => Math.min(value, node.nodeType === 3 ? node.textContent?.length ?? 0 : node.childNodes.length);
        selection.setBaseAndExtent(selected.anchor, offset(selected.anchor, selected.anchorOffset), selected.focus, offset(selected.focus, selected.focusOffset));
      }
      if (feed.clientHeight) {
        if (following) feed.scrollTop = feed.scrollHeight;
        else feed.scrollTop = anchoredTop;
      }
    },
  };
}

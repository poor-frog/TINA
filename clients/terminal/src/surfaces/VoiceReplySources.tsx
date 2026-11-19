"use client";
import { useEffect, useRef, useState } from 'react';
import { useOpenEntity } from '../ui-kit/docLinks';

interface Source {
  id: string; kind: 'transcript' | 'document' | 'calculation'; quote: string; segment_id?: string; speaker_name?: string;
  start_ms?: number; path?: string; paragraph?: number;
  meeting_id?: number; meeting_title?: string; meeting_start_time?: string;
}
const clock = (ms?: number) => ms == null ? '' : ms > 1e12 ? new Date(ms).toLocaleTimeString('vi-VN')
  : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Quotes are fetched again while open; saved reply text is never used as source evidence. */
export function VoiceReplySources({ base, requestId }: { base: string; requestId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState('Đang kiểm tra nguồn…');
  const openDoc = useOpenEntity();
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !sources.length) return;
    const id = window.location.hash.slice(1);
    if (id.startsWith(`voice-source-${requestId}-`)) {
      document.getElementById(id)?.scrollIntoView({ block: 'center' });
      revealed.current = true;
    }
  }, [sources, requestId]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(`${base}/sources/${encodeURIComponent(requestId)}`, {
          cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]),
        });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (abort.signal.aborted) return;
        setSources(result.sources);
        setStatus(result.unavailable ? `${result.unavailable} nguồn đã thay đổi, bị xóa hoặc không còn được chia sẻ.`
          : result.sources.length ? '' : 'Câu trả lời này chưa lưu nguồn trích dẫn.');
      } catch { if (!abort.signal.aborted) { setSources([]); setStatus('Chưa kiểm tra được nguồn. Đang thử lại…'); } }
      finally { if (!abort.signal.aborted) timer = setTimeout(refresh, 5000); }
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [base, requestId]);
  function reveal(segment: string) {
    const node = Array.from(document.querySelectorAll<HTMLElement>('[data-transcript-segments]'))
      .find(el => el.getClientRects().length && (JSON.parse(el.dataset.transcriptSegments || '[]') as string[]).includes(segment));
    if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.focus({ preventScroll: true }); }
    else setStatus('Đoạn gốc có thể chưa được tải trong transcript; bạn có thể đọc trích dẫn bên dưới.');
  }
  return <div aria-label="Nguồn câu trả lời" style={{ display: 'grid', gap: 8, marginTop: 10, fontSize: 12 }}>
    {status && <p role="status" style={{ margin: 0, color: 'var(--t3)' }}>{status}</p>}
    {sources.map((source,index) => <div key={source.id} id={`voice-source-${requestId}-${source.id}`}
      style={{ borderLeft: '2px solid var(--accent)', padding: '4px 10px', minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{color:'var(--t3)'}}>Nguồn số {index+1}</div>
      <div style={{ color: 'var(--t2)' }}>{source.kind === 'calculation' ? 'Phép tính được kiểm tra' : source.kind === 'transcript'
        ? `${source.speaker_name || 'Người nói'} · ${clock(source.start_ms)}`
        : `${source.path} · đoạn ${(source.paragraph ?? 0) + 1}`}</div>
      {source.meeting_id&&<div style={{color:'var(--t3)'}}>{source.meeting_title||`Cuộc họp ${source.meeting_id}`}{source.meeting_start_time?` · ${source.meeting_start_time}`:''}</div>}
      <blockquote style={{ margin: '5px 0', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{source.quote}</blockquote>
      {source.kind==='transcript'&&source.meeting_id&&String(source.meeting_id)!==/\/meetings\/(\d+)\//.exec(base)?.[1]
        ? <a href={`/meetings/${source.meeting_id}`} style={{color:'var(--accent)'}}>Mở cuộc họp nguồn ↗</a>
        : source.kind !== 'calculation' && <button type="button" onClick={() => source.kind === 'document' ? openDoc({ path: source.path! }) : reveal(source.segment_id!)}
        style={{ border: 0, padding: '3px 0', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}>
        {source.kind === 'document' ? 'Mở tài liệu nguồn ↗' : 'Xem trong transcript ↑'}
      </button>}
    </div>)}
  </div>;
}

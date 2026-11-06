"use client";
import { useEffect, useRef, useState } from 'react';
import { useMeetingDialogEscape } from './useMeetingDialogEscape';

interface Decision { label: string; reason: string; source_ids: string[] }
interface Source { id: string; segment_id: string; revision: number; speaker_name: string; start_ms: number; end_ms: number; quote: string; audio_available: boolean }
interface Report {
  id: string; meeting_id: number; agenda: string; canonical_revision: number; created_at: string; model: string;
  windows: Array<{ id: string; relevance: Decision; interaction: Omit<Decision, 'label'> & { labels: string[] }; progress: Decision }>;
  sources: Source[];
}
interface ReviewState { report: Report | null; stale: boolean; can_generate: boolean }
const labels: Record<string, string> = {
  relevant: 'Đúng trọng tâm', useful_tangent: 'Mở rộng hữu ích', off_scope: 'Ngoài phạm vi', uncertain: 'Chưa chắc chắn',
  constructive_disagreement: 'Bất đồng mang tính xây dựng', personal_hostility: 'Công kích cá nhân', sarcasm: 'Mỉa mai',
  dismissive_address: 'Bác bỏ thiếu tôn trọng', threat: 'Đe dọa', advancing: 'Có tiến triển', exploring: 'Đang tìm hiểu',
  repeating_unresolved_positions: 'Lặp lại quan điểm chưa được giải quyết',
};
const button = { background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: 6, padding: '5px 9px', cursor: 'pointer', fontSize: 12 } as const;
const clock = (ms: number) => ms > 1e12 ? new Date(ms).toLocaleTimeString() : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function DiscussionReview({ meetingId, openRef }: { meetingId: string; openRef?: { current: (() => void) | null } }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const serial = useRef(0);
  const [opened, setOpened] = useState(false);
  useMeetingDialogEscape(dialog, opened);
  const [data, setData] = useState<ReviewState | null>(null);
  const [agenda, setAgenda] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const base = `/api/discussion-reviews/${encodeURIComponent(meetingId)}`;

  useEffect(() => {
    if (!openRef) return;
    openRef.current = () => { setOpened(true); dialog.current?.showModal(); };
    return () => { openRef.current = null; };
  }, [openRef]);

  useEffect(() => {
    setData(null); setAgenda(''); setError(''); setVerified(false); setBusy(false); busyRef.current = false;
    if (!opened) return;
    const abort = new AbortController(); controller.current = abort;
    let first = true;
    async function refresh() {
      if (busyRef.current) return;
      const ticket = ++serial.current;
      setVerified(false);
      try {
        const response = await fetch(base, { cache: 'no-store', signal: abort.signal });
        const next = await response.json();
        if (!response.ok) throw new Error(typeof next.detail === 'string' ? next.detail : 'Không đọc được bản đánh giá.');
        if (abort.signal.aborted || ticket !== serial.current) return;
        setData(next); setVerified(true); setError('');
        if (first) { setAgenda(next.report?.agenda || ''); first = false; }
      } catch (e) { if (!abort.signal.aborted && ticket === serial.current) setError(e instanceof Error ? e.message : 'Không đọc được bản đánh giá.'); }
    }
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('tina:transcript-corrected', refresh);
    return () => { abort.abort(); serial.current++; window.removeEventListener('focus', refresh); window.removeEventListener('tina:transcript-corrected', refresh); };
  }, [base, opened]);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (busyRef.current || !signal || !agenda.trim()) return;
    busyRef.current = true; setBusy(true); setError('');
    const ticket = ++serial.current;
    try {
      const response = await fetch(base, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agenda: agenda.trim(), expected_id: data?.report?.id ?? null }) });
      const next = await response.json();
      if (!response.ok) throw new Error(typeof next.detail === 'string' ? next.detail : 'Không tạo được bản đánh giá.');
      if (!signal.aborted && ticket === serial.current) { setData(next); setVerified(true); }
    } catch (e) { if (!signal.aborted && ticket === serial.current) { setVerified(false); setError(e instanceof Error ? e.message : 'Không tạo được bản đánh giá.'); } }
    finally { if (!signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  const report = data?.report;
  const outdated = !verified || data?.stale;
  return <>
    {!openRef && <button type="button" style={button} onClick={() => { setOpened(true); dialog.current?.showModal(); }}>Discussion review</button>}
    <dialog ref={dialog} onClose={() => setOpened(false)} aria-label="Đánh giá thảo luận" style={{ width: 760, maxWidth: '90vw', maxHeight: '85vh', margin: 'auto', overflow: 'auto', background: 'var(--panel)', color: 'inherit', border: '1px solid currentColor', borderRadius: 10, padding: 24 }}>
      <h2>Đánh giá thảo luận</h2>
      <p>Phân loại transcript VI–EN sau cuộc họp theo phạm vi, tương tác và tiến triển. Nhận định AI gắn với từng trao đổi và trích dẫn gốc.</p>
      <form onSubmit={generate}>
        <label>Mục tiêu / chương trình cuộc họp<textarea aria-label="Mục tiêu / chương trình cuộc họp" value={agenda} onChange={e => setAgenda(e.target.value)} maxLength={4000} rows={4} disabled={busy || !verified || !data}
          placeholder="Ví dụ: Chọn phương án retry cho payment service, thống nhất tiêu chí và bước thử nghiệm."
          style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 8, background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: 6 }} /></label>
        <button style={button} disabled={busy || !verified || !data?.can_generate || !agenda.trim()}>{busy ? 'Đang đánh giá…' : 'Tạo đánh giá thảo luận'}</button>
      </form>
      {!data && !error && <p role="status">Đang tải…</p>}
      {data && !data.can_generate && <p role="status">Cần cuộc họp đã hoàn tất và có transcript để tạo đánh giá.</p>}
      {error && <p role="alert">{error} Đóng và mở lại để tải bản mới nhất.</p>}
      {report && <>
        <p>{report.model} · transcript revision {report.canonical_revision} · {new Date(report.created_at).toLocaleString()}</p>
        {outdated && <p role="status">Nguồn đã thay đổi hoặc chưa kiểm tra được. Hãy tải lại và tạo đánh giá mới.</p>}
        {agenda.trim() !== report.agenda && <p role="status">Bản bên dưới dùng mục tiêu đã lưu. Tạo lại để áp dụng mục tiêu vừa sửa.</p>}
        {report.windows.map((window, index) => <article key={window.id} style={{ borderTop: '1px solid currentColor', marginTop: 14, paddingTop: 10 }}>
          <h3>Trao đổi {index + 1}</h3>
          {(['relevance', 'interaction', 'progress'] as const).map(task => {
            const decision = window[task];
            const names = task === 'interaction' ? window.interaction.labels : [window[task].label];
            return <section key={task} style={{ marginBottom: 12 }}>
              <strong>{{ relevance: 'Phạm vi', interaction: 'Tương tác', progress: 'Tiến triển' }[task]}: {names.length ? names.map(name => labels[name] || name).join(' · ') : 'Không phát hiện tín hiệu tương tác trong danh mục'}</strong>
              <p>{decision.reason}</p>
              {decision.source_ids.map(id => { const source = report.sources.find(s => s.id === id); return source && <details key={id}>
                <summary>{source.speaker_name} · {clock(source.start_ms)}–{clock(source.end_ms)} · revision {source.revision}</summary>
                <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.quote}</blockquote>
                <small>{source.segment_id}</small>
                {!outdated && source.audio_available && <audio controls preload="none" aria-label="Nghe đoạn trích" src={`/api/transcripts/by-id/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(source.segment_id)}/audio`} style={{ display: 'block', width: '100%' }} />}
              </details>; })}
            </section>;
          })}
        </article>)}
      </>}
      <form method="dialog" style={{ marginTop: 16 }}><button style={button}>Đóng</button></form>
    </dialog>
  </>;
}

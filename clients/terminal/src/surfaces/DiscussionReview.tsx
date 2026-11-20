"use client";
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { MessageSquareText, X } from 'lucide-react';
import { useMeetingDialogEscape } from './useMeetingDialogEscape';
import styles from './meetingToolDialogs.module.css';

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
const clock = (ms: number) => ms > 1e12 ? new Date(ms).toLocaleTimeString() : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const tasks = { relevance: 'Phạm vi', interaction: 'Tương tác', progress: 'Tiến triển' } as const;

export function DiscussionReview({ meetingId, meetingTitle, openRef }: { meetingId: string; meetingTitle?: string; openRef?: { current: (() => void) | null } }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
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
  const open = useCallback(() => {
    setOpened(true);
    dialog.current?.showModal();
    if (body.current) body.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    if (!openRef) return;
    openRef.current = open;
    return () => { openRef.current = null; };
  }, [open, openRef]);

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
  const sources = new Map(report?.sources.map(source => [source.id, source]));
  return <>
    {!openRef && <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={open}>Discussion review</button>}
    <dialog ref={dialog} onClose={() => setOpened(false)} aria-labelledby={titleId} className={`${styles.dialog} ${styles.review}`} lang="vi">
      <header className={styles.header}>
        <span className={styles.headerIcon}><MessageSquareText size={20} aria-hidden="true" /></span>
        <div><h2 id={titleId}>Đánh giá thảo luận</h2><p>{meetingTitle && `${meetingTitle} · `}Transcript VI–EN</p></div>
        <form method="dialog"><button className={`${styles.button} ${styles.quiet} ${styles.iconButton}`} aria-label="Đóng đánh giá thảo luận"><X size={19} aria-hidden="true" /></button></form>
      </header>
      <div className={styles.body} ref={body}>
        <form className={`${styles.card} ${styles.stack}`} onSubmit={generate}>
          <label>Mục tiêu / chương trình cuộc họp<textarea value={agenda} onChange={e => setAgenda(e.target.value)} maxLength={4000} rows={2} disabled={busy || !verified || !data}
            placeholder="Ví dụ: Chọn phương án retry cho payment service, thống nhất tiêu chí và bước thử nghiệm." /></label>
          <div className={`${styles.row} ${styles.spread}`}>
            <p className={styles.meta}>Đánh giá theo phạm vi, tương tác và tiến triển.</p>
            <button className={`${styles.button} ${styles.primary}`} disabled={busy || !verified || !data?.can_generate || !agenda.trim()}>{busy ? 'Đang đánh giá…' : 'Tạo đánh giá thảo luận'}</button>
          </div>
        </form>
        {!data && !error && <p role="status">Đang tải…</p>}
        {data && !data.can_generate && <p className={styles.notice} role="status">Cần cuộc họp đã hoàn tất và có transcript để tạo đánh giá.</p>}
        {error && <p className={styles.error} role="alert">{error} Đóng và mở lại để tải bản mới nhất.</p>}
        {report && <section className={styles.stack}>
          <div className={`${styles.row} ${styles.spread}`}>
            <h3>Kết quả đánh giá</h3>
            <p className={styles.meta}>{report.model} · Bản ghi lời thoại phiên bản {report.canonical_revision} · <time dateTime={report.created_at}>{new Date(report.created_at).toLocaleString()}</time></p>
          </div>
          {outdated && <p className={styles.notice} role="status">Nguồn đã thay đổi hoặc chưa kiểm tra được. Hãy tải lại và tạo đánh giá mới.</p>}
          {agenda.trim() !== report.agenda && <p className={styles.notice} role="status">Bản bên dưới dùng mục tiêu đã lưu. Tạo lại để áp dụng mục tiêu vừa sửa.</p>}
          {report.windows.map((window, index) => <article key={window.id} className={styles.exchange}>
            <header><h4>Trao đổi {index + 1}</h4></header>
            {(['relevance', 'interaction', 'progress'] as const).map(task => {
              const decision = window[task];
              const names = task === 'interaction' ? window.interaction.labels : [window[task].label];
              return <section key={task} className={styles.finding}>
                <span className={styles.meta}>{tasks[task]}</span>
                <div>
                  <strong>{names.length ? names.map(name => labels[name] || name).join(' · ') : 'Không phát hiện tín hiệu tương tác trong danh mục'}</strong>
                  <p>{decision.reason}</p>
                  {decision.source_ids.map(id => {
                    const source = sources.get(id);
                    return source && <details key={id} className={styles.citation}>
                      <summary>{source.speaker_name} · {clock(source.start_ms)}–{clock(source.end_ms)} · phiên bản {source.revision}</summary>
                      <blockquote>{source.quote}</blockquote>
                      <small>{source.segment_id}</small>
                      {!outdated && source.audio_available && <audio controls preload="none" aria-label="Nghe đoạn trích" src={`/api/transcripts/by-id/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(source.segment_id)}/audio`} />}
                    </details>;
                  })}
                </div>
              </section>;
            })}
          </article>)}
        </section>}
      </div>
      <footer className={styles.footer}><form method="dialog"><button className={styles.button}>Đóng</button></form></footer>
    </dialog>
  </>;
}

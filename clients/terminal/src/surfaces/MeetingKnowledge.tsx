"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { invalidateDocLinkCaches, useOpenEntity } from '../ui-kit/docLinks';
import { MeetingFactReviews, type FactItem } from './MeetingFactReviews';
import { MeetingVoiceDrafts } from './MeetingVoiceDrafts';

interface Source {
  id: string; kind: 'transcript' | 'document'; quote: string; path?: string; meeting_id?: number; meeting_title?: string;
  segment_id?: string; revision?: number; speaker_name?: string; start_ms?: number; audio_available?: boolean;
}
interface Answer {
  id: string; question: string; claims: Array<{ text: string; source_ids: string[] }>;
  sources: Source[]; stale: boolean; saved_path: string | null;
  coverage: { selected: number; available: number; bounded: boolean };
}
interface Knowledge { documents: Array<{ path: string; title: string }>; answers: Answer[]; segment_count: number; facts?: FactItem[] }
const button = { background: 'var(--panel2)', color: 'var(--t1)', border: '1px solid var(--line2)', borderRadius: 6, padding: '5px 9px', cursor: 'pointer', fontSize: 12 } as const;
const clock = (ms?: number) => ms == null ? '' : ms > 1e12
  ? new Date(ms).toLocaleTimeString() : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function MeetingWikiSourceStatus({ path, slug, content }: { path: string; slug?: string; content?: string }) {
  const match = /^wiki\/meetings\/(\d+)\/([0-9a-f]{32})\.md$/.exec(path);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '')?.[1] || '';
  const meeting = match?.[1] || /^meeting_id:\s*[\"']?(\d+)[\"']?\s*$/m.exec(frontmatter)?.[1];
  const answer = match?.[2] || /^meeting_answer_id:\s*[\"']?([0-9a-f]{32})[\"']?\s*$/m.exec(frontmatter)?.[1];
  const [status, setStatus] = useState('Đang kiểm tra nguồn cuộc họp…');
  useEffect(() => {
    if (!meeting || !answer) return;
    let alive = true;
    async function check() {
      try {
        const query = slug ? `?slug=${encodeURIComponent(slug)}` : '';
        const response = await fetch(`/api/workspace/meeting-knowledge/${meeting}/answers/${answer}${query}`, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (alive) setStatus(data.stale ? 'Nguồn đã thay đổi — hãy kiểm tra lại trước khi dùng trang Wiki này.' : 'Nguồn cuộc họp đã được kiểm tra. Nội dung AI vẫn cần người đọc xác nhận.');
      } catch { if (alive) setStatus('Chưa kiểm tra được nguồn. Đừng coi trang này là thông tin đã được xác nhận.'); }
    }
    void check();
    const timer = window.setInterval(check, 15000);
    window.addEventListener('focus', check);
    window.addEventListener('tina:transcript-corrected', check);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', check); window.removeEventListener('tina:transcript-corrected', check); };
  }, [meeting, answer, slug]);
  return meeting && answer ? <p role="status" style={{ padding: 10, border: '1px solid var(--line2)', borderRadius: 7, fontSize: 12 }}>{status} <a href={`/meetings/${meeting}?answer=${answer}`} style={{ color: 'var(--blue)' }}>Mở cuộc họp và nguồn</a></p> : null;
}

export function MeetingKnowledge({ meetingId }: { meetingId: string }) {
  const [data, setData] = useState<Knowledge | null>(null);
  const [question, setQuestion] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [meetingChoices, setMeetingChoices] = useState<Array<{ id: string | number; title?: string }>>([]);
  const [extraMeetings, setExtraMeetings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [source, setSource] = useState<{ answer: Answer; source: Source } | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [verified, setVerified] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const identity = useRef(meetingId); identity.current = meetingId;
  const serial = useRef(0);
  const openDoc = useOpenEntity();
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const base = `/api/workspace/meeting-knowledge/${encodeURIComponent(meetingId)}`;
  const load = useCallback(async () => {
    const ticket = ++serial.current;
    try {
      const r = await fetch(base, { cache: 'no-store' });
      if (!r.ok) throw new Error('Chưa đọc được nguồn cuộc họp. Hãy thử tải lại.');
      const next: Knowledge = await r.json();
      const linked = new URLSearchParams(window.location.search).get('answer');
      if (linked && /^[0-9a-f]{32}$/.test(linked) && !next.answers.some(a => a.id === linked)) {
        const older = await fetch(base + '/answers/' + linked, { cache: 'no-store' });
        if (!older.ok) throw new Error('Không đọc được câu trả lời được liên kết.');
        next.answers.push(await older.json());
      }
      if (identity.current !== meetingId || ticket !== serial.current) return null;
      setData(next); setVerified(true); setError('');
      return next;
    } catch (e) {
      if (identity.current === meetingId && ticket === serial.current) {
        setVerified(false); setError(e instanceof Error ? e.message : 'Không đọc được nguồn.');
      }
      return null;
    }
  }, [base, meetingId]);

  useEffect(() => {
    setData(null); setVerified(false); setDocuments([]); setExtraMeetings([]); setMeetingChoices([]); setReview(null); setSource(null);
    void load();
    const refresh = () => { setVerified(false); void load(); };
    const onRevision = (event: Event) => {
      const id = (event as CustomEvent).detail?.meetingId;
      if (id == null || String(id) === meetingId) refresh();
    };
    window.addEventListener('tina:transcript-corrected', onRevision);
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 15000);
    return () => {
      serial.current++;
      window.clearInterval(interval);
      window.removeEventListener('tina:transcript-corrected', onRevision);
      window.removeEventListener('focus', refresh);
    };
  }, [load, meetingId]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('answer');
    if (id && data?.answers.some(a => a.id === id)) {
      setExpanded(true);
      document.getElementById(`meeting-answer-${id}`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [data]);

  async function chooseMeetings() {
    try {
      const response = await fetch('/api/meetings?limit=100', { cache: 'no-store' });
      if (!response.ok) throw new Error('Không đọc được danh sách cuộc họp.');
      const value = await response.json();
      if (identity.current !== meetingId) return;
      setMeetingChoices((value.meetings || []).filter((m: { id: string | number }) => String(m.id) !== meetingId));
    } catch (e) { setError((e as Error).message); }
  }
  async function post(path: string, payload?: unknown) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    const value = await r.json();
    if (!r.ok) throw new Error(value.detail || 'Không thực hiện được. Hãy thử lại.');
    if (identity.current !== meetingId) throw new Error('Cuộc họp đã thay đổi.');
    return value;
  }
  async function ask() {
    if (busy || !question.trim()) return;
    setBusy(true); setError('');
    try {
      await post('/ask', { question: question.trim(), documents, ...(extraMeetings.length ? { meeting_ids: extraMeetings.map(Number) } : {}) });
      await load(); setQuestion(''); setExpanded(true);
    } catch (e) { if (identity.current === meetingId) setError(e instanceof Error ? e.message : 'Không trả lời được.'); }
    finally { if (identity.current === meetingId) setBusy(false); }
  }
  async function save(answer: Answer) {
    setBusy(true); setError('');
    try { await post(`/answers/${answer.id}/apply`); invalidateDocLinkCaches(); setReview(null); await load(); }
    catch (e) { if (identity.current === meetingId) { await load(); setError(e instanceof Error ? e.message : 'Không lưu được.'); } }
    finally { if (identity.current === meetingId) setBusy(false); }
  }
  async function inspect(answer: Answer, citation: Source) {
    const latest = await load();
    if (!latest) return;
    const current = latest.answers.find(a => a.id === answer.id);
    if (!current) { setError('Nguồn này không còn trong lịch sử đang hiển thị.'); return; }
    setSource({ answer: current, source: citation });
    setAudioError(false);
    sourceDialog.current?.showModal();
  }
  const activeSourceAnswer = data?.answers.find(a => a.id === source?.answer.id);
  const outdated = !verified || activeSourceAnswer?.stale || source?.answer.stale;
  return <section aria-label="Hỏi về cuộc họp này" style={{ margin: '0 18px 12px', padding: 12, border: '1px solid var(--line)', borderRadius: 9, background: 'var(--panel)', fontSize: 12.5 }}>
    <form onSubmit={e => { e.preventDefault(); void ask(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <label style={{ flex: '1 1 250px' }}>Hỏi về cuộc họp này
        <input aria-label="Câu hỏi về cuộc họp" value={question} maxLength={2000} onChange={e => setQuestion(e.target.value)} placeholder="Đã chốt việc gì? Ai phụ trách?" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 5, padding: 8, background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--line2)', borderRadius: 6 }} />
      </label>
      <button style={{ ...button, alignSelf: 'flex-end' }} disabled={busy || !data || !question.trim()}>{busy ? 'Đang xử lý…' : 'Hỏi TINA'}</button>
    </form>
    <p style={{ color: 'var(--t3)', margin: '7px 0' }}>Dùng cuộc họp này, các cuộc họp bạn chọn thêm và tài liệu đã chọn. Câu trả lời có thể sai; hãy kiểm tra nguồn.</p>
    <details><summary>Tài liệu liên quan ({data?.documents.length ?? 0})</summary>
      {data?.documents.length === 0 && <p>Chưa có tài liệu Wiki được liên kết với cuộc họp này.</p>}
      {data?.documents.map(doc => <div key={doc.path} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, overflowWrap: 'anywhere' }}>
        <label><input type="checkbox" checked={documents.includes(doc.path)} onChange={e => setDocuments(current => e.target.checked ? [...current, doc.path] : current.filter(p => p !== doc.path))} /> Dùng {doc.title}</label>
        <button type="button" style={button} onClick={() => openDoc({ path: doc.path })}>Mở tài liệu</button>
      </div>)}
    </details>
    <details><summary>Hỏi cùng các cuộc họp khác ({extraMeetings.length}/4)</summary>
      <button type="button" style={button} onClick={() => void chooseMeetings()}>Chọn thêm cuộc họp</button>
      <p>Chỉ đối chiếu transcript của các cuộc họp bạn chọn và có quyền truy cập.</p>
      {meetingChoices.map(m => <label key={m.id} style={{ display: 'block' }}><input type="checkbox" checked={extraMeetings.includes(String(m.id))}
        disabled={!extraMeetings.includes(String(m.id)) && extraMeetings.length >= 4}
        onChange={e => setExtraMeetings(current => e.target.checked ? [...current, String(m.id)] : current.filter(id => id !== String(m.id)))} /> {m.title || 'Cuộc họp ' + m.id}</label>)}
    </details>
    {error && <p role="alert">{error} <button style={button} onClick={() => void load()}>Tải lại</button></p>}
    <MeetingFactReviews meetingId={meetingId} items={data?.facts || []} verified={verified} onRefresh={load} />
    <MeetingVoiceDrafts key={meetingId} meetingId={meetingId} />
    {!!data?.answers.length && <details open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
      <summary>Câu trả lời và bản nháp Wiki ({data.answers.length})</summary>
      <div style={{ maxHeight: '42vh', overflow: 'auto' }}>{data.answers.map(answer => <article key={answer.id} id={`meeting-answer-${answer.id}`} style={{ padding: '10px 0', borderTop: '1px solid var(--line)', overflowWrap: 'anywhere' }}>
        <strong>{answer.question}</strong>
        {(!verified || answer.stale) && <p role="status" style={{ color: 'var(--warn)' }}>{answer.stale ? 'Nguồn đã thay đổi — hãy hỏi lại trước khi dùng hoặc lưu.' : 'Đang kiểm tra lại nguồn.'}</p>}
        {answer.coverage.bounded && <p style={{ color: 'var(--t3)' }}>Đã đối chiếu {answer.coverage.selected}/{answer.coverage.available} đoạn phù hợp; chưa kiểm tra toàn bộ nội dung.</p>}
        {answer.claims.length === 0 && <p>Chưa tìm thấy đủ bằng chứng để trả lời. Thử hỏi cụ thể hơn hoặc chọn thêm tài liệu liên quan.</p>}
        {answer.claims.map((claim, i) => <div key={i}><p style={{ whiteSpace: 'pre-wrap', marginBottom: 5 }}>{claim.text}</p>
          {claim.source_ids.map(id => { const citation = answer.sources.find(s => s.id === id); return citation && <button key={id} type="button" style={{ ...button, margin: '0 5px 5px 0', color: 'var(--blue)' }} onClick={() => void inspect(answer, citation)}>{citation.kind === 'transcript' ? `${citation.meeting_id && String(citation.meeting_id) !== meetingId ? (citation.meeting_title || 'Cuộc họp khác') + ' · ' : ''}${citation.speaker_name} · ${clock(citation.start_ms)}` : citation.path}</button>; })}
        </div>)}
        {answer.saved_path ? <button style={button} onClick={() => openDoc({ path: answer.saved_path! })}>Mở trang Wiki đã lưu</button>
          : answer.claims.length > 0 && <button style={button} disabled={busy || answer.stale || !verified} onClick={() => setReview(review === answer.id ? null : answer.id)}>Đề xuất cập nhật Wiki</button>}
        {review === answer.id && <div role="region" aria-label="Duyệt bản nháp Wiki" style={{ marginTop: 8, padding: 10, border: '1px solid var(--line2)', borderRadius: 7 }}>
          <p>Bản nháp gồm câu hỏi, các câu trả lời và toàn bộ nguồn ở trên. Khi xác nhận, TINA tạo một trang mới; tài liệu hiện có được giữ nguyên.</p>
          <button style={button} disabled={busy || answer.stale || !verified} onClick={() => void save(answer)}>Xác nhận lưu vào Wiki</button>{' '}
          <button style={button} disabled={busy} onClick={() => setReview(null)}>Hủy</button>
        </div>}
      </article>)}</div>
    </details>}
    <dialog ref={sourceDialog} onClose={() => setSource(null)} aria-label="Nguồn trích dẫn" style={{ width: 600, maxWidth: '88vw', maxHeight: '80vh', overflow: 'auto', background: 'var(--panel)', color: 'var(--t1)', border: '1px solid var(--line2)', borderRadius: 10, padding: 20 }}>
      {source && <><h3>Nguồn trích dẫn</h3>
        {outdated && <p role="alert">Nguồn đã thay đổi hoặc chưa kiểm tra được. Đoạn dưới là bản được dùng khi trả lời.</p>}
        <p>{source.source.kind === 'transcript' ? `${source.source.speaker_name} · ${clock(source.source.start_ms)} · revision ${source.source.revision}` : source.source.path}</p>
        <blockquote style={{ whiteSpace: 'pre-wrap' }}>{source.source.quote}</blockquote>
        {!outdated && source.source.kind === 'transcript' && (source.source.audio_available
          ? <><audio key={`${meetingId}/${source.source.segment_id}`} controls preload="none" aria-label="Nghe đoạn audio gốc" onError={() => setAudioError(true)} src={`/api/transcripts/by-id/${encodeURIComponent(source.source.meeting_id ?? meetingId)}/segments/${encodeURIComponent(source.source.segment_id!)}/audio`} style={{ width: '100%' }} />{audioError && <p role="status">Chưa phát được audio gốc. Bản ghi có thể không còn khả dụng.</p>}</>
          : <p>Đoạn này chưa có audio gốc để phát lại. Bạn vẫn có thể kiểm tra câu chữ và người nói ở trên.</p>)}
        {source.source.path && <button style={button} onClick={() => { sourceDialog.current?.close(); openDoc({ path: source.source.path }); }}>Mở tài liệu nguồn</button>}
      </>}
      <form method="dialog" style={{ marginTop: 12 }}><button style={button}>Đóng</button></form>
    </dialog>
  </section>;
}

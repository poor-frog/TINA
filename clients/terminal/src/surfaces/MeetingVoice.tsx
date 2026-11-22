"use client";
import { useEffect, useRef, useState } from 'react';
import { VoiceReplySources } from './VoiceReplySources';

interface Policy { enabled: boolean; include_transcript: boolean; include_approved_actions?:boolean; shared_meeting_ids?:number[]; documents: string[]; revision: number; wake_variants: string[]; noise_suppression:boolean; allow_general_knowledge?:boolean; allow_web_search?:boolean }
const button = { padding: '6px 10px', background: 'var(--panel2)', color: 'var(--t1)', border: '1px solid var(--line2)', borderRadius: 6, cursor: 'pointer' } as const;
interface Diagnostic {
  event_id: string; code: string; observed_at_ms: number; expires_at_ms: number;
  heard_prefix?: string | null; heard_at_ms?: number | null;
}
interface AudioChannel { channel: number; frames: number; last_frame_ms: number; rms: number; sample_clock: boolean;
  gap_samples: number; overlap_samples: number; clock_resets: number; asr_inflight: number; asr_errors: number;
  capture_lag_ms?: number | null; capture_age_ms?: number | null; roundtrip_ms?: number | null; queue_ms?: number | null; asr_at_ms?: number | null }
interface AudioSnapshot { observed_at_ms: number; channels: AudioChannel[]; noise_suppression?:'off'|'starting'|'low'|'failed'|null }
interface Runtime { state: string; request_id?: string; session_active?: boolean; heartbeat_fresh?: boolean; diagnostic?: Diagnostic | null; audio?: AudioSnapshot | null }
const ms = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
interface VoiceReply { request_id: string; text: string; played_text?:string|null; state: string; created_at_ms: number;
  source_count?:number;answer_kind?:string;reason?:string;links?:Array<{url:string;title:string}> }
const replyLabel: Record<string, string> = { queued: 'Đang chuẩn bị đọc', started: 'Đang đọc', completed: 'Đã đọc', stopped: 'Đã dừng', failed: 'Phát thất bại', unconfirmed: 'Chưa xác nhận phát xong' };
const diagnosticLabel: Record<string, string> = {
  no_input: 'Chưa nhận thêm câu trả lời trong lượt chờ. Bot đã trở về chờ gọi tên.',
  dialogue_paused: 'Đã hỏi lại hai lần. Lượt hỏi tạm dừng; gọi TINA khi muốn tiếp tục.',
  waiting_asr: 'Bot đã nhận tiếng nói; đang chờ ASR trả text để nhận tên TINA.',
  tts_unavailable: 'TTS chưa sẵn sàng hoặc xác thực không thành công. Kiểm tra dịch vụ giọng nói.',
  sources_unavailable: 'Chưa đọc được nguồn meeting được chia sẻ. Kiểm tra tài liệu và dịch vụ Knowledge.',
  starting: 'Đang khởi động bộ nhận câu hỏi.', listening: 'Sẵn sàng nhận TINA, TINA ơi hoặc tin ơi.',
  name_not_matched: 'Đã nhận text ASR nhưng đầu câu chưa khớp tên TINA hoặc biến thể bạn duyệt.',
  name_unconfirmed: 'ASR đã thấy tên gọi; đang chờ kết quả tiếp theo xác nhận.',
  wake_confirmed: 'Đã nhận tên TINA.', waiting_speech_end: 'Đã nhận TINA; đang chờ bạn nói hết câu.',
  waiting_asr_tail: 'Bạn đã ngừng nói; đang chờ ASR trả đủ câu hỏi.',
  waiting_question: 'Đã nhận tên TINA; đang chờ phần câu hỏi hoặc ASR hoàn tất.',
  thinking: 'Đã nhận câu hỏi; đang tìm câu trả lời từ nguồn được chia sẻ.', speaking: 'Đang đọc câu trả lời.',
  waiting_quiet: 'Đang chờ khoảng yên để nghe lại.', stopped: 'Lượt hỏi đáp đã dừng.',
  completed: 'Đã đọc xong câu trả lời.', question_timeout: 'Chưa nhận đủ câu hỏi trong thời gian cho phép. Hãy gọi lại TINA kèm câu hỏi.',
  ambiguous_audio: 'Có người nói chồng nhau; lượt hỏi đã dừng. Hãy thử lại từng người một.',
  ambiguous_window: 'Các phần ASR chưa ghép được chắc chắn; hãy gọi lại kèm câu hỏi.',
  stale_asr: 'Một kết quả ASR cũ đã được bỏ qua để tránh trả lời lặp.',
  asr_unavailable: 'Backend ASR chưa sẵn sàng. Kiểm tra Settings → Transcription.',
  services_unavailable: 'Dịch vụ trả lời hoặc TTS chưa sẵn sàng. Kiểm tra nguồn, model và TTS.',
  worker_failed: 'Bộ nhận câu hỏi bị lỗi. Kiểm tra bot rồi lưu lại cấu hình để khởi động lại.',
  kws_unavailable: 'Wake-word chưa sẵn sàng. Hãy tạo bot mới sau khi kiểm tra model.',
  livekit_unavailable: 'LiveKit Agents chưa sẵn sàng hoặc bot cần image mới. Kiểm tra dịch vụ hoặc chọn lại TINA trong Settings.',
  interrupted: 'Đã dừng theo lời người gọi.',
  waiting_turn_end: 'Đang chờ bạn nói hết ý.',
  answer_failed: 'Chưa lấy được câu trả lời. Kiểm tra model và nguồn được chia sẻ rồi thử lại.',
  no_evidence: 'Không có đủ thông tin trong các nguồn được phép dùng để trả lời câu hỏi này.',
  playback_failed: 'Chưa phát được câu trả lời hoặc thao tác phát đã dừng. Kiểm tra mic/TTS của bot.',
  policy_changed: 'Cấu hình hoặc nguồn chia sẻ đã thay đổi; lượt cũ đã dừng.',
};
const empty: Policy = { enabled: false, include_transcript: false, documents: [], revision: 0, wake_variants: [], noise_suppression:false };
const stateLabel: Record<string, string> = { OFF: 'Đang tắt', LISTENING: 'Đang nghe TINA / TINA ơi / tin ơi',
  CAPTURING: 'Đang nghe câu hỏi', THINKING: 'Đang tìm câu trả lời', SPEAKING: 'Đang trả lời',
  QUIET: 'Chờ khoảng yên để nghe tiếp', ERROR: 'Đã dừng do lỗi — kiểm tra bot rồi lưu lại cấu hình' };

export function MeetingVoice({ meetingId, nativeId, repliesOnly = false }: { meetingId: string; nativeId?: string; repliesOnly?: boolean }) {
  const [policy, setPolicy] = useState<Policy>(empty);
  const [runtime, setRuntime] = useState<Runtime>({ state: 'OFF' });
  const [sourceReply, setSourceReply] = useState<string | null>(null);
  const [replies, setReplies] = useState<VoiceReply[]>([]);
  const [documents, setDocuments] = useState<Array<{ path: string; title: string }>>([]);
  const [available, setAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [variantInput, setVariantInput] = useState('');
  const [error, setError] = useState('');
  const dirty = useRef(false);
  const identity = useRef(meetingId); identity.current = meetingId;
  const base = `/api/meetings/${encodeURIComponent(meetingId)}/voice-assistant`;
  useEffect(() => {
    const abort = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout>;
    let expiryTimer: ReturnType<typeof setTimeout>;
    const statusError = 'Không tải được trạng thái Voice assistant.';
    const stale = () => setRuntime(current => ({ ...current, heartbeat_fresh: false, diagnostic: null, audio: null }));
    setSourceReply(new URLSearchParams(window.location.search).get('voiceSource'));
    dirty.current = false; setLoaded(false); setPolicy(empty); setRuntime({ state: 'OFF' }); setReplies([]); setError(''); setDocuments([]);
    async function refresh() {
      try {
        const r = await fetch(base, { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        if (!r.ok) throw new Error('Không đọc được cấu hình Voice assistant.');
        const value = await r.json();
        if (abort.signal.aborted) return;
        setRuntime(value.runtime); setReplies(value.replies || []); setAvailable(value.available); setLoaded(true);
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(stale, 15000);
        setError(current => current === statusError ? '' : current);
        if (!dirty.current) { setPolicy({ ...value.policy, wake_variants: value.policy.wake_variants || [] }); setVariantInput((value.policy.wake_variants || []).join(', ')); }
      } catch { if (!abort.signal.aborted) { stale(); setReplies([]); setError(statusError); } }
      finally { if (!abort.signal.aborted) pollTimer = setTimeout(refresh, 3000); }
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(pollTimer); clearTimeout(expiryTimer); };
  }, [base, meetingId]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    async function sources() {
      try {
        const r = await fetch(`/api/workspace/meeting-knowledge/${encodeURIComponent(meetingId)}`, { cache: 'no-store', signal: abort.signal });
        if (!r.ok) throw new Error();
        const value = await r.json();
        if (!abort.signal.aborted) setDocuments(value.documents);
      } catch { if (!abort.signal.aborted) setError('Chưa tải được các tài liệu đã liên kết với meeting.'); }
    }

    void sources();
    return () => abort.abort();
  }, [open, meetingId]);
  useEffect(() => {
    const detail = runtime.diagnostic;
    if (!detail) return;
    const timer = window.setTimeout(() => setRuntime(current => current.diagnostic?.event_id === detail.event_id
      ? { ...current, diagnostic: null } : current), Math.max(0, detail.expires_at_ms - Date.now()));
    return () => window.clearTimeout(timer);
  }, [runtime.diagnostic?.event_id, runtime.diagnostic?.expires_at_ms]);
  useEffect(() => {
    if (!runtime.audio) return;
    const observed = runtime.audio.observed_at_ms;
    const timer = window.setTimeout(() => setRuntime(current => current.audio?.observed_at_ms === observed ? {...current, audio:null} : current),
      Math.max(0, observed + 15000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [runtime.audio?.observed_at_ms]);
  function edit(patch: Partial<Policy>) { dirty.current = true; setPolicy(p => ({ ...p, ...patch })); }
  async function save() {
    const id = meetingId;
    setBusy(true); setError('');
    try {
      const r = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) });
      const value = await r.json();
      if (!r.ok) throw new Error(value.detail || 'Không lưu được cấu hình.');
      if (identity.current !== id) return;
      dirty.current = false; setPolicy({ ...value.policy, wake_variants: value.policy.wake_variants || [] }); setRuntime(value.runtime);
    } catch (e) { if (identity.current === id) setError((e as Error).message); }
    finally { if (identity.current === id) setBusy(false); }
  }
  async function stop() {
    if (!nativeId) return;
    const id = meetingId; setBusy(true); setError('');
    try {
      const r = await fetch(`/api/bots/google_meet/${encodeURIComponent(nativeId)}/speak`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Chưa dừng được câu trả lời; hãy kiểm tra bot.');
    } catch (e) { if (identity.current === id) setError((e as Error).message); }
    finally { if (identity.current === id) setBusy(false); }
  }
  const detail = runtime.diagnostic && runtime.diagnostic.expires_at_ms > Date.now() ? runtime.diagnostic : null;
  const audio = runtime.session_active !== false && runtime.heartbeat_fresh !== false && runtime.audio
    && Date.now() - runtime.audio.observed_at_ms < 15000 ? runtime.audio : null;
  const summary = !policy.enabled ? 'Đang tắt'
    : runtime.session_active === false ? 'Chưa có bot đang hoạt động'
      : runtime.heartbeat_fresh === false ? 'Chưa nhận trạng thái bot'
        : runtime.state === 'OFF' ? (detail?.code === 'starting' ? 'Đang khởi động voice' : 'Chưa sẵn sàng') : stateLabel[runtime.state] || runtime.state;
  return <>{!repliesOnly && <details onToggle={event => setOpen(event.currentTarget.open)} style={{ margin: '0 24px 10px', padding: '9px 12px', border: '1px solid var(--line2)', borderRadius: 8 }}>
    <summary style={{ cursor: 'pointer', fontSize: 13 }}>Voice assistant · {summary}</summary>
    <div style={{ display: 'grid', gridTemplateColumns:'minmax(0, 1fr)', minWidth:0, gap: 10, paddingTop: 12, maxWidth: 600, fontSize: 13 }}>
      <p style={{ margin: 0, color: 'var(--t3)', lineHeight: 1.5 }}>Tên gọi có sẵn: TINA, TINA ơi, tin ơi, ti na ơi, tiên na ơi, tinh anh ơi, tin anh ơi — ở đầu câu, không phân biệt hoa/thường. Meeting Google Meet mới mặc định bật Voice assistant và lọc tạp âm, dùng transcript của chính meeting; bạn có thể tắt hoặc đổi nguồn bên dưới.</p>
      <details style={{minWidth:0}}>
        <summary style={{cursor:'pointer'}}>Audio theo kênh{audio ? ` · ${audio.channels.length}` : ''}</summary>
        {!audio?.channels.length ? <p role="status" style={{color:'var(--t3)'}}>Chưa có số đo audio mới. Cần bot mới có hỗ trợ chẩn đoán.</p> : <>
          <div style={{overflowX:'auto',marginTop:8}}><table aria-label="Chẩn đoán audio theo kênh" style={{width:'100%',borderCollapse:'collapse',fontSize:12,textAlign:'left'}}>
            <thead><tr>{['Kênh / tín hiệu','Frame','Thiếu / chồng mẫu','Capture → bot','Chờ worker','Tổng ASR'].map(label=><th key={label} scope="col" style={{padding:6,whiteSpace:'nowrap'}}>{label}</th>)}</tr></thead>
            <tbody>{audio.channels.map(row => {
              const fresh = Date.now() - row.last_frame_ms < 3000;
              const asrFresh = row.asr_at_ms != null && Date.now() - row.asr_at_ms < 15000;
              return <tr key={row.channel} style={{borderTop:'1px solid var(--line2)'}}>
                <th scope="row" style={{padding:6,fontWeight:500}}>#{row.channel} · {!fresh ? 'Chưa có frame mới' : row.rms >= .0001 ? 'Có âm thanh' : 'Yên'}
                  <div style={{fontSize:11,color:'var(--t3)'}}>{row.asr_inflight ? `${row.asr_inflight} lượt ASR đang chờ/xử lý` : 'ASR rảnh'} · {row.asr_errors} lỗi</div></th>
                <td style={{padding:6}}>{row.frames}</td>
                <td style={{padding:6}}>{row.sample_clock ? `${row.gap_samples} / ${row.overlap_samples}` : 'Không có sample clock'}
                  {row.clock_resets > 0 && <div>{row.clock_resets} lần clock về 0</div>}</td>
                <td style={{padding:6,whiteSpace:'nowrap'}}>{fresh ? ms(row.capture_lag_ms) : '—'}</td>
                <td style={{padding:6,whiteSpace:'nowrap'}}>{asrFresh ? ms(row.queue_ms) : '—'}</td>
                <td style={{padding:6,whiteSpace:'nowrap'}}>{asrFresh ? ms(row.roundtrip_ms) : '—'}
                  {asrFresh && <div style={{fontSize:11,color:'var(--t3)'}}>Đuôi audio → gửi: {ms(row.capture_age_ms)}</div>}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <p style={{margin:'6px 0',fontSize:11,color:'var(--t3)'}}>Cập nhật khoảng 2–3 giây · chỉ chủ meeting xem. Có âm thanh không đồng nghĩa có lời nói. Thiếu/chồng là khoảng trống/chồng sample index quan sát được, chưa khẳng định mất gói mạng. Thời gian ASR là lượt gần nhất; “—” nghĩa chưa có số đo.</p>
        </>}
      </details>
      {loaded && !available && <p role="status" style={{ margin: 0 }}>Cần tạo bot mới có bật phát giọng nói sau khi dịch vụ TTS được cấu hình.</p>}
      {loaded && policy.enabled && <div role="status" aria-label="Chẩn đoán Voice assistant"
        style={{ padding: '10px 12px', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 6, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600 }}>Hoạt động gần nhất</div>
        {detail ? <>
          <div>{diagnosticLabel[detail.code] || 'Đang cập nhật trạng thái hỏi đáp.'}</div>
          {detail.heard_prefix && <div style={{ marginTop: 5 }}>ASR vừa nghe (3 từ đầu): <q>{detail.heard_prefix}</q></div>}
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>
            {new Date(detail.observed_at_ms).toLocaleTimeString('vi-VN')} · Chỉ chủ meeting xem · Tự ẩn sau 30 giây
          </div>
        </> : <div>{runtime.session_active === false ? 'Tạo hoặc tiếp tục bot để nhận trạng thái mới.'
          : runtime.heartbeat_fresh === false ? 'Chưa nhận được trạng thái mới từ bot; chẩn đoán cũ đã được ẩn.'
            : 'Chưa có chẩn đoán mới. Khi bạn nói, kết quả nhận tên và bước xử lý sẽ hiện ở đây.'}</div>}
      </div>}
      <label><input type="checkbox" checked={policy.enabled} disabled={!loaded || busy || (!available && !policy.enabled)} onChange={e => edit({ enabled: e.target.checked })} /> Bật Voice assistant cho meeting này</label>
      <label><input type="checkbox" checked={!!policy.noise_suppression} disabled={!loaded||busy||!available} onChange={e=>edit({noise_suppression:e.target.checked})}/> Lọc tạp âm</label>
      <div style={{fontSize:12,color:'var(--t3)',lineHeight:1.5}}>Mặc định bật cho meeting mới · CPU · cần bot mới sau cập nhật. Áp dụng cho cả ASR và VAD, giữ bản audio nhận về. Lọc có thể làm sai tên/phụ âm; chưa bật AGC, HPF hoặc AEC.
        <div role="status">Trạng thái lọc: {({off:'Tắt',starting:'Đang khởi động / chờ audio',low:'Đang lọc tạp âm',failed:'Bộ lọc lỗi — đang dùng audio gốc'} as Record<string,string>)[audio?.noise_suppression||'']||'Chưa có số đo từ bot'}</div>
      </div>
      <label style={{ display: 'grid', gap: 6 }}>Biến thể tên TINA mà ASR thường nhận được
        <input aria-label="Biến thể tên TINA" disabled={!loaded || busy} value={variantInput}
          placeholder="Ví dụ: ti na, ti na ơi" onChange={e => { setVariantInput(e.target.value); edit({ wake_variants: e.target.value.split(',').map(v => v.trim()).filter(Boolean) }); }} />
        <span style={{ color: 'var(--t3)', fontSize: 12 }}>Các tên mặc định ở trên đã có sẵn, không cần thêm hay lưu lại. Chỉ nhập biến thể khác nếu cần, phân cách bằng dấu phẩy rồi lưu. “Anh ơi” vẫn không được dùng.</span>
      </label>
      <fieldset disabled={!loaded || busy} style={{ border: '1px solid var(--line2)', borderRadius: 6, display: 'grid', gap: 8 }}>
        <legend>Nguồn được phép đọc cho cả phòng</legend>
        <label><input type="checkbox" checked={policy.include_transcript} onChange={e => edit({ include_transcript: e.target.checked })} /> Transcript của meeting này</label>
        <label><input type="checkbox" checked={!!policy.include_approved_actions} onChange={e => edit({ include_approved_actions: e.target.checked })} /> Task và quyết định đã duyệt của meeting này</label>
        {[...new Set([...documents.map(doc => doc.path), ...policy.documents])].map(path => <label key={path}><input type="checkbox" checked={policy.documents.includes(path)} onChange={e => edit({ documents: e.target.checked ? [...policy.documents, path] : policy.documents.filter(p => p !== path) })} /> {documents.find(doc => doc.path === path)?.title || `${path} (không còn liên kết)`}</label>)}
      </fieldset>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={button} disabled={!loaded || busy || (!dirty.current && runtime.state !== 'ERROR')} onClick={save}>Lưu cấu hình</button>
        {nativeId && policy.enabled && <button type="button" style={button} disabled={busy} onClick={stop}>Dừng câu trả lời</button>}
      </div>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--warn)' }}>{error}</p>}
    </div>
  </details>}
    {repliesOnly && error && <p role="alert" style={{ margin: '0 0 8px', color: 'var(--warn)', fontSize: 12 }}>Không tải được câu trả lời của TINA.</p>}
    {replies.length > 0 && <section aria-label="TINA trả lời" style={{ margin: repliesOnly ? 0 : '0 24px 16px', display: 'grid', gap: 8, maxHeight: repliesOnly ? undefined : '30vh', overflowY: repliesOnly ? 'visible' : 'auto', flexShrink: 0 }}>
      {[...replies].reverse().map(reply => <article key={reply.request_id} style={{ padding: 12, border: '1px solid var(--line2)', borderRadius: 8, background: 'var(--panel2)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <strong>TINA trả lời</strong><span role="status" style={{ color: 'var(--t2)' }}>{replyLabel[reply.state] || 'Chưa xác nhận'}</span>
          {reply.answer_kind&&<span style={{color:'var(--t3)'}}>{reply.answer_kind==='web'?'Web':reply.answer_kind==='general'?'Kiến thức chung':reply.answer_kind==='assistant'?'Trợ lý':'Nguồn meeting'}</span>}
          <time dateTime={new Date(reply.created_at_ms).toISOString()} style={{ marginLeft: 'auto', color: 'var(--t3)' }}>{new Date(reply.created_at_ms).toLocaleTimeString('vi-VN')}</time>
        </div>
        <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14, lineHeight: 1.6 }}>{reply.state==='stopped'&&reply.played_text!=null ? reply.played_text||'Chưa có câu nào được phát trọn vẹn.' : reply.text}</p>
        {!!reply.links?.length&&<div style={{display:'flex',gap:10,flexWrap:'wrap',marginTop:6}}>{reply.links.filter(link=>/^https?:\/\//i.test(link.url)).map(link=><a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)',fontSize:12}}>{link.title}</a>)}</div>}
        {!!reply.source_count && <div style={{ marginTop: 8 }}>
          <button type="button" aria-expanded={sourceReply === reply.request_id}
            onClick={() => setSourceReply(sourceReply === reply.request_id ? null : reply.request_id)}
            style={{ ...button, fontSize: 12, padding: '4px 8px', color: 'var(--accent)' }}>
            {sourceReply === reply.request_id ? 'Ẩn nguồn' : `Nguồn · ${reply.source_count}`}
          </button>
          {sourceReply === reply.request_id && <VoiceReplySources key={`${meetingId}:${reply.request_id}`} base={base} requestId={reply.request_id} />}
        </div>}
        {['stopped', 'failed', 'unconfirmed'].includes(reply.state) && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--t3)' }}>{reply.state==='stopped'&&reply.played_text!=null?'Chỉ hiển thị các câu đã phát trọn vẹn.':'TINA có thể chưa đọc hết nội dung này.'}</p>}
      </article>)}
    </section>}
  </>;
}

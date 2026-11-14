"use client";
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useService } from '../platform';
import { LayoutServiceId } from '../workbench/layout';
import { meetingsOnly } from '../app/mode';
import { voiceActivity, voiceActivityStatus, VOICE_ACTIVITY_TTL } from '../lib/voiceActivity';
import styles from './VoiceActivity.module.css';
import { requestChat } from './actions';

export function VoiceActivity({ meetingId, ended = false, onSnapshot }: { meetingId: string; ended?: boolean; onSnapshot?:(value:unknown)=>void }) {
  const layout = useService(LayoutServiceId);
  const [snapshot, setSnapshot] = useState<{ id: string; value: unknown }>({ id: '', value: undefined });
  const [handoff, setHandoff] = useState({busy:false, opened:'', error:''});
  const currentMeeting = useRef('');
  currentMeeting.current = ended ? '' : meetingId;
  useEffect(() => {
    if (ended || !/^\d+$/.test(meetingId)) return;
    const abort = new AbortController();
    let poll: ReturnType<typeof setTimeout>, expiry: ReturnType<typeof setTimeout>;
    setSnapshot({ id: meetingId, value: undefined });
    setHandoff({busy:false, opened:'', error:''});
    const stale = () => setSnapshot({ id: meetingId, value: null });
    async function refresh() {
      try {
        const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/voice-assistant`, {
          cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('Voice status unavailable');
        const value = await response.json();
        if (abort.signal.aborted) return;
        setSnapshot({ id: meetingId, value });
        onSnapshot?.(value);
        clearTimeout(expiry);
        const observed = value?.runtime?.kws?.observed_at_ms ?? Date.now();
        expiry = setTimeout(stale, Math.max(0, Math.min(VOICE_ACTIVITY_TTL, (typeof observed === 'number' ? observed : 0) + VOICE_ACTIVITY_TTL - Date.now())));
      } catch { if (!abort.signal.aborted) stale(); }
      if (!abort.signal.aborted) poll = setTimeout(refresh, 1500);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(poll); clearTimeout(expiry); };
  }, [meetingId, ended, onSnapshot]);
  if (!/^\d+$/.test(meetingId)) return null;
  const phase = voiceActivity(snapshot.id === meetingId ? snapshot.value : undefined, Date.now(), ended);
  const status = voiceActivityStatus(snapshot.id === meetingId ? snapshot.value : undefined, Date.now(), ended);
  const hint = (snapshot.id === meetingId ? snapshot.value as {runtime?:{handoff?:{request_id?:string;expires_at_ms?:number}}} : null)?.runtime?.handoff;
  const rid = hint?.request_id;
  const canContinue = !meetingsOnly() && !ended && rid && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(rid)
    && (hint?.expires_at_ms ?? 0) > Date.now() && handoff.opened !== rid;
  async function continueInChat() {
    if (!canContinue || handoff.busy) return;
    setHandoff(previous=>({...previous,busy:true,error:''}));
    try {
      const response = await fetch(`/api/meetings/${meetingId}/voice-assistant/handoff/${rid}`,{method:'POST',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(response.status === 409 ? 'This voice request changed or expired. Please ask TINA again.' : 'Could not open the voice request. Please retry.');
      const value = await response.json();
      if (currentMeeting.current !== meetingId) return;
      if (value.meeting_id !== Number(meetingId) || value.request_id !== rid || typeof value.original_request !== 'string') throw new Error('Invalid voice request. Please retry.');
      const task = value.task;
      const decision = value.decision;
      const prompt = [`Tiếp tục yêu cầu voice: ${value.original_request}`,
        ...(task ? [`Task: ${task.title || '(chưa có tiêu đề)'}`,`Phụ trách: ${task.assignee === '' ? '(để trống)' : task.assignee ?? '(chưa chọn)'}`,`Hạn: ${task.due === '' ? '(để trống)' : task.due ?? '(chưa chọn)'}`,
          ...(task.save_uncertain ? ['Chưa xác nhận được lần lưu trước. Kiểm tra bản nháp đã có trước khi thử tạo lại.'] : [])] : []),
        ...(decision ? [`Quyết định: ${decision.title || '(chưa có nội dung)'}`,
          `Trạng thái người gọi cung cấp: ${decision.requested_status === 'proposed' ? 'đề xuất' : decision.requested_status === 'decided' ? 'đã chốt (cần đối chiếu nguồn)' : 'chưa xác định'}`,
          `Kiểm tra nguồn: ${decision.evidence_status === 'supported' ? 'có đoạn xác nhận' : decision.evidence_status === 'conflict' ? 'các nguồn chưa thống nhất' : decision.evidence_status === 'missing' ? 'chưa có đoạn xác nhận' : 'chưa kiểm tra'}`,
          ...(decision.save_uncertain ? ['Chưa xác nhận được lần lưu trước. Kiểm tra bản nháp đã có trước khi thử tạo lại.'] : [])] : []),
        'Hãy tiếp tục từ thông tin đã thu; hỏi phần còn thiếu trước khi tạo bản nháp.'].join('\n');
      if (layout.store.getState().rightCollapsed) flushSync(()=>layout.toggleRight());
      requestChat({prompt,composeOnly:true,session:`voice-handoff-${meetingId}-${rid}`});
      setHandoff({busy:false,opened:rid!,error:''});
    } catch (error) {
      if (currentMeeting.current === meetingId) setHandoff(previous=>({...previous,busy:false,error:(error as Error).message}));
    }
  }
  return <span className={styles.group}><span className={styles.indicator} data-phase={phase} data-meeting-id={meetingId}
    role="status" aria-live="polite" aria-atomic="true" aria-label={`TINA · ${status.label}`} title={status.title}>
    <svg className={styles.wave} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6v4"/><path d="M8 3v10"/><path d="M13 5v6"/>
    </svg>
    <span className={styles.name}>TINA</span><span className={styles.label}>{status.label}</span>
  </span>{canContinue && <button className={styles.handoff} type="button" disabled={handoff.busy}
    onClick={()=>void continueInChat()} title="Review the voice request in a private chat before sending">
    {handoff.busy ? 'Opening…' : 'Continue in chat'}<span aria-hidden="true"> ↗</span>
  </button>}{handoff.error && <span className={styles.error} role="alert">{handoff.error}</span>}</span>;
}

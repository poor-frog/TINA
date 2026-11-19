/** Read-only presentation of the owner-scoped meeting-voice.v1 runtime. */
export const voiceActivities = {
  LISTENING: { label: 'Chờ gọi tên', title: 'Sẵn sàng nhận “hey TINA” hoặc “TINA ơi”.' },
  CAPTURING: { label: 'Đang nghe câu hỏi', title: 'TINA đang thu câu hỏi của người vừa gọi.' },
  THINKING: { label: 'Đang xử lý', title: 'TINA đang tìm nguồn và chuẩn bị câu trả lời.' },
  SPEAKING: { label: 'Đang trả lời', title: 'TINA đang phát giọng nói vào cuộc họp.' },
  QUIET: { label: 'Chờ nghe lại', title: 'Đợi âm thanh yên trước khi nhận lượt gọi tiếp theo.' },
  CHECKING: { label: 'Đang kiểm tra', title: 'Đang đọc trạng thái voice của bot.' },
  STARTING: { label: 'Đang khởi động', title: 'Voice assistant đang chuẩn bị.' },
  OFF: { label: 'Voice đang tắt', title: 'Voice assistant chưa được bật hoặc chưa sẵn sàng.' },
  NO_BOT: { label: 'Chưa có bot', title: 'Chưa có phiên bot đang hoạt động cho cuộc họp này.' },
  ENDED: { label: 'Đã kết thúc', title: 'Cuộc họp đã kết thúc; TINA không còn nghe.' },
  ERROR: { label: 'Voice gặp lỗi', title: 'Kiểm tra Voice assistant trong Settings.' },
  UNAVAILABLE: { label: 'Mất kết nối voice', title: 'Chưa nhận được trạng thái mới; không thể xác nhận TINA đang nghe.' },
} as const;
export type VoiceActivity = keyof typeof voiceActivities;
export const VOICE_ACTIVITY_TTL = 15_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function voiceActivity(value: unknown, now = Date.now(), ended = false): VoiceActivity {
  if (ended) return 'ENDED';
  if (value === undefined) return 'CHECKING';
  const body = record(value), runtime = record(body.runtime), policy = record(body.policy);
  if (runtime.session_active === false) return 'NO_BOT';
  if (policy.enabled === false || body.available === false) return 'OFF';
  if (runtime.session_active !== true || policy.enabled !== true || runtime.heartbeat_fresh !== true) return 'UNAVAILABLE';
  const state = runtime.state;
  if (state === 'OFF') return record(runtime.diagnostic).code === 'starting' ? 'STARTING' : 'OFF';
  if (state === 'LISTENING') {
    const kws = record(runtime.kws);
    if (kws.status === 'starting') return 'STARTING';
    if (kws.status === 'failed') return 'ERROR';
    if (kws.status !== 'ready' || typeof kws.observed_at_ms !== 'number' || !Number.isFinite(kws.observed_at_ms)
        || now - kws.observed_at_ms < -5000 || now - kws.observed_at_ms >= VOICE_ACTIVITY_TTL) return 'UNAVAILABLE';
  }
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(voiceActivities, state) ? state as VoiceActivity : 'UNAVAILABLE';
}

const voiceProgress = {
  drafting: { label: 'Đang chuẩn bị bản nháp', title: 'TINA đang đề xuất bản nháp để chủ meeting xem lại.' },
  planning: { label: 'Đang chọn nguồn', title: 'TINA đang xác định nguồn cần tra cứu.' },
  searching_transcript: { label: 'Đang tìm transcript', title: 'TINA đang tìm nội dung trong transcript được chia sẻ.' },
  reading_documents: { label: 'Đang đọc tài liệu', title: 'TINA đang tra Wiki và tài liệu được chia sẻ.' },
  searching_web: { label: 'Đang tìm web', title: 'TINA đang thực hiện truy vấn web đã được cho phép.' },
  reading_context: { label: 'Đang đọc ngữ cảnh', title: 'TINA đang đọc phần liên quan quanh nguồn vừa tìm được.' },
  answering: { label: 'Đang soạn câu trả lời', title: 'TINA đang chuẩn bị và kiểm chứng câu trả lời.' },
  preparing_speech: { label: 'Đang chuẩn bị giọng nói', title: 'Câu trả lời đã sẵn sàng; bot đang chuẩn bị phát.' },
} as const;

const voiceRecovery = {
  no_input: { label: 'Chờ bạn gọi lại', title: 'Chưa nhận thêm câu trả lời trong lượt chờ. TINA đã trở về chờ gọi tên.' },
  dialogue_paused: { label: 'Tạm dừng hỏi lại', title: 'Đã hỏi lại hai lần. Gọi TINA kèm thông tin cụ thể khi muốn tiếp tục.' },
  answer_failed: { label: 'Chưa lấy được câu trả lời', title: 'Kiểm tra model, dịch vụ trả lời và quyền nguồn. Câu hỏi rõ không cần nói lại chỉ vì dịch vụ gặp lỗi.' },
  playback_failed: { label: 'Không phát được audio', title: 'Câu trả lời có thể đã được tạo. Kiểm tra mic/TTS của bot; audio không tự phát lại.' },
} as const;

export function voiceActivityStatus(value: unknown, now = Date.now(), ended = false): { label: string; title: string } {
  const phase = voiceActivity(value, now, ended);
  const body = record(value), runtime = record(body.runtime), policy = record(body.policy), progress = record(runtime.progress);
  if (phase === 'THINKING' && typeof progress.stage === 'string'
      && Object.prototype.hasOwnProperty.call(voiceProgress, progress.stage)
      && typeof progress.request_id === 'string' && progress.request_id === runtime.request_id
      && typeof progress.session_uid === 'string' && progress.session_uid === runtime.session_uid
      && typeof progress.revision === 'number' && progress.revision === policy.revision
      && typeof progress.observed_at_ms === 'number' && Number.isFinite(progress.observed_at_ms)
      && now - progress.observed_at_ms >= 0 && now - progress.observed_at_ms < 180_000) {
    return voiceProgress[progress.stage as keyof typeof voiceProgress];
  }
  const diagnostic = record(runtime.diagnostic);
  if ((phase === 'LISTENING' || phase === 'QUIET') && typeof diagnostic.code === 'string'
      && Object.prototype.hasOwnProperty.call(voiceRecovery, diagnostic.code)
      && typeof diagnostic.session_uid === 'string' && diagnostic.session_uid === runtime.session_uid
      && typeof diagnostic.observed_at_ms === 'number' && Number.isFinite(diagnostic.observed_at_ms)
      && now - diagnostic.observed_at_ms >= 0 && now - diagnostic.observed_at_ms < VOICE_ACTIVITY_TTL
      && typeof diagnostic.expires_at_ms === 'number' && Number.isFinite(diagnostic.expires_at_ms) && diagnostic.expires_at_ms > now) {
    return voiceRecovery[diagnostic.code as keyof typeof voiceRecovery];
  }
  return voiceActivities[phase];
}

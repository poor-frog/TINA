# Refine a voice task while TINA is thinking

After “TINA ơi, tổng hợp quyết định trong cuộc họp”, the same identified caller can
say “Chỉ lấy phần backend thôi” before the answer starts playing. Other examples are
“Thêm người phụ trách và thời hạn”, “Bổ sung phần kiểm thử” and “Khoan, ý tôi là sprint trước”.
No new acoustic wake is needed for these explicit updates while THINKING. Ordinary remarks,
backchannels, another participant, unknown identity, stale windows and playback echoes do not
authorize a replacement. SPEAKING also accepts bounded caller corrections and pause cues; see
[tina-voice-speaking-interruption.md](tina-voice-speaking-interruption.md).

The bot aborts the old HTTP request, stops any waiting notice and waits for a cancellation
acknowledgment. LiveKit interrupts the exact old SpeechHandle and acknowledges after that turn's
cleanup. A late Stop cannot target a new handle. If cancellation cannot be confirmed, the bot
stays in an error state instead of dispatching an overlapping replacement. Meeting API suppresses
old request-bound heartbeats/cleanup with a Redis transaction so they cannot overwrite the new
capture/thinking state or release the new room lease.

After the existing quiet rearm, the already-confirmed update is fed through the same caller-bound
continuation. Only at dispatch does the bot combine the original user question with the update.
Raw hypotheses, canonical transcript and audio timestamps are not rewritten. A replacement gets
a fresh UUID, the same hashed transport caller scope, fresh source authorization and independent
playback receipts. Successive updates retain the earlier goal/restrictions within the existing
2000-character question limit. This is private user intent, never factual evidence or an inferred
account identity. The continuation must rearm within the existing five-second follow-up window.

The combined request reaches retrieval/planning, recap map/selection, generation and verification.
Recap map now receives the requested topic instead of only a generic extraction instruction.
Its bounded wait checks the room permit at most every 250 ms and exits on Stop/replacement,
without scheduling later map/select/verify stages. A synchronous provider call already dispatched
may still finish and occupy its existing pool slot until completion; its result cannot be released
by the cancelled turn. There is still only one admitted voice turn per meeting, not two agents
answering in parallel. Provider failure is distinct from cancellation.

Implicit updates never rewrite a public web/general query. Restate a complete explicit query with
“Khoan, tìm web về …” or stop and call TINA again. Oversized combined questions are refused rather
than silently truncating the original request. ASR engines, audio windows, FSMN-VAD, KWS, NS and
VieNeu-TTS remain unchanged. Existing waiting notices and owner progress labels follow the new
request; no unverified partial response is spoken.

Tests cover caller/source boundaries, cancellation acknowledgment, repeated refinements, late
answers, failed cancellation, immediate replacement in the actual SDK, late Stop, stale owner
status and cancellation while provider work is blocked. Real meeting timing and recognition
quality remain separate acceptance checks.

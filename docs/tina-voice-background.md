# Background meeting recaps

Say “TINA ơi, tổng hợp toàn bộ quyết định trong cuộc họp”. For a slow whole-meeting
recap, the bot says “Em đang tổng hợp, bạn chờ một chút nhé.” once, waits for the
verified result and plays it automatically. Transcript capture continues throughout.
Fast results speak directly without an extra notice.

The existing Agent API background pool runs the map/select/verify stages. All stages
share a 120-second waiting deadline; a busy pool waits for a slot rather than returning
early. Only original approved transcript chunks are evidence. The initial source
snapshot is preserved, so the recap describes the meeting up to the request rather
than chasing new transcript additions indefinitely.

The request remains one exclusive voice turn. Stop/caller correction can cancel it;
a replacement question/session, departure, policy revision or artifact deletion fences
the old result. Every model job checks current sharing/fingerprints and the internal
Meeting API turn permit before and after inference. In-flight provider work can finish
after Stop, but it cannot authorize another stage or playback. UUID-scoped RAM jobs do
not survive Agent API restart and are not a durable task queue.

The fixed public notice catalog is prewarmed in VieNeu-TTS. They bypass the busy
AgentSession and never enter factual conversation history. Normal acknowledgment has
a three-second TTS deadline; the longer recap notice has six seconds to allow microphone
setup and playback. Private answers are not cached.

Core HTTP answer wait is 150 seconds, Agents LLM wait 160 seconds, Agents route wait
165 seconds, bot service wait 170 seconds, and total bot turn budget 330 seconds inside
a 360-second reservation. If recap computation exceeds 120 seconds, the bot reports that
it has no fully verified summary yet. No partial facts or promise of later playback are
released. Longer/unbounded jobs, simultaneous voice questions and restart recovery are
outside this change.

Checks cover background completion/pool contention, service-secret permits, source and
turn cancellation, one-time notice, automatic playback, notice routing outside Agents
and old results arriving after a new question. Real meeting audio remains a separate test.

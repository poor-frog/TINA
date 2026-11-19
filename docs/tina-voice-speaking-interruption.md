# Speaking interruptions

While TINA is speaking, the identified caller can say “Khoan, ý tôi là sprint trước”,
“Không, ý tôi là phần backend”, “Chỉ lấy phần backend thôi” or “Cho tôi hỏi ai phụ trách demo?”.
The first three refine the original question; the last begins a new question. “Khoan đã”,
“Đợi một chút” and “Chờ chút” pause for a same-caller continuation. “Dừng”, “Dừng lại” and
“TINA dừng” stop without arming another question.

This extends the existing TINA interruption guard and LiveKit cancellation bridge. ASR, FSMN-VAD,
KWS, NS, TTS models and their windows are unchanged. There is no new LLM classification call.
Only the same transport participant on the same channel can interrupt; unknown or changed
identity cannot claim a turn. Source-clock validation and ASR agreement still apply.

Soft corrections/new-question cues while SPEAKING need final ASR, at least three words and
350 ms of source speech. Explicit pause/Stop cues retain their 150 ms minimum and stable-ASR
acceptance. “Ừ”, “đúng rồi”, “okay”, ordinary remarks, very short/noise-like snippets and VAD
activity alone do not stop playback. The local guard remembers up to three recently played
sentences for 1.8 seconds to reject exact/contained textual echoes across sentence boundaries,
including while cancellation is pending. This is a lexical/timing heuristic, not acoustic echo
cancellation or a semantic interruption model. Recognition errors and paraphrased echoes still
need real-audio evaluation; arbitrary speech is deliberately not accepted as an interruption.

The bot invalidates old work, mutes/kills local playback first, records the monotonic prefix of
fully completed sentences, then asks the server to cancel the old turn. This order prevents core
cancellation from finalizing an empty stopped receipt before the bot's played-prefix receipt.
The serialized existing reporter sends earlier started/progress receipts first. A failed prefix
receipt still cancels remotely but cannot automatically resume a replacement with unreliable
history. A failed cancellation or microphone stop also prevents replacement dispatch.

The replacement receives a new UUID and fresh authorization/verification. Corrections carry the
original question plus the new user detail, never generated-but-unheard claims. Known-caller
ASR arriving while cancellation is pending is bounded to eight hypotheses and replayed after
the existing quiet rearm. Other callers and remembered playback echoes are excluded. Explicit
public web/general queries still need full restatement rather than implicit private-context merging.

Heard history retains only complete playback or the confirmed completed-sentence prefix of a
stopped reply. A partly spoken sentence is conservatively omitted because the local player does
not provide reliable word alignment. Terminal/Extension already show this stopped prefix separately
from the original generated proposal. The raw meeting transcript remains independent.

Use a new bot after rebuilding. Ask who owns a demo and its deadline, interrupt during the second
sentence with “Khoan, ý tôi là sprint trước”, then check that the new answer uses that sprint,
the old answer does not resume, and the stopped reply contains only completed sentences. Also
check “ừ, đúng rồi”, another person's correction, and room-speaker echo. Automated tests cover
these text/timing/receipt boundaries; live Google Meet playback and noisy-room accuracy require
separate acceptance tests.

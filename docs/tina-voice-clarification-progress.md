# Voice clarification and tool progress

The existing LiveKit function-tool loop and TINA authorization bridge remain in use. No SDK
upgrade, additional orchestrator, ASR, KWS, VAD or TTS model is introduced.

## Clarification

A completed, source-free clarification is retained as intent context for the same transport
caller, meeting, bot session and policy revision. Queued/unheard questions never become context;
stopped playback retains only the already-heard prefix and does not keep a pending clarification.
The last three heard turns reconstruct the original question, earlier refinements and the latest
clarifying question. The latest clarification expires after 30 seconds without a reply. Older
steps can remain while that last step is fresh, within the existing 15-minute history bound.

Planning and generation receive this explicit pending task. Short replies also carry its topic
into lexical/semantic retrieval and reranking. Verification/repair sees the same combined intent.
An explicit new request replaces the previous goal; a correction can replace a prior refinement.
Prompts ask for one missing detail, avoid repeating a detail already supplied, and only offer
alternatives present in approved sources. This interpretation is model-dependent; no new model
call is added solely to classify a clarification. User refinements and generated history never
become factual evidence. Historical sources still require current fingerprints; private context
is never supplied to public web/general routes.

## Progress

Meeting API records allowlisted stages around its existing operations: planning, transcript
search, shared-document search, explicit web search, adjacent context lookup, answer preparation
and speech preparation. Concurrent tools can show the most recently started tool. Answer
preparation includes generation and verification; it does not claim those are separate measured
stages. The original detailed timings remain in content-free server logs.

The owner-only voice status returns `runtime.progress` only for a fresh THINKING heartbeat,
matching request/session/policy and the current exclusive room lease. Progress expires after
180 seconds. Stop, departure, policy revision, replacement request or failed polling removes the
visible detail. It contains identifiers, an enum and a timestamp; no questions, source quotes,
tool arguments or reasoning. Terminal and Extension use fixed labels in the existing small badge.
Older clients retain their generic state display. The bot uses one cached waiting notice per slow question: after 900 ms for an inline question,
or four seconds when it already acknowledged the wake. It cancels the timer when the answer
arrives or the turn stops. Progress labels do not trigger additional speech or factual history.

For a manual check, ask “TINA ơi, tóm tắt phần đó”, answer the clarification with a topic present
in the shared transcript, and then correct it if needed. The answer must address that topic using
approved evidence. During a slower Wiki lookup, watch the badge change to “Đang đọc tài liệu”.
Stop must remove that progress and prevent any late answer from playing.

Automated coverage lives in the voice knowledge/API tests and Terminal's voiceActivity tests
(including the Extension DOM presenter). These checks use fixtures, not live provider inference
or Google Meet microphone playback.

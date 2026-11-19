# Voice task and decision drafts

In a LiveKit-enabled Google Meet, ask “TINA ơi, tạo task demo cho An, hạn thứ Sáu”
or “TINA ơi, ghi quyết định: dùng PostgreSQL cho dự án”. TINA can propose one short
draft title, read it back and ask the meeting owner to review it in Terminal.
If the requested content is missing, it asks which task/decision to record; the existing
same-caller clarification context can supply that detail. Factual questions and quoted
instructions in retrieved sources cannot authorize a draft tool. Public web/general routes
do not inherit private action context.

The two SDK function tools are `draft_task` and `draft_decision`. They use the existing
bounded planning/lookup protocol, caller scope, request UUID and Stop fences. Tool execution
only returns a proposal. Finalization creates a private `.meeting-knowledge/<meeting>/voice-drafts/`
record after checking the current room permit and policy. A stopped finalization cannot
publish a task. A draft written just before Stop remains hidden unless its exact readback has
a completed microphone receipt. No approval/publish tool is available to the voice LLM.

The owner sees **Bản nháp từ voice** in the meeting's question/knowledge section after the readback
finishes. Edit title and details, optionally enter a task assignee label and an explicit ISO due
date, then choose **Xác nhận tạo task**, **Xác nhận ghi quyết định** or **Bỏ bản nháp**. The original
spoken request is retained in editable details, so names and relative dates are not silently
discarded by a short title. Assignee labels are text; they do not establish an account identity,
grant permissions or send notifications. Due dates are entered by the owner, not guessed from
“thứ Sáu”. Saying “đồng ý” in the room cannot authenticate the owner or approve a draft.

Approval creates a normal workspace entity under `kg/entities/task/voice-<id>.md` (open task)
or `kg/entities/decision/voice-<id>.md` (owner-reviewed decision note). The Tasks list refreshes
after approval. **Mở tài liệu** opens either result. This note records what the owner approved;
it does not infer unanimous meeting agreement, alter the canonical transcript/memory or share
the new document back into room RAG automatically. No external ticket, calendar or message is sent.

The owner-only GET/POST endpoints live below
`/api/workspace/meeting-knowledge/<meeting>/voice-drafts`. Reads require current meeting ownership,
matching policy revision and a completed readback. Failed/stopped/queued readbacks do not qualify.
Review repeats authorization while holding the existing workspace write lock and checks the draft
revision. Deterministic request-based IDs and exclusive file creation prevent duplicate documents;
existing or edited documents are never overwritten. A retry after a partial publication can reuse
the exact same content. Policy changes and artifact deletion hide pending drafts. At most 20
eligible recent draft records are listed; files remain in the owner's workspace. Storage follows
the existing local-workspace pattern and is not a distributed multi-node transaction.

The existing ASR, VAD, KWS, TTS and voice capture are unchanged. Automated tests cover actual SDK
function tools, owner review, completed playback, Stop/policy revocation, duplicate/conflicting writes,
symlinks, editable UI, failed refresh and revision conflicts. Real Google Meet recognition, provider
planning quality and audible readback remain separate acceptance checks.

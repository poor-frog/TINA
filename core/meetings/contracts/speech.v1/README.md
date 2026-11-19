# speech.v1 — correlated playback and the single-room voice pilot

Core meetings owns these wire shapes. `speech_speak`/`speech_stop` share the existing meeting
command channel; acts.v1 consumers ignore unknown actions, and legacy Speak/Stop stay valid.
The new bot parser accepts both protocols. Do not add fields to the frozen acts.v1 schema.

An owner opts in by adding UUID `command_id` to `POST /bots/{platform}/{native}/speak`.
The existing 4000-character/voice-enabled/active/owner checks apply. The response adds the
`PlaybackStatus` fields to `accepted`. A duplicate ID with identical text/voice/session does
not republish; changed input returns 409. One tracked speech command per meeting is allowed.
Receipt retention is ten minutes; the active reservation lasts 200 seconds. These are bounded
deduplication receipts, not durable exactly-once playback or a replay-after-expiry guarantee.

`GET /bots/{platform}/{native}/speak/{command_id}` returns `PlaybackStatus` through Gateway
under the same owner authorization, including retained receipts after the bot leaves the latest
meeting for that owner/platform/native ID. `DELETE .../speak?command_id=<UUID>` requests that command's
Stop. Acceptance is not a terminal playback acknowledgement. Stop before publication leaves a
cancellation tombstone, preventing a late matching Speak from being published.

The bot posts `PlaybackReport` to `/bots/internal/callback/speech` using its infrastructure
`x-internal-secret`; the receiver requires a configured secret and the command's recorded bot
session. This route is not exposed through Gateway. Redis CAS enforces queued -> started ->
completed, or queued/started -> failed/stopped, and immutable terminal states. `started` comes
from the local paplay process, and `completed` requires successful PCM playback and microphone
cleanup. This proves the bot playback substrate, not audibility at a remote meeting participant.
Callback delivery retries receipts only, never synthesis. Missing/expired receipts fail closed.

`PlaybackReport.played_text` is an optional bounded prefix for voice-assistant replies. While
started, it advances only after each complete sentence plays; a stopped receipt may carry the
same prefix. The receiver rejects non-prefix/regressing values and progress on manual commands.
Terminal receipts stay immutable. This is sentence-level local playback completion, not a claim
of remote audibility or word alignment. Older producers omit the field and retain their behavior.

The optional single-process coordinator has one operator-configured room and an explicitly
enrolled list of TINA user IDs. Each request validates the participant's own X-API-Key through
Gateway `/auth/me`; the client never supplies room, user ID, document paths or shared secrets.

- `POST /turns/{request_id}` reserves capture (201), returning `TurnStatus`.
- `PUT /turns/{request_id}/audio` sends audio/wav (202), <=800000 bytes, 0.1–24 seconds,
  uncompressed mono PCM16 at 16 kHz. The UUID is stable across retries; changed audio is 409.
- `GET /turns/{request_id}` returns that participant's `TurnStatus`.
- `DELETE /turns/{request_id}` cancels that participant's turn. Capturing/waiting can stop
  immediately; possibly playing turns release only on a real terminal bot receipt.

Capture expires after 35 seconds, terminal receipts after ten minutes, and there are at most
256 retained turns. The process keeps no durable job/audio/text storage. Restart loses turns;
clients must not replay an ambiguous Speak automatically. ERROR/playback_unknown keeps the room
reserved until Stop is confirmed or an operator stops the bot and restarts/reconfigures the pilot.
Question endpointing is client-owned; source approval, grounded claims and room credentials are
coordinator-owned. All STT/agent/meeting calls use existing public HTTP seams.

The multi-client pilot additionally requires the [speech-room.v1](../speech-room.v1/README.md)
handshake and epoch/revision headers. This does not change the frozen playback or turn shapes.

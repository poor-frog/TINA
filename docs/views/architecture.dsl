# GENERATED from architecture.calm.json — do not edit (pnpm arch:dsl --write)

system meetings  # capture → transcribe → record; owns the raw transcript
  service bot
  service discord-connector
  service desktop
  service meeting-api
  service alignment-worker
  service mcp
  module buffer
  module capture-codec
  module gmeet-capture
  module gmeet-pipeline
  module jitsi-capture
  module join
  module mixed-capture-core
  module mixed-pipeline
  module record-chunker
  module recording
  module remote-browser
  module teams-capture
  module whisper
  module zoom-capture
  contract acts.v1
  contract captured-signal.v1
  contract flagged-issue.v1
  contract invocation.v1
  contract lifecycle.v1
  contract service-authority.v1
  contract transcript.v1
  contract webhook.v1
  service transcription
  data-asset segments-stream [writers: bot]
  data-asset tc-stream [writers: meeting-api]
  data-asset tc-mutable [writers: bot, meeting-api]
  data-asset bm-status [writers: meeting-api]
  data-asset u-meetings [writers: meeting-api]
  data-asset bot-commands [writers: meeting-api]
  database segments-table [writers: meeting-api]
  data-asset recording-blob [writers: bot, meeting-api]
  data-asset userdata-blob [writers: remote-browser, bot]
  data-asset transcript-document.v1
  data-asset transcript-alignment.v1
  data-asset asr-status.v1
  database desktop-journal
  data-asset transcript-refinement.v1
  data-asset transcript-revision.v1
  data-asset speaker-revision.v1
  data-asset canonical-transcript.v1
  data-asset meeting-memory.v1
  data-asset meeting-memory-revision.v1
  data-asset stt-foundation.v1
  data-asset stt-metrics.v1
  service transcript-sync
  service diarization-worker
  service tts-sidecar
  data-asset speech.v1
  data-asset speech-playback [writers: meeting-api]
  data-asset speech-room.v1
  service asr-control

system agent  # the execution domain: a trigger becomes one governed agent turn over a workspace.v1 git repo; owns no transcript
  service agent-api
  contract event.v1
  contract invoke.v1
  contract proactive-card.v1
  contract routine.v1
  contract task.v1
  contract tool.v1
  contract tool-approval.v1
  contract unit.v1
  contract workspace.v1
  service agent-worker
  data-asset meeting-wiki-entity
  data-asset out-stream [writers: agent-worker]
  data-asset unit-in
  data-asset va-chat
  data-asset meeting-knowledge-pages
  data-asset workspace-human-documents
  contract meeting-translation.v1
  database meeting-translation-cache [writers: agent-api]
  contract meeting-translation.v2
  data-asset discussion-review.v1
  data-asset discussion-reviews

system gateway-system  # the one public edge (api.v1, ws.v1)
  service conformance
  service gateway
  contract api.v1
  contract logevent.v1
  contract ws.v1

system identity  # access + audit; owns the durable DB
  service admin-api
  contract identity.v1
  data-asset identity-db [writers: admin-api]

system runtime-system  # workload spawn (bot/agent containers)
  contract runtime.v1
  contract schedule.v1
  service runtime

system deploy  # Deployment and execution-target registry. Local tina CLI/TUI shares Compose configuration, build/activation and readiness logic; operational mutations target the selected Docker context/project, preserve data volumes and support dry-run. Read-only full diagnostics resolve effective ASR through Identity and probe configured host/container health without inference. Allowlisted repository checks reuse existing gates and write private local logs. ASR configuration uses existing Identity global/account settings APIs with explicit scoped previews and secret-free output. Fresh local setup creates private configuration and new Compose-managed volumes, refuses existing configuration/resources and occupied ports, and reuses deployment plus optional ASR configuration/status verification; it does not install native capture or models. No user meeting/agent API client is added.
  contract execution-targets.v1
  contract config.v1

system service-authority-system  # optional operator-owned admission and active-service authority; absent in stock OSS and never owns billing policy inside core
  service service-authority

system system-webhook-system  # optional operator-owned terminal-event consumer; absent in stock OSS and never selected from customer or meeting data
  service system-webhook

system completion-provider  # the deployment or per-user model endpoint; may be tenant-hosted or an external provider. Groq uses Codex Responses at https://api.groq.com/openai/v1 for chat, DeepSeek uses the Claude Code Anthropic-compatible endpoint at https://api.deepseek.com/anthropic, and Gemini uses agy with its Gemini API-key provider. Their tool-less meeting jobs use OpenAI-compatible Chat Completions at the respective fixed Groq, DeepSeek and Gemini endpoints. The same masked per-user/platform provider credential selects both paths; TINA transcript API tokens remain separate.

system platform  # shared infra backing the services
  service redis
  database postgres
  service object-store

system flows  # the reaction engine; owns the reaction row and its effect receipts
  module flows-engine
  module flows-defs
  module flows-steps
  module flows-schema
  module flows-timeline
  service flows-api
  service flows-worker
  data-asset flows-rows
  contract flows.v1

system foreground-application  # User-selected local application with the focused text field; receives only the transcript pasted after the explicit dictation hotkey is released.

system speech-client  # Optional host speech CLI: per-microphone KWS, bounded pre-roll and Silero VAD question capture, explicit Start/Stop and participant-only credentials. Opt-in run/run-file sends bounded WAV to the single-room speech coordinator; ordinary listen/file remain local. Wake is activation, not authentication. Default TTS remains Truc Ly. Room-wide polling suppresses KWS/pre-roll while busy; stale status/boot changes disarm until explicit restart; idle requires 800 ms quiet.

edges:
  bot -write-> segments-stream
  bot -write-> tc-mutable
  meeting-api -read-> segments-stream  # Producer session_uid is retained durably for recording-to-segment mapping.
  meeting-api -write-> tc-mutable
  meeting-api -write-> segments-table
  meeting-api -write-> tc-stream
  agent-api -read-> tc-stream
  gateway -read-> tc-mutable
  terminal -read-> tc-stream
  terminal -read-> out-stream
  bot -write-> recording-blob
  bot -read-write-> userdata-blob  # restore session before launch (read) + write rotated session back on clean teardown (write)
  remote-browser -write-> userdata-blob  # provisioning login uploads the confirmed signed-in session
  gateway -read-> recording-blob
  bot -call-> transcription  # audio -> first-party STT via TRANSCRIPTION_SERVICE_URL; the local CPU stack reaches STT on the main TINA Compose network
  terminal-app -call-> transcription  # authenticated composer dictation -> selected STT via /api/stt with request IDs and capture-lag metadata; Docker Desktop routes host.docker.internal to loopback FunASR
  terminal-app -read-> transcription  # verified admin-only GET /api/admin/asr-status resolves selected backend and reads content-free asr-status.v1; no audio or transcript text; browser render timings remain local
  terminal-app -call-> agent-api  # after stop, the authenticated Terminal sends only final transcript text to /api/dictation/polish; raw text remains in the composer for restore and no chat history is written
  agent-worker -call-> completion-provider  # one-shot, tool-less CompletionPort call for the final transcript using effective per-user model settings; sends text only, never audio or chat history
  agent-worker -call-> completion-provider  # on meeting end, a tool-less CompletionPort summarizes surfaced cards only; it receives no raw transcript or filesystem tools
  agent-worker -read-> workspace.v1  # validate changed entity frontmatter against workspace.v1 before committing each writable mount
  agent-worker -write-> meeting-wiki-entity  # deterministically serialize the validated summary/cards and commit only kg/entities/meeting/{id}.md
  bot -read-> bot-commands  # SUBSCRIBE acts.v1 commands
  meeting-api -write-> bm-status  # PUBLISH status
  meeting-api -write-> u-meetings  # PUBLISH per-user status
  meeting-api -write-> bot-commands  # PUBLISH leave/speak
  meeting-api -write-> recording-blob  # S3 PUT stitched master
  meeting-api -write-> postgres
  meeting-api -write-> object-store
  meeting-api -req-> runtime  # POST /workloads spawn bot
  meeting-api -req-> admin-api  # GET /internal/calendar-configs discovers secret-gated calendar connections for sync and disconnect cleanup
  meeting-api -req-> service-authority  # optional signed service-authority.v1 admit/continue decision; unset is explicit OSS allow-all, configured failure is closed
  meeting-api -req-> system-webhook  # optional signed terminal webhook.v1 delivery to a boot-frozen operator destination; customer webhook SSRF policy remains separate
  agent-api -read-> segments-stream  # XREADGROUP agent_copilot (proactive watcher)
  agent-api -req-> runtime  # POST /workloads spawn agent-worker
  agent-api -read-> out-stream  # SSE relay (/api/chat, /api/meeting/stream)
  agent-api -write-> unit-in  # POST /api/chat/approval verifies the owner and session, then XADDs a one-call decision
  agent-worker -read-> tc-stream  # copilot tails transcript
  agent-worker -write-> out-stream  # XADD turn events, MCP approval requests and resolutions, cards, and notes
  agent-worker -read-> unit-in  # chat path XREADs prompts and matching owner decisions while Codex waits for MCP approval
  mcp -req-> gateway  # every MCP tool forwards the caller's X-API-Key to the public REST surface
  gateway -req-> meeting-api  # proxy /bots /transcripts /meetings /recordings and per-calendar sync
  gateway -req-> agent-api  # proxy /agent/*
  gateway -req-> mcp  # proxy /mcp — POST buffered, GET relayed unbuffered (SSE stream)
  gateway -req-> admin-api  # POST /internal/validate (authz oracle) plus user calendar connection CRUD
  gateway -read-> bm-status  # WS fan-out
  gateway -read-> u-meetings  # WS auto-subscribe
  gateway -read-> va-chat  # WS fan-out
  admin-api -write-> identity-db
  admin-api -write-> postgres
  terminal -req-> gateway  # all REST via gateway
  terminal -req-> gateway  # live WS via gateway
  dashboard -req-> gateway  # dashboard → gateway REST (hosted-compat aliases; the hosted-proven wiring)
  dashboard -req-> gateway  # dashboard → gateway /ws (live transcript view)
  slim -req-> gateway  # Python client; REST via gateway
  extension -req-> gateway  # read-only authenticated Bot transcript list and exact-row snapshots
  extension -req-> desktop  # read-only Desktop archive listing and exact transcript snapshots; opens the saved review page
  flows-worker -write-> flows-rows
  flows-api -write-> flows-rows  # the second writer, recorded because it is real: POST /events admits a fact in the API process (flows_integrations/flows_api.py → flows.admit → INSERT INTO reaction) and the registry writes flow_version there too. The chart carried only flows-worker, so the one shared carrier in this domain read as single-writer
  flows-api -read-> flows-rows
  flows-worker -req-> agent-api  # steps reach domains only over their published HTTP surfaces (core/flows/src/flows_steps/common.py) — a domain never knows flows exists
  flows-worker -req-> gateway
  flows-worker -req-> admin-api
  native-capture -write-> desktop  # TINA Capture connects to loopback :9099, verifies a per-user HMAC challenge proof, then sends capture.v1 named PCM frames through the launcher proxy to Desktop's ephemeral loopback ingest port. Dual-source capture defaults to Speex AEC plus residual suppression: channel 999 is system audio, channel 1002 archives original mic without ASR, and channel 1000 sends derived mic to ASR. Runtime =0 overrides can disable AEC or residual suppression. Missing sample-index.v1, failed DSP initialization or unavailable reference falls back to original mic. Stop closes ingest and finalizes the existing pipeline. The local token is not the Gateway API key.
  native-capture -write-> foreground-application  # holding Fn captures microphone-only audio through the existing Desktop ASR path; on release, TINA copies the final transcript to the system clipboard and sends Command+V to the focused local application. No screen context is read.
  desktop -call-> transcription  # bounded WAV windows from Desktop to selected loopback STT via TRANSCRIPTION_SERVICE_URL; native profile uses :18001, alias custom; original VAD segment offsets return on the same transcription contract
  desktop -req-> admin-api  # Internal-secret POST /internal/transcription/resolve at new capture-session admission; optional user API key resolves personal preference, otherwise platform default. Selected STT URL/token stay inside Desktop; clients receive only safe backend metadata. Existing sessions retain their selection.
  native-capture -req-> desktop  # Loopback-only GET /transcription/config for safe next-session ASR metadata and GET /transcripts for captured-session results; no provider credentials cross to the native client.
  native-capture -call-> desktop  # After Fn dictation stops, TINA Capture sends only the final raw transcript to Desktop's loopback-only :8057 polish proxy. The proxy uses the server-held TINA_DESKTOP_API_KEY; when the Agent API or CompletionPort is unavailable the client retains and inserts raw ASR.
  desktop -call-> agent-api  # Desktop forwards final transcript text only to Gateway POST /agent/dictation/polish under the bound user's API key; audio, raw transcript and credentials are never placed in the native client request to the Agent API.
  native-capture -call-> desktop  # Live Translation sends only confirmed transcript text and a target language to the loopback Desktop translation proxy. The result is a presentation-only caption sidecar; it does not write ASR, canonical transcript, revision history or audio.
  desktop -call-> agent-api  # Desktop forwards confirmed transcript text and target language to Gateway POST /agent/dictation/translate using the server-held API key. Agent runs a tool-less CompletionPort job; the translation is not persisted.
  native-capture -read-> desktop  # Loopback-only WS /ws subscription per captured meeting (platform desktop, native_id tina-native-<uuid>) carrying transcript.v1 confirmed/pending frames for the overlay and floating subtitle window; reconnect failures never stop audio capture and are not written back.
  desktop -req-> desktop-journal  # Desktop persists source PCM once per captured frame, confirmed ASR and correction history on the local owner boundary. Owner review highlights token changes, filters changed segments and plays source clips next to proposals. Corrections atomically update revision history, current-text FTS and a metadata-only durable outbox. Speaker CAS writes append speaker-revision.v1 in the same SQLite transaction. Canonical and exact-quote candidate memory are owner projections over finalized accepted text and identities, not client-derived data.
  meeting-api -call-> alignment-worker  # Owner-triggered post-meeting MFA job sends only the verified segment WAV and its raw ASR text to a token-authenticated loopback worker; model, source hashes and word timings return to the owner-only alignment view.
  meeting-api -req-> gateway  # After a correction or word-alignment transaction commits, replay metadata-only transcript.revised events from meeting JSONB to the owner user channel and authorized meeting channel. Clients refetch exact transcript and alignment snapshots on changes/reconnect. Speaker assignments use the same transaction/outbox/channel flow with speaker-revision.v1; audio and raw ASR remain unchanged. Canonical/memory projections use the same owner-scoped durable outbox (meeting-memory-revision.v1); clients poll the memory snapshot while open and refresh transcript on revision events.
  transcript-sync -read-> desktop  # Owner-triggered GET /transcripts/{platform}/{native}/foundation after capture stops; stt-foundation.v1 contains references, not PCM.
  transcript-sync -call-> gateway  # Authenticated owner GET/PUT /transcripts/by-id/{row}/replicas/{meeting_uid}; expected_revision and immutable source history protect the meeting.data replica.
  meeting-api -call-> discord-connector  # POST/GET/DELETE /workloads on the connector's runtime.v1 surface: a Discord spawn creates one in-process voice session whose WorkloadSpec.env carries the invocation.v1 document; stop is confirmed (left, flushed, terminal lifecycle emitted).
  discord-connector -write-> segments-stream  # XADD transcription_segments with transcript.v1 segments; one named lane per speaker, session_uid = invocation.connectionId
  discord-connector -write-> tc-mutable
  discord-connector -read-> bot-commands  # SUBSCRIBE acts.v1 commands; only `leave` is served in this increment
  discord-connector -call-> transcription  # decoded per-speaker PCM -> first-party STT via the invocation's TRANSCRIPTION_SERVICE_URL
  desktop -call-> diarization-worker  # Owner-triggered post-meeting speaker analysis sends saved system audio to the token-authenticated loopback worker; bounded acoustic turns return as proposals. Authority retains raw audio/text and applies identities with revision protection.
  meeting-api -call-> diarization-worker  # Owner-triggered post-meeting speaker analysis sends saved system audio to the token-authenticated loopback worker; bounded acoustic turns return as proposals. Authority retains raw audio/text and applies identities with revision protection.
  desktop -call-> alignment-worker  # Owner-triggered post-meeting batch sends verified capture PCM16 and accepted text to the existing authenticated loopback MFA worker. Exact tokens, duration, model and source hashes are validated; revision-safe timing is a derived owner projection, never a text rewrite.
  meeting-api -write-> canonical-notes-requests  # Canonical source snapshot -> isolated tool-less CompletionPort -> meeting-row source/lease CAS -> approved derived view.
  agent-api -read-> canonical-notes-requests  # Agent API verifies the request proof and owner-scoped lease before dispatching a trusted canonical worker; untrusted event prompts cannot select this path.
  agent-worker -write-> canonical-notes-results  # Only a proof-and-lease-verified dispatch enters the canonical worker; it binds job user_id to TINA_OWNER before publishing results.
  meeting-api -read-> canonical-notes-results  # Canonical source snapshot -> isolated tool-less CompletionPort -> meeting-row source/lease CAS -> approved derived view.
  meeting-api -write-> canonical-notes-approved  # Canonical source snapshot -> isolated tool-less CompletionPort -> meeting-row source/lease CAS -> approved derived view.
  agent-api -read-> canonical-notes-approved  # Canonical source snapshot -> isolated tool-less CompletionPort -> meeting-row source/lease CAS -> approved derived view.
  agent-api -req-> meeting-api  # Owner-scoped GET meeting and canonical transcript for bounded evidence-backed Q&A and manual post-meeting discussion reviews; each source is reauthorized, and there are no transcript writes.
  agent-api -write-> meeting-knowledge-pages  # Persist private answer/source snapshots and explicitly reviewed create-only Wiki pages; no overwrites.
  terminal -read-> meeting-knowledge-pages  # Through existing authenticated Gateway workspace proxy: related docs, bounded multi-meeting answers, source-meeting quotes/audio, freshness warnings and revision-guarded fact reviews.
  agent-api -write-> discussion-reviews  # Manual owner request -> private read-only unit.v1 worker -> validated classification -> canonical recheck -> locked compare-and-swap report publication.
  terminal -read-> discussion-reviews  # Authenticated Gateway proxy: agenda form, exact quoted evidence, classifications and stale-state display; no client classification.
  dashboard -read-> discussion-reviews  # Dashboard adapts the same owner-only review protocol through its authenticated Gateway proxy.
  agent-worker -call-> completion-provider  # One tool-less CompletionPort call per chronological window, with explicit agenda, target-window VI/EN text and earlier transcript context only; optional native JSON Schema output where supported, followed by worker/API validation and source-checked evidence. Records actual model identity; sends no audio or unrelated files.
  agent-api -write-> workspace-human-documents  # Authenticated explicit Markdown edit and optional selected-path local commit; owner and content preconditions are enforced in the control plane.
  bot -call-> tts-sidecar  # Existing owner-authorized Speak commands make the voice-enabled browser bot send text to TTS_SERVICE_URL/v1/audio/speech with X-API-Key. PCM is resampled by the optional sidecar to 24 kHz and played by the unchanged PulseAudio virtual microphone path; speak_stop aborts request and playback.
  speech-client -req-> speech-coordinator  # Participant-authenticated bounded WAV and turn status; no shared service secrets on clients. Authenticated speech-room.v1 occupancy polling plus epoch/revision capture fencing; all hosts pause wake dispatch during a shared turn.
  speech-coordinator -req-> gateway  # Operator-scoped meeting/Wiki APIs and correlated Speak/Stop; participant auth/me.
  speech-coordinator -req-> transcription  # Bounded consented question WAV including up to two seconds wake pre-roll; existing authenticated OpenAI-compatible STT.
  bot -req-> meeting-api  # Internal-secret-authenticated speech.v1 receipts bound to the recorded bot session.
  meeting-api -write-> speech-playback  # Meeting API alone owns the ephemeral Redis playback state.
  agent-api -write-> meeting-translation-cache  # Owner-scoped SQLite phrase cache, live-tail observations and job leases; every HTTP access first reauthorizes canonical transcript and meeting status.
  terminal-app -call-> agent-api  # Authenticated English/bilingual view reads and advances the shared translation overlay; original ASR remains independent.
  extension -call-> agent-api  # Meeting Bot viewer requests the same gateway-authorized translation cache; provider secrets remain server-side.
  terminal-app -call-> asr-control  # Authenticated account-only ASR start/stop and safe resource status through Terminal proxy; private derived host key.
  asr-control -call-> admin-api  # Internal account preference CAS and aggregate enabled demand; no user list or credential projection.
  asr-control -call-> transcription  # Authenticated real audio readiness and derived-key drain fencing before owned process/container stop.
  bot, agent-worker deployed-in runtime
  gateway, meeting-api, agent-api, admin-api, runtime, redis, postgres, object-store, transcription, asr-control deployed-in deploy
  flows-api, flows-worker deployed-in deploy

flows:
  live-transcript-flow: bot-writes-segments-stream -> collector-reads-segments -> collector-writes-tc -> aw-tcnative
  discord-transcript-flow: ma-discord-connector -> dc-stt -> dc-writes-segments-stream -> collector-reads-segments -> collector-writes-tc
  native-live-translation-flow: native-capture-desktop -> native-capture-desktop-live -> native-capture-live-translation -> desktop-live-translation
  dispatch-flow: aa-runtime -> workers-deployed -> aw-unitout -> aa-unitout
  meeting-wiki-flow: agent-worker-meeting-summary-completion -> agent-worker-validates-workspace-entity -> agent-worker-writes-meeting-entity

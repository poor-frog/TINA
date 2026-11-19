# agent-api — the agent control plane (Python)

## Meeting questions and reviewed Wiki pages

The existing authenticated workspace proxy exposes these owner-scoped routes:

- `GET /api/workspace/meeting-knowledge/{meeting_id}`: linked private Markdown documents and the latest 20 answers with freshly checked source status.
- `POST .../{meeting_id}/ask`: `{question, documents: []}`. Read canonical segments from Meeting API, optionally include explicitly selected linked files, select at most 40 excerpts / 48,000 text characters and dispatch a private, tool-less worker using the owner's model configuration. Partial coverage is explicit.
- `GET .../{meeting_id}/answers/{answer_id}?slug=`: recheck one answer, including from an authorized mounted workspace when opening its Wiki page.
- `POST .../{meeting_id}/answers/{answer_id}/apply`: explicit approval creates `wiki/meetings/{meeting_id}/{answer_id}.md`. Retries are idempotent; an edited existing page is never replaced.

Private immutable answer/source snapshots live under `.meeting-knowledge/{meeting_id}/` in the private primary workspace. The model can reference only supplied source IDs; quotations, identities and timestamps come from the server. This validates source identity, not whether every generated claim follows logically from its citations. Missing evidence produces no savable claims. Source fingerprints include text revision, speaker revision, timing and audio references; selected document edits also invalidate citations. Apply checks freshness immediately before writing, but Meeting API and the filesystem do not share a distributed transaction. Saved Wiki pages recheck their sources when viewed.

This first slice creates new pages in private workspaces. It does not merge existing Wiki pages, search across meetings, add embeddings, commit Git history, or synchronize native Desktop SQLite automatically.

## Purpose

The agent domain's HTTP front door and the one place dispatches turn into runtime spawns. It
mirrors the `runtime/` kernel api: it never runs an agent in-process — it builds a `unit.v1`
*now*-dispatch, hands it to the Dispatcher (which spawns the sandboxed worker via `runtime.v1`),
and RELAYS the dispatch's output Stream back as SSE. It carries `/api/chat`, the `/invocations`
sink, `/api/routines`, `/events`, the `/api/meeting/*` live-copilot surface, `/api/workspace/*`
reads, the in-process `transcription_watcher`, and the in-container worker (`serve` / `serve_meeting`).
Python because the agent domain is the LLM/tooling + runtime ecosystem (P13).

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | gateway / terminal | `POST /invocations` | a `unit.v1` dispatch → one `runtime.v1` agent spawn |
| consumes | gateway / terminal | `POST /api/chat` (SSE), `/api/chat/reset`, `GET /api/sessions` | a chat now-dispatch; SSE view of `unit:<id>:out` |
| consumes | any integration | `POST /events` | an `event.v1` → `unit.v1` (carried plan) → dispatch |
| consumes | terminal | `POST /api/routines`, `GET /api/routines`, `DELETE /api/routines/{id}` | a `routine.v1` → a `schedule.v1` cron job |
| consumes | bridge / terminal | `POST /api/meeting/{start,bot,stop}`, `GET /api/meetings/live`, `GET /api/meeting/stream` | launch/stop a live-meeting copilot; SSE merge of transcript + copilot out |
| consumes | terminal | `GET /api/workspace/{tree,file,git}` | workspace tree, file content, git state |
| calls | runtime kernel | `runtime.v1` (Dispatcher → RuntimePort) | the worker container `env` (repo URL + scoped token) |
| calls | gateway / meeting-api | `POST /bots`, `DELETE /bots/{platform}/{native_id}` | forward our self-hosted bot in/out of a meeting |
| consumes | self-hosted bots | redis stream `transcription_segments` | live segments, tailed by `transcription_watcher` |
| publishes | terminal / `serve_meeting` | redis stream `tc:meeting:{uid}` | per-meeting transcript wire (drafts + finals) |
| spawns-over | runtime kernel | `runtime.v1` agent profile | `agent-meet-{uid}` copilot, re-armed on transcript activity |

## Contracts

**Owns:** `core/agent/contracts/unit.v1`, `event.v1`, `invoke.v1`, `routine.v1`, `tool.v1`,
`task.v1`, `proactive-card.v1`, `workspace.v1` (the agent domain's contracts).
**Consumes:** `core/runtime/contracts/runtime.v1` + `schedule.v1`, `core/meetings/contracts/transcript.v1`,
`core/identity/contracts/identity.v1`, `core/gateway/contracts/api.v1`. Schemas are read by path and
jsonschema-validated — never importing neighbour code. All sealed in `contracts.seal.json` (repo root).

## Isolated evaluation

```bash
uv run pytest -q        # uv manages this package's own venv/deps
```

`tests/` spans L1 contract-consumer (`test_contracts_consumer.py`) · L2 unit with faked ports
(`test_api.py`, `test_routines.py`, `test_events.py`, `test_tools.py`, `test_worker.py`,
`test_chat_runner.py`, `test_config.py`) · L3 integration over real git + a real Claude loop
(`test_real_git_workspace.py`, `test_github_vcs.py`, `test_agent_llm_loop.py`).

## Status

- ✅ delivered — `/invocations` dispatch sink → `runtime.v1` spawn
- ✅ delivered — `/api/chat` SSE relay of `unit:<id>:out`, `/api/chat/reset`, `/api/sessions`
- ✅ delivered — `/api/routines` CRUD → `schedule.v1` cron jobs
- ✅ delivered — `/events` generic ingress (`event.v1` → `unit.v1`)
- ✅ delivered — `/api/meeting/{start,bot,stop,stream}`, `/api/meetings/live` live-copilot surface
- ✅ delivered — `transcription_watcher`: fan `transcription_segments` → `tc:meeting:{uid}` + spawn copilot
- ✅ delivered — `/api/workspace/{tree,file,git}` reads
- ✅ delivered — in-container worker (`serve` / `serve_meeting`)
- ✅ delivered — multi-session chat: real conversation threads keyed `agent-{subject}-chat-{session}`
  (default `main`, back-compat), per-thread continuity file (`.claude/sessions/{session}.session`,
  `main` migrates from the legacy `.claude/.session`), and a durable redis-backed session index
  (`/api/sessions` newest-first, `/api/chat` upserts, `/api/chat/reset` drops thread + continuity).
  All threads live in the ONE user workspace (conceptually `type: user`).
- ✅ delivered — workspace-driven meeting-copilot config: `agents/meeting.md` (the per-agent config
  home — a VISIBLE, git-governed file, seeded from the workspace template) steers the live copilot —
  `enabled`, `model` (allowlisted), `cadence_segments`, `card_kinds`, `write_meeting_doc`, plus a
  natural-language steering body merged into the prompt. Parsed by `agent_config.load_meeting_config`
  with per-key fallback to code defaults (absent file ⇒ all defaults). `agents/` is extensible to
  chat/routines configs ⬜ planned.
- ✅ delivered — workspace skills: governed `skills/<name>/SKILL.md` (a VISIBLE, git-tracked tree,
  seeded with one example) symlinked into `.claude/skills` per turn so the isolated worker's `claude`
  auto-discovers them. `agents/` + `skills/` are the two per-workspace agent-extension homes. Skill
  helper scripts run under the turn's existing `--allowedTools` grant (no separate skills gate).
- ⬜ planned — multi-workspace (company/service tiers — a FUTURE axis beyond the single user workspace)
- 🟡 partial — in-memory live-meeting registry (redis-backed adapter pending)
- ⬜ planned — GET /api/meetings (proxy meeting-api + merge live registry)
- ⬜ planned — a session_end doc-binding write turn
- ⬜ planned — WS publishers (u:{user_id}:meetings on registry add/stop/drop, u:{user_id}:workspace on commit)

## Explicit human review and document edits

`GET/PUT /api/workspace/document` reads UTF-8 text and permits explicit edits only in private writable content Markdown paths. PUT requires `expected_sha256` of the loaded file (null creates a new file), validates entity frontmatter where applicable, serializes through the existing workspace write lock and replaces the file atomically. Optional `commit:true` makes a selected-path local Git commit without publishing. Protected control/config paths and shared workspace writes are refused. The existing model harness has its own write lifecycle; the content precondition is not a global lock against every external filesystem writer.

`POST /api/workspace/meeting-knowledge/{meeting_id}/facts/review` accepts `{fact_id, expected_fingerprint, expected_revision, status, text}`. Status is approved/discarded/pending. It reads owner-scoped Meeting Memory and canonical source, compares exact quotes/revisions/speakers/times, preserves prior reviewed items whose source disappeared as stale, and stores the human display decision separately in `.meeting-knowledge/{meeting_id}/reviews/{fact_id}.json`. Reviews use atomic replacement and the workspace lock. Canonical memory is not modified. GET meeting-knowledge includes these candidates/reviews; bounded answer generation still excludes unrelated meetings.

The image bakes SHA-256-pinned multilingual-E5-small INT8 ONNX/tokenizer assets and MIT notice for local CPU voice retrieval. Only the control-plane dependency group includes ONNX Runtime, Tokenizers and NumPy. Native setup: `python -m control_plane.voice_retrieval --download`; `TINA_VOICE_EMBED_DIR` selects the model directory (image default `/opt/tina/voice-retrieval`). Missing/corrupt assets log a content-free warning and retain BM25 until process restart.

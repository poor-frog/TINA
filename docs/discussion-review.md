# Discussion Review — Option A

## Use

Open a **completed** meeting. In Terminal, expand **Tools** above the transcript and select
**Discussion review**; in Dashboard, select **Discussion review** beside the transcript.
Enter the meeting objective/agenda, then choose **Tạo đánh giá thảo luận**. The saved
review includes that agenda; editing the draft requires generating again to apply the change.

The tool-less LLM classifies chronological transcript windows, one call per window, predominantly
Vietnamese with English technical terms. Each call sees the current exchange and earlier context,
not later turns. Explanations are requested in Vietnamese and non-CJK explanations are rejected
for one correction attempt. Each exchange shows:

| Task | Classes |
|---|---|
| Relevance | relevant / useful tangent / off scope / uncertain |
| Interaction | constructive disagreement / personal hostility / sarcasm / dismissive address / threat / uncertain |
| Progress | advancing / exploring / repeating unresolved positions / uncertain |

Interaction supports multiple labels; an empty list means no listed signal was detected.
`uncertain` is exclusive. The rubric distinguishes technical disagreement and consequences from
personal attacks/threats, and productive exploration from stalled repetition. It evaluates exchanges,
not participant reputation. This text-only version does not infer vocal emotion.

Expand the cited speaker/time entries to see exact text, text revision and segment ID. Audio playback
uses the existing authenticated segment-audio route when source audio is available and the report is
current. Reports include the actual model name and the fixed `discussion.vi-en.v1` rubric version.
Classification quality, especially sarcasm and Vietnamese pragmatics, needs evaluation on labeled
meetings; schema/reference checks establish structural validity only.

## Bounds and consistency

- Explicit manual request; no automatic analysis or live alerts.
- One request includes the entire nonblank finalized source, up to **200 segments / 24000 transcript
  characters / 20 windows**. Windows target 60 seconds or 3000 characters at segment boundaries.
  A longer individual segment remains intact. Oversized input returns 422; nothing is silently dropped.
- Windows are processed chronologically. Each call sees the target window and earlier context, never
  later turns. Relevance/interaction evidence must be from the target window; progress may cite
  earlier windows. Repetition needs at least two distinct turns.
- The model is asked for schema-shaped JSON; adapters use native JSON Schema output settings where
  supported. The worker and API validate the response and evidence regardless. Invalid/unavailable
  model output is an error, never a fabricated `uncertain` classification.
- Each window call allows 180 seconds for local model startup/inference. The total relay deadline
  scales with the window count up to 15 minutes. The UI keeps the previous saved report when
  generation fails.
- The API authorizes the meeting/canonical source on every read and before saving. Source changes
  reject delayed publication or mark saved results stale on the next read. This is cross-store
  freshness checking, not a distributed database transaction.
- The latest report and its agenda are stored atomically at `.discussion-reviews/{meeting_id}.json`
  in the caller's current private writable workspace, using the existing workspace lock and an
  `expected_id` compare-and-swap. Other workspaces have their own reviews. These are private derived
  snapshots like meeting Q&A; removing meeting access makes them unavailable through this API.

## Configuration and deployment

Use the existing **Models** settings or deployment `TINA_LLM_PROVIDER`, `TINA_LLM_BASE_URL`,
`TINA_LLM_MODEL` and server-side credentials. No new model installation, service, environment variable
or database migration is needed. Rebuild Agent API, agent-worker, Gateway and the client images to
ship the change. Runtime workers must use the rebuilt worker image.

Inference stays behind `CompletionPort`, making a future AWS adapter independent of the review UI
and contract. Agenda and bounded transcript text go to the configured model endpoint. No audio,
chat history or unrelated workspace documents are sent. Payloads use the existing private job path,
short-lived output stream and sanitized error logging.

## API

Gateway paths (internal Agent API uses `/api/` instead of `/agent/`):

- `GET /agent/discussion-reviews/{meeting_id}` → `{report, stale, can_generate}`.
- `POST /agent/discussion-reviews/{meeting_id}` with
  `{"agenda":"Choose a retry strategy for payment service","expected_id":null}` → the same state.
  For replacing a report, supply its current ID. Identical source/agenda/rubric returns the saved
  report without another model call.

Owner access is derived from gateway identity. Live meetings or conflicting revisions return 409;
empty/oversized input returns 422. Failed inference uses the existing sanitized 5xx completion errors.
Both clients adapt the same `discussion-review.v1` result; neither derives classifications locally.

## Verification

- Agent tests: `cd core/agent && uv run --frozen --group dev pytest -q tests/test_discussion_review.py`
  (the existing workspace lock requires a POSIX environment).
- Gateway tests: from `core/gateway/services/gateway`, `uv run --frozen pytest -q tests/test_agent_proxy.py`.
- Terminal behavior: from `clients/terminal`, `pnpm exec vitest run src/surfaces/__tests__/discussionReview.test.tsx`.
- Contract: `node core/agent/contracts/discussion-review.v1/validate.mjs`.
- Real local model + browser smoke test: follow [the Compose Option A instructions](../deploy/compose/README.md#option-a-real-model-browser-smoke-test).

Tests use injected completions; they do not assert real-model accuracy or require provider credentials.

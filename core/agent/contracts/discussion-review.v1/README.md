# discussion-review.v1

Option A: a manual post-meeting text classification using the existing CompletionPort. The agent
owns this derived review; Meeting API remains authoritative for the canonical transcript.

- `Classification` is the requested model JSON: one ordered result per supplied window.
- `Report` adds server-owned agenda, model/rubric provenance, canonical revision, source fingerprint
  and exact source quotes. A model cannot supply or rewrite these quotes.
- Relevance and progress are single-choice. Interaction is multi-label; `[]` means no listed
  signal and `["uncertain"]` must stand alone. Runtime validation additionally rejects unknown,
  future or out-of-window references and incomplete coverage. Repetition needs distinct source turns.
- No numeric confidence is inferred. Valid JSON/evidence references do not prove semantic accuracy.

See [Discussion Review](../../../../docs/discussion-review.md) for operation, limits and endpoints.
Validate goldens with `node core/agent/contracts/discussion-review.v1/validate.mjs` from the repo root.

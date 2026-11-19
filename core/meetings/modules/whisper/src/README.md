# whisper/src

Front door [`index.ts`](index.ts). [`transcription-client.ts`](transcription-client.ts)
is the HTTP client to transcription-service; [`confidence.ts`](confidence.ts) is the
pure low-confidence filter (pinned by `confidence.test.ts`); [`log.ts`](log.ts) is the
host-injectable logger.

`continuityPrompt` in the shared client file is the live callers' two-second minimum for inherited
context. `continuity-prompt.test.ts` checks sample-rate/boundary behavior, unchanged PCM/results,
explicit refinement prompts and held unexpected-language output. It does not filter matching text.

Optional `queue_ms` is read only from valid bounded `Server-Timing: asr_queue;dur=...` responses.
`server-timing.test.ts` checks missing/malformed headers stay absent and raw text stays unchanged.

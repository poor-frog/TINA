# Dashboard tests

Run `pnpm --dir services/dashboard test` from the repository root. Tests cover the
Dashboard adapters, interaction state and transcript presentation without live API keys.

Transcript review coverage includes token diffs and draft revision preservation.
`test_transcript_quality.test.ts` renders source/proposal evidence, checks the distinction
between text-only and text/quiet-audio warnings, and verifies legacy-job presentation.
Quiet-frame energy is advisory and never presented as proof of absent speech.

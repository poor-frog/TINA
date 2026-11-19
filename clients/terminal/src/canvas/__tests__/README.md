# canvas tests

Unit tests for the meeting canvas text-processing layer. These tests pin cleanup, tag selection, chaptering, and note-shaping behavior.

- `meetingTranslation.test.tsx` covers exact-source/revision phrase pairing, one English result per group,
  edited-member invalidation, growing Vietnamese tails, recording playback, dropdown changes,
  API retry and isolation when navigating between meetings. It verifies continued advancement
  past a retrying phrase, no automatic POST for exhausted phrases, explicit recovery, per-phrase
  original-text fallback and owner-wide quota/auth hints. Network calls are mocked.
- `meetingCanvasDefaultView.test.tsx` checks the **Song ngữ** dropdown default, then explicitly
  chooses **Tiếng Việt** to verify that existing original/processed switching and AI-note actions
  retain their behavior.

From the repository root:

```bash
pnpm --dir clients/terminal test src/canvas/__tests__
```

`meetingHealthBanner.test.tsx` checks compact notice disclosure, retained issue dismissal and
no notice for a healthy feed. Existing canvas/translation/playback tests protect the original
filtering, model-request and audio-target behavior while the reading layout changes.
The banner tests also cover hiding a duplicate ended notice without hiding live disconnects.
`meetingCanvasDefaultView.test.tsx` verifies that recap tools open and close without starting
processing or losing the transcript, and distinguishes empty ended meetings from waiting live feeds.

voiceSourceNavigation.test.tsx covers authorized document navigation, current/other transcript reveal, once-only hints and hidden/reloaded/unmounted/stale views.

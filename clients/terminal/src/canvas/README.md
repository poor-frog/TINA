# canvas

Harnessed Meeting Canvas runtime for terminal-side generated React views.

Meeting Bot transcripts offer one language dropdown above search with **No Translate · Bản gốc**,
**English** and **Song ngữ**; **Song ngữ** is selected by default. The original-only
option does not request translation.
English/bilingual requests the shared `meeting-translation.v2` overlay through the existing
authenticated proxy. Exact accepted source text is retained separately from display cleanup
so edits cannot attach a stale translation. Each pair preserves speaker/time and recording
playback. Backend-owned groups join source fragments into one original/English phrase.
The live tail shows **Đang gom câu…** until a sentence boundary or stable pause; stopping
the meeting flushes it immediately. Missing translations retain Vietnamese; errors expose
retry without stopping ASR. Editing any member invalidates its entire English phrase.
Phrase failures show their own waiting/manual-retry state; other phrases continue advancing.
The poller honors `can_advance` without stopping GET updates. Quota/auth/configuration/service
cooldowns have specific recovery hints, and explicit retry bypasses cooldowns without redoing
successful translations. Known canonical revisions are checked even if source words are unchanged.
The meeting info rail starts collapsed to leave more space for paired paragraphs.

Translation files:

- `MeetingTranslation.tsx` owns the language selector, status/retry controls and cancellable overlay polling.
- `translationGroups.ts` projects backend phrase boundaries onto exact source IDs/text; it does not choose translation boundaries or call a model.
- `MeetingCanvasView.tsx` selects the display mode, applies phrase-aware search/speaker filtering and passes paired content to `LiveTranscriptEngine.tsx`.
- `types.ts` and `useMeeting.ts` retain exact accepted `sourceText` alongside display cleanup so stale English is rejected after edits.

Existing original/processed transcript switching is available in **Tiếng Việt** mode. Provider
failure affects the English overlay only. See the [canvas tests](__tests__/README.md) and
[backend contract](../../../../core/agent/contracts/meeting-translation.v2/README.md).

Public surface:
- `runtime.tsx` renders validated `views/meeting.tsx` source.
- `kit.tsx` exports the theme-locked `ui` component vocabulary.
- `useMeeting.ts` and `actions.ts` expose the live meeting feed and sanctioned side effects.

This folder may depend on terminal surfaces for existing meeting/workspace data seams, but generated
views may only use the injected harness globals and `ui.*` kit.

Meeting memory, speaker identities and transcript review use their native dialogs directly,
without an `aria-hidden` clipped ancestor. Their triggers still use the existing open refs;
centering, bounded scrolling and shared controls are scoped in
`../surfaces/meetingDialogs.module.css`. No meeting-data or API behavior changes.

## Transcript reading layout

`MeetingTranscript.module.css` scopes the reading toolbar, status notices and bilingual phrases.
The toolbar separates heading/meeting info, search/speaker/language controls, translation status
and the existing memory/speaker/review actions. Its query-container class is defined in the
same CSS module as the queries so scoped container names agree across builds. Container queries follow the canvas pane width,
including a resized Workbench pane, instead of relying only on browser width. Long transcript
lines use a bounded reading width; English overlays have a quiet tinted block. Original text,
backend grouping, filtering, playback targets, translation polling and retry payloads are unchanged.
`MeetingHealthBanner.tsx` keeps the health headline visible and places the underlying issue in a
native Details disclosure; existing error dismissal and health predicates remain unchanged.

For ended meetings, recording playback sits inside the transcript toolbar, and **Tools**
expands the existing memory, speaker-identity and transcript-review actions on demand.
Search, speaker filtering and language selection remain visible. When the meeting page's
recap header already displays the end state, the canvas omits the duplicate ended banner;
live connection and error notices are retained. Recording loading/failure messages use
the same playback area. Audio loading, seek targets and all action payloads are unchanged.
An empty ended meeting says no transcript is available rather than waiting for new speech;
the live waiting state and empty search results keep their separate messages.

Raw transcript segments preserve accepted source text, stable speaker keys and speaker status.
The English overlay keeps its exact-source pairing while speaker corrections and live draft
updates retain the same identity and original wording.

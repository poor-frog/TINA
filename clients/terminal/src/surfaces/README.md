# surfaces

Meet launch actions share `meetingId.ts` for URL normalization. A Google Meet code or link
produces `https://meet.google.com/<code>`, matching the Dashboard's native-id join destination;
browser account selectors and tracking queries are not forwarded to the Bot. Zoom, Teams and
Jitsi retain their original link for passcode and deployment context. A successful Bot request
means requested; Google Meet host admission is still a separate lifecycle state.
The meeting header labels joining and waiting states explicitly; only `active` is displayed as Live.

Settings → ASR status (`asrStatus.tsx`) is admin-only and reads the selected ASR service's bounded,
content-free diagnostics through `/api/admin/asr-status`. It distinguishes missing samples,
unsupported backends, unconfigured endpoints and unreachable services; browser frame timings
stay local to the current page.

Settings → Models (`settings.tsx`) renders provider-specific model lists through
`modelCatalog.ts` + `modelPicker.tsx`: the picker asks the provider for the credential's live
model list (`/api/models/catalog`) and falls back to short built-in suggestions while that request
is unavailable. **Custom model…** keeps newer or account-only IDs reachable. Thinking uses Auto
for every provider, with no manual selector. Known text-only models are disabled for Chat model
and remain selectable for Meeting model. Groq's credential test checks a function call, its
matching result, and the final reply through the worker's compatibility adapter. The test below the form is
disabled while the form is dirty: it probes the SAVED config, so testing before Save would report
the previous provider.

One contributed module per surface. Each file `registerSurface`s its activity-bar item + view(s) (and
optional `onSubmit`/commands); `index.tsx` is the barrel whose import triggers registration. The shell
(`../workbench/`) renders whatever is registered — adding a surface is a new file + a barrel import,
never an edit to the shell (P2/P6). Real today: `chat` (MVP0), `workspace` (MVP1), `tasks` + `routines`
(MVP2). Placeholders (Live/Inbox/Calendar) keep the activity bar complete until their MVP.

**`workspace.tsx` is the live-collaboration surface** — the KNOWLEDGE panel (full workspace tree, the
`_system` key toggle, cross-workspace search), per-mount sections, the aggregated SOURCE CONTROL
RECENT ACTIVITY feed (email-attributed, clickable files), the "new updates" nav badge
(`updatesBadge.ts` + the Workbench poll), doc auto-reload + one-click **Changes** diff, README
auto-pin on shared connect, and the Share/invite dialog (single-rank). The end-to-end model is in
**[`docs/docs/core/workspaces.mdx`](../../../../docs/docs/core/workspaces.mdx)**.

**Calendars are plural** (`calendarConnections.tsx`, the plural `/user/calendars` API — see
[`docs/docs/api/calendar.mdx`](../../../../docs/docs/api/calendar.mdx)). An account holds up to ten
named ICS connections, each with its own `enabled` flag, auto-join policy and bot name. There is ONE
manager — Settings → Calendar (list · add · rename · replace feed · pause · disconnect · sync-one);
the Meetings rail popover (`meeting.tsx`) and the first-run card (`meetingsOnboarding.tsx`) are the
point-of-need skins over the same API and defer everything else to Settings. Three invariants the
tests pin: the feed address is **write-only** (the API returns `ics_url_set` + a recognition mask, and
no input is ever prefilled from the server), the ten-connection cap is stated in the UI rather than
arriving as a surprise 409, and a write that changes what gets joined (`auto_join` · `bot_name` ·
`enabled` · a replaced `ics_url`) is followed by the per-calendar sync that reconciles
already-imported meetings — a rename is not, because it changes nothing downstream.

**Error presentation is part of the surface contract** — surfaces render `presentError(e)`
(`apiClient.ts`), never `e.message`: the headline is user vocabulary ("Couldn't reach the TINA
server…", the backend's own prose reason verbatim when it sent one), while the untranslated
plumbing string stays on the operator channels (the returned `detail` and a `console.warn`). The
raw idiom `e instanceof Error ? e.message : String(e)` is banned from surface files by
`__tests__/errorPresentation.guard.test.ts`. State-bearing controls (the meeting header's
Stop/Send bot) additionally follow the live ws.v1 connection (`useLiveMeetingsConnection`):
disconnected → indeterminate/disabled, never an actionable control derived from a stale snapshot.

## Meeting dialogs

Dialog backdrops blend the semantic background token with transparency, so they follow
the active theme and satisfy the palette guard without component-level hex colors.

`meetingDialogs.module.css` scopes the shared native-dialog presentation used by
`MeetingMemory.tsx`, `SpeakerRegistry.tsx` and `TranscriptReview.tsx`. Dialogs center in the
viewport, keep the title and Close action visible, and scroll only their bounded content area.
Labels stack above full-width controls; buttons, disabled states, evidence disclosures and
long source identifiers follow the Terminal theme in light and dark mode.
`useMeetingDialogEscape.ts` captures Escape while a dialog is open so closing it cannot
also trigger workbench Back navigation; native focus handling is retained. Speaker identity
editing appears before optional recording analysis. Meeting memory can filter out windows without suggestions; turning the filter off
restores all conversation evidence. Fetching, polling, save/refinement/analysis payloads and permission rules are unchanged.

Verify with `pnpm --dir clients/terminal exec tsc --noEmit` and the existing
`meetingMemory.test.tsx`, `meetingDialogs.test.tsx` and `transcriptReview.test.tsx` suites. Visually check all three dialogs at
wide and narrow viewport sizes, including long evidence lists, empty/error/loading states,
Close/Escape, speaker selection and transcript filtering/editing.

`meetingPage.module.css` lays out the existing meeting title, metadata and lifecycle actions,
using container queries so the header wraps within a resized Workbench pane. `meeting.tsx`
retains the same status derivation, permissions and Ask/Stop/Share handlers.
Ended meetings show a compact end status in the metadata row. `meetingWhenLabel` replaces
cached live-only labels with the saved start time when available, and otherwise omits that
placeholder; it does not invent a timestamp. The existing recap badge and lifecycle actions
remain available, with recording playback presented in the canvas toolbar.

TranscriptReview adds owner-triggered Check audio and Refine flagged segments for
bot recordings, with a current-revision quality filter and readable advisory reasons.
Checks have no ASR cost; selective refinement retains explicit audio comparison/Apply.

Failed bot refinement items show safe service-specific reasons. Retry failed segments
submits the latest job ID, keeps saved vocabulary and successful proposals, and is
disabled during active work. No automatic retry or model selection is added.

Review transcript -> Refinement options includes **Optimize quiet audio**, off by
default and disabled during work/live meetings. Only ASR start requests include the
opt-in; Check audio still measures the original and retry sends only the saved job ID.
Proposals explain whether limited gain was used or why original audio was retained.
The audio player always uses the original recording for owner comparison.

`transcript-quality.tsx` presents the meetings-owned source/proposal checks separately.
It explains text-only cues versus cues coinciding with mostly quiet audio, with
optional original RMS/quiet-frame/clipping details. These never assert absent speech.
The review filter includes a flagged second-pass suggestion at its exact source
revision, even when source text was unflagged. Stale evidence is hidden after edits;
after Apply only evidence matching the applied proposal/revision remains visible.
Legacy jobs without text/proposal checks remain readable. Apply stays explicit.

Meeting voice labels distinguish assistant replies from meeting evidence, general knowledge and public web.

Voice assistant settings separate Voice, Behavior and Meeting tasks. The persistent Save changes/Discard footer handles account voice, pronunciations and new-bot defaults together; Apply to meeting saves only that room’s revision-checked source policy. Tabs retain edits and support arrow, Home and End keys.

The Settings navigation uses shared brand tokens, sentence-case groups, icon-and-label rows and a checked current selection. Search and admin-only ASR visibility stay in SettingsBody; visual hover and keyboard focus live in settingsNavigation.module.css.

Agent model settings group the provider and ChatGPT connection above paired chat/meeting model controls. The account-switch explanation is collapsible; reconnect, logout, callback handoff and masked credential partial updates retain their existing API behavior. Styling is scoped in agentModelSettings.module.css.

VoiceReplySources displays fresh owner-authorized evidence under voice replies. Source reads revalidate every five seconds while expanded, abort on meeting changes/unmount, and clear quotes on permission/outage failures; transcript anchors and existing document navigation open originals.

MeetingVoiceDrafts presents editable, owner-only voice task/decision proposals inside MeetingKnowledge. Review needs a fresh owner read and explicit confirmation; task publication refreshes the Tasks list through tina:tasks-changed.

Voice handoffs use the existing chat action with `composeOnly` and a dedicated session: reveal the rail, preserve any existing draft, and prefill for review. Handoff chat skips ambient UI grounding; Agent API resolves current owner context on each turn.

Voice drafts have twenty-item pages with older/newer navigation. Counts explicitly describe the visible page; edits or in-flight saves block navigation, and switching meetings starts on page1. Review by draft ID is independent of the list page.


Voice assistant → Meeting offers named Project sources. Choose sources once, save a name, then
select that profile and Apply to meeting in another room. Room source options can override project defaults without editing the saved
profile; Save as project sources creates a new immutable selection. Remove profile revokes its
room references. Public web permission and automatic public web selection are separate switches.


Voice assistant → Meeting → Answer agent selects Sandbox agent or Direct LLM. Newly created
voice-capable meetings use Sandbox agent; saved legacy policies remain selectable. Sandbox source
tools are executed and checked by TINA, and its CLI cannot directly access account workspaces.

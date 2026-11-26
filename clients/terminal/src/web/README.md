# web — TINA Production User UI Shell

End-user production interface mounted at `/` and `/meetings/[meetingId]` alongside the developer
TINA Terminal workbench at `/terminal`.

## Architecture
- **Pre-Login Landing & OAuth Gate (`TinaLanding.tsx` + `HeroMeetingScene.tsx` + `tinaLanding.module.css` mounted by `src/app/AuthGate.tsx`)**:
  Editorial neo-brutalist warm-paper pre-login showcase tailored to TINA (Google/Microsoft OAuth,
  first-run admin claim, dev `@example.test` debug login, interactive multi-layer animated Hero
  meeting scene with clickable teammates & rolling TINA bot, bilingual VI+EN live transcript & Voice
  TTS preview, self-hosted architecture overview, platforms/models matrix, and FAQ), strictly
  isolated via CSS Modules with self-contained artwork in `public/landing/`.
- **Scoped CSS (`tina-web.css`)**: All layout, dark/light theme tokens, and Terminal-to-Web CSS
  variable bridges live under `.tina-web` and `.tina-login-shell` so Tailwind and Dockview styles
  in `/terminal` remain completely isolated.
- **Zero duplicate backend logic**: Reuses `server.mjs` (`/ws`), `/api/*` proxies, `AppGates`
  (auth/invites/setup/onboarding), `useLiveMeetings`, `MeetingCanvasView` (live transcript +
  bilingual translation + audio), `LiveAssistRunningView` + `liveMeetingStateApi`, `MeetingKnowledge`,
  `SpeakerTalkTimePanel` (computed from `fetchDurableTranscript`), `streamChatTurn` + `/api/chat/approval`,
  `RoutinesBoard`, `SharedWorkspacesPanel` (`workspaceApi`), and the real Settings panels
  (`CalendarConnectionsPanel`, `ModelsSection`, `VoiceSettings`, `TokensPanel`, `GitHubTokenCard`, `AsrStatusPanel`).
- **Meetings Notebook (`MeetingsView.tsx` + `meetingsFilter.ts`)**: Date-grouped list (Live Now,
  Upcoming by day, Recorded by day), multi-dimensional Filter popover (date range, platform,
  participants, duration, recording), row `•••` action menu (Rename via `POST /api/meetings/{id}/annotate`,
  Share session, Copy link, Ask TINA, Delete, bot actions); global Split-Button `Capture ▾` lives in
  `TopBar.tsx`.
- **Meeting Workspace (`MeetingDetailView.tsx` + `MeetingSmartSearch.tsx` + `MeetingSidePanel.tsx` + `MeetingBottomPlayer.tsx` + `meetingDetail.module.css`)**:
  3-column + bottom-player detail workspace: dedicated breadcrumb top bar (`#My Meetings / <code> •••`,
  inline Rename, Share session, BotControls, Enable live assist), left **Smart Search** rail (real AI
  Filters, Discussion Review / transcript metrics, interactive Speaker Talk Time with WPM & share rings,
  Topic Trackers), center **Notes / AI Skills / Action Items / Live Assist** document (AI Executive
  Summary, checklist, Chapters & Outline timeline from real processed notes, one-click grounded AI Skills,
  and mounted TINA power tools), right **Ask Tina / Transcript** panel (streaming meeting-scoped chat,
  source-cited Wiki `MeetingKnowledge`, bilingual VI/EN translation, chronologically interleaved
  `TINA Agent` Voice TTS replies from `/api/meetings/{id}/voice-assistant` with expandable
  `VoiceReplySources` citations, search & audio-synced rows), and docked bottom studio audio scrubber.
- **Ask Tina (`AskTinaView.tsx`)**: Full-page SSE assistant with real MCP Tool Approval cards
  (`/api/chat/approval`), Copy & Share response actions, searchable `/api/sessions` history,
  meeting pre-grounding, `@`-mention picker (`#451`), shimmering thinking state (`#453`), connected
  agent task-step timeline (`#454`), morphing tool approval card (`#455`), morphing voice dictation
  pill (`#457`), and real `/routine` prompt compilation.
- **Lucian micro-interaction layer (`lucian/`)**: Ported MIT primitives from Lucian UX/UI Prompt
  bridged onto TINA's dark/light palette (`lucianTokens.css`), including the global stacked toast
  deck (`#435` `LucianToastStack` + `webToast.ts`) mounted in `WebApp.tsx` and the circular-reveal
  dark/light mode toggle (`#219` `LucianThemeToggle`) mounted in `TopBar.tsx`.
- **Knowledge Hub (`KnowledgeView.tsx` + `knowledgeFriendly.ts` + `constellationGraph.ts` + `KnowledgeDocEditor.tsx` + `KnowledgeCopilotDrawer.tsx` + `KnowledgeGraphCanvas.tsx` + `knowledgeView.module.css`)**:
  Notion-style, non-tech-friendly Knowledge library mounted directly at `/?nav=knowledge` (with URL
  deep-linking `?nav=knowledge&ws=&doc=&tab=` and Back/Forward reading history), uniting Private
  spaces (`My Space`), Team Spaces (owner/contributor direct editing, uploads, AI access switch &
  share invite links), and the read-only `Templates & Guides` (`_global`) library. Opens to a clean
  **Library Overview** dashboard with compact Space Picker dropdown, single unified smart Search,
  topic-based sidebar (`Pages & Notes`, `Meeting Notes`, `Projects`, `People`, `Tasks`, `Uploaded
  Files`), single-bar reading view (with TOC Outline, `Mentioned in` backlinks, Meeting Source
  Provenance, and Uploaded File summary cards), YAML-free clean Page Editor (lossless frontmatter
  patching + Vietnamese-safe slugging + visual `Link page` picker + `[[` autocomplete), inline Ask
  Tina drawer, 60fps HTML5 Canvas **Constellation Knowledge Graph** (force-directed glowing star-map
  default covering entities, regular pages, Markdown/`[[wikilinks]]`, `#tags`, and All Spaces, plus
  a `Display` settings popover and optional **Columns** layout switcher), and **Activity & Settings**
  with collapsible `Advanced · GitHub Sync`. Includes a subtle `Developer view` toggle (OFF by default)
  to expose raw file trees, Markdown/YAML, and Git diffs.
- **Personal / Team Settings (`SettingsView.tsx` + `WebModelsPanel.tsx` + `webModelsPanel.module.css`)**:
  Two-column hub with URL query sync (`?nav=settings&settingsWorkspace=personal|team&settingsSection=<id>`),
  ordered for everyday workflows first (Meetings, AI & Voice, Preferences/Account, then Developer &
  Connections). Includes a 3-card live **Active AI Overview** strip (Chat & Knowledge AI, Meeting &
  Voice AI, Speech to Text), 3-step elevated cards with tactile rounded provider tiles using official
  `/provider-logos/*.svg` marks, stale-model reset on provider switch, inline OAuth/API-key/Bedrock/Custom
  authentication, secret reveal toggle, paired `ModelPicker`/`ChatGPTModelInput` fields, sticky unsaved
  Save & Test bar, Dark/Light appearance switching (`useTheme`), Team workspace/member/invite management,
  and admin-only Deployment sections. Set `NEXT_PUBLIC_HIDE_MODEL_SETTINGS=1` (build-time and/or runtime
  container env surfaced by `/api/auth/me`) to hide both **AI Models & Transcription** (Personal) and
  **Global Defaults** (Team) on `/` while keeping model controls available in `/terminal`. The Web
  **Voice Assistant** section mounts `<VoiceSettings voiceOnly />` so everyday users get a clean tactile
  voice-preset picker + preview without operator tabs (full Voice/Behavior/Meeting controls remain in `/terminal`).
- **Dev/Admin bridge**: Shows an "Open TINA Terminal" shortcut and permits `/terminal` routes only
  when `/api/admin/me` (`requireAdmin()`) confirms administrator access (or `NEXT_PUBLIC_SHOW_TERMINAL_SWITCH=1`
  / local dev override), independently of `WorkspacePilotUserIds` so non-admin users get full Web Chat,
  Knowledge, Tasks, and Routines without exposing `/terminal`.

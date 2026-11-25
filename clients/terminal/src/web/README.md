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
  Share session, Copy link, Ask TINA, Delete, bot actions), and Split-Button `Capture ▾` in both
  `TopBar.tsx` and `MeetingsView.tsx`.
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
  meeting pre-grounding, and real `/routine` prompt compilation.
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
  Hallmark `modern-minimal` AI Provider & Auth flow (hairline-ruled provider matrix using official
  `/provider-logos/*.svg` marks, flat inline OAuth/API-key/Bedrock/Custom authentication band,
  secret reveal toggle, paired `ModelPicker`/`ChatGPTModelInput` fields, Save & Test verification status),
  Dark/Light appearance switching (`useTheme`), Team workspace/member/invite management, and admin-only
  Deployment sections.
- **Dev/Admin bridge**: Shows an "Open TINA Terminal" shortcut only when `/api/admin/me` confirms
  admin/dev access (or `NEXT_PUBLIC_SHOW_TERMINAL_SWITCH=1` / local dev override).

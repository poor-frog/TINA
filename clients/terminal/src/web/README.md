# web — TINA Production User UI Shell

End-user production interface mounted at `/` and `/meetings/[meetingId]` alongside the developer
TINA Terminal workbench at `/terminal`.

## Architecture
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
- **Ask Tina (`AskTinaView.tsx`)**: Full-page SSE assistant with real MCP Tool Approval cards
  (`/api/chat/approval`), Copy & Share response actions, searchable `/api/sessions` history,
  meeting pre-grounding, and real `/routine` prompt compilation.
- **Personal / Team Settings (`SettingsView.tsx`)**: Two-column hub with URL query sync
  (`?nav=settings&settingsWorkspace=personal|team&settingsSection=<id>`), Dark/Light appearance
  switching (`useTheme`), Team workspace/member/invite management, and admin-only Deployment sections.
- **Dev/Admin bridge**: Shows an "Open TINA Terminal" shortcut only when `/api/admin/me` confirms
  admin/dev access (or `NEXT_PUBLIC_SHOW_TERMINAL_SWITCH=1` / local dev override).

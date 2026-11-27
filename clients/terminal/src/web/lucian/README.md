# `src/web/lucian/`

Ported micro-interaction primitives from the [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) library (MIT License), mapped onto MeetTina's Obsidian Teal (dark) and Porcelain Teal (light) theme tokens.

## Contents

### Theme Bridge
- `lucianTokens.css` — Bridges `--ux-*` tokens and `.ux` base rules (box-sizing, focus-visible, `prefers-reduced-motion` clamp) to TINA's dark/light palette.

### Package 1 — Chat AI, Toasts & Theme
- `webToast.ts` + `LucianToastStack.tsx` + `lucian-435.css` — `#435` Stacked toast notification deck with auto-dismiss progress bar, hover fan-out/pause, swipe-to-dismiss, and optional Undo.
- `LucianThemeToggle.tsx` + `lucian-219.css` — `#219` Circular-reveal dark/light mode switch synced with `src/app/theme.ts`.
- `LucianThinkingText.tsx` + `lucian-453.css` — `#453` Shimmering AI thinking status indicator with rotating star and expandable live progress trace.
- `lucian-454.css` — `#454` Connected vertical agent task-step timeline styling used by `src/web/AgentActivitySteps.tsx`.
- `LucianToolApprovalCard.tsx` + `lucian-455.css` — `#455` Morphing MCP tool-call approval card (pending card → spinning pill → check or denied strikethrough).
- `LucianVoiceInputButton.tsx` + `lucian-457.css` — `#457` Morphing voice dictation pill with live waveform, blinking recording indicator, and elapsed timer.
- `LucianMentionPicker.tsx` + `lucian-451.css` — `#451` `@`-mention floating autocomplete picker with Vietnamese diacritic-insensitive search, `kind:query` filters, sliding selection pill, keyboard navigation, and backend context compilation for Meetings, Knowledge pages/files, Spaces, Tasks, People, and Schedule.
- `LucianSlashPicker.tsx` — `/` slash command floating picker & prompt compiler (`/research`, `/routine`, `/recap`, `/prep`, `/tasks`, `/draft`, `/schedule`, `/save`, `/new`) shared across `AskTinaView`, `KnowledgeCopilotDrawer`, and `MeetingSidePanel`.

### Package 2 — Meeting Workspace, Live Bot & Knowledge Hub
- `LucianDynamicIsland.tsx` + `lucian-459.css` — `#459` Live Activity Dynamic Island pill on `TopBar` for active bot meetings with live elapsed timer, dancing equalizer, swipe-to-cycle, and spring expand drawer.
- `LucianSelectionTooltip.tsx` + `lucian-220.css` — `#220` Selection quote-share floating tooltip for Meeting Transcript and Meeting Notes (`Ask Tina`, `Highlight`, `Copy quote`).
- `LucianVoiceOrb.tsx` + `lucian-458.css` — `#458` Multi-blob reactive AI voice orb displaying live TINA Voice Agent states (`idle`, `listen`, `think`, `speak`).
- `LucianReadAloud.tsx` + `lucian-476.css` — `#476` Word-by-word read-aloud karaoke highlight with morphing play/pause button and progress ring for Voice Agent replies and active playing transcript rows.
- `LucianChapterRail.tsx` + `lucian-195.css` — `#195` Segmented chapter timeline and clickable chapter rail drawer inside `MeetingBottomPlayer`.
- `LucianAudioLoopRegion.tsx` + `lucian-194.css` — `#194` Waveform loop region editor with draggable start/end handles wired to real `<audio>` looping in `MeetingBottomPlayer`.
- `LucianSpeakerDonut.tsx` + `lucian-097.css` — `#097` Interactive SVG speaker talk-time donut chart that pops slices on hover and smoothly re-splits remaining shares when speakers are excluded/included.
- `LucianUnsavedBar.tsx` + `lucian-250.css` — `#250` Sticky sliding unsaved-changes bar (`Unsaved changes: N`, Discard, Save with spinner & Saved confirmation) used in `KnowledgeDocEditor` and `WebModelsPanel`.
- `LucianSelectionFormatting.tsx` + `lucian-140.css` — `#140` Contextual Markdown selection formatting bar (`B`, `I`, `</>`, `[[ ]]`) with live `aria-pressed` indicators in `KnowledgeDocEditor`.

### Package 3 — App Shell, Navigation, Tasks & Pre-Login Landing
- `LucianCommandKButton.tsx` + `lucian-471.css` — `#471` 3D keycap `⌘K` / `Ctrl+K` trigger button on `TopBar` with sequential sink/spring animation, ripple, and modifier breathing prompt.
- `LucianCommandPalette.tsx` + `lucian-046.css` — `#046` Unfolding command palette in `GlobalSearch` with gliding highlight bar, query match `<mark>`, keyboard navigation, and theme toggle command.
- `LucianSlidingTabs.tsx` + `lucian-039.css` — `#039` Spring-gliding pill tabs with directional panel motion and arrow-key roving focus across `HomeView`, `MeetingsView`, `MeetingSidePanel`, and `TasksView`.
- `LucianTaskChecklist.tsx` + `lucian-014.css` + `lucian-093.css` — `#014` Progress-ring checklist with stroke-drawn check & strikethrough sweep paired with `#093` 8-dot burst, gradient progress bar, and canvas confetti completion celebration in `TasksView`.
- `LucianSkeletonCard.tsx` + `lucian-439.css` — `#439` Shimmering skeleton card lists (`row` and `chat` variants) for initial loading states across `HomeView`, `MeetingsView`, `TasksView`, and `AskTinaView`.
- `LucianAutomationFlow.tsx` + `lucian-201.css` — `#201` Interactive bilingual 4-node TINA meeting pipeline flow on `TinaLanding` with animated SVG connector dots and step timers.
- `LucianBentoGrid.tsx` + `lucian-214.css` — `#214` 5-tile living bento feature grid on `TinaLanding` with hover/focus mini-scenes (live typing, search bars, talk-time bars, security shield pulse, platform marquee).
- `LucianCursorGlowGrid.tsx` + `lucian-228.css` — `#228` Cursor-lit cross-gap spotlight card borders for the enterprise use cases grid on `TinaLanding`.
- `LucianGlowCta.tsx` + `lucian-211.css` — `#211` Rotating conic-beam & glow-border sign-up CTA section at the bottom of `TinaLanding`.

# `src/web/lucian/`

Ported micro-interaction primitives from the [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) library (MIT License), mapped onto MeetTina's Obsidian Teal (dark) and Porcelain Teal (light) theme tokens.

## Contents

- `lucianTokens.css` — Bridges `--ux-*` tokens and `.ux` base rules (box-sizing, focus-visible, `prefers-reduced-motion` clamp) to TINA's dark/light palette.
- `webToast.ts` + `LucianToastStack.tsx` + `lucian-435.css` — `#435` Stacked toast notification deck with auto-dismiss progress bar, hover fan-out/pause, swipe-to-dismiss, and optional Undo.
- `LucianThemeToggle.tsx` + `lucian-219.css` — `#219` Circular-reveal dark/light mode switch synced with `src/app/theme.ts`.
- `LucianThinkingText.tsx` + `lucian-453.css` — `#453` Shimmering AI thinking status indicator with rotating star and expandable live progress trace.
- `lucian-454.css` — `#454` Connected vertical agent task-step timeline styling used by `src/web/AgentActivitySteps.tsx`.
- `LucianToolApprovalCard.tsx` + `lucian-455.css` — `#455` Morphing MCP tool-call approval card (pending card → spinning pill → check or denied strikethrough).
- `LucianVoiceInputButton.tsx` + `lucian-457.css` — `#457` Morphing voice dictation pill with live waveform, blinking recording indicator, and elapsed timer.
- `LucianMentionPicker.tsx` + `lucian-451.css` — `#451` `@`-mention floating autocomplete picker with sliding selection pill, keyboard navigation, and bouncing mention chips for Meetings, Knowledge pages, and Spaces.

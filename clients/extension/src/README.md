# Extension source

- `viewer.ts` — transcript-first panel, source/meeting selection, transcript polling, translation orchestration, settings and destination links. The display-language dropdown defaults to **Song ngữ**; a compact language button reflects the effective display mode and opens/focuses the existing selector, and the translation notice is empty until a meeting is selected. Its state is separate from the retained capture-language setting.
- `bot-transcript.ts` — authenticated Bot and Desktop transcript list/snapshot readers; exact meeting identity validation, cancellation and retry.
- `transcript-feed.ts` — transcript turn renderer with scroll/text-selection preservation and one original/English pair per backend phrase in translated modes.
- `translation.ts` — authenticated `meeting-translation.v2` reads/advances through the Bot gateway, cancellation and retry; projects backend groups only when visible source members and known canonical revisions still match. Honors `can_advance` while continuing GET updates; explicit retry can bypass phrase/service cooldowns. Provider keys never enter the extension.
- `translation.test.ts` — grouped projection, stale text/revision rejection, authenticated shared-cache reads, independent phrase retry progress, no automatic POST for exhausted phrases or quota cooldowns, and explicit retry.
- `viewer-background.ts` — opens the Chrome side panel when the toolbar icon is clicked. It has no capture or network handlers.
- `sidepanel.html` — viewer/settings UI with a native, keyboard-accessible **Review a meeting** disclosure, collapsed by default, containing source, meeting and language selectors. The collapsed summary retains the selected meeting; the Transcript heading, effective-language shortcut, translation status and retry remain outside the expandable controls; compact header/footer and phrase spacing prioritize reading; expanding/collapsing leaves the existing viewer subscriptions and language mode intact.

`build.mjs` bundles only the viewer and its side-panel launcher. The older capture implementation files remain in the checkout for compatibility with existing source-level diagnostics, but the extension build and manifest do not ship or grant access to them.

Run `pnpm --dir clients/extension typecheck` and `pnpm --dir clients/extension test` from
the repository root. Build with `pnpm --dir clients/extension build`, then reload the installed
extension in `chrome://extensions`. See the [installation guide](../README.md).

Voice replies accept the additive assistant kind for fixed server-owned conversation and capability responses.

The footer beside Open Terminal shows a compact read-only voice indicator for Google Meet bots. It reuses the existing owner-scoped voice snapshot read, clears across source/meeting changes, and expires readiness after 15 seconds. It adds no capture permission or bot mutation.

Voice reply cards expose collapsed source evidence through the owner-only source endpoint. Only the expanded card polls fresh quotes; reset/meeting changes abort and clear evidence. Source links open the matching reply in Terminal. Source text is inserted as text, never markup.

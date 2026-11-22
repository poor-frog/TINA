# Extension source

- `viewer.ts` — transcript-first panel, source/meeting selection, transcript polling, translation orchestration, settings and destination links. The language selector beside **Transcript** defaults to **VI + EN** and controls transcript display and translation. Its state is separate from the retained capture-language setting.
- `bot-transcript.ts` — authenticated Bot and Desktop transcript list/snapshot readers; exact meeting identity validation, cancellation and retry.
- `transcript-feed.ts` — transcript turn renderer with scroll/text-selection preservation and one original/English pair per backend phrase in translated modes.
- `translation.ts` — authenticated `meeting-translation.v2` reads/advances through the Bot gateway, cancellation and retry; projects backend groups only when visible source members and known canonical revisions still match. Honors `can_advance` while continuing GET updates; explicit retry can bypass phrase/service cooldowns. Provider keys never enter the extension.
- `translation.test.ts` — grouped projection, stale text/revision rejection, authenticated shared-cache reads, independent phrase retry progress, no automatic POST for exhausted phrases or quota cooldowns, and explicit retry.
- `welcome.ts` / `welcome.html` — toolbar popup with Google sign-in, recent meetings and account settings.
- `viewer-background.ts` — brokers the authenticated session and resets the old sidebar-on-click behavior.
- `meet-content.ts` — mounts the movable TINA button and the floating Bot transcript panel on Google Meet.
- `meet-panel.ts` / `meet-panel.html` — reads the exact Google Meet Bot transcript and translation. Notes displays the saved Flow recap and still offers an on-demand summary with source links. Pins link to confirmed segments and support an optional label. They are stored in this extension profile by gateway, API key and meeting run. Only the segment ID, timestamp and label are stored locally. Footer actions send or stop the Bot and open Terminal.
  The cleaned transcript appears in Notes after the meeting ends and processed content is available.
- `sidepanel.html` — viewer/settings UI with one meeting panel for selected transcript meeting and active-tab Bot status/action. Its native **Review a meeting** disclosure retains the selector and refresh control; matching selected and active meeting IDs render once. The Transcript heading owns the language selector, with translation status and retry below it; expanding/collapsing leaves the existing viewer subscriptions and language mode intact.

`build.mjs` bundles the side-panel viewer, its launcher, and the Meet control/panel. The older audio-capture implementation files remain in the checkout for compatibility with source-level diagnostics, but the extension build does not ship or grant access to them.

Run `pnpm --dir clients/extension typecheck` and `pnpm --dir clients/extension test` from
the repository root. Build with `pnpm --dir clients/extension build`, then reload the installed
extension in `chrome://extensions`. See the [installation guide](../README.md).

Voice replies accept the additive assistant kind for fixed server-owned conversation and capability responses.

The footer beside Open Terminal shows a compact read-only voice indicator for Google Meet bots. It reuses the existing owner-scoped voice snapshot read, clears across source/meeting changes, and expires readiness after 15 seconds. It adds no capture permission or bot mutation.

Voice reply cards expose collapsed source evidence through the owner-only source endpoint. Only the expanded card polls fresh quotes; reset/meeting changes abort and clear evidence. Source links open the matching reply in Terminal. Source text is inserted as text, never markup.

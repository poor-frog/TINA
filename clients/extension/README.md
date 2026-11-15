# TINA Transcript Viewer

The Chrome extension can send TINA Bot to a supported meeting link in the active tab, read authorized transcripts, and request a saved English translation overlay for Meeting Bot rows. It does not record audio, request microphone or tab-audio access, open the Desktop ingest WebSocket, or auto-start bots.

## Vietnamese to English

Final Vietnamese transcript text shares the pure display formatter in
`packages/transcript-rendering/src/format.ts` with Terminal. It formats explicit quantities,
dates/times, phones and technical versions/codes without changing source rows or citations.
Drafts and ambiguous forms stay raw. The UI shows only formatted finals, with no original-ASR disclosure; source text remains unchanged underneath.
Translation cache validation still uses the exact raw source and revisions, and display formatting
respects the source members of a bilingual phrase. Reload the unpacked extension after rebuilding
`dist/`; rebuilding the Terminal container alone does not reload the Chrome extension.

The compact **Review a meeting** disclosure is collapsed by default. Open it to refresh the Bot
meeting list, choose a meeting or transcript language, and see the source: **Meeting Bot · TINA
Terminal**. The selected meeting is shown in its collapsed summary, with a chevron indicating that
the whole card opens the controls.
The Transcript heading has a compact language button that opens and focuses the existing
language selector; translation progress and retry stay visible below it. Collapsing the controls
does not stop transcript polling or translation. Expanded controls scroll within a bounded area
so the transcript remains accessible on short panels. Original text and lightly tinted English
blocks use separate visual levels in both light and dark themes. Empty meeting lists do not
show a translation loading message. Connection/capture details remain in Settings. The compact header, meeting card, phrase spacing
and footer leave more height for the transcript without removing controls or source text.

The language dropdown inside **Review a meeting** defaults to **Song ngữ** and offers
**Tiếng Việt**, **English** and **Song ngữ**. The same owner-authorized
agent cache serves Terminal and extension; provider credentials remain on the server and the
saved Meeting model performs tool-less text translation. `meeting-translation.v2` groups
consecutive finalized fragments of the same speaker into one phrase. The live tail shows
**Đang gom câu…** until a sentence boundary or stable pause; stopping flushes it immediately.
Both clients render the same backend boundaries with one English result per phrase. Reload the
extension after upgrading.

The original transcript remains visible when an English phrase is pending or unavailable.
Provider failures back off automatically; **Thử lại** explicitly retries. Edits invalidate only
the corresponding phrase. Reading above the live edge preserves the scroll anchor.
Translation inference advances while a translated view is open; closing all views pauses
new calls. Reopening resumes missing segments without regenerating cached translations.

## Transcript source

- **Meeting Bot · TINA Terminal** is the viewer's transcript source. The source card identifies it, and **Refresh meetings** reloads the list. Select a meeting to view exact-row snapshots, including drafts and accepted transcript edits. **Open Terminal** opens that meeting in TINA Terminal. A compact TINA voice status occupies the right side of the footer for Google Meet bots.

The viewer uses the existing Bot read endpoints. It sends the API key in the `X-API-Key` header,
refuses redirects, and clears a transcript when the server denies access. It stores the key and
endpoint settings in `chrome.storage.local`. Transcript snapshots are polled every 1.5 seconds
while selected; transient failures retry after 3 seconds.

## Send a bot from the active meeting tab

When the side panel is open on a supported Google Meet, Zoom, or Teams meeting URL, **Meeting link detected** appears with a **Send Bot** button. The button sends the current meeting URL and detected ID to the configured Meeting Bot gateway; no copy/paste into Terminal is needed. The API key must include the **Join meetings** (`bot`) scope. The bot may wait in the lobby for a host to admit it. Detection is URL-based, so it can appear on the pre-join/lobby page; it does not inspect meeting-page contents or verify that you have joined. The side panel itself opens from the extension toolbar action, not automatically when a tab navigates.

If the send request or Bot fails, the button becomes **Send Bot Again**. When a watched meeting ends, the panel returns to the meeting list and clears the transcript from view; the saved transcript remains available by selecting that meeting. The transcript follows new rows by default; scrolling up pauses following and shows **Latest transcript**.

## Settings

The settings page keeps the existing configuration fields:

- **API key** — account key used for Bot reads; sending a bot requires the **Join meetings** (`bot`) scope.
- **Deployment** — retained deployment profile.
- **Meeting Bot API gateway** — Bot transcript API, defaults to `https://tinabot.duckdns.org/extension-api`.
- **TINA Terminal URL** — meeting destination, defaults to `https://tinabot.duckdns.org`.
- **Capture server, Language, Auto-start** — retained for compatibility and shown inactive. This extension build cannot use these settings to capture audio.

Existing values are preserved when the extension is upgraded. A previously selected Desktop archive
source now opens the Meeting Bot list; legacy endpoint values remain stored but are no longer shown
or used by this viewer. For a standard local Compose deployment, set the Bot gateway to
`http://127.0.0.1:18056` and Terminal to `http://127.0.0.1:13000`. For the `tina-production` OrbStack project, set
the Bot gateway to `http://127.0.0.1:28056` and Terminal to `http://127.0.0.1:23000`. This build
grants HTTP access to loopback hosts and HTTPS access to `tinabot.duckdns.org`. Other HTTPS hosts
require a matching host permission in the manifest.

## Build and install

```bash
node build.mjs
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `clients/extension/dist`. The manifest grants storage, tabs, side-panel, loopback HTTP, and HTTPS access to `tinabot.duckdns.org`. It includes no meeting-site content scripts, tab-capture, microphone, offscreen, or ingest-WebSocket permissions.

Voice status shows fresh same-session recovery diagnostics for silent expiry, paused clarification, answer-service failure and failed audio. Rebuild `dist/` and reload the unpacked extension to load changes.

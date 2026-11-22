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

The unified meeting panel keeps the selected transcript meeting and the active-tab Bot action together. Open **Review a meeting** to refresh the list or choose another meeting. When both point to the same meeting, its identity appears once.
The Transcript heading has a compact language selector; translation progress and retry stay visible below it. Collapsing the controls
does not stop transcript polling or translation. Expanded controls scroll within a bounded area
so the transcript remains accessible on short panels. Original text and lightly tinted English
blocks use separate visual levels in both light and dark themes. Empty meeting lists do not
show a translation loading message. Connection/capture details remain in Settings. The compact header, meeting card, phrase spacing
and footer leave more height for the transcript without removing controls or source text.

The language selector beside **Transcript** defaults to **VI + EN** and offers
**Tiếng Việt**, **English** and **VI + EN**. The same owner-authorized
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

In the Google Meet overlay, a speaker can show the profile picture already visible in the current
Meet tab. The overlay matches the observed participant ID from TINA's speaker registry and falls
back to an initial when no exact match or picture is available. The Meet tab keeps observed pictures
in memory after a participant leaves, including when the overlay is closed and reopened. Changing
rooms or reloading the tab clears those pictures.

## Transcript source

- **Meeting Bot · TINA Terminal** is the viewer's transcript source. Select a meeting to view exact-row snapshots, including drafts and accepted transcript edits. The refresh control beside the meeting selector reloads the list. **Open Terminal** opens that meeting in TINA Terminal. A compact TINA voice status occupies the right side of the footer for Google Meet bots.

The toolbar icon opens a popup. Sign in with Google or choose **Use an API key** to see **My meetings**,
open recent meetings in Terminal, and manage the current account from the settings icon. Use a TINA API
key with transcript access (`tx`). Open **Options** from the toolbar icon's context menu to edit
the connection while signed out. For Google sign-in, Terminal verifies Gmail and links its subject
to the existing TINA account, then hands the extension a single-use PKCE code. The service worker
keeps credentials in extension-owned storage, and Gateway enforces the existing meeting permissions.
Signing out revokes the Google session or removes the saved API key locally, and clears the meeting
data from both extension views.

## In-call Google Meet panel

On a Google Meet room URL, the TINA button starts beside the meeting tools when the Meet extension slot
is available, with the left edge as a fallback. Click it to open the panel or drag it to move it.
The extension remembers its position across reloads. With the button focused, use the arrow keys to
move it and Home to restore the default. The floating panel shows the exact matching
TINA Bot transcript, VI + EN translation, processed Notes,
Bot status, and an explicit **Stop TINA Bot** action. Notes are read-only and keep their stale/source
status; the extension never enables note generation. Stop requests all active/retrying TINA Bot runs
for that exact Google Meet room; closing the panel stops its transcript and Notes watchers. The extension
reads Bot data and does not capture meeting audio, microphone input, or video. Chrome will ask to grant the extension access to
`meet.google.com`; reload the Meet tab after reloading the unpacked extension.

**Ask TINA** opens inside the Meet panel. It uses the confirmed transcript for the selected Bot
meeting and any linked documents you select. Answers and quotes share the meeting Q&A history
with Terminal. Confirm **Lưu vào Wiki** to create a Wiki page from a sourced answer.
**Bắt kịp 60 giây** summarizes confirmed transcript in the minute before the request or the
final minute of an ended meeting. It shows the window and latest confirmed timestamp.
Update Agent API along with the extension to use this action.
Ask TINA automatically uses the latest eligible answer as context for the next question. Follow-ups
use confirmed transcript from the same meeting. Clear the context beside the composer to ask
independently, or use **Hỏi tiếp** on an older eligible answer to change the reference.
Update Agent API and its meeting-knowledge worker image together with the extension for follow-up.
This needs an Agent API enabled behind the configured Gateway. If you use the AWS demo proxy,
deploy the updated Caddyfile to expose Meeting Knowledge operations to the extension.

In **Notes**, **Quyết định & Việc cần làm** refreshes confirmed transcript candidates during
the meeting. Open the source label to read the original quote. **Xác nhận**, **Bỏ qua**, and **Mở lại**
save the same review shown in Terminal. Reviews require current evidence and never create tasks.

## Send a bot from the active meeting tab

When the viewer is open in the side panel on a supported Google Meet, Zoom, or Teams meeting URL, it shows the active-tab Bot action beside the selected transcript meeting. If they are different meetings, the active tab is named separately. **Send Bot** uses the signed-in account and configured Meeting Bot Gateway. The bot may wait in the lobby for a host to admit it. Detection is URL-based, so it can appear on the pre-join/lobby page.

If the send request or Bot fails, the button becomes **Send Bot Again**. When a watched meeting ends, the panel returns to the meeting list and clears the transcript from view; the saved transcript remains available by selecting that meeting. The transcript follows new rows by default; scrolling up pauses following and shows **Latest transcript**.

## Settings

The settings page exposes these connection settings:

- **Account** — sign in with Google and confirm the Gmail account in Terminal.
- **Meeting Bot API gateway** — Bot transcript API, defaults to `https://tinabot.duckdns.org/extension-api`.
- **TINA Terminal URL** — meeting destination, defaults to `https://tinabot.duckdns.org`.

The addresses are selectable while signed in. Sign out to edit them.

Existing values are preserved when the extension is upgraded. A previously selected Desktop archive
source now opens the Meeting Bot list; legacy endpoint values remain stored but are no longer shown
or used by this viewer. For a standard local Compose deployment, set the Bot gateway to
`http://127.0.0.1:18056` and Terminal to `http://127.0.0.1:13000`. For the `tina-production` OrbStack project, set
the Bot gateway to `http://127.0.0.1:28056` and Terminal to `http://127.0.0.1:23000`. This build
grants HTTP access to loopback hosts and HTTPS access to `tinabot.duckdns.org`. Other HTTPS hosts
require a matching host permission in the manifest.

Set `TINA_GATEWAY_EXTENSION_ORIGINS` to the exact installed extension origins in both Terminal
and Gateway. Compose shares this setting. Helm deployments set it in `terminal.extraEnv` and
`gateway.extraEnv`. Use an instance-specific `NEXTAUTH_SECRET` of at least 32 characters and
register the existing Terminal Google callback URL. The public Terminal and Gateway must share
one HTTPS origin. A local stack can use two ports on the same loopback hostname.

## Build and install

```bash
node build.mjs
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `clients/extension/dist`. The manifest grants storage, tabs, side-panel, loopback HTTP, HTTPS access to `tinabot.duckdns.org`, and Google Meet page access for the in-call panel. It adds no tab-capture, microphone, offscreen, or ingest-WebSocket permission.

### Connect to local Compose

1. Use Node.js 22.13+ with npm. From the repository root, run `npm ci --prefix clients/extension`
   and `npm --prefix clients/extension run build`. Load `clients/extension/dist` and copy its ID
   from `chrome://extensions`.
2. Set `TINA_GATEWAY_EXTENSION_ORIGINS=chrome-extension://<id>` in the local Compose env. Run
   `make all` with [Google sign-in configured](../../README.md#set-up-google-sign-in).
3. Open **Options** from the extension's Chrome menu while signed out. Set **TINA Terminal URL**
   to `http://127.0.0.1:13000` and **Meeting Bot API gateway** to `http://127.0.0.1:18056`.
   If you use custom ports, copy the URLs printed by `make all` and use the same hostname in both.
4. Open the extension popup, choose **Sign in with Google**, and confirm **Connect extension**
   in Terminal with your Gmail account. Unpacked extension IDs can differ between installations.

Voice status shows fresh same-session recovery diagnostics for silent expiry, paused clarification, answer-service failure and failed audio. Rebuild `dist/` and reload the unpacked extension to load changes.

When an automatic bot retry is pending, **Cancel retry** cancels it through the same owner-scoped Stop
endpoint used by Terminal. After cancellation or exhausted retries, **Send Bot Again** starts a manual run.

Failed Meeting Bot attempts show the server-provided owner-only join diagnosis alongside the retry controls. Rebuild and reload the unpacked extension to receive UI updates; a join refusal is separate from voice playback failure.

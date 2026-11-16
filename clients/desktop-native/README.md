# TINA Capture

Tauri v2 shell with Rust audio capture for **macOS 15+ and Windows 11 (x64)**. Microphone and system
audio stay on separate channels. No screen frame handler is registered and no
screen images are saved.

The app has two surfaces:

- the **main window** — choose sources, start/stop, pause, toggle captions, read
  the transcript and save it as Markdown;
- a **floating overlay** — a Speakly-style detect, record and meeting-ended card
  that stays visible above other apps and never takes focus from the meeting.

Capture starts only after the user presses **Start** or **Record meeting**.
Detection is advisory and never starts capture by itself.

## Build and open

### Windows 11

Requires Rust's MSVC toolchain, Visual Studio C++ Build Tools, WebView2 and Node.js >=22.13.
Windows validation uses Node.js 24.22.3 LTS. Older Windows Node 24 releases, including 24.11.1,
can abort during process shutdown ([upstream issue](https://github.com/nodejs/node/issues/56645));
use an updated LTS runtime for Desktop and its tests.
From PowerShell at the repo root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter '@tina/desktop...' build
cd clients/desktop-native
npm ci
npm run build
```

The native executable is `src-tauri/target/release/tina-capture.exe`; the NSIS installer is
under `src-tauri/target/release/bundle/nsis/`. Local builds are unsigned.

Start Desktop in a separate PowerShell session before opening Capture:

```powershell
# Select the private local deployment config; never paste its contents into a terminal or chat.
$env:ENV_FILE = 'C:\private\tina.env'
# Only for the separate local CPU ASR deployment whose Docker-only hostname is transcription-api:
$env:TINA_DESKTOP_TRANSCRIPTION_URL = 'http://127.0.0.1:8083'
node deploy/compose/bin/desktop-local.mjs
```

Run the launcher from the repo root. `ENV_FILE` must be readable by the Windows user; a WSL config
can be selected by its `\\wsl.localhost\Ubuntu\home\<user>\.config\tina\.env` path. An encrypted
deployment file must first be loaded with Dotenvx or replaced by the existing private local config.
The host URL override affects only the deployment ASR backend. Personal/custom and managed backend
choices retain their configured endpoints and credentials. Do not change shared settings to a
loopback URL just to make Desktop work: Docker bots need their existing endpoint.

Windows uses WASAPI shared-mode conversion to mono 16 kHz. The default microphone and
process-excluding system loopback stay on separate source channels. The app verifies Desktop's
HMAC proof before opening audio devices. The ingest token lives at
`%LOCALAPPDATA%\local.tina.capture\desktop-ingest-token`, encrypted for the Windows user with DPAPI;
it is not a Gateway/provider credential.

Choose a source and press **Record meeting** or **Start dictation**. Capture never starts by itself.
Pause discards queued audio; resume preserves source-clock gaps. Closing the Windows main window
exits Capture and closes ingest. Exports go to Downloads and **Show in Explorer** reveals the file.
Windows does not provide the macOS Fn shortcut, automatic meeting detection, automatic paste or
Speex AEC in this version. Dictation copies text for manual Ctrl+V; use headphones for dual-source
recording. Microphone access failures link to Windows privacy settings. Device removal/clock reset
stops capture with an error; select the correct default device and start a new session.

Software tests do not establish microphone levels, echo quality or live ASR latency. Hardware
enumeration without recording is available with
`cargo test --manifest-path clients/desktop-native/src-tauri/Cargo.toml capture_windows::tests::windows_input_and_output_devices_are_available -- --ignored --exact`.
Start an actual recording explicitly to check audio on the target machine.

### macOS

Requires Rust, Node/npm, and a full Xcode installation (Xcode 16+) with the
macOS 15 SDK:

```sh
cd clients/desktop-native
npm ci
npm run build
open 'src-tauri/target/release/bundle/macos/TINA Capture.app'
```

If only Apple Command Line Tools are installed, linking can fail on missing
`swiftCompatibility` libraries. Point Cargo at Xcode explicitly:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
MACOSX_DEPLOYMENT_TARGET=15.0 npm run build
```

The app is locally ad-hoc signed, not a notarized/public release. Its bundle
identifier is `local.tina.capture`. Ad-hoc signatures are bound to a binary hash:
rebuilding can invalidate a previous permission even if Settings still shows its
switch as enabled. After a rebuild, quit the app, remove only its old entry from
Screen & System Audio Recording, add the current `.app`, enable it, and reopen it.
A stable Apple Development/Developer ID signing identity is needed to preserve
the same designated requirement across future builds; none is configured here.
It asks macOS for microphone and Screen & System Audio Recording access when
starting capture. If permissions were changed, quit/reopen the app. No permission
bypass is attempted. The hardened app includes
`com.apple.security.device.audio-input` in its signing entitlements as well as
`NSMicrophoneUsageDescription` in Info.plist. Both are required for macOS to
permit a microphone permission prompt.

## Capture experience

### Meeting detection

TINA reads CoreAudio process objects (`kAudioProcessPropertyIsRunningInput`) and
matches the bundle id against a small allowlist of meeting apps and browsers. No
audio samples or TCC grant are needed for detection. An app must hold the
microphone for **5 seconds** before the detect card appears, so device tests and
teardown blips do not raise a prompt. The card auto-closes after **15 seconds**
and **Not now** dismisses that specific microphone acquisition; a new call
surfaces again.

### Floating overlay

Speaker labels follow Desktop's accepted speaker registry. Saved transcripts →
Transcript review → Speaker identities provides name confirmation and per-segment
assignment, plus optional post-meeting system-audio diarization with separate
Apply. Acoustic groups stay unknown until named; native captions retain distinct
segments even when microphone and system speech share a timestamp. Speaker-only
updates preserve the current draft. See
[Desktop speaker mapping](../../deploy/transcription/diarization/README.md#desktop-speaker-mapping)
for source identity rules and analysis limits.

One transparent, always-on-top, non-focusable window is resized and repositioned
by Rust (`src-tauri/src/overlay.rs`):

| Mode | Size (logical px) | Contents |
| --- | --- | --- |
| detect | 460 × 138 | App name, source note, **Record meeting**, **Not now** |
| record | 420 × 152 | Elapsed clock, live meter, **Pause/Resume**, **Captions**, **Stop** |
| ended | 460 × 168 | Release notice, 15 s grace bar, **Stop & save**, **Keep recording** |

The record card keeps working while the main window is hidden. Closing the main
window hides it — an active session and the overlay continue. Click the Dock icon
(or Cmd+Tab to the app) to bring the main window back. The overlay is drag-enabled
and does not steal keyboard focus from the meeting.

### Meeting-end reminder

When a detected app releases the microphone for **5 seconds** while recording,
the overlay switches to **Meeting ended?** and starts a **15 second** grace bar.
**Stop & save** ends capture; **Keep recording** continues until the app returns.
If the grace expires, TINA keeps recording and suppresses the reminder until the
app takes the microphone again. Capture is never auto-stopped.

### Live captions

While a meeting session is recording, TINA subscribes to Desktop's `WS /ws` for
that meeting (`platform: desktop`, `native_id: tina-native-<uuid>`). Transcript
frames carry `confirmed[]` and `pending[]`; the native overlay keeps a rolling
window in memory and a separate subtitle window shows the last three confirmed
lines plus the pending line. Captions can be toggled from the overlay or the main
window, and the subtitle font size is adjustable. A socket failure never affects
audio capture, and the subscription retries while the session is active.

### Live Translation

The Live Translation screen starts the same `capture.v1` session as Meeting mode.
Choose Transcript or Subtitle output, select microphone/system-audio sources, and
optionally choose a target language. Confirmed original captions remain owned by
Desktop. When a target is selected, Capture sends confirmed text segments to the
loopback-only Desktop translation proxy; Desktop forwards text only through the
user's server-side TINA Agent CompletionPort. Translations live only in the
current capture process and subtitle presentation. They are never written to
the transcript journal, raw ASR, correction history, audio archive, or export.
Translation requires a bound `TINA_DESKTOP_API_KEY` and configured Agent model;
without them the original transcript and capture continue unchanged.

### Pause, resume and export

Pause drops captured frames, freezes the elapsed clock and zeroes the meter.
Resume continues the same Desktop session with a preserved timestamp gap.
**Save notes** exports the current Desktop transcript as Markdown to
`~/Downloads/TINA meeting <date> <time>.md` and offers **Show in Finder**.

## Local flow

ScreenCaptureKit supplies source sample rate, PCM format and media timestamps. Rust
checks the format, downmixes each source independently and resamples to 16 kHz with
sherpa's stateful anti-aliasing resampler. A shared media-clock anchor maps timestamps
to epoch milliseconds; this is an arrival-calibrated estimate, not a hardware-latency
measurement. A source gap resets its resampler and preserves the gap in timestamps.

Packets use the **existing capture.v1** binary codec: channel 999 `System audio`,
channel 1000 `You`, named headers with four-byte name padding. They go only to
`ws://127.0.0.1:9099/ingest`, platform `desktop`, session `tina-native-<UUID>`.
TINA Desktop must be running and returns `ready` before capture starts. Closing or
stopping the app closes ingest, which finalizes Desktop's transcript pipeline.

Audio → Desktop windowing → selected ASR `/v1/audio/transcriptions`
→ existing Desktop transcript API/WebSocket → transcript view in this app. Desktop's transcript store
remains in memory; export before restarting if it must be retained. The Tauri app
does not load another Qwen model, so it does not duplicate model RAM.

Start Desktop with `node deploy/compose/bin/desktop-local.mjs` to follow Terminal's central ASR
settings and authenticated native audio-ingest proxy. The launcher binds Desktop's ingest server
to an ephemeral loopback port and exposes the native port only after installing a per-user HMAC
challenge secret at `~/Library/Application Support/local.tina.capture/desktop-ingest-token`
(owner-only file permissions). TINA Capture verifies the server proof before requesting audio
permission or sending PCM; this secret is separate from Gateway credentials.
With no account binding, native capture follows **Global defaults → Transcription**;
an optional server-side `TINA_DESKTOP_API_KEY` follows that account's personal preference instead.
The app shows the selection for the next session while idle and the pinned selection while running.
Saving settings does not switch an active capture or start an ASR service. Service tokens stay in
Desktop/identity and never cross to this app.

The capture queue holds at most 128 packets and network writes time out after two
seconds. Pausing invalidates queued audio before any later send; stopping discards
the unsent queue tail instead of waiting to flush it. Dropped packets and capture
errors are visible in the app. Sources remain separate; system audio does not identify
individual remote participants. Speex AEC and residual echo suppression are enabled
by default when both microphone and system audio are selected. Normal builds include
the `speex-aec` Cargo feature. Track 1002 preserves raw microphone PCM in the Desktop
archive; only the derived microphone on track 1000 is sent to ASR. If no time-aligned
system-audio reference is available, that mic block passes through unchanged. An
older Desktop without sample-index.v1 or a DSP initialization failure also uses the
original mic. With residual suppression enabled, aligned blocks also use a stateful
70 Hz high-pass on both mic/reference and Speex denoising capped at -3 dB. Raw mic
and system audio remain unchanged in the archive. AGC and Speex VAD remain off;
microphone-only dictation does not enable these stages. No samples are gated out,
and output timestamps, sample indexes and lengths stay unchanged.

Capture Diagnostics reports actual processed blocks, bypassed samples, source mic
clipping and setup fallback reasons. AEC initialized with zero processed blocks is
shown as waiting for aligned audio, not as proof that echo was removed. Counters
survive pause/resume; pending pre-pause samples and DSP state do not.

Set `TINA_MIC_CLEANUP=0` to return to AEC plus residual suppression without the new
high-pass/denoising. Set `TINA_SPEEX_RESIDUAL_SUPPRESSION=0` to keep linear AEC only,
or `TINA_SPEEX_AEC=0` to use the original mic. These are rollback controls and apply
when a new capture session starts. Real speakerphone WER/CER improvements have not
been established; deterministic DSP checks do not establish recognition quality.

## Dictate into another app

Keep TINA Capture running and hold **Fn** while speaking. No text field is needed:
release Fn to see the transcript in TINA Capture and copy it to the clipboard. If
another app is active, TINA also sends **Command+V** to that app; when TINA Capture
is active, it skips auto-paste. Dictation uses the microphone only and does not read
the screen. After transcription, Desktop may send the final text (never the audio)
through its loopback polish bridge when a bound `TINA_DESKTOP_API_KEY` and the
Gateway Agent API are available. The polished text is copied/pasted; **Copy original
transcript** restores the raw ASR text to the clipboard. If polish is unavailable,
TINA copies/pastes the raw transcript.

Fn shortcuts and automatic paste both require TINA Capture to be enabled in **System
Settings → Privacy & Security → Accessibility**. Restart TINA Capture after enabling
it. If access is unavailable, the transcript is still copied to the clipboard. Audio
follows TINA Desktop's selected transcription endpoint; a deployment may route that
endpoint outside this Mac. Optional dictation polish and Live Translation send
transcript text through the Gateway to the configured CompletionPort; that provider
may also be remote. Those text-only calls never receive audio. The dictation path
reuses ScreenCaptureKit, so macOS may
also require Screen & System Audio Recording permission even though dictation only
captures the microphone channel. The Desktop server holds `TINA_DESKTOP_API_KEY` and
forwards only final transcript text to the Gateway; the native client never receives
the key. Without that optional key, Fn dictation still works and uses raw ASR text.

## Speakly parity and deliberate gaps

The reference is Genspark Speakly's meeting capture. This client matches the
capture experience, not its cloud notes product.

| Speakly behavior | TINA Capture |
| --- | --- |
| Meeting-app microphone detection with a sustain window | Yes, CoreAudio process objects + 5 s sustain + 15 s auto-close |
| One floating, always-on-top record widget | Yes, one overlay window with detect/record/ended modes |
| Live captions and a subtitle window | Yes, Desktop `WS /ws` with confirmed/pending lines |
| Pause/resume with a frozen clock | Yes; paused frames are dropped |
| Meeting-end reminder with keep-recording grace | Yes, 5 s release + 15 s grace, never auto-stop |
| Post-ASR text polish with raw-text recovery | Yes, optional server-side CompletionPort; raw stays available |
| Transcript export | Markdown to `~/Downloads` |
| AI notes and summaries | Not implemented — Desktop exposes no notes endpoint |
| Live translation | Transcript/Subtitle modes; confirmed text uses the server-side CompletionPort when configured |
| Local Ogg/Opus recording archive and upload | Not implemented — Desktop persists the transcript journal; audio stays in the existing capture path |
| Single mixed audio stream | Deliberately different — TINA keeps channel 999 system / 1000 mic for attribution |
| Speakerphone acoustic echo cancellation | Default for mic + system audio: Speex AEC + residual suppression; raw mic on channel 1002, derived mic on channel 1000 to ASR |
| Menu-bar extra, launch-at-login | Not implemented |

Native capture is independent from the browser extension; running both for the same
conversation creates two sessions. No microphone or system-audio permission is needed
merely to build the application.

## Development checks

```sh
cd clients/desktop-native/src-tauri
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
MACOSX_DEPLOYMENT_TARGET=15.0 cargo test --offline
cd ..
npm run build
```

The normal build and launch enable AEC, residual suppression, 70 Hz high-pass and
mild denoising for dual-source meeting capture. To roll back to linear AEC only:

```sh
cd clients/desktop-native/src-tauri
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
MACOSX_DEPLOYMENT_TARGET=15.0 \
TINA_SPEEX_RESIDUAL_SUPPRESSION=0 cargo run
```

Set `TINA_SPEEX_AEC=0` instead to disable both stages at runtime. A minimal build
can disable the echo path with `cargo build --no-default-features`; SpeexDSP still
provides resampling. Capture no longer links Sherpa/ONNX solely for resampling:
both libraries exported incompatible `kiss_fft` symbols and could corrupt AEC or
preprocessor output. ASR backend selection in Desktop/Bot is unchanged.

References: https://developer.apple.com/documentation/screencapturekit and
https://github.com/k2-fsa/sherpa-onnx/tree/master/tauri-examples .

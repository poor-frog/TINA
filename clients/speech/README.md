# TINA speech client

`listen` and `file` perform local-only wake detection. The opt-in authorized voice-turn
path (`run`/`run-file`) is described under [Authorized voice turns](#authorized-voice-turns).

In local detection mode, this optional host client detects **Hey TINA** with Sherpa-ONNX
on CPU and emits local JSON diagnostics. This mode does not contact STT, the agent, Gateway
or a meeting, play audio, or save microphone recordings. TINA's shared TTS default remains **Trúc Ly**, speaking TINA as "ti na".

Run on each participant's actual host, not in the meeting bot or a Docker container. Windows,
Linux and macOS use PortAudio through sounddevice. Windows wheels include PortAudio; Linux
needs `libportaudio2` (for example `sudo apt install libportaudio2`), and macOS may need
`brew install portaudio`. Microphone permission is granted through the host OS.

## Install and download once

From the repository root, with [uv](https://docs.astral.sh/uv/) installed:

```sh
uv sync --project clients/speech --python 3.11 --locked
uv run --project clients/speech tina-speech setup
uv run --project clients/speech tina-speech devices
```

`setup` is the only network/download operation. It fetches the upstream English GigaSpeech
3.3M KWS archive (~17.6 MB), verifies its pinned SHA-256 and size, and installs only the INT8
encoder/decoder/joiner, tokenizer, token table and original model card (~5.5 MB).
[`model-assets.json`](../../core/meetings/modules/voice-engine/tina_meeting_voice/model-assets.json) pins archive and file hashes. The archive
hash is recorded from the HTTPS download, not represented as an upstream signed checksum.
SentencePiece encodes `HEY TINA` using that exact model's BPE as:

```text
▁HE Y ▁T IN A @HEY_TINA
```

The default model cache is `%LOCALAPPDATA%/tina/speech/<model>` on Windows and
`${XDG_CACHE_HOME:-~/.cache}/tina/speech/<model>` elsewhere. `setup`, `listen` and `file`
each accept `--model-dir PATH`. Detection verifies all pinned files and the keyword file
offline and fails if they are missing/modified; it never silently downloads a model.

## Start and stop on your machine

Pick an **input** index from `devices`; indices are machine-specific. For example, on the
development Windows machine index 1 is the EDIFIER X5 Pro headset under MME:

```sh
uv run --project clients/speech tina-speech listen --device 1 --seconds 20
```

Speak "Hey TINA", pause at least three seconds, then try again. A `wake` JSON line means
local detection, not a meeting action. `--seconds 0` (the default) listens until **Ctrl+C**.
Closing/stopping releases the input stream and clears the detector's audio buffer. There is
no background service, auto-start, credential or enrollment requirement in this phase.

Input must support **16 kHz mono float32**. PortAudio requests that format once; the client
does not repeatedly resample blocks. If the selected host API rejects it, choose another
input/API from `devices` (MME/DirectSound/WASAPI on Windows). There is no silent device switch
or system-audio/loopback fallback.

## Replay the synthetic pilot

On Windows, create an English synthetic fixture with the installed Microsoft Zira Desktop
SAPI voice. This fixture generator does not select or change the shared TTS voice:

```powershell
powershell -NoProfile -File clients/speech/make-fixtures.ps1
uv run --project clients/speech tina-speech file output/speech-stage2/fixtures/hey-tina.wav
uv run --project clients/speech tina-speech file output/speech-stage2/fixtures/negative.wav
```

The positive fixture has three calls separated by silence; the negative has near-match
names and ordinary conversation. Expected counts in the initial synthetic smoke: **3 / 0**.
The separate Trúc Ly Vietnamese synthetic wake fixture was missed **0/3**; the English KWS
baseline is provisional until real/accented speech is tested. The ordinary Trúc Ly reply
without "Hey" caused zero triggers. Neither result proves general resistance to TTS feedback.
Other platforms can replay those same WAVs. Bring your own fixtures as uncompressed mono
PCM16 WAV at 16 kHz; unsupported formats fail explicitly. If conversion is needed, convert
once before replay, for example `ffmpeg -i input.wav -ar 16000 -ac 1 -c:a pcm_s16le output.wav`.
WAV replay adds 0.4 seconds of zero lookahead at EOF, identified in the summary.

The summary reports processing wall/CPU time separately. `cpu_percent` is process CPU/wall
time while decoding; fast offline replay may use one full core. `cpu_realtime_percent`
divides process CPU by audio duration, an offline estimate rather than a live microphone
measurement. Neither includes model-loading time. Wake timestamps mark detection, not the
exact spoken keyword's end; these are not measured human wake-latency percentiles.

## Bounds and behavior

- The audio callback only copies/enqueues up to 20 ms; inference runs outside it. The queue
  holds at most one second. Input overflow or a full queue stops/disarms capture explicitly.
- A rolling RAM buffer holds at most two seconds. A wake retains a bounded copy including
  audio up to the detection boundary, so a later turn controller can preserve an immediately
  following question. This phase does not cut a question at the detection timestamp, trim a
  text prefix, or implement question endpointing/upload.
- One event per utterance: re-arm needs both 1.5 seconds since the last wake and 0.8 seconds
  continuous quiet (RMS <0.01). The energy gate only controls re-arming, not wake recognition.
- Every input has independent native and cooldown state. Diagnostics contain only the fixed
  keyword and sample counters; they omit audio, recognized free text and credentials.
- Local diagnostics are not a published core event/API contract. The later authorized room
  coordinator, VAD question capture, playback status and shared TTS suppression are phase 3+.
  Do not point this pilot at loudspeakers expecting it to arbitrate a meeting.

## Tests and remaining acceptance

```sh
uv run --directory clients/speech pytest -q
```

The existing Python gate discovers this package/tests; no new CI job is required. Tests cover
no-wake behavior, per-utterance gating, state isolation, Stop cleanup, bounded buffers/queue,
offline replay and tampered models. The synthetic smoke exercises the real native KWS model.

Human/accented speech, noisy rooms, real-time microphone CPU/latency, held-out misses and
long negative corpora remain to be measured. Synthetic detections are a functional proof,
not a release-level accuracy or false-activation claim. In particular "TINA ơi" is not a
supported synonym for the English wake phrase.

To remove the pilot, stop it with Ctrl+C and delete its local environment/model cache if
desired. No main-stack services, schemas, capture paths or model-provider settings change.

## Authorized voice turns

This opt-in pilot reuses existing STT and grounded meeting Knowledge APIs. TTS remains Trúc Ly.
`listen`/`file` still perform local-only wake detection. Only `run`/`run-file` dispatch a voice turn.

### Prepare the server

Build/deploy the changed Meeting API, Gateway and browser-bot image from this checkout before
using correlated speech. A newly spawned, admitted, voice-enabled bot is required. Old images
cannot acknowledge speech.v1 commands. Preserve the existing Compose project/override chain.

Copy `room.example.json` to a private file outside Git. Replace all example IDs with actual
operator-owned meeting/user IDs; native meeting URL alone grants no TINA permissions. The
coordinator is locked to that meeting and explicitly approved linked Markdown documents.
The operator's identity must own the active meeting; enrolled participants use their own keys.
For synthetic validation, use a separate test meeting and the fixtures below, never overwrite
real notes or fabricate production bot admission.

Set these secrets in the coordinator process environment from your private configuration:

- `TINA_SPEECH_OPERATOR_KEY`: operator API key, with bot/tx/browser and required agent access.
- `TINA_SPEECH_STT_KEY`: token for the configured self-hosted transcription endpoint.

```powershell
uv sync --project clients/speech --python 3.11 --locked
uv run --project clients/speech tina-speech setup
uv run --project clients/speech tina-speech serve --config C:\private\tina-speech-room.json
```

The server binds loopback port 18006. Startup verifies operator identity, active voice bot and
linked approved Wiki paths. It does not silently enroll users or discover unrelated documents.
No default stack service, user table or agent prompt/retrieval pipeline is replaced.

### Run a participant

In a separate host process, set **only your own** `TINA_SPEECH_USER_KEY`. Shared operator/STT/TTS
keys never go to participants. `TINA_SPEECH_COORDINATOR_URL` defaults to
`http://127.0.0.1:18006`; non-loopback connections require HTTPS. Multi-machine hosting/TLS
is operator-managed. Run one coordinator process/worker for the room, and install the
same branch on every participant host. Set `participants` to each user's real TINA user ID;
each host uses its own enrolled user's API key. The local example lists IDs 7 and 8 as placeholders.
For separate machines, expose the loopback service through an authenticated-network HTTPS
reverse proxy with caching disabled, or use an operator-configured SSH tunnel and keep the
participant URL on loopback. Do not expose a plain HTTP coordinator on the LAN.

```powershell
uv run --project clients/speech tina-speech devices
uv run --project clients/speech tina-speech run --device 1
```

Speak "Hey TINA" followed by a question, without a long pause. Ctrl+C closes the microphone
and cancels the turn. Question capture is limited to 20 seconds after wake, with a five-second
no-question deadline and Silero VAD silence endpointing. The callback remains nonblocking.

Audio sent to STT includes up to two seconds of pre-roll, preserving an immediately following
question and the wake phrase; it can include brief preceding microphone context. The coordinator
requires ASR to **begin** with the wake phrase before removing that anchored prefix. The
unaccented ASR spelling **hay tina** is accepted alongside **Hey Tina**; this does not change
the acoustic wake phrase, accept a prefix in mid-sentence, or permit an empty question. Earlier
conversation or an empty/unrecognized wake/question fails closed instead of being trimmed into
a different question. The pinned KWS Python result omits the absolute offset after native silence
resets, so relative token timestamps are not used as a precise acoustic crop.

If VAD already ended buffered speech when KWS reports the wake, capture allows 1200 ms for
the following question to start instead of immediately uploading a wake-only clip. A question
entirely in pre-roll remains preserved, with that bounded extra wait.

State: ARMED -> CAPTURING -> WAITING -> SPEAKING -> QUIET -> ARMED. Wake dispatch stays disabled throughout
capture/wait/playback. Only validated `claims[].text` with approved current sources is spoken;
empty claims get one fixed insufficient-information reply. Errors never speak raw JSON, tool
output or a personal-chat fallback. No Wiki Apply/document editing action is called.

### Correlation, cancellation and recovery

The core-owned [speech.v1](../../core/meetings/contracts/speech.v1/README.md) protocol adds tracked
commands and actual bot playback receipts. Legacy Speak/Stop remains supported. A successful
Speak HTTP response only means acceptance; paplay exit/PCM/microphone cleanup determine the
terminal receipt. This still does not prove remote-participant audibility.

One room turn is active at a time. Request IDs are stable over retries, changed audio is rejected,
and duplicate Speak is not republished within receipt retention. Stop creates a tombstone to
block late matching Speak. Cancelling STT/LLM discards late results. If playback is ambiguous,
ERROR keeps the room reserved and the client disarmed; do not automatically retry or re-arm.
Retry explicit Stop. If receipts have expired or services cannot recover, the operator must stop
the bot, confirm it has left, then restart/reconfigure the coordinator with a new active bot.
The single-process pilot has volatile state; restart does not resume/replay turns.

### Multiple enrolled hosts

The core-owned [speech-room.v1](../../core/meetings/contracts/speech-room.v1/README.md)
handshake adds authenticated `GET /room` snapshots. Every host polls every 250 ms independently
of its turn worker. The room is busy from the winning capture grant through real terminal
playback. Other hosts enter BUSY, discard pre-roll and do not feed KWS. If two microphones hear
the same call, the central atomic grant admits one; the loser discards its local question and
never uploads it. There is no queue of stale questions. This arbitration does not identify who
actually spoke or promise the microphone with the best signal will win.

Grant revisions reject delayed losing requests even after the room becomes idle. A boot UUID
rejects old requests after coordinator restart. Upgrade coordinator and clients together; the
phase 3 client without the handshake is no longer accepted for turn dispatch.

After a turn or BUSY interval, each host waits for 800 ms continuous local quiet before ARMED,
resetting KWS/pre-roll. A failed status poll, snapshot older than one second or changed boot UUID
enters ERROR, drops capture and attempts Stop after pending HTTP. It stays disarmed after network
recovery: Ctrl+C and explicitly run the participant again after the operator checks the room.
An idle-status poll is advisory; the epoch/revision reservation check is the final atomic gate.
Do not restart the coordinator to clear unknown playback until the old bot has been stopped and
confirmed absent. A freshly started process cannot reconstruct old playback receipts on its own.

To pilot two hosts, start the coordinator once, start `run --device <index>` on each host, then
ask one question at a time and one simultaneous question. Check both clients pause while Tina
answers, only one answer plays, and both return through QUIET to ARMED. Disconnect one client's
network and verify ERROR; reconnect alone must not re-arm it. Repeat with headphones and speakers.
These physical microphone/remote listening checks remain separate from simulated acceptance.

Older single-meeting Agent APIs are supported without requesting the unused `meeting_ids`
field. If a source omits its additive meeting ID, it is bound to the fixed authenticated
Knowledge endpoint; an explicit different meeting ID or unapproved path is still rejected.

### Synthetic fixtures and focused checks

`fixtures/` contains clearly labeled fake source material. It does not itself insert anything
into a live TINA workspace/meeting. The operator must explicitly link the test Wiki into the
test meeting before a live end-to-end run.

```powershell
powershell -NoProfile -File clients/speech/make-fixtures.ps1
uv run --project clients/speech tina-speech run-file output/speech-stage2/fixtures/question.wav
uv run --directory clients/speech pytest -q
```

`run-file` uses the same KWS/VAD/turn controller with paced synthetic WAV input, and does not
open a microphone. It needs the configured participant key and coordinator. Deterministic unit
tests fake upstream HTTP; they do not establish real LLM, Meet admission or remote audibility.
Keep those integration checks separate from unit-test counts and human wake-word accuracy.

Phase 4 checks (2026-11-04): 51 deterministic speech tests pass. A separate native KWS/Silero
smoke ran two independent clients through real loopback HTTP and simulated upstream services:
one winner for a shared wake, zero extra Speak calls during a repeated busy-room wake, then
a successful turn from the other host client. Both returned to ARMED. Evidence is under ignored
`output/speech-stage4/native-proof.json`. No microphone, real LLM or Meet was used in that smoke.
Phase 4 changes only the optional Python client/coordinator: existing phase 3 stack images do
not need rebuilding. Restart the coordinator and all participant clients together after updating.

## Bot-hosted Google Meet mode

Participants need no local client in this mode. See [in-bot voice deployment](../../docs/tina-meeting-voice.md). This host CLI remains an optional local pilot; KWS, assets and Silero capture are shared from `tina-meeting-voice`.

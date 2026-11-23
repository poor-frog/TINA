# Optional Vietnamese TTS sidecar (speech phase 1)

The default **Trúc Ly** preset (Northern Vietnamese) with **Blaze VieNeu-TTS v3 Turbo Enhanced (Trộn 0.7)**,
using the ONNX CPU backend. This implements
the bot's existing speech HTTP interface. STT, agent dispatch, transcripts and bot playback
are unchanged. The standalone Compose project remains available. The main stack now also offers an opt-in `speech` profile through `TINA_MEETING_VOICE=1`; see [bot-hosted voice](../../docs/tina-meeting-voice.md).

The Piper proposal is replaced because its eSpeak phonemizer/data introduces GPL, contrary
to ADR-0004. VieNeu, sea-g2p and the chosen model/codec cards declare Apache-2.0.
No reference recording, voice cloning or training is enabled.
The SDK also installs transitive MPL/LGPL packages as separate unmodified dependencies;
their scoped records are in the repository's `license-exceptions.json`.

## Account voice and pronunciation settings

Settings → Voice assistant exposes the pinned SDK's 25 preset voices, browser-only preview and
up to 32 custom `term = pronunciation` overrides (2 KB encoded). Preferences live in the account's
existing identity settings. Partial saves preserve the independent prepare-new-bots preference.
New enabled bot sessions pin the owner's speech profile in private Redis; existing sessions keep
their selected voice/rules. No glossary enters public meeting JSON or canonical answer text.

Meeting API signs bounded speech profiles with a domain-separated key derived by the main stack
from its existing `INTERNAL_API_SECRET`. Only API and TTS receive that derived key; bots/Agents
receive the signed meeting/session descriptor. No additional private-key file is required. Ordinary
TTS clients cannot supply unsigned pronunciation rules or audio references. Standalone clients may
choose a preset directly; standalone signed profiles require the same explicitly supplied derived key.

Public notice cache keys include the selected preset. Default notices warm at startup; a selected
profile's notice catalog warms in a bounded, low-priority background job before room voice reports
ready. User synthesis/queued requests take precedence. Only fixed public notices are cached, never
private answers or pronunciation examples. The custom glossary does not rewrite fixed notices.

`TINA_TTS_THREADS` sets CPU threads (1–8; portable default 2). `TINA_TTS_PREBUFFER_MS` configures bot
prebuffer (80–1000 ms; default 150); short clips are still released when the stream finishes.
`benchmark.py` measures uncached single/three-concurrent HTTP synthesis and simulates 150/300 ms
playout without microphone output. On this Mac's Docker CPU run, warm first PCM was 248 ms at two
threads and 180 ms at four; all sampled 150/300 ms playout simulations had zero potential starvation.
The local deployment uses four threads and retains 150 ms. This small, stochastic sample set does
not establish a meeting-playback SLA or performance under active ASR/VAD load.

## Encrypted token for one machine

A private pair at `~/.config/tina/tts-local/.env` and `~/.config/tina/tts-local/.env.keys`
takes precedence over the shared repo token when no explicit `TINA_TTS_ENV_FILE` or
`TINA_TTS_KEYS_FILE` is supplied. The local directory is private (0700), its files are 0600,
and both files stay outside the checkout. This lets each self-hosted deployment use its own
TTS API token without changing `deploy/tts/.env` or the main-stack key. An incomplete local
pair fails closed; it does not silently switch back to shared credentials. Explicit file
and key overrides retain priority.

For bot-hosted voice, prepopulate the `tts-models` volume with the authenticated
installer below, then keep the speech profile enabled when recreating the stack:

```sh
TINA_MEETING_VOICE=1 python3 deploy/tts/run.py -- make all
```

The runner decrypts the token only into process memory and gives the same value to Meeting API
and TTS. Spawned voice-enabled bots obtain that token through the existing server-side wiring;
participants receive neither the service token nor its decryption key.

## Setup on another machine (Ubuntu/WSL or Linux)

For a fresh TINA checkout, copy the release `.env.keys` to the repo root and run
`make all`. It provisions the encrypted GitHub release bundle on a cache miss.
The private key stays on the host. The installer receives only the unwrapped
bundle passphrase through stdin. Existing verified snapshots are reused.

The manual steps below cover standalone or separately provisioned deployments.

`deploy/tts/.env` encrypts its TTS token with the same root `.env.keys` used for
`deploy/compose/.env`. Provision that private root key once through a secure channel; never commit
or paste it. No separate `tts.env.keys` is needed. An optional `~/.config/tina/tts-local/` pair
can override the shared file on a machine that needs a private token.

Install Dotenvx in the OS where Compose runs (inside Ubuntu for WSL):

```bash
# With Node.js/npm available in that OS:
npm install --global @dotenvx/dotenvx@2.38.2
dotenvx --version
mkdir -p "$HOME/.config/tina" "$HOME/.cache/tina/tts"
chmod 600 .env.keys
```

Node.js is not required for the standalone CLI; see the
[official installation options](https://dotenvx.com/docs/install/). This workstation has
Dotenvx 2.38.2 at `/usr/local/bin/dotenvx` inside Ubuntu WSL.

`run.py` strictly reads only `TTS_API_TOKEN` through Dotenvx into memory. With no local override,
it uses `deploy/tts/.env` and the root `.env.keys`. Missing/wrong keys fail before the requested
command launches, without printing decrypted output. The TTS key
and unrelated encrypted values are not injected into child processes. Existing main-stack
keys supplied by the caller remain available to that stack's loader. The selected TTS file
overrides an ambient stale `TTS_API_TOKEN`.

Optional caller environment overrides:

| Variable | Default |
| --- | --- |
| `TINA_TTS_KEYS_FILE` | root `.env.keys` (or local override key) |
| `TINA_TTS_ENV_FILE` | this checkout's `deploy/tts/.env` |
| `DOTENVX_BIN` | `dotenvx` found in PATH |
| `TINA_TTS_MODELS` | this user's `~/.cache/tina/tts` |
| `TINA_MAIN_NETWORK` | `tina-local_tina` (Compose default) |
| `TINA_TTS_HOST_PORT` | `18004` (Compose default) |

No machine-specific model path is embedded in the shared file. The env/key pair does not
supply Docker, model weights, the main network or the main stack's key.

From this checkout's root, with Docker running and the main network available:

Accept the access conditions on the [Blaze model page](https://huggingface.co/blaze-voice-ai/vienue-v3-turbo-enhanced)
and sign in with `hf auth login` using a token with read access. The commands below
use the default Hugging Face token path. Adjust the mount source if you configured a
different path. The token is available only to the one-time installer container.

```bash
docker build -t tina/tts:dev deploy/tts
docker run --rm --user "$(id -u):$(id -g)" \
  -e HF_HUB_OFFLINE=0 -e HF_HUB_DISABLE_XET=1 \
  --mount "type=bind,src=$HOME/.cache/huggingface/token,dst=/run/secrets/hf_token,readonly" \
  -e HF_TOKEN_PATH=/run/secrets/hf_token \
  -v "$HOME/.cache/tina/tts:/models" tina/tts:dev python install_models.py
python3 deploy/tts/run.py -- docker compose -f deploy/tts/docker-compose.yml up -d --no-build --wait
curl --fail http://127.0.0.1:18004/health
```

Use the runner for subsequent Compose commands too:

```bash
python3 deploy/tts/run.py -- docker compose -f deploy/tts/docker-compose.yml logs --tail 50 tts
python3 deploy/tts/run.py -- docker compose -f deploy/tts/docker-compose.yml stop tts
```

Do not pass the encrypted file directly to `docker compose --env-file deploy/tts/.env`:
Compose cannot decrypt it. The runner supplies the token through the process environment;
the Compose file passes only that token to the inference container. `.dockerignore` excludes
env/key files from the TTS build context.

For the main Compose speech profile, use the same installer with the
`<compose-project>_tts-models` named volume in place of the host cache. If the volume
does not exist yet, create it from your configured Compose project with
`docker compose --profile speech create --no-build tts-models`. Then build and
start with the existing stack runner:

```bash
python3 deploy/tts/run.py -- make all
```

If using an existing private main configuration, keep its `ENV_FILE`, Compose project and
override chain. The runner sets `TTS_SERVICE_URL=http://tts:8000` unless already overridden,
and does not edit the main env file. Keep using the runner when recreating Meeting API so
the shared token stays consistent. The main env's own decryption key is still required.

## Restore a TTS bundle without downloading the model

If you received a TTS bundle with the pinned Enhanced and MOSS assets, extract it
outside the checkout and run its restore script from this checkout's root:

```bash
tar -xf /path/to/downloads/tina-tts-enhanced-9ab89d0.tar -C /path/to/downloads
bash /path/to/downloads/tina-tts-enhanced-9ab89d0/restore.sh tina-local
PROJECT=tina-local TINA_MEETING_VOICE=1 python3 deploy/tts/run.py -- make all
```

Use your Compose project name in both commands. The bundle loads the TTS image
for your CPU architecture and verifies the model files in that project's
`tts-models` volume. This skips the Hugging Face download. The rest of the
stack still uses its normal configuration and dependencies.

## Legacy private env (Ubuntu/WSL)

Existing private plaintext configs remain usable as below; this setup does not overwrite
or delete operator files. New shared checkouts should use the encrypted setup above. The
current workstation's original token was retained and matches its private main-stack config.

From this checkout's root, with the main `tina-local` stack already running:

```bash
docker build -t tina/tts:dev deploy/tts
mkdir -p "$HOME/.config/tina" "$HOME/.cache/tina/tts"
python3 - <<'PY'
from pathlib import Path
import os, secrets
config = Path.home() / '.config/tina/tts.env'
if not config.exists():
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write('TTS_API_TOKEN=' + secrets.token_hex(32) + '\n')
        out.write('TINA_TTS_MODELS=' + str(Path.home() / '.cache/tina/tts') + '\n')
        out.write('TINA_MAIN_NETWORK=tina-local_tina\nTINA_TTS_HOST_PORT=18004\n')
PY
docker run --rm --user "$(id -u):$(id -g)" \
  -e HF_HUB_OFFLINE=0 -e HF_HUB_DISABLE_XET=1 \
  --mount "type=bind,src=$HOME/.cache/huggingface/token,dst=/run/secrets/hf_token,readonly" \
  -e HF_TOKEN_PATH=/run/secrets/hf_token \
  -v "$HOME/.cache/tina/tts:/models" tina/tts:dev python install_models.py
docker compose --env-file "$HOME/.config/tina/tts.env" \
  -f deploy/tts/docker-compose.yml up -d --no-build --wait
curl --fail http://127.0.0.1:18004/health
```

Existing private config is retained. Model/codec files (~566 MB) are downloaded at the revisions
in `model-assets.json`, verified against upstream SHA-256 for weights and Git
blob hashes for small files, and mounted read-only. The installer retains upstream cards and
reuses complete snapshots without network access. Startup verifies the
same files and cache references; inference uses `HF_HUB_OFFLINE=1`, no remote model code, and
disables ONNX telemetry. Weights stay outside the image and source tree. Dependencies are
hash-locked in `requirements.txt`; regenerate using the command in that file's header.

## Connect the bot

For the encrypted setup, the runner supplies the shared token and default service URL without
editing the main env file. Preserve the existing Compose override chain/project. The following
example recreates only Meeting API using its existing image and an existing private main env;
omit the `ENV_FILE` assignment to use `deploy/compose/.env` and its own matching key:

```bash
ENV_FILE="$HOME/.config/tina/.env" python3 deploy/tts/run.py -- python3 - <<'PY'
import sys
sys.path.insert(0, 'deploy/compose/bin')
from stack import Stack
stack = Stack('doctor')
stack.preflight()
stack.compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
              '--wait', '--wait-timeout', '120', 'meeting-api')
PY
```

Legacy plaintext setups can retain their matching `TTS_API_TOKEN`/`TTS_SERVICE_URL` in the
private main env and execute the inner Python command without `deploy/tts/run.py`. Keep a
single matching token on both sides; do not mix a newly generated legacy token with the shared
encrypted token. Never put token values in shell arguments, Git or browser settings.

Spawn a **new** browser bot with `voice_agent_enabled: true`. Existing bot environments do
not change when Meeting API restarts. The owner-scoped Gateway endpoints already exist:

- `POST /bots/{platform}/{native_meeting_id}/speak`, body `{"text":"Xin chào","voice":"auto"}`.
- `DELETE /bots/{platform}/{native_meeting_id}/speak` to stop.

Only an admitted active bot owned by the authenticated caller can speak. Hold its API key
in a private file/environment, not a URL. `accepted` means command publication, not audible
playback. Discord speaking remains unsupported.

## Protocol and lifecycle

- `POST /v1/audio/speech`, `X-API-Key`, `Content-Type: application/json`.
- Body: `{"model":"tts-1","input":"Xin chào","voice":"auto","response_format":"pcm"}`.
- Output: **headerless little-endian PCM16, mono, 24,000 Hz**, resampled from the model's 48 kHz.
- `voice=auto` selects Trúc Ly unless a signed owner profile selects another preset. Preset names
  are allowlisted from the pinned SDK; model paths, reference recordings and arbitrary rules are refused.
- Standalone `TINA`/`Tina`/`tina` is spoken as "ti na"
  to prevent acronym spelling; agent/transcript text and other acronyms remain unchanged.
- Limits: 4,000 input characters, 20,000 request bytes, 120 seconds synthesized audio.
  The sidecar admits at most sixteen connections and closes each after 145 seconds total
  (including slow headers/body). Excess connections are closed before allocating a handler.
  The bot allows 150 seconds total for synthesis and playback, within the coordinator's
  175-second receipt wait. Slow CPU synthesis can exceed this budget and fails rather than
  reporting completion. Closing a connection cannot preempt native inference; its single
  synthesis lock remains held until inference actually returns.
- GET `/health` and `/status` expose content-free readiness/format information.
- One native synthesis at a time; a FIFO queue permits six waiters for at most 30 seconds. Overflow/timeout returns 503; disconnected queued clients are removed.
- No CORS, text storage or input/credential logging. Published port is loopback-only; bots use
  the authenticated service on the existing Docker network.
- PCM streams as native audio chunks become available. Stop closes the playback/request immediately;
  an active native chunk is not forcibly preempted and retains the single-flight lock until it returns.

## Verification and rollback

```bash
docker run --rm --network none -v "$PWD/deploy/tts:/tests:ro" tina/tts:dev \
  python -m unittest discover -s /tests -p test_server.py
python3 deploy/tts/run.py -- docker compose -f deploy/tts/docker-compose.yml \
  exec -T tts python - --output /tmp/tts-smoke.wav < deploy/tts/smoke.py
```

The smoke checks real synthesis, PCM framing, sample rate and non-silence. Listen to its WAV,
then verify audible speech and Stop from a second participant in a controlled meeting.
HTTP success and a virtual microphone test are not substitutes for the meeting check.

`playback-smoke.mjs` can run as `BOT_WORKER_ENTRY` inside an isolated, existing browser-bot
image. It calls the shipped `tts-playback.js`, captures the real PulseAudio virtual microphone,
and verifies Stop during playback, without joining a meeting. It writes
`/tmp/tts-virtual-mic.wav` and `/tmp/tts-playback-proof.json`. This is a substrate proof only;
it does not assert Google Meet admission, microphone UI state or remote audibility.

Stop this optional service with the same `docker compose ... stop tts`. To roll back, restore
the previous two TTS values in the private main env, recreate Meeting API and replace any
test bot spawned with voice enabled. Preserve all model and main-stack volumes.

## Encrypted startup checks

```bash
python3 -m unittest discover -s deploy/tts -p test_env.py -v
```

With Dotenvx installed, this includes a real encrypt/decrypt transfer into another temporary
home: matching env/key succeeds, stale ambient token is replaced, unrelated values/private
keys are absent from the probe, and a wrong key prevents execution. No Docker/model is needed.
The CI TTS job installs pinned Dotenvx and runs these alongside the audio/protocol tests.

`GET /ready` requires the same `X-API-Key` as synthesis, and performs no inference. The bot voice preflight uses it to check that shared credentials match. `/health` and `/status` remain content-free unauthenticated probes.

Bot ASR-addressed voice accepts its built-in TINA name variants at the beginning of a turn. Before readiness, the service prewarms/caches the fixed public wake, neutral waiting, summary and tool-progress phrases. Two legacy waiting phrases remain cached for older bot images. These match the bot's public notice whitelist, bypass project pronunciation overrides and the busy Agents LLM session. Wake/neutral phrases rotate without an extra LLM request. Specific progress speech requires a fresh matching request/revision from the leased meeting turn; absent or stale progress uses neutral waiting copy. Bot answers are validated before sentence-by-sentence playback and never cached.

### Verified replies and the spoken copy

Voice workers generate the reply with a 25-second provider budget, then use a separate 15-second
review against the supplied sources. Exact digit/date tokens absent from cited evidence are
rejected before review. The reviewer checks entailment, the correct owner/task/unit/deadline,
negation and proposal/decision contradictions. A rejected, malformed or unavailable review yields
an insufficient-evidence reply; the unchecked draft is never sent to TTS. This is an additional
model check, not a proof of factual correctness, and can increase voice response latency.

TTS keeps `input` as the display/history text and derives a separate `speech_text` immediately before
inference. The installed pinned `sea-g2p` normalizer handles selected time, full-date and currency
spans; unary signs are preserved explicitly. A date such as `03/04` is spoken as literal digits and
slash rather than assigning day/month. URLs, email and backtick code are excluded from this custom
preprocessing; VieNeu still performs its own phonemization. The original answer and ASR are untouched.

### Project pronunciation dictionary

Edit `deploy/tts/pronunciations.json` and rebuild/recreate TTS with your normal deployment command.
The file is packaged into the image; running processes do not reload edits. Defaults include TINA,
API and common voice/runtime abbreviations (LLM, ASR, STT, TTS, VAD, KWS, CPU, GPU, MPS, CUDA, SDK
and SQL). Letter spellings are intended for Vietnamese speech; project overrides may replace them. To add a project and explicitly select it for two meeting IDs (the IDs in Terminal URLs):

```json
{
  "default": {"TINA": "ti na", "API": "ây pi ai"},
  "projects": {"demo": {"ACME": "ác mi"}},
  "meeting_projects": {"14": "demo", "25": "demo"}
}
```

Bots send their validated invocation `meeting_id`; previews/unknown meetings use only defaults.
This is operator-approved pronunciation configuration, not content read from private workspaces.
Clients cannot submit dictionaries. Review every pair before deployment: the service enforces word,
size and numeric/markup restrictions but cannot prove two spellings sound like the same name.
The fixed public messages are exempt from project overrides. Speech text is bounded to 12,000
characters and is never included in logs or saved over display text. Numbers in glossary entries
are rejected so date/amount normalization stays in the controlled numeric rules.

Focused offline checks (use a TTS image with its pinned dependencies installed):

```sh
python -m unittest test_speech_text test_server
```

### Streaming and one-sentence lookahead

The sidecar now calls `infer_stream()` and returns PCM16 mono/24 kHz with HTTP/1.1 chunked transfer.
A stateful soxr resampler carries its filter state between native 48 kHz chunks and flushes once at
normal completion. The cached fixed acknowledgment remains a ready-made PCM stream. Private answers
are not cached. First audio is generated before the response headers; failures before that return
503, while later failures close the connection without a success chunk terminator. Clients must
treat an incomplete response as failed, even if some audio has already been heard.

The shared FIFO/connection/absolute time limits still apply. Cancellation is checked between native
iterations and writes, closes the generator and releases its slot after any active native call
returns. Disconnects are checked again after a native chunk returns, before sending headers or audio,
so a cancelled first chunk cannot claim HTTP 200 or drain the remainder of the utterance.
A native call already executing is not forcibly preempted. Slow readers exert TCP
backpressure; the absolute connection deadline bounds a stalled client.

Each bot holds at most two synthesis handles: the current sentence and one lookahead. Each uses a
bounded PassThrough (24 KB high-water mark plus transport buffers); playback waits for 150 ms of PCM
or a valid shorter finished stream. Lookahead never opens the microphone or starts the player. A
failed lookahead cannot mute current playback. Source policy is checked again after preparation
and before each sentence plays. Stop, departure, policy change and final cleanup cancel both
handles. Completed receipts require the HTTP stream's normal end, valid PCM, successful player exit
and microphone cleanup. The bot's playback-start callback waits for process spawn and the first
successful PCM write, after meeting microphone verification; it does not prove remote audibility.

The LLM answer remains fully validated before speech preparation. No unverified token streaming,
new ASR backend, voice model or inference precision is introduced. `test_streaming.py` checks early
HTTP audio, truncated streams and resampling continuity; bot voice/playback tests cover lookahead,
Stop and policy revocation. Measure HTTP audio latency separately from meeting delivery latency.


Technical pronunciation changes should be reviewed with listening samples before adding many
terms. They rewrite only whole words in the spoken copy, case-insensitively; code, URLs, email,
identifiers and stored answer/transcript text retain their original notation. A dictionary entry
cannot establish the preferred pronunciation of a person's name. Keep personal/project names in
an explicitly selected project dictionary after the owner supplies the desired reading.

Three-meeting operation keeps one native synthesis at a time, with six FIFO waiters, a 30-second
queue timeout and sixteen bounded connections so readiness remains available during lookahead.
Authenticated fixed public clips already in the prewarmed whitelist bypass the synthesis queue;
private replies always use serialized native inference and are never cached.

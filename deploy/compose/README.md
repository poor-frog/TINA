# deploy/compose — the v0.12 control-plane stack (P4)

`docker-compose.yml` brings up the v0.12 control plane: the infra (`postgres:17-alpine`,
`valkey/valkey:8-alpine`, `storage` (versitygw) + `storage-init`) and the long-running services below, each building its own
slim image from `<service>/Dockerfile`:

| service      | build context                          | host port | entrypoint                         |
|--------------|----------------------------------------|-----------|------------------------------------|
| admin-api    | `core/identity/services/admin-api`     | 18057     | `python -m admin_api`              |
| runtime      | `core/runtime`                         | 18090     | `python -m runtime_kernel`         |
| meeting-api  | `core/meetings/services/meeting-api`   | 18080     | `python -m meeting_api`            |
| agent-api    | `core/agent/services/agent-api`        | 18100     | `uvicorn control_plane.api`        |
| gateway      | `core/gateway/services/gateway`        | 18056     | `python -m gateway`                |
| terminal     | `clients/terminal`                     | 13000     | Next.js custom server              |
| mcp          | `core/meetings/services/mcp`           | 18010     | the MCP transport                  |
| flows-api    | repo root, `core/flows/Dockerfile`     | 18200     | `python -m flows_integrations.flows_api` |
| flows-mailbox| repo root, `core/flows/Dockerfile`     | —         | `python -m flows_integrations.mailbox` (profile `mailbox`) |
| discord-connector | repo root, `core/meetings/services/discord/Dockerfile` | 18101 | `node dist/index.js` (profile `discord`) |

### flows, and what it replaces

`flows-api` is the reaction engine's HTTP surface and one of the domains the MCP assembly asks for
a tool manifest (PRD decision 40): `mcp` fetches `/.well-known/mcp-tools.json` from it, so a stack
that runs flows serves flows' tools on the one MCP surface, and one that does not simply serves
fewer. Before this service existed the engine ran as HOST processes beside the stack and `mcp` was
pointed at the docker BRIDGE ADDRESS of that host lane — a host-specific IP written into a
deployment, for a service the deployment did not run. `FLOWS_API_URL` now defaults to
`http://flows-api:8200`; set it to point at a flows elsewhere, or set it EMPTY to run a deployment
that genuinely does not carry the domain.

An existing deployment that reaches flows through such a bridge keeps working: its
`TINA_FLOWS_API_URL` override still wins over the new default, so the host lane and any listener
in front of it retire on the operator's own schedule, after the stack is cut over — not on the day
this merges.

`flows-mailbox` is the inbound mail lane (IMAP poll → `POST /events`), the same image under a
different command and with the same environment. It is behind the `mailbox` COMPOSE PROFILE and
therefore off by default, because mail is an optional intake: a lane started without real IMAP
credentials restart-loops and reads as a broken stack. Turn it on with `--profile mailbox` (or
`COMPOSE_PROFILES=mailbox`) once `TINA_MAIL_ADDR` and `TINA_MAIL_APP_PASSWORD` are set. Do not
scale it — the IMAP cursor is single-writer by design.

Two things flows will refuse, and both are deliberate: it will not start without
`TINA_FLOWS_API_KEY`, `TINA_FLOWS_ADMIN_KEY` and `INTERNAL_API_SECRET` (a weak default makes an
unconfigured deployment look configured), and it will refuse to compose a mailed link when
`TINA_UI_URL` is unset — at the link, not at boot, because a deployment may legitimately have no
terminal. Every key it reads is declared in `core/flows/src/config.v1.json` and checked against
this file by `gate:config-contract`.

`discord-connector` is the Discord voice bot and it is behind the `discord` profile for two
reasons: it refuses to boot without `DISCORD_BOT_TOKEN` (a stock stack would restart-loop), and it
must run as exactly **one** replica — one bot token holds one Discord Gateway session, and a
second process with the same token evicts the first mid-meeting. Enable it with a token and
`docker compose --profile discord up -d --build`; the bot needs the privileged **Server Members
Intent** plus View Channels / Connect / Speak, and `DISCORD_GUILD_ALLOWLIST` is recommended unless
the bot is single-tenant. meeting-api reaches it through `DISCORD_CONNECTOR_URL` (compose defaults
it to the service; an explicitly empty value disables Discord, and a spawn without the profile
fails at the connect with a 502 — enable the profile). See
[`core/meetings/services/discord/README.md`](../../core/meetings/services/discord/README.md).

The Runtime spawns the source-built bot and agent-worker images on demand; they are not
long-running Compose services. Readiness distinguishes healthy services, running workers without
healthchecks, and completed initialization jobs.

## ASR devices and automatic GPU selection

Optional `TINA_LIVEKIT_AUDIO=1` puts both new Google Meet transcript windows and voice-question STT
through the local LiveKit Agents adapter, retaining the selected model, windows and LocalAgreement.
Its private audio bridge reuses WebRTC NS Low once for ASR/Silero/KWS. `make all` builds the bot before
the LiveKit image, which copies the same native DSP library. See [audio bridge](../livekit/README.md#local-audio-bridge)
for permissions, limits and rollback. The default `0` preserves existing deployment routing.

`TINA_LIVEKIT_VAD_SHADOW=1` observes Silero in the LiveKit worker alongside the bot's existing
Silero. The model cache is mounted read-only and permission requires enabled room voice. Numeric
activity/endpoint comparisons never change voice decisions or disable transcript/TTS on failure.
See [hosted Silero observation](../livekit/README.md#hosted-silero-observation). Default is `0`.

`TINA_AUDIO_DENOISER=dtln` selects local CPU DTLN for noise-enabled Google Meet bots using the audio
bridge; `webrtc` retains NS Low. `make all` builds hash-verified upstream ONNX weights and their MIT
notice into the LiveKit image, so no manual model installation or runtime download is needed.
New bots receive the selected filter; raw archives, 64 ms capture, ASR models/windows and room
on/off preferences remain unchanged. See [DTLN configuration](../livekit/README.md#local-audio-bridge).

Account speech settings (preset voice and bounded pronunciations) are configured in Terminal.
The stack derives `TINA_TTS_PROFILE_KEY` from the existing internal secret and supplies it only to
Meeting API/TTS, so no additional dotenvx key is required. `TINA_TTS_THREADS` defaults to 2;
`TINA_TTS_PREBUFFER_MS` defaults to 150. See [speech profiles and benchmark](../tts/README.md#account-voice-and-pronunciation-settings).

With a configured `TINA_VIEGEM_TOKEN`, the default `TINA_VIEGEM_DEVICE=auto` resolves to native
MPS on Apple Silicon or Docker CUDA on Linux/Windows WSL2. `make plan` reports the candidate
`viegem_device` without allocating GPU resources. Unsupported hosts and failed GPU checks produce
an error; CPU requires explicit `TINA_VIEGEM_DEVICE=cpu`. Only the acoustic model uses the GPU:
FSMN-VAD and KenLM remain on CPU.

Mac setup prepares native Python 3.11 and hash-verified assets, then verifies a real MPS operation
before Docker application activation. It stops only the selected project's old VieGem CPU service
before starting the owned LaunchAgent. Native startup failure reports an error and attempts to
restart the old CPU container, without marking the requested MPS deployment successful.
`make down` also removes/stops the owned native LaunchAgent and keeps cached model files.

CUDA setup automatically appends `docker-compose.viegem-cuda.yml`, builds pinned `cu130` PyTorch
wheels, reserves one NVIDIA GPU only for inference, and tests driver access plus an actual CUDA
operation before changing application containers. Windows uses WSL2 and Docker Desktop GPU
integration; native Windows Python is unsupported. NVIDIA driver installation is not automated.
The CUDA configuration/tests do not substitute for validation on a real NVIDIA machine.
The subsequent RTX 5060 Laptop/WSL2 startup and audio probe is recorded in the
[VieGem worker README](../transcription/viegem/README.md#windows-wsl2-cuda-verification--2026-11-05).

VieGem uses a token-free model-install job for Docker or prepares the same verified cache for native MPS.
Inference mounts cached weights read-only and receives tokens from the selected dotenvx env,
without mounting private keys. The shared Mac/Desktop endpoint stays at host port 18005;
Docker engines must provide host-gateway reachability for that published endpoint.
Only a fresh transcription registry defaults to VieGem; existing ASR preferences are preserved.
Enabled account preferences decide which workers remain running; no account can stop another account's ASR.

## Usage

`make all` also builds the public-only Agent Reach worker on the private network. New configurations
grant four read-only web/GitHub tools through `TINA_CHAT_TOOLBELT`. Existing explicit toolbelts remain
unchanged; add `reach.web.search`, `reach.web.read`, `reach.github.search`, `reach.github.read` to enable
them for chat. `TINA_AGENT_REACH_URL` selects retrieval for voice web queries after the room's existing
web permission and explicit public-query checks. Empty retains the provider's web search. No host
cookies or GitHub tokens are imported. See [Agent Reach](../agent-reach/README.md).

### Meeting voice

On a fresh clone, install the normal prerequisites and place the shared release
`.env.keys` at the repository root. Plain `make all` seeds the local config with
meeting voice and CPU Gipformer. It downloads and verifies the encrypted Enhanced
bundle from GitHub, unlocks it with that same key, and populates the model volume.
Existing env files are preserved. The verified volume is reused on subsequent runs.

Set `TINA_MEETING_VOICE=1` to enable voice on an instance with trained wake word models and a TTS
token. To also enable the LiveKit Agents runtime, set `LIVEKIT_AGENT_URL=http://livekit-agent:8080`.
When the main environment has no TTS token, Stack loads `deploy/tts/.env` with the shared root
`.env.keys`. An optional local TTS pair can override it; its key is never forwarded to containers.
Provision the root private key privately before first startup. `make plan` reports
`meeting_voice`, `tts_credentials_ready` and `kws_models_source` without writing configuration.

`make all` verifies the two retained KWS ONNX files in the model volume. If absent, it imports
`hey_tina.onnx` and `tina_oi.onnx` using the existing checksum-validated atomic installer from
`TINA_KWS_MODELS_DIR` (relative paths resolve from the repo root; the default is
`output/wakeword-training/tina-v1/models`). Missing or invalid artifacts stop before application
restart. A new install with voice enabled needs the trained artifact pack. Models remain read-only
in inference bots.

Application readiness authenticates to TTS and checks Agents `/ready`, including cross-service
TTS credentials/audio format. `make all` does not print the provisioned API key into logs; the
explicit `make -C deploy/compose provision-token` command remains available when needed.

The same operations are available as `tina` CLI/TUI after `make cli-install` from the repo root.
See [CLI commands, output and safety semantics](bin/README.md#local-tina-cli--tui).
New local users can run `tina setup` for prerequisite/conflict checks, a private fresh configuration,
source build/start and optional ASR configuration. See [first installation](bin/README.md#first-installation-cli-040).
Existing installations keep using `plan`/`deploy`; setup never replaces their env files or data.

Prerequisites: Python 3, make, Docker engine >=26 and Docker Compose with `up --wait` support.
When the selected env file is Dotenvx-encrypted, `make`/the TINA CLI also require the Dotenvx CLI and
the matching private key in `.env.keys` (kept outside Git). Stack commands decrypt into a mode-0600
temporary env file for Compose; generated credentials in a Dotenvx-managed file are written encrypted.
Plain private `ENV_FILE`s remain supported.

On a fresh clone, `make all` creates the ignored `deploy/compose/.env` from the template and
generates the application secrets. Follow the [Google sign-in guide](../../README.md#set-up-google-sign-in)
to enable Google login. For an isolated checkout or a config path outside the repository, use the
first-install CLI:

```bash
mkdir -p "$HOME/.config/tina"
make cli-install
export PATH="$HOME/.local/bin:$PATH"
export ENV_FILE="$HOME/.config/tina/.env"
tina setup --dry-run
tina setup
```

```bash
make plan        # read-only: selected project, files, services, volumes and image references
make all         # seed secrets, build bot/services/worker, pull infra, start, wait, provision access
make doctor      # read-only: required images and readiness of every selected service
make ps
make logs
make down        # same selected project; preserve volumes
```

`make all`/`build`/`bot` default to source image tag `dev`; `IMAGE_TAG=...` in the shell or Make
command line overrides it. Direct Compose commands and read-only status commands retain the `.env`
image tag. Every required service/worker image must finish before activation. `up --no-build
--pull never --wait` then waits up to `WAIT_TIMEOUT` seconds (default 180), and key provisioning
must succeed before the entrypoint reports success. Provisioning creates a new scoped key on each
successful invocation. This verifies control-plane readiness, not ASR accuracy or meeting acceptance.

Project selection follows explicit `PROJECT` (or legacy `COMPOSE_PROJECT`), then Compose's normal
`COMPOSE_PROJECT_NAME` environment/dotenv precedence. The resolved name is also used for Runtime's
network and Agent's workspace volume. A custom env file selects both interpolation and service
`env_file` values; paths passed through Make are relative to `deploy/compose` unless absolute:

```bash
make plan ENV_FILE=/absolute/path/to/instance.env
make plan PROJECT=another-instance
```

Docker context is pinned for each run, together with the built-in Buildx builder for that context.
Optionally persist DOCKER_CONTEXT in the env file to bind the deployment to its data daemon; an
explicit shell DOCKER_CONTEXT/DOCKER_HOST wins. The global Docker context is never switched.
A different BUILDX_BUILDER is refused for local source builds so images cannot be exported to another daemon.

On Kiri, Runtime mounts `~/.kiri/run/docker.sock` so it talks to the selected engine. Kiri currently
does not enforce Docker `VolumeOptions.Subpath`; because TINA uses that feature to isolate each
worker's workspace grants, the Compose runner refuses the Kiri Docker runtime and keeps workload
spawning stopped until a backend with enforced subpath mounts is configured. TINA's API, calendar,
and meeting history services can still run on Kiri.

Persist optional profiles and override paths in that env file, or pass them in the environment:

```dotenv
COMPOSE_PROFILES=dashboard
COMPOSE_FILE=docker-compose.yml:/absolute/path/to/machine-override.yml
```

Compose's `COMPOSE_PATH_SEPARATOR` is supported. Preserve the deployment's actual chain/order of
files. Changes to that chain or omission of an already-running profile service stop before build or
container changes; `ALLOW_CONFIG_CHANGE=1` allows an intentional change. `make all` builds source into
the selected image references, so do not include a snapshot/release-image overlay when you intend
to preserve those images. Use a source-build configuration explicitly for a source upgrade.

A fresh `.env` receives a random admin/signing token and internal secrets with owner-only file
permissions. Existing non-empty valid values are preserved. Published admin placeholders are
refused without rotating them: changing an existing signing secret requires a deliberate migration.
`make -n all` only prints recipes; `make plan` resolves the configuration without mutation or secrets.

Desktop/Capture, the extension and host ASR/alignment/diarization workers remain separate. Use the
[Desktop launcher](bin/README.md), [native Capture instructions](../../clients/desktop-native/README.md)
and the chosen backend under `deploy/transcription`. Saving a backend in Settings does not start
its server. The entrypoint does not infer missing user credentials from an empty deployment `.env`;
verify user/global STT and model/subscription choices in Settings → Models.

`make -C deploy/compose down` removes containers and keeps data volumes. To deliberately delete
the database, recordings, Redis data and agent workspaces, use
`make -C deploy/compose destroy DESTROY=yes`. `make -C deploy/compose help` lists both commands.

Storage readiness checks the same endpoint as meeting-api (`S3_ENDPOINT`, else `MINIO_ENDPOINT`
with `MINIO_SECURE`), creates the bucket if absent, and verifies a PUT/GET/DELETE probe outside
`recordings/`. Any failure prevents meeting-api from starting. After a MinIO upgrade, old
recordings stay in the old volume and do not play back from the new storage until copied with
`make -C deploy/compose migrate-storage`. Update `.env`'s old endpoint to `storage:9000` as shown
in the [upgrade guide](../../docs/docs/upgrade-from-minio.mdx).

`.env.example` documents every variable (faithful to the 0.11 `deploy/compose` names: `DB_*`,
`REDIS_URL`, `ADMIN_TOKEN`, `INTERNAL_API_SECRET`, `MINIO_*`, `BROWSER_IMAGE`/`AGENT_IMAGE`,
`DOCKER_GID`, `*_HOST_PORT`).

## Option A: real-model browser smoke test

The Discussion Review overlay runs local Qwen 2.5 7B Instruct inference through Ollama. It requires
Docker Compose with NVIDIA GPU access (8 GB VRAM is sufficient), Node.js >=22.13, pnpm 11.7, and
Chrome installed where Node can launch it. On Windows, run the setup from WSL2 with Docker Desktop's
GPU integration enabled. The model download is several GB and happens on first start.

For a fresh isolated local installation, run these commands from the repository root in WSL2/Linux.
The private config lives outside the checkout, and `tina setup` refuses to overwrite an existing
config or project:

```bash
make cli-install
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.config/tina"
export ENV_FILE="$HOME/.config/tina/discussion-review.env"
tina setup --dry-run --project tina-local
tina setup --project tina-local
```

Layer in the local model overlay, install workspace dependencies if needed, and run the real UI test:

```bash
docker compose --env-file "$ENV_FILE" \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/docker-compose.discussion-local.yml \
  -p tina-local up -d --build --wait --wait-timeout 180

pnpm install --frozen-lockfile
TINA_REVIEW_TEST_ENV_FILE="$ENV_FILE" node clients/terminal/tests/discussion-review.docker.mjs
```

The smoke test logs in as `reviewer@example.test`, creates a synthetic completed meeting, and checks
the report through the Terminal UI against the configured local model. It also checks schema validity,
exact source quotes, unchanged canonical transcript, cached reuse, owner isolation, and reload
persistence. Each run leaves its synthetic meeting in the local database; screenshots and JSON reports
are written under the ignored `output/discussion-review-docker/` directory. Review output for one
synthetic fixture does not establish general classification accuracy.

The test defaults to `deploy/compose/.env.local`, `tina-local`, and `http://localhost:13000`; override
the private config path with `TINA_REVIEW_TEST_ENV_FILE`, the Compose project with
`TINA_REVIEW_TEST_PROJECT`, or the loopback URL with `TINA_REVIEW_TEST_URL`. Stop the stack without
deleting its model or data volumes by running the same Compose command with `down` instead of `up`:

```bash
docker compose --env-file "$ENV_FILE" \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/docker-compose.discussion-local.yml \
  -p tina-local down
```

## Smoke probe — "is this install actually working?"

### Existing OrbStack production instance

The migrated local instance selects `DOCKER_CONTEXT=orbstack`, project `tina-production`, and
`docker-compose.orbstack.yml` in its private `.env`. Its five imported data volumes are external;
keep them when rebuilding or stopping the stack. The overlay requires those volumes to exist and
is not a fresh-install preset. It preserves the source assembly with Flows/MCP off unless profile
`automation` is selected. [Migration evidence and operational limits](../../docs/research/orbstack-cutover-20261030.md).

`make doctor` checks this selected instance. Desktop/Capture and native ASR workers remain on macOS.

```bash
make probe                       # from the repo root (compose is the default surface)
```

Drives the ONE full journey through the gateway front door — spawn → schedule → boot → join →
transcribe → live-view → stop — then sweeps every component's logs once. Each stage prints
Expected / Actual / Verdict; a red stage names where the journey broke and fails the command.
With the mock bot as `BROWSER_IMAGE` (`mock-bot:dev`) the journey is a deterministic green,
transcript included; with the real bot it drives a dead synthetic meeting to a truthful named
`join_failure`. See `deploy/compose/probe.sh` (a wrapper over `scripts/probe/journey.sh`).

## ASR start/stop by account

Settings → Models → Transcription controls the managed VieGem worker.
Selecting a managed model starts it and verifies authenticated audio,
then updates only the signed-in account. Turning the account switch off disables new transcription for
that account. It does not stop another account's worker or overwrite their preference.

A worker with no enabled account demand is retired after ten idle seconds, only after all
meeting bots/local Desktop captures have ended and its in-flight requests have drained. The UI
shows physical worker state separately from the account's enabled state. Changing a setting never transfers an
already-running capture to another model. Keep all capture on this managed host; remote unmanaged
captures must remain operator-managed because their session lifetime is not observable here.

`make all` installs an authenticated host controller on loopback port 18007 (override with
`TINA_ASR_CONTROL_PORT`), passed to Terminal as `TINA_ASR_CONTROL_URL`. The controller receives
only known backend names and verified account IDs; no Docker socket or command execution API is
exposed to the browser. Private keys remain on the host and ASR tokens never reach the UI.
Identity stores versioned account preferences; the controller serializes lifecycle changes and
reconciles them every two seconds. `make down` stops the controller first. WSL2 restores its
detached controller with `make all` after a reboot; Mac uses an owned per-deployment LaunchAgent.

`make doctor` checks the ASR backends demanded by enabled accounts, including native MPS.
A managed backend with zero current account demand may remain stopped without failing the
deployment check. Per-session capture/ASR health remains a separate meeting diagnostic.

## Vietnamese turn detector observations

New voice bots default to `TINA_VOICE_TURN_SHADOW=1`. The existing model-bootstrap job prepares
hash-pinned Smart Turn v3.2 CPU INT8 and Namo Multilingual INT8 assets (about 352 MB with tokenizer)
in the shared model volume. Bot inference mounts the cache read-only. A separate CPU child produces
content-free score/timing observations only; existing VAD/ASR endpointing and transcript writes remain
the authority. Set `TINA_VOICE_TURN_SHADOW=0` and start a new bot to disable observations.
See [shadow mode](../../docs/tina-turn-shadow.md) for limits and evaluation requirements.

### Upgrade from managed Gipformer

The old `asr` profile and built-in Gipformer endpoint are retired. Configure
`TINA_VIEGEM_TOKEN` in the existing private environment to use managed VieGem,
or configure an active external transcription endpoint. Accounts that selected
Gipformer inherit the current deployment default. A saved Gipformer platform
default resolves to VieGem when its URL and credential are available.

If a previous Compose deployment still runs Gipformer, end any captures first and stop the old
service in that same Docker context and Compose project before running `make all`. The deployment
guard detects running services that are absent from the new Compose file. Keep its model cache
if you still run standalone benchmarks.

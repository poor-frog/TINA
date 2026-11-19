# VieGem-ASR + KenLM + FSMN for TINA

Optional HTTP-window worker for `5CD-AI/VieGem-ASR`. Uses the existing TINA Bot/Desktop
OpenAI-compatible boundary; select **VieGem + LM** under **Settings → Models → Transcription → Backend**.
The named backend resolves its credential on the server. Existing sessions and default backend selection are not changed by installation.

## Model and runtime

VieGem CTC runs with PyTorch FP32 on explicit `mps`, `cpu`, or `cuda`; FSMN and the
upstream KenLM 4-gram prefix beam decoder run on CPU. No automatic device fallback.
LM parameters follow the published example: alpha 0.35, beta 1.5, beam width 32;
the FSMN end-of-silence default is 1200 ms (Gipformer remains at 800 ms); explicit valid
`min_silence_duration_ms` requests still override it. Name bias is disabled by default. This
endpoint does not accept decoder tuning from clients.

This is bounded HTTP-window inference (`streaming=False`), not an incremental cache/session
implementation. It accepts up to 90 seconds, decodes VAD ranges of at most 30 seconds,
and returns original 16 kHz source-clock speech intervals. These are not word timestamps.
Clips cut inside a word can lose boundary speech; assess with recorded meeting audio before
production selection. Draft/final confirmation remains in TINA's existing pipeline.

Model output is lowercase, without punctuation, with numbers in spoken form. English is
supported principally inside Vietnamese speech; `en` is an accepted hint, not a guarantee of
English meeting quality. `auto` returns language `unknown`. Prompts are accepted for API
compatibility but do not condition this CTC model. Preserve raw ASR separately from edits/polish.

The `model-assets.json` manifest pins VieGem code/checkpoint/LM and Google EmbeddingGemma 2
base weights/tokenizer/feature config to exact revisions and SHA-256. Verify every file before
loading; only then import the pinned upstream `asr` code. `torch.load(weights_only=True)` loads
the checkpoint. The model reconstructs frozen encoder parameters from the pinned local base;
missing trained parameters and unexpected checkpoint keys fail startup. Both models, code and
license notices remain in ignored `deploy/transcription/models/viegem-fsmn/`.

The checkpoint alone is not the complete model: the base weights add about 1.49 GB on disk.
Peak startup/model/Metal memory must be measured on the target machine. Calls are serialized
because the upstream encoder stores intermediate activations on its module instance.

## Start through make all: automatic GPU selection

Clone the repository, install dotenvx, provide its matching private `.env.keys`, and run `make all`.
The default `TINA_VIEGEM_DEVICE=auto` selects native MPS on Apple Silicon or Docker CUDA on
Linux/Windows WSL2. Only VieGem CTC and its frozen encoder move to the GPU; FSMN and KenLM stay
on CPU. Native Windows Python/PowerShell is unsupported: run the commands inside WSL2 with
Docker Desktop Linux integration and a supported NVIDIA Windows driver.

`make plan` reports the proposed device without launching a GPU job. `make all` checks actual
compute before activation: native MPS executes a tensor operation after dependencies are ready;
CUDA verifies Docker NVIDIA access and then a CUDA operation in the pinned runtime image.
Missing/incompatible GPUs cause a clear failure rather than silent CPU fallback. The subsequent
model/audio probe must also pass. The original Mac-only checks covered configuration/failure
paths; the Windows WSL2 CUDA verification below records the subsequent NVIDIA hardware check.

For MPS, setup installs missing uv/cmake through Homebrew, creates Python 3.11 and prepares the
same hash-verified cache. Docker's VieGem profile is omitted from the active Mac services; its
previous owned CPU container is stopped before the managed native worker binds 18005.
The owned LaunchAgent reads only the worker token from the selected encrypted env. If native
startup fails, deployment reports failure and attempts to restart the old CPU container.
`make down` stops/removes the owned native LaunchAgent and keeps cached model files.

For CUDA, the entrypoint adds `docker-compose.viegem-cuda.yml`, selects pinned `cu130` PyTorch
wheels and reserves one GPU for the inference container. The model-install job needs no GPU and
fills the cache before application activation. Inference mounts this cache read-only and receives
only its runtime token; private dotenvx keys are not mounted. `TINA_VIEGEM_DEVICE=cpu make all`
explicitly selects the optional CPU image instead. The GPU/CPU Docker endpoint publishes host
port 18005, preserving the existing native Desktop loopback rewrite on Mac/WSL-compatible hosts.
Other Docker engines need equivalent host-gateway reachability or an appropriate endpoint.

Gipformer's `asr` profile and model installer remain independent. Terminal starts the selected
worker and retires the previous one only after all accounts and active sessions release it. Existing
user/global preferences are preserved; only a fresh registry receives a new VieGem default.

## Install on native Apple Silicon

Use a separate Python 3.11 environment. The first download requires network access; serving
is offline and loads local files only. No `trust_remote_code` loading is enabled.

```sh
uv venv --python 3.11 .venv/viegem
uv pip install --python .venv/viegem/bin/python -r deploy/transcription/viegem/requirements.txt
python3 deploy/transcription/viegem/install-models.py
# Create ~/.config/tina/.env.viegem with TINA_VIEGEM_TOKEN, then encrypt it:
dotenvx encrypt -f "$HOME/.config/tina/.env.viegem" -fk "$HOME/.config/tina/.env.keys"
export TINA_VIEGEM_DEVICE=mps
sh deploy/transcription/viegem/start.sh
```

The standalone default address is `127.0.0.1:18005`. `make all` keeps the native MPS worker on
loopback for Docker Desktop; with OrbStack it binds only to OrbStack's private `bridge100` address
and registers that address for Docker-hosted TINA. The bearer token remains required. Configure the
managed registry with the same token.
The server accepts the original model ID, `custom`, and the legacy `whisper-1` alias.
`/health`, `/status`, `/capabilities`, `/v1/models` and authenticated
`POST /v1/audio/transcriptions` match the existing worker contract.

`TINA_VIEGEM_DEVICE`, `_HOST`, `_PORT`, `_TOKEN`, `_MODEL_DIR` are startup-only variables.
For CPU use `TINA_VIEGEM_DEVICE=cpu`; CUDA requires a compatible NVIDIA/PyTorch setup on its
host. CUDA is not verified by the Mac checks. MPS runs on the Mac host, outside Linux Docker.

Authentication occurs before multipart parsing. The shared HTTP worker caps upload at 25 MiB,
permits one inference plus three waiters, expires queue waits after 10 seconds, and retains
the inference lock until a cancelled native operation finishes. Diagnostics contain timings,
model/device and queue information, never audio, transcripts, or credentials.

## Checks

```sh
.venv/viegem/bin/python -m unittest discover -s deploy/transcription/viegem -p 'test_*.py'
.venv/gipformer-fsmn/bin/python -m unittest discover -s deploy/transcription/gipformer -p 'test_*.py'
```

The model-free checks cover API auth, limits, languages, errors, short/silent input and exact
speech samples/source offsets. Real-model evidence must additionally cover load, nonempty
speech, silence, malformed input, Bot/Desktop delivery and latency. Do not compare published
WER directly with TINA's pilot: normalization and source subsets differ. Use the same frozen
audio and report greedy, LM and current Gipformer separately before switching defaults.

## License and sources

VieGem is CC-BY-NC-SA-4.0 for non-commercial research, and use also follows Gemma terms.
Keep the downloaded model cards and original notices. This backend is not represented as
commercially licensed. The installer neither accepts new external terms nor uploads audio.

- [VieGem model card](https://huggingface.co/5CD-AI/VieGem-ASR)
- [Pinned inference code](https://huggingface.co/5CD-AI/VieGem-ASR/blob/95eae70b21fb0ef640e3ac4ea8cfa2380872ed20/asr/model.py)
- [Pinned KenLM decoder](https://huggingface.co/5CD-AI/VieGem-ASR/blob/95eae70b21fb0ef640e3ac4ea8cfa2380872ed20/asr/lm_decode.py)
- [Google base](https://huggingface.co/google/embeddinggemma-2)

## Verified on this Mac — 2026-11-04

The earlier native worker was installed as GUI-user LaunchAgent `local.tina.viegem`, with
`RunAtLoad`/`KeepAlive` and loopback `127.0.0.1:18005`. Launcher:
the repo’s `deploy/transcription/viegem/start.sh`; the generated plist selects the deployment’s
encrypted env and matching private key. The earlier standalone installation used
`~/.config/tina/.env.viegem` and `~/.config/tina/.env.keys` (both mode 0600).
`start.sh` reads only `TINA_VIEGEM_TOKEN` through dotenvx with strict decryption and file
precedence over ambient variables; unrelated deployment secrets are not injected.
`TINA_VIEGEM_ENV_FILE` selects the encrypted env and `TINA_VIEGEM_KEYS_FILE` selects its key file
(default: adjacent `.env.keys`). If no file exists, an explicitly supplied `TINA_VIEGEM_TOKEN`
is still accepted. The plist contains no credential. Logs:
`~/Library/Logs/TINA/viegem.{stdout,stderr}.log`.

Real pinned weights + KenLM loaded on Apple MPS in FP32. A frozen public FLEURS VI
10.5 s clip returned nonempty speech and source VAD bounds; the first measured HTTP
request took about 1.28 s. Silence returned empty text; malformed audio returned 400;
missing credentials returned 401. Real HTTP → Bot → disposable Desktop → canonical
and memory smoke passed with one confirmed segment per path and zero pipeline faults.
The production Meeting API container reached the Mac worker and an authenticated empty
request returned 422, proving the shared Custom endpoint network/auth boundary.

A separate 69.47 s scripted TTS VI/EN meeting returned 15 VAD segments, WER 10.06%,
CER 12.46%, in about 1.58 s HTTP. This single diagnostic is not a representative
meeting/code-switch benchmark, a greedy-vs-LM comparison, or live UI latency measurement.
Do not infer CUDA performance or model superiority from it. Evidence remains outside Git:
`~/tina-test-rig/viegem-20261104/` (integration log and synthetic-meeting JSON).

To select this worker for the next session, configure the managed registry below once,
then choose **VieGem + LM** in the Terminal transcription Backend menu. Users do not
enter the worker token. Installing the worker alone does not change account/global ASR settings.

The shared HTTP boundary retains its inference lock through repeated request cancellation,
including a model failure during cancellation. The GMeet transcript filter preserves short
replies such as “Có” and “Không”; it still rejects punctuation-only output and known artifacts.

## Managed Terminal selection

`viegem` is a named backend in Identity's transcription registry, like Apple/NVIDIA.
An administrator configures `viegem_url` once under Global defaults. Set
`TINA_VIEGEM_TOKEN` in the dotenvx-encrypted `deploy/compose/.env`; the source-build stack
entrypoint decrypts it at startup and passes it to Identity. Identity resolves this deployment
token before any legacy database token and never persists the environment value. While set,
token writes through Global defaults are rejected; rotate the encrypted deployment value and
restart Identity plus the native worker instead. Without this environment variable, the legacy
`viegem_token` registry field remains supported.
Users then select **VieGem + LM**; no personal token or service URL is required.
The server resolves platform-owned credentials for this selection only. Arbitrary Custom
endpoints never borrow this token. Browser-facing global settings omit the managed token;
the token field is write-only, and the regular user response only contains safe metadata.
The endpoint is unavailable for new selection until both registry fields are configured.
Legacy personal Custom endpoints remain valid and can still use their own tokens.

The 2026-11-04 dotenvx migration rotated the worker token, removed the legacy plaintext token
file and cleared matching current database credentials. Active secrets remain available to the
worker and Identity in process/container memory; dotenvx protects the env files at rest.
Historical backups may still contain the revoked old token. Keep decryption keys private.

## Docker CPU verification on this Mac — 2026-11-04

The selected deployment now runs `tina-production-viegem-1` on CPU, published at 18005.
The owned native MPS LaunchAgent was stopped and removed after a candidate container passed
health/auth/audio checks. Model caches and dotenvx private keys were preserved; the serving
container mounts models read-only and has no private key mount. `make all` completed with both
independent model-install jobs and healthy Docker ASR workers; Terminal's selected VieGem probe
returned HTTP 200 without a personal token.

A small diagnostic used the same three cached FLEURS VI clips (6.60–10.56 seconds), two requests
per runtime, with unchanged FSMN and KenLM settings. Median HTTP time was 0.668 s on Docker CPU
and 0.122 s on native MPS; CPU median/max real-time factors were 0.071/0.088. Text matched between
runtimes on these three clips. This is not a representative WER, sustained meeting load or CUDA
benchmark. Private evidence: `~/tina-test-rig/viegem-docker-20261104/`.

## Automatic GPU verification on this Mac — 2026-11-04

The current `auto` deployment completed through `make all` and selected native MPS. The old
owned CPU container is stopped; native health reports `device=mps`. MPS tensor computation,
three cached VI speech clips and Terminal's authenticated ASR probe passed. The three speech
outputs matched the earlier CPU diagnostic; this does not establish general WER equivalence.
KenLM/FSMN CPU placement, dotenvx credentials, cached weights and account selection are preserved.
CUDA Compose resolution and mocked driver/kernel failure paths passed; no real NVIDIA hardware
was available to build/run/benchmark the CUDA image. Evidence:
`~/tina-test-rig/viegem-auto-gpu-20261104/`.

## Windows WSL2 CUDA verification — 2026-11-05

The local deployment passed a CUDA tensor computation on an NVIDIA GeForce RTX 5060 Laptop GPU
(8 GB) with the source-built PyTorch 2.14.1/cu130 image. All pinned model assets passed their
SHA-256 checks. One public FLEURS Vietnamese validation clip (14.94 seconds) returned nonempty
speech and four source-clock segments in 2.19 seconds; silence returned empty text and a request
without credentials returned HTTP 401. This is a startup/integration check, not a WER benchmark.

This host uses an 8 GB WSL2 memory ceiling and 4 GB swap. The local VieGem service has a 4 GB
memory limit (5 GB including swap); the earlier 6 GB WSL2 ceiling was insufficient while a live
bot, development Terminal and both ASR workers were active. Raising a WSL2 limit requires a WSL
restart: finish active meetings first. After restarting WSL, recreate any service whose stale
Docker Desktop bind mount no longer resolves its host files before declaring it healthy.
Installation preserves global defaults and other accounts' transcription choices.

## ASR start/stop by account

Settings → Models → Transcription now controls the managed Gipformer and VieGem workers.
Selecting a managed model starts it and verifies authenticated audio,
then updates only the signed-in account. Turning the account switch off disables new transcription for
that account. It does not stop another account's worker or overwrite their preference.

A worker with no enabled account demand is retired after ten idle seconds, only after all
meeting bots/local Desktop captures have ended and its in-flight requests have drained. The UI
shows physical worker state separately from the account's enabled state. If another account
still selects the old model, both workers stay running. Changing a setting never transfers an
already-running capture to another model. Keep all capture on this managed host; remote unmanaged
captures must remain operator-managed because their session lifetime is not observable here.

`make all` installs an authenticated host controller on loopback port 18007 (override with
`TINA_ASR_CONTROL_PORT`), passed to Terminal as `TINA_ASR_CONTROL_URL`. The controller receives
only known backend names and verified account IDs; no Docker socket or command execution API is
exposed to the browser. Private keys remain on the host and ASR tokens never reach the UI.
Identity stores versioned account preferences; the controller serializes lifecycle changes and
reconciles them every two seconds. `make down` stops the controller first. WSL2 restores its
detached controller with `make all` after a reboot; Mac uses an owned per-deployment LaunchAgent.

## Experimental TINA name bias

`TINA_VIEGEM_NAME_BIAS` is an operator-only value from 0 to 2, default **0 (no extra name weight)**.
It changes only the KenLM decoder: a positive value admits lowercase `tina` to its word/prefix vocabulary
and adds that score when the word is completed. The vocabulary change also removes upstream
OOV/partial-word penalties, so even a small weight can affect competing words. It is not a
per-request prompt and does not change the model weights, alpha/beta, beam, FSMN or source clock.
The baseline decoder is not mutated. Make-all forwards the value to native MPS or Docker CUDA/CPU;
changing it requires restarting the corresponding worker after active requests have drained.

custom_words.txt is a worker-wide word list outside the model asset directory. Blank
lines and lines starting with # are ignored; whitespace-separated entries are independent words,
not phrase constraints. TINA_VIEGEM_CUSTOM_WEIGHT is a finite value from 0 to 2 (default 1.0),
and TINA_VIEGEM_CUSTOM_WORDS_FILE can select another worker-visible file. A positive name weight
sets tina's weight independently. The reserved word tina is ignored in this list and controlled
only by TINA_VIEGEM_NAME_BIAS.
These terms bias every request handled by this VieGem worker, not a meeting-specific context.
Changes are read at worker startup, so restart the worker to reload them. The default file is copied
into Docker images and included in the native worker revision fingerprint; it is not part of
model-assets.json.

The bundled list is active globally at its default weight; set TINA_VIEGEM_CUSTOM_WEIGHT=0 to
disable it. A word prior can add a term where it was never spoken, so evaluate changes on matched
audio with labeled positives and negative near-homophones before expanding the list. The report from
benchmark/name_bias.py keeps real hypotheses/audio private and distinguishes synthetic controls
from unlabeled real candidates.

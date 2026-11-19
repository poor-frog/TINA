<div align="center">

<img src="assets/logodark.svg" alt="TINA logo" width="72"/>

# TINA

**Meeting bots and real-time transcription — self-hosted.**



![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)
![Source baseline](https://img.shields.io/badge/source%20baseline-0.12-informational.svg)
![Deploy](https://img.shields.io/badge/deploy-self--hosted-success.svg)

Run the complete system on infrastructure you control. TINA has no hosted API or account service.

</div>

---

## Transcript translation

After a meeting ends and its summary is ready, the optional automation stack can email each known
attendee a Vietnamese thank-you message with links to the saved summary and recording. Access is
bound to the recipient's signed-in email. See [post-meeting email setup](core/flows/README.md#email-after-a-meeting).

Meeting Bot transcripts in Terminal and the Chrome extension share a language dropdown:
**Tiếng Việt**, **English**, and **Song ngữ** (the default). English/bilingual views use the
saved **Meeting model** in Settings → Models. Provider credentials remain on the server.

The backend groups consecutive finalized ASR fragments of the same speaker before translating.
Vietnamese remains visible while a phrase is forming or the model API is unavailable. Translation
results are cached for both clients; editing source text invalidates the affected phrase. New
translation calls pause when no English/bilingual view remains open. Desktop archive rows in
the extension currently retain their original-only view.

See the [extension guide](clients/extension/README.md),
[Terminal canvas guide](clients/terminal/src/canvas/README.md), and
[grouped translation contract](core/agent/contracts/meeting-translation.v2/README.md).

## ⚡ Quickstart

This checkout starts the configured `tina-production` deployment with automatic GPU selection for VieGem: native MPS on Apple Silicon, or Docker CUDA on Windows/WSL2 with NVIDIA GPU support. Gipformer stays in Docker on CPU. On macOS,
start OrbStack or Docker Desktop first. You need Docker Engine 26+, Compose with `up --wait`, Python
3.10+, `make`, and the private Dotenvx key that matches this repository's encrypted config.

### 1. Clone the repository

```bash
git clone https://github.com/poor-frog/TINA.git
cd TINA
```

### 2. Install Dotenvx

On macOS, use the official Homebrew tap:

```bash
brew tap dotenvx/brew
brew trust dotenvx/brew
brew install dotenvx
```

Or install the CLI with npm: `npm install --global @dotenvx/dotenvx`.

### 3. Add the matching private key

Get the existing `.env.keys` file from your private password manager or secure backup and place it at
the repository root. It must contain the `DOTENV_PRIVATE_KEY` matching `deploy/compose/.env`. The
file is ignored by Git and must never be committed or pasted into documentation, shell commands, or
chat. A newly generated key will not decrypt this repository's config.

Optional speech/TTS has its own encrypted env, protected by that same root key; see
[`deploy/tts/README.md`](deploy/tts/README.md#setup-on-another-machine-ubuntuwsl-or-linux).

### 4. Preview and start TINA

```bash
chmod 600 .env.keys
make plan     # read-only: check project, profiles and native_viegem
make all      # install models, build services, start and verify ASR
```

`TINA_VIEGEM_DEVICE=auto` is the default. `make plan` shows the proposed `viegem_device` without starting workers; `make all` verifies the actual GPU before changing running services:

| Host | VieGem acoustic model | KenLM / FSMN-VAD |
|---|---|---|
| Mac Apple Silicon | Native PyTorch MPS, managed LaunchAgent | CPU |
| Windows through WSL2 / Linux with NVIDIA | Docker CUDA, pinned CUDA 13.0 PyTorch wheels | CPU |

Windows commands must run inside WSL2 with Docker Desktop's Linux/WSL integration and the NVIDIA Windows driver configured. A native Windows Python/PowerShell deployment is not supported. Driver installation remains an operator prerequisite. A failed GPU/driver/kernel check stops deployment; there is no automatic CPU fallback. `TINA_VIEGEM_DEVICE=cpu make all` is an explicit optional CPU deployment.

On Mac, `make all` installs missing uv/cmake through Homebrew, creates native Python 3.11, checks MPS computation and downloads/verifies the pinned assets. It stops this project's old VieGem CPU container before starting the owned MPS LaunchAgent on port 18005. Other checkouts' workers are preserved. On WSL2, it verifies NVIDIA access, builds the CUDA image, tests an actual CUDA operation and prepares cached model assets before application activation. Both paths require an authenticated audio probe before access is provisioned.

The `asr` profile independently prepares Gipformer assets and starts its CPU container on 18002. Model weights and private dotenvx keys stay outside Git; keys are not mounted into inference containers. `make all` retains database, recordings and workspaces. A fresh transcription registry gets VieGem as its default; existing global and personal preferences remain unchanged.

The shared config enables `automation,asr,dashboard,viegem`. The entrypoint resolves that feature to the appropriate runtime; Mac's active Docker profiles exclude the VieGem container when MPS is selected. Terminal stays on 23000 and the API gateway on 28056. `make down` also stops/removes the owned native MPS LaunchAgent, retaining model files. Terminal retires the unneeded ASR worker only after all enabled accounts and active local sessions release it; see account-scoped control below.

Open Terminal after the command reports ready:

```text
  Terminal UI : http://127.0.0.1:23000
  API gateway : http://127.0.0.1:28056
```

Google OAuth credentials are already in the encrypted deployment config; on an empty database, the
first successful sign-in becomes administrator. Keep the API key printed by `make all` private.

This is the existing `tina-production` deployment, not a clean-install recipe. If you do not have
its matching private key, ask the owner for it through a secure channel. To create a separate local
instance with new volumes instead, follow the [fresh-install guide](deploy/compose/bin/README.md#first-installation-cli-040).
See the [VieGem guide](deploy/transcription/viegem/README.md) for the native worker and the [Gipformer guide](deploy/transcription/gipformer/README.md) for its Docker service. MPS is verified on this Apple Silicon Mac. CUDA configuration and failure paths are tested; a real NVIDIA/WSL2 run is still required for hardware validation.


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

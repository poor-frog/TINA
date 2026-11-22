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

Start Docker Engine 26+ with a Compose version that supports `up --wait`. You also need
Python 3.10+, Git, Bash, Make, and OpenSSL. On macOS, start OrbStack or Docker Desktop first.
On Windows, run the commands in WSL2 with Docker integration enabled.

```bash
git clone https://github.com/poor-frog/TINA.git
cd TINA
```

### Set up Google sign-in

In [Google Auth Platform](https://console.cloud.google.com/auth/clients), create a **Web application**
OAuth client. Add `http://127.0.0.1:13000/api/auth/callback/google` as an authorized redirect URI.
If you change the port or hostname, use the same origin in the browser, in `NEXTAUTH_URL`, and in the
Google redirect URI. Basic Google sign-in works for external apps in **Testing** with the standard
identity scopes. For optional Google Calendar and Meet access in Testing, add the account under
**Audience → Test users**. A friend running their own instance can create their own OAuth client.
[Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
· [Google app audience](https://support.google.com/cloud/answer/15549945)

Create the local configuration if it is missing, then use your editor to fill in `GOOGLE_CLIENT_ID`
and `GOOGLE_CLIENT_SECRET`.

```bash
(umask 077; test -e deploy/compose/.env || cp deploy/compose/.env.example deploy/compose/.env)
```

To encrypt this configuration at rest, install [dotenvx](https://dotenvx.com/docs/install) and run
these commands from the repository root:

```bash
dotenvx encrypt -f deploy/compose/.env
chmod 600 deploy/compose/.env deploy/compose/.env.keys
```

Keep the generated `deploy/compose/.env.keys` in your private backup. Each install has its own OAuth
configuration and stack secrets. Both local files are ignored by Git.

### Start TINA

```bash
make all
```

If OrbStack is running and Docker points at another context, use `DOCKER_CONTEXT=orbstack make all`.
On a fresh checkout, `make all` creates the local env from the template if needed, generates stack
secrets including `NEXTAUTH_SECRET`, builds the images, and starts the services. Open
[Terminal](http://127.0.0.1:13000) and choose **Sign in with Google**. The first successful sign-in
on a new instance becomes administrator. To connect the browser extension,
follow the [local extension setup](clients/extension/README.md#connect-to-local-compose).

Set up a transcription backend and Agent model in **Settings → Models** to use live transcription
and Ask TINA. For a local CPU backend, see [Gipformer](deploy/transcription/gipformer/README.md).
For native Apple Silicon MPS or Docker CUDA on Linux/WSL2, see
[VieGem](deploy/transcription/viegem/README.md). Wake word and spoken replies require a TTS token and
trained artifacts. See [meeting voice setup](deploy/compose/README.md#meeting-voice).

If you already run TINA from a checkout that tracks `deploy/compose/.env`, back up that file and
its matching `.env.keys` before pulling the update. Restore the env file at the same path to keep
your deployment settings and volumes.

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

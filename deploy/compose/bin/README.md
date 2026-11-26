# deploy/compose/bin — deployment and gate runners

## Local tina CLI / TUI

From the repo root run `make cli-install`. This installs a symlink at `~/.local/bin/tina` to
this checkout, refuses to replace another executable, and works outside the repo. Add that directory
to PATH if it is not already present. Requires Python 3.10+, Docker Compose and, for TUI, a macOS/Linux
TTY with Python curses. No new Python dependency is installed.

```bash
tina                       # TUI on a terminal; read-only status when piped
tina setup                 # new local install: preview, private config, build/start, optional ASR setup
tina setup --dry-run        # check prerequisites/conflicts; create nothing persistent
tina status
tina doctor --json
tina doctor --full          # Compose + host/ASR/worker diagnostics, without inference
tina check cli              # CLI regression tests; no live-stack mutation
tina check graph
tina check dataflow
tina check contracts
tina check all --json       # four checks, private logs, one JSON result
tina asr status             # global + configured Desktop selection, credentials hidden
tina asr verify             # host/container status, no audio upload
tina asr configure          # interactive scope/backend/endpoint/hidden token + preview
tina plan
tina deploy --dry-run
tina build --yes            # source images only; running containers remain
tina deploy --yes           # source build + activate + readiness + access provisioning
tina up --yes               # existing image tags; no build or pull
tina restart terminal --yes # existing container/image, no recreate
tina down --yes             # remove containers/network, preserve all volumes
tina logs runtime --tail 50
tina logs runtime --follow
tina open terminal
```

The CLI and Make entrypoint share `stack.py`; TUI calls the same CLI dispatcher. ENV_FILE,
DOCKER_CONTEXT, PROJECT and COMPOSE_FILE use the deployment rules in the parent README. The
installed symlink follows this checkout; keep it in place or rerun the installer from its new location.
No separate CLI credential/profile database is created. API meeting/transcript/routine commands
are outside this release.

The ASR controller reports disabled Compose profiles as stopped instead of failing the whole
runtime status request. Native MPS VieGem is still checked through its host endpoint without a Compose service.

### First installation (CLI 0.4.0)

Clone `https://github.com/poor-frog/TINA.git` or use an existing checkout. On macOS install and
start OrbStack or Docker Desktop. On Linux start a local Docker engine.
You need Python 3.10+, make (for CLI installation), git, bash, openssl and Docker engine >=26 with
Compose supporting `up --wait` and optional `env_file` entries. Builds download dependencies and
infrastructure images and can take several minutes; use a host with about 8 CPUs and 16 GB RAM.

```bash
cd /path/to/TINA
make cli-install
export PATH="$HOME/.local/bin:$PATH"  # add this to your shell profile for future terminals
mkdir -p "$HOME/.config/tina"
export ENV_FILE="$HOME/.config/tina/.env"
tina setup --dry-run                # inspect the new install; creates no config or Docker resources
tina setup                          # create the private config and a separate tina-local deployment
```

Use an explicit private path to keep this instance separate from a regular `make all` deployment.
Setup refuses to overwrite an existing config and uses the local Docker context (or explicit
DOCKER_CONTEXT), the base `docker-compose.yml`,
project/image tag `tina-local`, default loopback ports and new Compose-managed volumes. It does not
inherit another deployment's shell settings, profiles, credentials or migration overlay. Optional
Dashboard, Discord and mailbox profiles stay off. Base Compose includes MCP and flows; native
Desktop/Capture and ASR workers are separate. No existing service is stopped to free a port.

The preview checks the engine, bindings, occupied ports and existing project containers, volumes
and network before asking to continue. Setup refuses an existing configuration (including a symlink),
existing project resources and remote Docker sockets. It writes a complete mode-0600 `.env` without
overwriting anything, with new database/storage/auth/signing credentials, then reuses `tina deploy`
for source builds, activation, readiness and access provisioning. Your global Docker context stays
unchanged. Image tags are scoped to the new project; the shared bot build-base tag/cache is reused.

After deployment, an interactive terminal can run the existing global ASR configuration wizard
and host/container status verification. The endpoint/token remain your explicit choice. No ASR
model is installed or started. Skipping ASR returns `setup=platform_ready, asr_ready=false` with
next commands. Configure [Google sign-in](../../../README.md#set-up-google-sign-in) in the selected
`ENV_FILE`, run `tina deploy`, then sign in to Terminal and configure agent model or subscription
credentials in Settings → Models.

For scripts, `tina setup --yes --json` builds/starts the platform without prompts and returns the
ASR commands as next steps. It does not auto-configure ASR or open a browser. A failed ASR probe
returns exit 1 with the platform URL and diagnostics. Build failure or cancellation retains the
config and any created resources: inspect `tina status`, then retry with `tina deploy`; setup does
not reset an installation. The wizard is for local evaluation, not public/cloud hardening.

Existing installations should use `tina doctor`, `tina deploy` and `tina asr configure`. For a new
config path select `ENV_FILE=/private/existing-directory/.env.tina-new tina setup --project tina-new`;
keep using that ENV_FILE in subsequent commands. Its parent directory must exist, and default
ports must be free. If you need custom ports/profiles, prepare the env file explicitly and use
the existing `plan`/`deploy` flow. Do not use the imported-volume OrbStack migration overlay for a
fresh installation. Dry-run mints no credentials and creates no config, images or Docker resources.

### Full diagnostics and repository checks

`doctor` checks Compose; `doctor --full` additionally collects host and ASR diagnostics, even when
a Compose check fails. It resolves global/default ASR through Identity's existing read-only
`/internal/transcription/resolve` operation. Only explicit `deployment` selection may use environment
fallbacks. An invalid account credential or missing named backend never silently selects another model.
When `TINA_DESKTOP_API_KEY` is configured, Desktop ASR uses that account; bot diagnostics use global
defaults and do not claim to inspect every bot user's preference.

Desktop health is read at host loopback :8056. Capture bridge :9099 is a TCP-only probe: reachable
is reported as `not_verified`, without a WebSocket handshake or capture session. ASR `/status`
is checked from the host and the selected stack's Agent API container; tokens stay private and
container probe credentials travel via stdin, never process arguments. Worker URLs come from the
selected deployment; host-only worker env files and actual Capture permissions are not inspected.
`host.docker.internal` is translated to loopback only for host probes.

HTTP probes have bounded response sizes/timeouts, ignore proxy env variables and refuse redirects.
Only allowlisted metadata is returned; no transcript/audio is fetched and no inference/model-loading
job is submitted. `ready` covers required configured checks; `complete=false` highlights evidence
gaps such as an unverified listener. A reachable bridge is permitted with this evidence warning;
a closed bridge fails readiness. Optional unconfigured workers do not fail the command. An
unreachable configured worker or ASR does fail it. A backend without recognized `/status` diagnostics
is marked unsupported, never declared inference-ready.

`check [cli|graph|dataflow|contracts|all]` runs the existing tools from the repo root, independently
of Docker configuration. `check` defaults to all four, continues after a failure and returns a summary.
It neither seals schemas nor deploys. It requires preinstalled repo tools and the existing Compose
test environment; uv runs frozen/offline/no-sync and npm/npx is offline, so it does not install missing
dependencies. Checks create redacted logs under `~/Library/Logs/TINA/checks/` on macOS or
`~/.local/state/tina/checks/` on Linux, with private run directories and mode-0600 log files.
Each check has a 300-second timeout. Exit 1 means at least one failed; `data.checks` retains each
underlying exit code, log path and failure tail. Full-doctor failures similarly retain
`data.diagnostics` in the JSON error envelope. `--dry-run` runs no probes/checks and creates no logs.

The green TUI has Full system check and Repository checks entries using these same dispatchers.

### ASR settings (CLI 0.3.0)

The ASR settings TUI submenu offers status, verify and configure. `tina asr status` shows global
defaults and the configured Desktop binding. `--scope account` uses TINA_API_KEY, or the configured
TINA_DESKTOP_API_KEY, validates expiry/scopes through Identity and identifies the account ID. It never
accepts a user ID as authority and never falls back to global credentials after an account denial.
Status reads effective selection; verify additionally probes the saved host/container ASR status.
Neither command uploads audio, starts a model or changes settings. Active capture sessions may keep
their pinned backend; changes apply to new sessions. Actual per-bot user overrides may differ.

```bash
tina asr configure --scope global --backend custom \
  --url http://host.docker.internal:18005 --clear-token --dry-run
tina asr configure --scope global --backend custom \
  --url http://host.docker.internal:18005 --token-env TINA_ENDPOINT_TOKEN --dry-run
# After reviewing scope/endpoint/credential action, replace --dry-run with --yes to save.
tina asr status --scope account
tina asr verify --scope account
tina asr configure --scope account --backend default --dry-run
```

These URLs are explicit examples, not an auto-selected worker. Interactive configuration lists the
existing backend choices and requests the endpoint/token privately. Missing scope/backend in a
noninteractive configure is an error. An unchanged endpoint preserves credentials by omission.
Changing an endpoint with stored credentials requires a new token or explicit --clear-token, so an
old credential is not silently forwarded to a different service. `--token-env` takes a variable name;
`--token-file` takes an owner-only, non-symlink file with one raw token (not a dotenv file). Raw
--token/--api-key arguments are refused without echoing their values. No credential is stored in a new
CLI config file or printed in previews/results. Avoid putting secrets in endpoint URLs.

Global configuration uses existing GET/PUT /internal/settings/transcription; account changes use
/user/transcription with that account's API key. Custom global endpoints map to the existing
default_backend=deployment slot because the current API does not support a custom default_backend
value. FunASR/Sherpa named choices have URL slots but no token slot; use a custom endpoint for an
authenticated service. This API has no arbitrary per-endpoint model override: status shows the
request alias and verify shows model metadata actually reported by the endpoint.

Configure previews the context/project, scope, before/after endpoint, credential action and affected
new sessions. It requires --yes or interactive confirmation, re-reads settings to detect intervening
edits, sends only selected settings fields, reads back and resolves the result. A missing selected
project/Identity published port fails before sending a settings request. Other scopes and unrelated
fields are retained. The existing global settings API has no atomic CAS: concurrent administrator
edits may still race after the re-read. Failed/unconfirmed writes are not blindly retried or rolled
back; inspect status. Successful save is not proof of connectivity: run asr verify separately.

Read commands never provision tokens. Deploy verifies provisioning like make all and creates a
fresh scoped key; it suppresses the returned credential. Repeated deploys therefore are not credential
idempotent, so failed mutating operations are not marked automatically retryable. Up may recreate
containers when an image/config changed; restart uses Compose restart and keeps the running image.
Build updates tags which Runtime may use for subsequent spawned workloads.

`--dry-run` resolves and validates the target but never builds, starts, opens a browser, mints secrets
or tokens. Mutations show context/project and impact; use `--yes` for scripts. A non-TTY requiring
confirmation returns `confirmation_required`, never waits for input. No command removes volumes.

Output defaults to a table on a TTY, a single JSON envelope on a pipe. `--json` or `--format json|table`
overrides it. JSON has `ok`, `data` or `error`, and `meta.schema_version=1`. Long command output and
follow logs go to stderr; the final envelope stays on stdout. Known configured secrets, common
credential fields, bearer/basic headers and URL credentials are redacted. Arbitrary application text
cannot be guaranteed secret-free; review logs before sharing them. Help/version output is plain text.

Exit codes: 0 success; 1 execution/readiness failure; 2 invalid arguments/confirmation/interactive
requirement; 130 cancellation. Cancellation during a mutation does not promise rollback: check status.
TUI supports arrow keys or j/k, Enter, r refresh, Esc/q exit; it restores terminal modes on exit.

CLI/TUI copy is English. The TUI reads TINA's dark theme from `branding/tokens.json`: deep green
canvas, mint accent and a green selection bar. Colors adapt to programmable, 256-color and basic
color terminals, with a monochrome fallback. Any temporarily changed terminal palette entries are
restored when leaving the menu. `NO_COLOR` disables styling; JSON and piped output never receive
color escapes. Status tables use the same brand accents on interactive terminals.

Tests: `uv run --project deploy/compose/tests pytest deploy/compose/tests/test_make_entrypoint.py
deploy/compose/tests/test_tina_cli.py`. Operational commands must be exercised on an isolated project;
readiness is not a meeting/ASR/agent acceptance test.

`stack.py` owns the source deployment flow used by Make: Compose resolves project/env/overrides,
then all required images build before activation. `plan` and `doctor` are read-only; `all` waits
for selected services and fails if access provisioning fails. It never sources/evals dotenv text.
The same context is used for `down`, status and the meeting probe. See the [deployment guide](../README.md).

`stack-test` is the one entrypoint the `gate:compose` gate dispatches: it detects docker (skip green
if absent), then runs the stack-readiness proof (`../tests/stack_test.py`) via `uv run pytest`. The
proof owns the full up→prove→`down -v` lifecycle itself.

```bash
bin/stack-test                  # always-on subset (the routine gate)
COMPOSE_BOT=1 bin/stack-test    # + the real bot-spawn proof (steps 3·6a)
COMPOSE_NO_BUILD=1 bin/stack-test   # reuse cached images (skip --build)
```

`desktop-local.mjs` starts the native host Desktop against this stack's central ASR settings.
Run `node deploy/compose/bin/desktop-local.mjs` from the repository after building `@tina/desktop`.
It reads the identity port/internal secret from `.env`, binds only to `127.0.0.1`, and keeps STT
credentials server-side. Extension API keys select personal preferences; native capture follows
Global defaults unless `TINA_DESKTOP_API_KEY` binds an account. The launcher puts Desktop's ingest
listener on an ephemeral loopback port and exposes native capture through an authenticated proxy at
`127.0.0.1:9099`. A per-run HMAC secret is written with owner-only permissions under
`~/Library/Application Support/local.tina.capture/`; TINA Capture proves the proxy before starting
audio capture. See the
[Desktop README](../../../core/meetings/services/desktop/README.md) for restart/history restoration.

`sync-transcript.mjs SOURCE_MEETING_URL DESTINATION_BY_ID_URL` explicitly copies one completed
Desktop foundation snapshot into an owned Meeting API source replica. Set `TINA_API_KEY` and,
when required, `TINA_DESKTOP_API_KEY` in the environment. It refuses redirects and non-loopback
unencrypted URLs, reads at most 4 MiB, uses receiver CAS and reports only metadata. No PCM is uploaded.
See [stt-foundation.v1](../../../core/meetings/contracts/stt-foundation.v1/README.md).
Its isolated check is `node deploy/compose/tests/sync_transcript_test.mjs` from the repo root.

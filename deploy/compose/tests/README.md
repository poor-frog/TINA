# deploy/compose/tests — the gate:compose stack-readiness proof (P5)

`test_tina_setup.py` checks fresh-install isolation, prerequisites, occupied ports/resources,
atomic private config creation, confirmation, deploy reuse, recovery and optional ASR verification.
It uses doubles and runs in `tina check cli`; it never starts or stops the production stack.

`test_asr_control.py` also checks that an absent optional VieGem profile cannot break Gipformer
runtime status, while native MPS status remains available without a Compose VieGem service.

`stack_test.py` brings up the **real** v0.12 compose stack (see `../docker-compose.yml`), proves it
is ready to run the tina bot, and tears it all down (`down -v`) in a guaranteed finally — the
"fully tested / proven ready" deliverable, run via `make -C deploy/compose stack-test`.

The `stack` session fixture (`conftest.py`) owns the whole lifecycle: `docker compose up -d --build`
under an isolated project name, a bounded wait for every service `healthy`, then `down -v` on exit.
Everything polls with bounded timeouts — never sleep-and-hope. Absent docker → the module self-skips
(green-or-skip).

## What it proves

| step | proof | always-on? |
|------|-------|------------|
| 1  | `/health` 200 on gateway·meeting-api·runtime·admin-api | yes |
| 2  | admin-api mints a scoped token; gateway accepts it (200), rejects missing/invalid (401) + out-of-scope (403); a proxied call reaches meeting-api | yes |
| 4  | XADD golden segments → the collector consumer stores them (live segment hash) + publishes `tc:meeting:{id}:mutable` → a `/ws` client (through the gateway) receives the live frame | yes |
| 5  | upload a chunk via the bot's `/internal/recordings/upload` → the object lands in object storage (listed through meeting-api's own S3 client); finalize → a master is assembled there | yes |
| 6c | `continue_meeting` reuses the meeting row + accumulates a session; the prior transcript survives | yes |
| 6d | a user at `max_concurrent_bots` gets `429` on the N+1; a freed slot admits the next | yes |
| 6b | the join-retry re-spawn wiring is present in the live image; the **backoff proof leans on the offline P3 `test_join_retry.py`** (forcing a real transient join-failure on a live bot is slow/flaky) | yes (wiring) |
| 3  | `POST /bots` → meeting-api spawns via runtime → a real `tina-mtg-…` container appears in `docker ps` AND the meeting advances to `joining`; then the bot is stopped + cleaned | **`COMPOSE_BOT=1`** |
| 6a | start-then-stop a real bot → terminal; the leave-command channel wiring is asserted | **`COMPOSE_BOT=1`** |

## Run

```bash
make -C deploy/compose stack-test        # always-on subset (what gate:compose runs)
make -C deploy/compose stack-test-bot    # + the real bot-spawn proof (COMPOSE_BOT=1, slow ~7GB image)
```

On a host where other services hold the default ports (or a dev stack is already up), run the proof
beside them with `COMPOSE_DYNAMIC_PORTS=1` so the gate binds free random host ports.

### Always-on vs `COMPOSE_BOT`-gated — why

Steps 3 and 6a drive a **real `tina/tina-bot:v012` container** (Playwright browser, ~7GB image)
through its lifecycle (the published `tina/tina-bot:dev` is the old 0.10 line and fails the
`lifecycle.v1` handshake; a source-built bot from `make -C deploy/compose bot` also works). That
is slow and inherently flaky for a routine gate (browser boot, a dummy
meeting URL, callback timing). The fast steps (1·2·4·5·6c·6d·6b) exercise the entire control plane —
auth, the transcript bus, recordings→object-store, and the lifecycle/scheduling wiring — with no real
bot, deterministically, so they are the always-on `gate:compose`. The bot-spawn proof is **runnable**
(`COMPOSE_BOT=1`) and is the thing that finally says "a real bot spawns and reaches `joining`".

### RESOLVED — the real bot-spawn (step 3) now passes

The three carve gaps that once blocked a live `COMPOSE_BOT=1` bot spawn are all fixed; a `POST /bots`
on the live stack now spawns a real `tina-mtg-…` container (verified end-to-end):

1. **meeting-api `ADMIN_TOKEN`** — fixed. `../docker-compose.yml` sets `ADMIN_TOKEN` on the meeting-api
   service, and `__main__.py` resolves `token_secret = os.getenv("ADMIN_TOKEN")` with a fail-fast
   `_require_config(("ADMIN_TOKEN",))` that refuses to boot without it, so `POST /bots` returns `201`
   (no more 500 on mint). (`bot_spawn` still relies on the `ADMIN_TOKEN` env fallback inside
   `mint_meeting_token` rather than an explicitly-threaded `token_secret`, but the fail-fast guarantees
   it is present.)
2. **`updated_at` tz mismatch** — fixed. The repo writes tz-naive (`datetime.now(timezone.utc).replace(tzinfo=None)`)
   and the column uses a server-side `onupdate=func.now()`, so there is no offset-aware/naive subtraction.
3. **runtime image `docker` CLI** — fixed (was a misdiagnosis). The `DockerBackend` talks to
   `/var/run/docker.sock` over the **socket HTTP API** (`requests_unixsocket`), needing no `docker`
   client and no daemon in the image; `runtime/Dockerfile` installs no docker package at all.

The always-on subset (never spawns a real container) remains fully green on the live stack.

### Note on `GET /transcripts` vs the `:mutable` frame (step 4)

In this carve the collector's live-path stores in-flight segments in the redis hash
`meeting:{id}:segments` and publishes the `:mutable` update; `GET /transcripts` reads the postgres
`transcriptions` table (the parent's background db-writer that flushes the hash → table is out of this
carve's scope). So step 4 proves the **store** side via the redis hash and the **publish** side via the
live `/ws` frame — the two observable halves the running stack actually produces.

## Entrypoint regression tests

```bash
python3 -m unittest discover -s deploy/compose/tests -p test_make_entrypoint.py -v
```

These tests never start/stop a live stack. They cover Make dry-run safety, bootstrap secret
preservation, build-before-activation, readiness/access failures, override/profile guards and
volume retention. Config tests use the real Compose CLI without needing its daemon to resolve
alternate dotenv files, profiles, image interpolation and project/network/workspace names.

`test_tina_cli.py` adds CLI/TUI command routing, JSON/error envelopes, redaction, dry-run/no-input
behavior, image-preserving restart, volume-preserving down, cancellation and local symlink installation.
Mutations use fake Docker; installed-command operations are separately exercised on an isolated stack.

`test_tina_diagnostics.py` covers Identity selection and denied-credential handling, host/container
ASR probes, bounded HTTP without redirects, output allowlisting/redaction and explicit unverified
capture state. It uses mocks and a temporary local HTTP server, without audio or model inference.
`test_tina_checks.py` covers the check allowlist, failure aggregation, private redacted logs,
missing tools and cancellation/timeout cleanup. Run all of these with the installed `tina check cli`.

`test_tina_asr.py` covers global/account settings previews and writes against an in-memory API double:
scope isolation, denied credentials, changed-endpoint token decisions, private token files, intervening
edits, ambiguous writes/readback mismatches, malformed settings and the selected project/port guard.
The actual Identity route integration is also exercised separately with TestClient and an in-memory
session double; it does not alter production settings or claim PostgreSQL persistence coverage.

Production entrypoint checks in `test_make_entrypoint.py` cover dedicated TTS autoload, secret-free
startup logs, read-only missing-credential plans, cached KWS reuse, readonly artifact import and
reverification before application activation. They use fixtures and do not restart the live stack.

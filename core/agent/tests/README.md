# tests — agent-api (L1 + L2 of the validation pyramid)

`uv run pytest -q` (driven by `gate:python`).

| File | Level | Proves |
|---|---|---|
| `test_contracts_consumer.py` | L1 contract | transcript.v1 + workspace.v1 goldens validate by-path; meetings internals are un-importable |
| `test_core_run.py` | L2 unit | `core.run()` with **faked ports**: reads a transcript.v1 golden → emits the stub action → would-commit a workspace.v1-conformant entity |
| `test_config.py` | unit | `TINA_*` env validates + fails fast; secrets stay out of repr; worker `env` matches `runtime.v1` golden |
| `test_translation_groups.py` | unit | fragmented speech joins into phrases; speaker identity, pauses, sentence/size boundaries, source timestamps and stable group IDs are preserved |
| `test_meeting_translation.py` | API + unit | owner authorization, durable shared phrase cache, in-flight source/revision/access rechecks, concurrent viewer deduplication/lease expiry, per-phrase bounded retries, owner-wide service cooldown/generation, SQLite upgrade/restart, live-tail buffering, stop flush, saved Meeting model and visible-only output |
| `fakes.py` | — | in-memory `WorkspacePort` / `RuntimePort` — the seam that makes L2 possible |
| `conftest.py` | — | loads transcript.v1 goldens by path (the spec, P8) |

Focused translation checks, from `core/agent`:

```bash
uv run pytest tests/test_meeting_translation.py tests/test_translation_groups.py tests/test_llm_openai_compat.py tests/test_llm_anthropic.py -q
uv run pytest tests/test_api.py -k translation -q
```

These tests fake provider calls and do not need API keys or consume inference quota. The broader
agent suite includes POSIX file locks and symlinks; run it on Linux/WSL or in the existing Docker
test environment when developing on Windows. Frontend behavior belongs to the Terminal canvas
and extension suites, not these backend tests.

`test_api.py` rejects partial translation deltas on terminal worker errors or missing completion
markers. `test_llm_openai_compat.py` checks typed failure status through all three HTTP completion
adapters, including quota and timeout, without live credentials.

Codex network/web probes run explicitly in an isolated built worker image. They do not use model
credentials or production workspace volumes. Run from the repository root (use the appropriate
Docker context for the host):

```sh
for probe in codex_network_smoke.py codex_web_smoke.py; do
  docker run --rm --read-only --tmpfs /tmp --tmpfs /work \
    --security-opt seccomp=unconfined --security-opt no-new-privileges --cap-drop SYS_ADMIN \
    -v "$PWD/core/agent/tests/$probe:/smoke.py:ro" \
    --entrypoint python tina/v012-agent-worker:dev /smoke.py || exit 1
done
```

The network probe checks allowed HTTPS/Git, blocked domains/private addresses/proxy bypass,
offline/read-only turns and metadata/credential protection. The web probe uses a local Responses
fixture to inspect real Codex requests on new/resumed threads: live, cached and disabled modes.
It does not claim that a live model/account actually performed a search.

The refinement Apply/Restore translation regression verifies that canonical text changes
invalidate the affected phrase's cached translation, retain other phrases, and translate
restored source text again without returning the previous revision's translation.

Foundation tests cover translation-only model selection, Meeting model fallback, allowlist rejection and isolation from ordinary chat/meeting units.

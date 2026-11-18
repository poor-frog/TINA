# Agent Reach for TINA

Shared public retrieval worker pinned to Agent Reach 1.6.1 commit
`c70ae6da5d39bc90e09ad2ae0575ccc89f31e284` (MIT).
`make all` builds it from the upstream GitHub source and starts it on the private Compose network.
It has no published host port, credentials, browser sessions or workspace mounts.

Four operations are available: web search (Exa), public page reading (Jina with Exa fallback),
public GitHub repository search and repository README/issue/PR reading (anonymous GitHub API).
External hosted backends still require internet access and impose their own limits. Public GitHub
API access is limited without authentication; no host GitHub token is imported.
Results include URLs and bounded text. Search results are snippets/descriptions, not proof of full
article/repository coverage. Issue/PR reads include at most the first 50 comments, not merge evidence.

Chat uses existing tool.v1 grants: `reach.web.search`, `reach.web.read`, `reach.github.search`,
`reach.github.read` in `TINA_CHAT_TOOLBELT`. The stdio MCP bridge executes these fixed operations
without shell commands. Only selected tools attach to an interactive chat; prompts treat returned
text as untrusted sources and should cite their returned URLs.

Voice retains the existing meeting permission `allow_web_search` and explicit public-query boundary.
Examples after calling TINA:

- `Tìm trên web về Redis Streams`
- `Đọc web https://redis.io/docs/`
- `Tìm GitHub redis client python`
- `Đọc GitHub redis/redis`

Confirmed public queries are the only input to the retrieval worker. No transcript, shared documents,
conversation history, model credentials or owner API keys are sent to it. Retrieved text goes to the
selected LLM, then TINA's existing citation/numeric/claim verifier. An outage or source-less response
returns an explicit unavailable/no-sources result; it does not silently retry with another provider.
Stop fences late results using TINA's current turn checks. An already running synchronous model job
may finish; it cannot authorize playback. The retrieval server kills its exact subprocess on HTTP
disconnect or timeout.

For voice, the existing LangGraph `search_web` tool now reads the first two distinct result pages
in parallel through this same gateway. A successful read replaces that URL's search snippet with
the original bounded Markdown, preserving headings/tables inside the 5,000-character excerpt.
Failed or mismatched-URL reads retain the original search excerpt; they never invent page content.
Explicit URL/GitHub reads are already page reads and are not fetched again.

If web search returns no usable evidence or the answer model returns no claims, one public-only
refinement may search again and read one additional distinct page. Limits per tool invocation are
two searches, three page attempts (two concurrent), six unique excerpts, and one refinement of at
most 200 characters. A minimum remaining budget is required for refinement. The original question
remains the answer/verification target; the refinement sees only that public question and public
excerpts. Quota/auth failures, invalid answers and failed numeric/claim verification never trigger
another search. All stages share the core retrieval deadline (30 seconds for LiveKit tool lookup)
and the current-turn fence; cancelled in-flight reads may finish within their HTTP timeout but
cannot start another model/search call or authorize playback. Content-free web_retrieve/web_read/
web_refine spans and search_rounds/pages_read/pages_failed counters separate added work from LLM time.

At most two subprocesses run concurrently, each with a 24-second outer deadline and bounded input
and output. The service is intended for TINA's trusted private network; do not publish its port.
`/health` checks local imports/readiness only and does not promise upstream internet availability.
`TINA_AGENT_REACH_URL` is deployment-owned; empty disables voice use of this worker. Host Agent Reach
is independent and is not installed, upgraded or configured by this integration.

Verification:

```sh
uv sync --project deploy/agent-reach --locked
uv run --project deploy/agent-reach pytest deploy/agent-reach -q
uv run --project core/agent pytest core/agent/tests/test_agent_reach.py -q
```

Optional real CLI/MCP proof (fake LLM, actual public page, no provider credentials):

```sh
docker run --rm --network tina-production_tina --cap-drop=SYS_ADMIN \
  --security-opt seccomp=unconfined --security-opt no-new-privileges:true \
  -v "$PWD/core/agent/tests:/proof:ro" --entrypoint python \
  tina/v012-agent-worker:dev /proof/agent_reach_smoke.py
```

Use your selected project's private network name when it differs. This proof checks source URL
preservation and a real Codex MCP call/result round trip; it does not exercise a live voice meeting.

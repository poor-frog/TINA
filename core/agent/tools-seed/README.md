# tools-seed — the unit toolbelt registry

One JSON per tool, loaded by `ToolRegistry.from_dir` into a TINA runner grant. Each file is
`{ "tool": <tool.v1>, "mcp": { "tool_name", "command", "args", "env", "env_vars", "url", "type" } }` —
the `tool` half is the governance descriptor (grant `auto`/`gate`, cred ref, barriers), while
`tool_name` is the exact MCP operation exposed by that server. Missing `tool_name` is fail-closed.
the `mcp` half is how to launch the server. A unit's `unit.v1.tools` names select from here; `auto`
tools enter the allow-set, `gate` tools attach but are withheld for per-call approval. Adding a tool
(email, calendar, … thousands) is a descriptor here, never agent-api code. The email tool lands with
the MVP3 email-service.

For interactive chat, the deployment-owned `TINA_CHAT_TOOLBELT` JSON array selects the names exposed
to units; clients cannot add tool names. `auto` servers may run without a prompt. `gate` servers use
Codex's per-call approval request and the authenticated terminal chat card; a server shared by both
grant types is treated as gated. The worker passes the scoped identity token only to MCP servers and
excludes it from Codex shell-tool environments. Keep credentials out of tool descriptors, URLs, and
command arguments; resolve them through the scoped identity token or named environment variables.
`env` values are per-server literals for non-secret settings. Put credential names in that server's
`env_vars` allowlist; the worker passes only those named values to that MCP subprocess, and different
integrations should use distinct variable names when their credentials differ.

`reach.web.search`, `reach.web.read`, `reach.github.search` and `reach.github.read` attach the
read-only `tina-reach` MCP bridge (`python -m llm.reach_mcp`). Its deployment-owned
`TINA_AGENT_REACH_URL` reaches the private shared public-retrieval worker. It never receives
the owner GitHub token or browser sessions. Only selected operations are granted; generated
content is untrusted evidence and returned URLs must accompany claims. See deploy/agent-reach.

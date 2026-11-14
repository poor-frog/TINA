# TINA agent front door

TINA is a self-hosted meeting and agent system. This checkout has an independent Git repository,
but no remote, public issue tracker, hosted API, or image registry is configured. Do not push or
publish artifacts until the project owner supplies those endpoints.

## Before editing

- Inspect `git status --short --branch` and preserve changes already in the checkout.
- Keep changes limited to the requested behavior. Update every affected caller, configuration
  example, fixture, and document when changing a shared contract.
- The core owns API and event contracts; clients adapt at their boundary.
- For schema or contract changes, update the corresponding seals. For architecture or data-flow
  changes, update `architecture.calm.json` in the same change.
- Keep secrets out of source, logs, examples, and generated artifacts.

## Local development

- Node.js: `>=22.13`; package manager: `pnpm@11.7.0`.
- `make all` builds and starts the Docker Compose stack from this checkout.
- `make lite` builds and starts TINA Lite locally.
- Configure transcription through a self-hosted OpenAI-compatible STT endpoint. TINA has no hosted
  account or transcription service.
- For Kubernetes, build and preload the images yourself; the chart defaults to `imagePullPolicy: Never`.

## Git and release state

- The TINA `.git` directory is standalone and has no remote configured.
- Preserve Apache-2.0 and upstream copyright/third-party notices.
- Do not create commits, rewrite history, add a remote, or publish images unless the user explicitly
  asks and provides any required ownership or destination details.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

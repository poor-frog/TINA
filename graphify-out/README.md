# TINA code graph

Generated with [Graphify](https://github.com/Graphify-Labs/graphify) 0.9.111 using
local AST extraction only. Documents, images, and audio are excluded; no LLM or API
calls are needed.

- `graph.json`: queryable symbols and relationships.
- `graph.html`: interactive view aggregated by community for this large graph;
  its integrity-pinned vis-network dependency loads from the unpkg CDN.
- `GRAPH_REPORT.md`: community summaries, inferred connections, and coverage limits.
- `.graphify_build.json`: preserves the code-only scope for updates.
- `.graphify_labels.json` and its `.sig` sidecar: community names and membership signatures.
- `cost.json`: extraction token accounting, excluding the assistant session itself.

Caches, manifests, analysis intermediates, and machine-specific paths stay local.

## Regenerate from the repository root

```sh
uv tool install 'graphifyy==0.9.111' --with tree-sitter-sql
graphify extract . --code-only
graphify cluster-only . --no-label --no-viz
graphify export html
```

For routine code changes, run `graphify update .` as described in `AGENTS.md`.
Query with `graphify query "meeting transcript runtime"`, or use `graphify path`
and `graphify explain` for focused navigation.

The initial scan covered 2,499 supported code/configuration files. Graphify could
not parse 31 Helm Go templates as plain YAML and reported 111 files with no modeled
symbols. Potentially sensitive files are excluded by the extractor. Inferred links
and the 50 reported self-links need source verification before relying on them.

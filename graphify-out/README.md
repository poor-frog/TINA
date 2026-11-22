# TINA knowledge graph

Generated with [Graphify](https://github.com/Graphify-Labs/graphify) 0.9.111 from
code, documents, and images. Code relationships come from local AST extraction;
document and image relationships come from semantic extraction. Eleven potentially
sensitive files were excluded. Two WAV files were not transcribed because
`faster-whisper` is not installed.

- `graph.json`: queryable symbols and relationships.
- `graph.html`: interactive view aggregated to 1,611 community nodes for this
  large graph; its integrity-pinned vis-network dependency loads from the unpkg CDN.
- `GRAPH_REPORT.md`: community summaries, inferred connections, and coverage limits.
- `.graphify_build.json`: preserves the full-corpus scope for updates.
- `.graphify_labels.json` and its `.sig` sidecar: curated community names and membership signatures.
- `.graphify_labels.pending.json`: deterministic fallback names for unlabeled communities.
- `cost.json`: token totals are incomplete because semantic extraction agent usage was not exposed.

Caches, manifests, analysis intermediates, and machine-specific paths stay local.

## Regenerate from the repository root

Use the Graphify skill with `$graphify .` for a full rebuild and `$graphify . --update`
for incremental changes. A CLI-only `graphify extract . --code-only` run does not
recreate the document and image relationships in this graph. Query with
`graphify query "meeting transcript runtime"`, or use `graphify path` and
`graphify explain` for focused navigation.

The scan covered 3,404 supported files (about 2.38 million words): 2,545 code files,
799 documents, 58 images, and 2 audio files. The graph contains 32,835 nodes,
72,753 edges, and 1,611 communities. The integrity diagnostic found dangling
endpoints and self-loops; inferred relationships and those edges should be checked
against their source before relying on them.

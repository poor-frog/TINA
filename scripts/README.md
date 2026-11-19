# scripts — repo tooling — the gate suite (gates.mjs) and helpers

_Governed by `docs/docs/governance/architecture.mdx` (P1–P12). This folder owns one concern; its public surface is its `index`/contract; it may depend only on what the dependency-rules allow._

`gate:python` prints each package before invoking `uv run pytest`, streams dependency
installation and per-test progress, and reports the package duration after success.
Pytest dumps a blocked stack after 120 seconds and reports its ten slowest tests;
this diagnostic dump does not skip or pass a blocked test. A failed package stops
the gate. The CI Python step has a separate overall timeout (see the workflows README).
`gate-python-progress.test.mjs` verifies child output and fail-fast behavior using
disposable UV shims on POSIX, without installing test dependencies.

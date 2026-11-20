# Discussion Review Benchmark Scripts

These scripts run offline experiments for the discussion-review classifier:

- `benchmark_discussion_review.py` runs the benchmark against an OpenAI-compatible local model endpoint, validates each report, and records timing, usage, and fixture checks. It never calls the application API or publishes workspace reports.
- `benchmark_discussion_review.docker.mjs` starts that Python runner in a disposable Docker container and records progress and GPU samples. It expects the separate `tina-review-benchmark-ollama` container and local runner image described in the [discussion review guide](../../../docs/discussion-review.md).

For setup, options, privacy notes, and example commands, see the guide's [Benchmark runner](../../../docs/discussion-review.md#benchmark-runner) and [Local Docker execution](../../../docs/discussion-review.md#local-docker-execution) sections.

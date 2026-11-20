# Discussion Review Fixtures

These synthetic JSON fixtures support discussion-review tests and offline benchmark diagnostics:

- `discussion_review_benchmark.json` contains an eight-turn scenario used to exercise relevance, interaction, and progress classifications.
- `discussion_review_future_joke.json` and `discussion_review_future_sincere.json` share the same initial transcript window and vary only the later clarification, to check whether future context changes an earlier classification.

They are diagnostic examples, not a representative labeled accuracy dataset. The benchmark and fixture limitations are documented in the [discussion review guide](../../../../docs/discussion-review.md#benchmark-runner).

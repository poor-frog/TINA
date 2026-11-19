# Local wake-word tests

Run `uv run --directory clients/speech pytest -q` from the repository root. Deterministic
tests need no microphone or downloaded model. Replay generated synthetic WAVs through the
real CLI/model separately, following the package README; never label them human validation.

Coordinator tests accept the anchored VieGem spelling `hay tina` while rejecting mid-sentence
wake text and an empty question. This does not validate a human speaker's wake-word accuracy.
Capture regressions preserve a question after a short wake pause and retain late buffered speech.

The two-host room race uses separate participant HTTP clients and keys over one ASGI
lifespan/event loop, matching the single-process coordinator. It verifies one winning
capture/upload/playback and the losing participant's next grant, then drains both host
executors before closing the server. Nesting two `TestClient` lifespans on the same app
would share asyncio locks/tasks across loops and can hang CI during teardown.

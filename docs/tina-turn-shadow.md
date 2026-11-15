# Vietnamese turn detection observations

Voice boundaries remain owned by TINA's bot controller: Silero activity, ASR-tail coverage and lexical
pause checks decide when to call LiveKit Agents. Agents stays in manual-turn mode. No second STT or
transcript writer is added. New voice bots default to `TINA_VOICE_TURN_SHADOW=1` through Meeting API;
set it to `0` and start a new bot to disable observations.

At a same-caller quiet boundary with covered ASR text, the bot asynchronously submits an audio snapshot
to a separate native subprocess. It can observe before the lexical pause delay expires. It never waits
for scores or changes ASR requests. VieGem + KenLM + FSMN and Gipformer + FSMN retain their pipelines.

| Model | Input | Runtime |
|---|---|---|
| Smart Turn v3.2 CPU INT8 | <=8 seconds of caller PCM, Whisper normalized log-mel features | CPU ONNX |
| Namo v1 Multilingual INT8 | Current ASR question, tokenizer capped at final 512 tokens | CPU ONNX |

Files, revisions, sizes and SHA-256 are pinned in voice-engine's `turn-models.json`. Weights and tokenizer
total about 352 MB on disk, downloaded once by model bootstrap into the existing shared model volume.
Inference mounts it read-only and never downloads files. Model memory is private to each bot process
and scales with simultaneous voice meetings; RAM is not the same as artifact size. Cache license files
retain Smart Turn's BSD-2-Clause and Namo's Apache-2.0 notices.

The observer accepts one request at a time and retains <=8 seconds per channel, at most 32 channels.
Snapshots include at most 500ms before the current question's onset. Stop, resumed same-caller speech,
source/sample gaps and conflicting identities fence late observations. Teardown closes the child and
clears memory. A 1.5-second optional inference deadline retires slow observers; initialization has its
own 20-second deadline. Observer failure never disables voice. No cloud inference service is called.
Questions completed before model initialization may have no observation; readiness never delays voice.

`voice_turn_shadow` logs contain scores, timing, request UUID and channel only, never text/audio/names
or tokens. Join request UUID with existing voice timing logs to compare candidate versus actual dispatch
time. `agree` compares scores against reference 0.5; this threshold is uncalibrated and is not a turn
decision or ground truth. Human labels or explicitly approved evaluation audio are needed to measure
premature endings and latency. Shadow observations cannot establish an accuracy claim on their own.

## Verification and rollout

Python tests validate installer hashes/atomicity, IPC and preprocessing. TypeScript tests validate
bounded buffers, ownership, Stop/resumed-speech fences and unchanged dispatch with pending inference.
Real model smoke validates CPU loading and finite outputs; silence/synthetic audio proves wiring only.

`make all` builds the bot and prepares model cache; new voice-enabled Google Meet bots receive shadow
mode. Existing bot containers retain their old image. Collect Vietnamese and mixed-language observations
before enabling any active detector policy. This change implements observation only.

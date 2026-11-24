# Gipformer 1.5 + FSMN-VAD for TINA

The HTTP auth/queue/upload boundary is shared with VieGem in `../http_worker.py`.
The Gipformer model, settings and decoder remain owned by this worker.

Optional HTTP-window backend: **FunASR runs FSMN-VAD on CPU**, then **Sherpa-ONNX
runs Gipformer 1.5 INT8 on each speech interval**. Gipformer is not loaded through
FunASR `AutoModel`. The worker preserves VAD offsets on the original 16 kHz source
timeline, including silence between intervals. It does not concatenate speech and
invent compressed timestamps. Segment intervals are VAD speech ranges, not word
alignment. Existing Desktop/Bot window confirmation remains responsible for live
drafts/finals; this backend is not token streaming or diarization.

The checkpoint is Vietnamese. Do not assume complete English/code-switch support.
Explicit English language requests return 422; auto/unspecified requests return
`language: unknown` because this model does not detect language. Prior-text `prompt`
is accepted for wire compatibility but is not used as a hotword/prefix mechanism.
There are no synthesized confidence scores or word timestamps.

## Install and run

Requires Python 3.11 on the tested macOS arm64 host. A separate environment avoids
changing the installed Qwen/FunASR or diarization workers:

```sh
uv venv --python 3.11 .venv/gipformer-fsmn
uv pip install --python .venv/gipformer-fsmn/bin/python -r deploy/transcription/gipformer/requirements.txt
python3 deploy/transcription/gipformer/install-models.py
```

`model-assets.json` pins the upstream Hugging Face revision and SHA-256 of the
INT8 encoder/decoder/joiner, tokens and model card. FSMN assets are separately
checksum-pinned and reused from the existing ModelScope cache when exact; otherwise
the installer downloads and verifies them. A differing existing file fails rather
than being overwritten. Models live in ignored `deploy/transcription/models/`.
Startup verifies every pinned asset; it never executes downloaded model code.
Gipformer weights are MIT according to the upstream model card. Preserve upstream
notices and independently check the FSMN/PyTorch/runtime terms when redistributing.

Create `~/.config/tina/gipformer.env` with mode 0600:

```sh
TINA_GIPFORMER_TOKEN=replace-with-at-least-32-random-characters
TINA_GIPFORMER_PORT=18002
```

```sh
sh deploy/transcription/gipformer/start.sh
curl --fail http://127.0.0.1:18002/health
```

The local deployment has launchd label `local.tina.gipformer`; logs are under
`~/Library/Logs/TINA/gipformer.*.log`. Inference uses two CPU threads per runtime,
one resident model pair, one running request and at most three waiting requests.
The queue wait limit is 10 seconds. Cancelled native inference retains its lock
until the model thread finishes. No browser CORS is enabled. The serving interface
binds only loopback and transcriptions require a Bearer token before upload parsing.

## Standalone use

This worker is retained for research and comparison runs. TINA uses
[VieGem](../viegem/README.md) as its managed ASR backend. Gipformer accepts
`whisper-1` and `custom` as compatibility aliases for its pinned model.

## HTTP and verification

- `GET /health`, `/v1/models`, `/capabilities`.
- `GET /status`: existing content-free `asr-status.v1`, including model, queue,
  errors and bounded latency samples. It contains no transcript/audio/token.
- `POST /v1/audio/transcriptions`: multipart `file`, `model`, optional `language`,
  `prompt`, `response_format` (`json`, `verbose_json`, `text`), and
  `min_silence_duration_ms` (100–2000; default 800). Bearer token required.

Input limit: 25 MiB, 90 seconds, 1–8 channels, 8–192 kHz, bounded decoded sample
count. SoundFile decodes WAV/FLAC and supported formats; scipy resamples to 16 kHz.
Stereo is downmixed. Digital silence returns empty text. Short tails are padded
only for VAD analysis and output stays clipped to the original duration. Speech
longer than 30 seconds is decoded in bounded windows; boundary accuracy is not
proven for such long continuous speech. Invalid VAD results, model failures and
bad audio fail explicitly; they are not successful empty transcripts.

```sh
cd deploy/transcription/gipformer
../../../.venv/gipformer-fsmn/bin/python -m unittest -v test_server.py
```

From the root, after building the existing Desktop/Bot packages, opt into a real
worker smoke with a supplied speech WAV (mono 16 kHz PCM16, at most 30 seconds):

```sh
node deploy/transcription/gipformer/smoke.mjs /path/to/existing-speech.wav
```

The smoke drives the real Bot lane and ephemeral Desktop capture.v1 ingest into
the worker, then checks finalized transcript, canonical and memory, source identity
and credential exclusion. It does not join an external meeting or write real
meeting state. See the bounded replay results and limitations in
[`gipformer-fsmn-20261027.md`](../../../docs/research/gipformer-fsmn-20261027.md).

Sources: [Gipformer inference](https://github.com/ggroup-ai-lab/gipformer/blob/0cac5b183d2e1a9e3429ff69080e09cc62ebdf9b/infer_onnx.py),
[pinned model card](https://huggingface.co/g-group-ai-lab/gipformer1.5-68M-rnnt/tree/dd9227dcd8705c13f33bdbe59728d546ab94480f),
[FunASR](https://github.com/modelscope/FunASR).

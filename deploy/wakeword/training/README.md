# Local TINA ONNX training

Experimental models for `hey TINA` and `TINA ơi`, using LiveKit WakeWord 2.1.1.
The standalone `TINA` and `ê TINA` detectors were deleted at the operator's request; the recipe
does not generate or train them again. Their historical evaluation records are not active models.
Generated data/checkpoints/models belong under the Git-ignored `output/` tree, never source control.
The training environment is isolated in `.venv/wakeword-training` and uses Apple MPS sequentially.
New voice-capable bots now activate through the two retained KWS models; selected ASR supplies question text and transcript.

`generate_local.py` runs in an isolated existing TINA TTS image with its pinned model volume read-only.
It uses no LiveKit Cloud credentials and no participant recordings. Preset voices are deduplicated
by speaker embedding and split across train/validation/test. Within each phrase, `TINA` is synthesized as `ti na`.
The current image has 25 unique preset embeddings: 17 training, 4 validation and 4 test voices.
Examples include Kim Thanh, Ngọc Huyền, Hải Đăng and Mai Anh in training; Trúc Ly is held out
for validation. Distinct presets do not prove distinct human recording speakers.
Only the two retained calls are positive; unrelated near-sounding calls form hard negatives.

Synthetic spans use 10 ms energy-based alignment estimates. Held-out synthetic voices and public
speech are useful engineering checks, not evidence of real meeting recall. Real speakers, microphone
conditions, overlap and the combined two-model false-alarm rate must be measured before deployment.

## Reproduce on this Apple Silicon checkout

```sh
uv venv --python 3.13 .venv/wakeword-training
uv pip install --python .venv/wakeword-training/bin/python -r deploy/wakeword/training/requirements-macos.lock
mkdir -p output/wakeword-training/tina-v1
```

Generate data in one terminal (use the Docker context and existing TTS model volume of this machine):

```sh
docker --context orbstack run --rm --init --name tina-kws-local-data --cpus 3 --memory 4g --network none \
  --env PYTHONPATH=/app \
  --mount type=volume,source=tina-production_tts-models,target=/models,readonly \
  --mount type=bind,source="$PWD/deploy/wakeword/training",target=/recipe,readonly \
  --mount type=bind,source="$PWD/output/wakeword-training/tina-v1",target=/output \
  --user 0:0 --entrypoint python tina/tts:dev /recipe/generate_local.py \
  --output /output --recipe /recipe/phrases.json
```

Train/export in another terminal. It waits for each phrase's complete manifest, writes the upstream
Parquet dataset, trains 5,000 steps on MPS with the upstream batch recipe (two loader workers),
calibrates on the upstream held-out public speech/noise recipe, and exports a streaming ONNX model.
First use downloads pinned pretrained encoders and public speech/noise/RIR assets; generation itself
is offline and isolated from TINA's production TTS queue. No LiveKit Cloud account is used.

```sh
PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 \
PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.35 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.25 \
.venv/wakeword-training/bin/python deploy/wakeword/training/train_local.py \
  --output output/wakeword-training/tina-v1 --recipe deploy/wakeword/training/phrases.json
```

Models: `output/wakeword-training/tina-v1/models/{hey_tina,tina_oi}.onnx`.
Each gets a SHA-256 and a separate synthetic validation/test evaluation JSON. Native training
checkpoints are saved before calibration so export can resume if calibration/network fails.
A model is not production-ready merely because its ONNX file exists. The 0.5 threshold is calibrated
on upstream public negatives; measured false-alarm rates on Vietnamese meetings may differ.

## Current background run

The local supervisor keeps generation and sequential training running after the terminal disconnects,
with at most two trainer restarts. Do not start another trainer while its PID is alive.

```sh
cat output/wakeword-training/tina-v1/job-status.json
tail -n 10 output/wakeword-training/tina-v1/training.log
```

`phase: complete` requires both ONNX models and their evaluation reports. Keep the Mac awake
and connected to power. To stop this run and its isolated generator, create the stop marker:

```sh
touch output/wakeword-training/tina-v1/STOP
```

Stopping before a phrase finishes its 5,000 steps loses that phrase's in-progress training; completed
phrase checkpoints are retained. Remove the marker before explicitly starting a new supervisor.

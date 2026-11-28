# syntax=docker/dockerfile:1.7
# Fast ARM64 code patch for VieNeu TTS on top of the model-baked staging base image.
ARG VIENEU_BASE
FROM ${VIENEU_BASE}
COPY --chown=10001:10001 \
  deploy/tts/engine.py \
  deploy/tts/server.py \
  deploy/tts/speech_text.py \
  deploy/tts/voice_profile.py \
  deploy/tts/pronunciations.json \
  deploy/tts/install_models.py \
  deploy/tts/model-assets.json \
  /app/

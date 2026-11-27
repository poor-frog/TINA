# syntax=docker/dockerfile:1.7
# Overlay build for @tina/bot on top of the voice-baked ARM64 staging base image.
# Preserves /models/meeting-voice, /opt/hf-cache, /ms-playwright, and /opt/tina-voice
# while recompiling updated TypeScript sources under core/meetings/services/bot/src.
ARG BOT_BASE
FROM ${BOT_BASE}

ARG TINA_IMAGE_VERSION=unknown
ENV TINA_IMAGE_VERSION=${TINA_IMAGE_VERSION}

COPY core/meetings/services/bot/src /app/core/meetings/services/bot/src

RUN cd /app/core/meetings/services/bot \
    && ./node_modules/.bin/tsc \
    && test -f dist/index.js \
    && test -f dist/meeting-voice.js \
    && /opt/tina-voice/bin/python -c 'from pathlib import Path; from tina_meeting_voice.assets import verify_vad; from tina_meeting_voice.kws_shadow import verify; root = Path("/models/meeting-voice"); verify_vad(root); verify(root / "livekit-tina-v1")'

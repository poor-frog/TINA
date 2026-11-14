ARG TINA_BOT_IMAGE=tina/tina-bot:dev
FROM ${TINA_BOT_IMAGE} AS noise
RUN mkdir /opt/tina-ns-runtime \
    && cp /opt/tina-voice/lib/libtina_ns.so /opt/tina-ns-runtime/ \
    && cp -L /lib/$(uname -m)-linux-gnu/libwebrtc_audio_processing.so.1 /opt/tina-ns-runtime/

FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.9.22
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OTEL_SDK_DISABLED=true XDG_CACHE_HOME=/tmp/tina-cache PATH=/opt/venv/bin:$PATH LD_LIBRARY_PATH=/opt/tina-voice/lib
WORKDIR /app
COPY deploy/livekit/pyproject.toml deploy/livekit/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project --no-default-groups
COPY deploy/livekit/dtln_assets.py ./
RUN python dtln_assets.py /opt/tina-dtln
COPY --from=noise /opt/tina-ns-runtime/ /opt/tina-voice/lib/
COPY core/meetings/modules/voice-engine/tina_meeting_voice/denoise.py ./tina_ns.py
COPY core/meetings/modules/voice-engine/tina_meeting_voice/assets.py core/meetings/modules/voice-engine/tina_meeting_voice/capture.py core/meetings/modules/voice-engine/tina_meeting_voice/vad_monitor.py core/meetings/modules/voice-engine/tina_meeting_voice/wakeword.py core/meetings/modules/voice-engine/tina_meeting_voice/model-assets.json ./tina_meeting_voice/
COPY deploy/livekit/adapters.py deploy/livekit/rag.py deploy/livekit/task_flow.py deploy/livekit/audio.py deploy/livekit/audio_stream.py deploy/livekit/vad_shadow.py deploy/livekit/dtln.py deploy/livekit/server.py deploy/livekit/smoke.py deploy/livekit/production_smoke.py ./
COPY core/agent/shared/voice_trace.py ./voice_trace.py
COPY core/agent/shared/voice_tools.py ./voice_tools.py
RUN python -c "from tina_ns import NativeNs; p=NativeNs(); p.close()"
USER 65532:65532
CMD ["python", "server.py"]

ARG BOT_IMAGE=tina/tina-bot:dev
FROM ${BOT_IMAGE}
COPY --from=voice_assets . /models/meeting-voice/
RUN --network=none /opt/tina-voice/bin/python -c 'from pathlib import Path; from tina_meeting_voice.assets import verify_vad; from tina_meeting_voice.kws_shadow import verify; root = Path("/models/meeting-voice"); verify_vad(root); verify(root / "livekit-tina-v1")'

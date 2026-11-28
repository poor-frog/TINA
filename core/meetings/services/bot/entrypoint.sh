#!/bin/bash
# @tina/bot entrypoint — bring up the X11 + PulseAudio environment the browser /
# capture / speak path expects, then run the worker (boot → join → ... → die).
#
# Mirrors the production bot's meeting-mode bringup (services/tina-bot/core/
# entrypoint.sh), trimmed to what the v0.12 carved bot needs:
#   • Xvfb on :99           — a display for the headful Chromium @tina/remote-browser launches.
#   • fluxbox               — a WM so the browser window manages cleanly.
#   • PulseAudio            — the audio graph: tts_sink → virtual_mic (speak) + a null sink.
# The worker itself reads TINA_BOT_CONFIG (invocation.v1) and drives the rest.
set -u

export DISPLAY="${DISPLAY:-:99}"

echo "[entrypoint] Starting Xvfb on ${DISPLAY} and PulseAudio in parallel..."
Xvfb "${DISPLAY}" -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
pulseaudio --start --exit-idle-time=-1 --log-target=syslog 2>/dev/null &
PA_PID=$!

# Poll X11 socket every 50ms (max 3s) instead of coarse 300ms sleeps.
i=0
while [ "$i" -lt 60 ]; do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  kill -0 "${XVFB_PID}" 2>/dev/null || break
  sleep 0.05
  i=$((i + 1))
done

echo "[entrypoint] Starting fluxbox..."
fluxbox >/tmp/fluxbox.log 2>&1 &

# Wait for pulseaudio --start to finish and daemon socket to accept pactl (max 2s)
# instead of an unconditional 1s sleep.
wait "${PA_PID}" 2>/dev/null || true
i=0
while [ "$i" -lt 40 ]; do
  pactl info >/dev/null 2>&1 && break
  sleep 0.05
  i=$((i + 1))
done
# Voice/capture audio graph (best-effort; only the speak path strictly needs it).
pactl load-module module-null-sink sink_name=meeting_rx \
  sink_properties=device.description="MeetingAudioReceive" 2>/dev/null || true
pactl set-default-sink meeting_rx 2>/dev/null || true
pactl load-module module-null-sink sink_name=tts_sink \
  sink_properties=device.description="TTSAudioSink" 2>/dev/null || true
pactl set-sink-volume tts_sink 70% 2>/dev/null || true
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic \
  source_properties=device.description="VirtualMicrophone" 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true
pactl set-sink-mute tts_sink 1 2>/dev/null || true
# Muting the capture source makes Meet report a system-microphone problem; gate TTS at its sink.
pactl set-source-mute virtual_mic 0 2>/dev/null || true

# Run the worker from its package dir so the schema path (src→../../../contracts)
# and the pnpm-linked workspace deps resolve. Always emit start + exit breadcrumbs
# so an instant crash is never silent in container stdout.
# BOT_APP_DIR/BOT_WORKER_ENTRY are overridable so the entrypoint's signal handling is
# unit-testable outside the image (entrypoint.test.ts drives a stub worker through it).
cd "${BOT_APP_DIR:-/app/core/meetings/services/bot}" || exit 1
echo "[entrypoint] Starting @tina/bot worker (node dist/index.js, DISPLAY=${DISPLAY})..."

# SIGNAL FORWARDING (the exit-137 fix): this script is PID 1, and a PID-1 bash neither dies on
# SIGTERM nor passes it to a foreground child — so `docker stop` (and the runtime's graceful
# terminate) reached NOBODY, every stop escalated to SIGKILL (exit 137) mid-capture, and the
# bot's graceful leave (leave meeting → flush recording → terminal lifecycle callback → exit 0,
# bounded <25s by its own watchdog) never ran. Run the worker in the background and FORWARD
# TERM/INT to it; wait() resumes on the trap (128+N) so loop until the worker really exits.
node "${BOT_WORKER_ENTRY:-dist/index.js}" &
WORKER_PID=$!
trap 'kill -TERM "${WORKER_PID}" 2>/dev/null' TERM
trap 'kill -INT "${WORKER_PID}" 2>/dev/null' INT
wait "${WORKER_PID}"
EXIT_CODE=$?
while kill -0 "${WORKER_PID}" 2>/dev/null; do
  wait "${WORKER_PID}"
  EXIT_CODE=$?
done
echo "[entrypoint] @tina/bot worker exited with code ${EXIT_CODE}"
exit ${EXIT_CODE}

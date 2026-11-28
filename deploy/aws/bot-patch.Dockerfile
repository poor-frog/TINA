# syntax=docker/dockerfile:1.7
# Slim, SOCI-ready build for @tina/bot on top of the voice-baked ARM64 staging base image.
# Compiles updated TypeScript sources, prunes unused Playwright browsers (Firefox/WebKit/
# headless-shell), awscli v2 (replaced by native Node SigV4 S3 sync), VNC extras, and
# unrelated monorepo services, then repacks into a clean single-layer rootfs for fast
# Fargate cold starts + SOCI v2 lazy loading.
ARG BOT_BASE
FROM ${BOT_BASE} AS builder

ARG TINA_IMAGE_VERSION=unknown
ENV TINA_IMAGE_VERSION=${TINA_IMAGE_VERSION}

COPY core/meetings/modules/gmeet-capture/src /app/core/meetings/modules/gmeet-capture/src
COPY core/meetings/modules/record-chunker/src /app/core/meetings/modules/record-chunker/src
COPY core/meetings/modules/remote-browser/src /app/core/meetings/modules/remote-browser/src
COPY core/meetings/modules/join/src /app/core/meetings/modules/join/src
COPY core/meetings/services/bot/src /app/core/meetings/services/bot/src
COPY core/meetings/services/bot/entrypoint.sh /app/entrypoint.sh

RUN set -eu; \
    sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh; \
    cd /app/core/meetings/modules/gmeet-capture && ./node_modules/.bin/tsc; \
    cd /app/core/meetings/modules/record-chunker && ./node_modules/.bin/tsc; \
    cd /app/core/meetings/modules/remote-browser && ./node_modules/.bin/tsc; \
    cd /app/core/meetings/modules/join && ./node_modules/.bin/tsc; \
    cd /app/core/meetings/services/bot && ./node_modules/.bin/tsc && node build-browser-utils.mjs; \
    cp /app/core/meetings/services/bot/dist/browser-utils.global.js /app/browser-utils.global.js; \
    test -f /app/core/meetings/services/bot/dist/index.js; \
    test -f /app/core/meetings/services/bot/dist/meeting-voice.js; \
    test -s /app/browser-utils.global.js; \
    /opt/tina-voice/bin/python -c 'from pathlib import Path; from tina_meeting_voice.assets import verify_vad; from tina_meeting_voice.kws_shadow import verify; root = Path("/models/meeting-voice"); verify_vad(root); verify(root / "livekit-tina-v1")'

# Prune verified unused bloat BEFORE repacking into scratch so removed bytes disappear completely.
RUN set -eu; \
    rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-* /ms-playwright/chromium_headless_shell-*; \
    rm -rf /usr/local/aws-cli /usr/local/bin/aws /usr/local/bin/aws_completer; \
    apt-get purge -y x11vnc novnc websockify >/dev/null 2>&1 || true; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/man/* /tmp/*; \
    rm -rf /app/core/agent /app/core/flows /app/core/gateway /app/core/identity /app/core/runtime \
           /app/core/meetings/services/meeting-api /app/core/meetings/services/mcp \
           /app/core/meetings/modules/voice-engine; \
    find /app/core/meetings -type f \( -name '*.test.*' -o -name '*.map' \) -delete; \
    find /opt/tina-voice -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true; \
    mkdir -p /tmp /app/storage/screenshots && chmod 1777 /tmp; \
    CHROME_BIN="$(cd /app/core/meetings/modules/remote-browser && node -e "const {chromium}=require('playwright'); console.log(chromium.executablePath())")"; \
    echo "[slim] chromium: ${CHROME_BIN}"; \
    test -x "${CHROME_BIN}"; \
    if ldd "${CHROME_BIN}" | grep -q "not found"; then ldd "${CHROME_BIN}" | grep "not found"; exit 1; fi; \
    command -v Xvfb fluxbox pulseaudio pactl xdotool xclip node

FROM scratch
ARG TINA_IMAGE_VERSION=unknown
COPY --from=builder / /
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    NODE_ENV=production \
    TINA_HF_CACHE=/opt/hf-cache \
    TINA_S3_NATIVE=1 \
    TINA_IMAGE_VERSION=${TINA_IMAGE_VERSION}
WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]

# Transcription control

The authenticated Terminal boundary for account-scoped ASR lifecycle settings.
`runtime/` proxies safe status and start/stop requests to the deployment's host controller.
Audio transcription remains at `/api/stt`. The signed-in `/api/transcription/test` route
forwards to the Gateway in every Terminal mode using the caller’s session.

The browser never receives worker tokens, the internal Identity secret, Docker access,
or a caller-selectable account identity. See [runtime](runtime/README.md).

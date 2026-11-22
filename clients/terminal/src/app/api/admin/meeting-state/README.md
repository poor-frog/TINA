# Meeting-state operator diagnostics

The `[meetingId]` route uses the existing admin allowlist gate, then forwards the server-held
internal secret to agent-api. GET exports volatile scrubbed profiler metadata; POST retries failed
state jobs. Ordinary participant API proxy routes cannot acquire this credential.

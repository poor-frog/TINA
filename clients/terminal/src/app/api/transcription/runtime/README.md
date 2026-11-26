# Account ASR runtime

`GET /api/transcription/runtime` returns the signed-in account's selection, aggregate
worker demand and physical worker status. `POST` accepts exactly `backend`
(`viegem`), boolean `enabled`, and nonnegative integer `revision`.

The route verifies the auth cookie through `currentUser`, rejects cross-origin writes,
and attaches the verified user ID server-side. It derives a dedicated control key
from the internal secret and forwards requests to `TINA_ASR_CONTROL_URL`.
Neither the platform secret nor ASR credentials cross the browser boundary.

The host controller checks authenticated audio before committing a new selection through
Identity's revision-CAS endpoint. It retains workers needed by other accounts or local
sessions, and drains idle requests before stopping an owned worker. Failures return
safe errors; clients refresh status before retrying an uncertain operation.

Tests: `src/app/api/__tests__/asrRuntime.test.ts` covers verified identity, request shape,
derived-key forwarding and public loopback-origin handling behind Docker.

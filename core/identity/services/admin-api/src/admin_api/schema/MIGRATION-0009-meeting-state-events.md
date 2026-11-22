# Meeting-state audit events

The schema synchronizer creates `meeting_state_events` before enabling the live assistant.
Its matching Meeting API model is a schema mirror, not an independent schema owner.

Each row has an event ID, meeting FK, unique per-meeting sequence, JSON payload and indexed nullable
expiry. Active-meeting audit rows have no expiry. At meeting end, expiry defaults to end + 14 days.
Meeting API prunes expired rows independently of the retained state snapshot. Artifact deletion
explicitly removes events; the FK also cascades when a meeting itself is deleted.

Apply the normal admin-api schema synchronization before starting the new Meeting API version.
No historical rows need a backfill. The feature is per-meeting opt-in and both model IDs must be set.

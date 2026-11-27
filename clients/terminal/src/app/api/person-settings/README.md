# api/person-settings

Authenticated per-user email and timezone preference proxy (`GET`/`PUT /api/person-settings`).
Resolves the caller's verified `userId` from the `tina-token` cookie via `validateAuthToken` and
proxies to admin-api's `/internal/users/{user_id}/settings` using `INTERNAL_API_SECRET` server-side
so the user controls `mail_minutes`, `mail_rsvp`, `mail_join`, `mail_prep`, and `timezone` directly
in Settings.

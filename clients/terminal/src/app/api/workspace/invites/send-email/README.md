# api/workspace/invites/send-email

Authenticated endpoint (`POST /api/workspace/invites/send-email`) that verifies an existing
workspace invite token via `/agent/workspace/invites/preview` and emails the server-constructed
share link (`https://meettina.site/?invite=<token>`) to the requested teammate email addresses.

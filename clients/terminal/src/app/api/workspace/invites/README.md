# api/workspace/invites

Dedicated proxy for `GET`/`POST /api/workspace/invites` that forwards workspace invite minting to
the gateway (`/agent/workspace/invites`) and automatically emails the shareable invite link via
Amazon SES to `allowed_emails` (restricted invites) or optional `notify_emails` (open links).

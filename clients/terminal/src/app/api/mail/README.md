# api/mail

Outbound transactional email helpers for TINA Terminal (login notifications and workspace invite
delivery) sent over Amazon SES SMTPS (`email-smtp.<region>.amazonaws.com:465`) using Node's
built-in `node:tls` module — zero external npm dependencies. Automatically becomes a safe no-op
when SES env vars are unset or when targeting reserved RFC 2606 test domains (`.test`, `.example`).

# Google Calendar link intent

This same-origin route starts a separate, read-only Google Calendar authorization. It validates the
signed-in TINA user and request origin, then sets a short-lived, HTTP-only intent cookie that the
OAuth callback checks before storing any calendar grant.

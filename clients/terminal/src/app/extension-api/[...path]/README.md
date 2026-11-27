# Extension API Catch-All Proxy

Forwards allowlisted `/extension-api/*` calls and CORS preflights (`OPTIONS`) directly to the
Gateway (`GATEWAY_URL`) with extension-supplied headers only.

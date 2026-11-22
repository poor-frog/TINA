# Extension session routes

This route group accepts the browser extension's OAuth exchange, refresh, logout, and
owner-authorized connection requests. Every extension request is restricted to the exact
TINA_GATEWAY_EXTENSION_ORIGINS allowlist, and codes are single-use with PKCE.

The terminal's /connect-extension page handles Google sign-in and account confirmation.

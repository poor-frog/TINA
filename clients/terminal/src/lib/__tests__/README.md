# Boundary helper tests

ChatGPT tests cover subject validation, pending-state isolation and the internal
connection broker. Route/UI tests separately cover authentication, origin checks,
failure behavior and disconnect/reconnect presentation. No real token is used.

Voice status tests also validate Terminal/Extension recovery labels against session identity, expiry and observation clocks; active speech and stale diagnostics never masquerade as an idle recovery state.

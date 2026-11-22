# terminal route (`/terminal`)

Mounts the full TINA Terminal Dockview workbench (`App`) for the dev team and power users while
the production end-user UI serves `/` and `/meetings/[meetingId]`. Both shells share the same
origin, `server.mjs` `/ws` proxy, `/api/*` routes, and `AppGates` (auth, invites, setup, onboarding).

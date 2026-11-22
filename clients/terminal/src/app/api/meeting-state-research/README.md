# Meeting-state document research proxy

This narrow route forwards an authenticated, user-triggered bounded shared-workspace document query
through Gateway to the agent control plane. It is separate from the catch-all proxy so the meeting
surface can request this meeting-scoped feature in meetings-only mode without enabling general chat
or agent endpoints.

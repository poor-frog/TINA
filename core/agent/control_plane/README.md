# agent · control_plane

The agent control plane: the FastAPI app (`api.py`) and orchestration that dispatches work to workers and reconciles routine/meeting lifecycle. Owns request handling, routine bookkeeping, transcription watching, and event relay — distinct from the `worker/` that runs a single agent workload.

A leading chat `/research <topic>` (or explicit `research: true` from document actions) uses `knowledge_research.py` to select an active private writable
destination and instruct the existing agent to save a new sourced note. Meeting/repo/web rows carry
evidence versions and verification dates; absent evidence and partial failures remain visible.
The server does not treat the agent's synthesis as independently verified facts. Private Codex chat
history restores source URLs from the matching turn's metadata, never from another shared mount.

`discussion_review.py` exposes owner-only `GET/POST /api/discussion-reviews/{meeting_id}` for manual
post-meeting reviews. It reads canonical sources through the published Meeting API, dispatches a
private completion job and persists the latest source-checked report in the caller's private workspace.
See [Discussion Review](../../../docs/discussion-review.md) for limits and model configuration.

ChatGPT plan credentials live in the private `openai-auth` volume. Terminal completes OAuth;
`/internal/openai-auth/{subject}` requires the internal secret and owns generation reads, credential
saves and disconnect. Saves and refresh share a file lock with disconnect. Disconnect rotates the
generation before removing the profile, so a callback started before disconnect cannot restore it.
This clears the selected TINA user's connection, not browser sessions or tokens already copied to
running workers. Meeting model labels resolve personal settings before deployment defaults, with
an explicit workspace model pin taking precedence; labels describe configuration, not inference health.

Meeting translation: `GET/POST /api/meeting-translations/{meeting_id}` exposes the
`meeting-translation.v2` English phrase overlay. Every request first authorizes canonical transcript
and meeting status through Meeting API. GET observes live-tail stability without inference;
POST advances one ready phrase, joining consecutive ASR fragments of the same speaker
through the existing tool-less translation worker and the user's saved Meeting model.
SQLite results and atomic 120-second leases live outside workspace Git trees on the existing
workspace volume. Web/extension share cache entries by owner, meeting, phrase and exact source members.
Sentence endings, speaker changes and pauses close a phrase; size/time limits bound latency.
An unfinished live tail waits five seconds without new finalized text. Stopping the meeting
flushes it immediately. Old fragment cache entries remain on disk but are not reused.
Failures back off 15/60/300 seconds; an explicit retry bypasses the backoff. Drafts, raw ASR,
canonical revisions and capture continue independently. With all translated views closed,
new translation calls pause until a client reopens one.

Settings → Models lists come from the provider itself (`model_catalog.py` behind
`POST /api/models/catalog`): fixed first-party endpoints selected by `mode`, the caller's draft or
saved key used for that single request, non-chat entries filtered out, and a rejected key reported as
401 instead of an empty list. Callers supply `mode` only — never a base URL — so this route cannot be
turned into an egress proxy.

## Workspace membership + invites + roles (Lane M — the access layer for shared workspaces)

> **The full workspace + collaboration model (tiers, personal, sharing, live collaboration, deferred)
> is documented in [`docs/docs/core/workspaces.mdx`](../../../docs/docs/core/workspaces.mdx).** This section is the Lane M
> membership/invite mechanism.

`workspace_membership.py` is the access layer for shared workspaces. **Single-rank model (owner ruling
2026-07-07):** a shared workspace has ONE member rank — every member is read/write and can share
(mint/revoke invites); the **`owner` is just the CREATOR** (the only one who can unshare / remove
members / change role). The read-only `viewer` role stays in the lattice for back-compat but is **not
invitable** — `INVITABLE_ROLES = ("contributor",)`.

**Two stores, written together (git is authoritative, the index is derived):**
- **Authoritative** — the workspace's OWN git repo at `policy/members.json`
  (`[{subject, role: owner|contributor|viewer, added_by, added_at}]`) and `policy/invites.json`
  (only the sha256 **hash** of each invite token, with `{id, role, mode, allowed_emails, expires_at,
  max_uses, uses, revoked, …}`). Auditable, travels with the workspace, survives a DB loss.
- **Index** — `users.data.memberships[]` (`[{workspace_id, role, added_at}]`) for "workspaces shared
  with me". agent-api has no DB, so this is reached through the injected `MembershipIndex` port
  (real adapter → identity admin-api `/internal/users/{id}/memberships`; an in-memory fake in tests,
  and the composition-root default when `TINA_ADMIN_API_URL` is unset — the git file stays authoritative).

**API surface** (`/api/workspace/*`, gateway-fronted, subject = `X-User-Id`):
- `POST /invites` (owner/contributor) → mint a scoped invite; token returned ONCE. Body carries
  `role`, `expires_in_sec`, `max_uses`, and the ACCESS MODE: `mode: open|restricted` +
  `allowed_emails[]` (AMENDMENT 5). `open` = anyone-with-link (authenticated) redeems; `restricted`
  = only an authenticated user whose VERIFIED email (`X-User-Email`, gateway-injected from the
  resolved key) is in `allowed_emails`.
- `POST /invites/accept` (any logged-in user; POST-AUTH redeem, no anonymous/guest) → validate
  (hash lookup, not expired/revoked, uses<max_uses, AND mode==open OR verified email listed) → grant
  membership (both stores) → increment uses. Idempotent per user (double-accept = one membership).
  The token carries no workspace id — it is resolved by hash scan over shareable workspaces.
- `DELETE /invites/{id}` (owner/contributor) revoke · `GET /invites`, `GET /members`
  (owner/contributor) · `DELETE /members/{subject}` (owner) · `POST /members/{subject}/role` (owner,
  the "change read/write permissions" DoD item) · `GET /shared` = the "shared with me" listing.

**Role enforcement** — `require_role(root, workspace_id, subject, min_role)` (owner > contributor >
viewer) is the ONE gate every shared route uses. Under single-rank: **mint/revoke/list invites +
list members = any member** (`require_role("contributor")`); **unshare / remove member / change role
= creator only** (`require_role("owner")`). The system tiers + reserved/own-private slugs are never
shareable (`RESERVED_SLUGS` = `sys` / `_system` / `system` / `_global` / `global` / `seed` /
`seed-prev`; `ensure_workspace_shareable` refuses them and the private baseline).
**DEFERRED DECISION** (owner's call): whether to also offer an owner-restricted invite mode — see
`docs/docs/core/workspaces.mdx`.

**`is_member(root, workspace_id, subject) -> role|None`** is the seam Lane A calls for mount-resolution
and transcript-subscribe-by-membership. This lane provides membership DATA + APIs only — it does NOT
touch the mount set / dispatch.

### policy/ is PLATFORM-WRITE-ONLY (the write-guard mechanism, Q3)

`policy/` (members.json, invites.json) is written ONLY by the control plane
(`workspace_membership.policy_commit` — stages + commits just `policy/` with the platform identity as
committer, never sweeping the agent's tree). An **agent turn must never modify `policy/`**. Enforcement
lives in the worker's turn-commit path (`llm/ports.run_harness_turn`): `_revert_policy_writes(work)`
runs right before `git add -A` — it reverts any tracked `policy/` change back to HEAD and deletes any
untracked `policy/` add, emitting `{"type":"policy-reverted","paths":[…]}`. So a turn's legitimate
(non-policy) writes still commit while a policy tamper is reverted before it can land. (Chosen default
per plan Q3: post-turn validation + revert.)

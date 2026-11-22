# core/flows — the reaction engine

## Email after a meeting

New `meeting.completed` events use `post_meeting` version 5. Once the existing summary job succeeds,
`email_meeting_followup` saves its report as the bounded meeting annotation `data.summary`, then
sends a Vietnamese thank-you email with separate summary and recording links. Non-Google-Meet
meetings keep invite-based recipients. Google Meet uses the provider's attended roster and resolves
signed-in participants by Google account ID and verified provider email. Anonymous, phone and
unresolved accounts are omitted. If Meet attendance is unavailable, only the owner may receive the
report. Temporary lookup failures use the existing bounded flow retry after sending to any verified
recipients. Confirmed sends are kept across retries. Duplicates, invalid addresses and the service
mailbox are excluded.

The report has a separate 6000-character field so a Vietnamese summary cannot consume the existing
16 KiB metadata budget. Meeting lookup uses the row-id detail endpoint rather than the first list
page. Declined invite addresses stay excluded even if the completion event repeats them.
Terminal can still read legacy `metadata.tina_summary`; the next summary write removes that old
copy while preserving unrelated metadata, so clearing the summary cannot reveal stale text again.

Recipients sign in using the email that received the message. Attendee links use recipient-restricted
shares with explicit read-only recording access; existing transcript-only links gain no recording
permission. No meeting content or recording attachment is put in the email. A meeting without audio
still has a meeting page, which states that no recording is available.

The existing `mail_minutes` owner preference, per-meeting `share: false` and flow-level
`attendee_followup: off` remain effective. Attendee links are issued only to email domains allowed by
`attendee_domains` or `TINA_FLOWS_ATTENDEE_DOMAINS`. If neither is set, only the owner's domain is allowed.
Version-5 legacy mail steps relay the new delivery receipt,
so they do not send a second email. In-flight older flow versions keep their original behavior.
Per-recipient checkpoints preserve confirmed sends and restricted links across retry. SMTP cannot
guarantee exactly-once delivery if a worker crashes after server acceptance but before checkpointing.

Compose needs `automation`, `TINA_FLOWS_API_URL=http://flows-api:8200`, a real
`TINA_FLOWS_API_KEY`, `TINA_FLOWS_AGENT_API_URL=http://agent-api:8100`, configured meeting inference,
and `TINA_UI_URL` set to the externally reachable Terminal URL. The existing company-layer setup
gate must be complete for the worker to advance. Outbound mail reuses `TINA_MAIL_ADDR` plus
`TINA_MAIL_APP_PASSWORD` for Gmail SSL, or the existing `TINA_MAIL_SMTP_HOST`/`TINA_MAIL_SMTP_PORT`
relay. The `mailbox` profile is needed only for inbound mail. Keep credentials in private deployment
configuration. Edit the copy in `_global/mail/meeting-followup.md`; the baked source is
[`behavior/mail/meeting-followup.md`](../../behavior/mail/meeting-followup.md).

The follow-up now sends `multipart/alternative`: the existing editable plain-text copy plus a
branded HTML version. The minimal light design uses the Tina palette, generous spacing, table
layout and two buttons. React Email source lives in [`email-design/`](email-design/README.md);
`pnpm build` there exports the shell and fragments into `src/flows_steps/templates/`.
`email_design.py` fills those assets with escaped copy, meeting titles and URL attributes; no externally hosted
images, tracking pixels or new frontend runtime are required. The original Tina logo is rasterized
from `clients/terminal/public/tina-logo.svg` into the bundled `templates/tina-logo.png` and attached
inline via Content-ID inside the HTML's `multipart/related` part. Styling is inline, with solid
colors and Outlook-aware buttons. There are no animations or decorative status badges.
React Email is an authoring dependency only; the Python worker still needs no Node runtime.
Legacy notices remain plain text.

### Gmail SMTP

The default `TINA_NOTIFY_CHANNEL=smtp` uses `smtp.gmail.com:465` with SSL and authenticates with
`TINA_MAIL_ADDR` plus `TINA_MAIL_APP_PASSWORD`. Enable Google 2-Step Verification and create a
[Gmail App Password](https://support.google.com/accounts/answer/185833); the regular account
password is not the SMTP credential. Set the mailbox values in your instance's private
`deploy/compose/.env`. Encrypt it with dotenvx if you use that workflow, and keep the matching
`.env.keys` in your private backup. Keep `.env.example` free of real credentials.

Leave `TINA_MAIL_SMTP_HOST` empty for Gmail. Setting that key selects the existing plain,
unauthenticated relay transport; `TINA_MAIL_SMTP_PORT` only applies to that relay. Recreate the
flows services after changing their environment. Sending a test message verifies the mailbox,
but automatic meeting emails still require the automation and summary prerequisites above.

### Resend delivery

Set these in private deployment configuration (the names are listed in
`deploy/compose/.env.example`; keep that example free of real API keys):

```dotenv
TINA_NOTIFY_CHANNEL=resend
TINA_RESEND_API_KEY=YOUR_RESEND_SENDING_API_KEY
TINA_RESEND_FROM=onboarding@resend.dev
```

Without a domain, `onboarding@resend.dev` is for tests to the email associated with your Resend
account only. For actual attendee delivery, verify your domain in Resend and replace the sender
with an address on that domain, such as `hello@your-domain.com`.
See [Resend's testing restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

The `resend` notification adapter reuses the same MIME builder and sends via
`smtp.resend.com:465` with certificate-verified TLS, username `resend` and the API key as password.
HTML, plain text, the inline logo and RFC Message-ID threading are preserved. No SDK is required.
Missing credentials fail before opening a connection. The selector applies to all `notify()`
messages in this flows deployment, including meeting follow-ups. The default remains `smtp`.
Recreate the flows services after changing their environment; changing a host env file alone does
not update existing containers. The deployment's existing secret-loading workflow still applies.

Inbound IMAP and calendar RSVP remain on the existing mailbox configuration. If `TINA_MAIL_ADDR`
is set, Resend notifications include it as Reply-To so replies can reach that intake. To use the
Helm deployment, set `flows.mail.notifyChannel`, `flows.mail.resendApiKey` and
`flows.mail.resendFrom` through private values. To switch back, select `TINA_NOTIFY_CHANNEL=smtp`.

## Engine

Durable product workflows as TWO Postgres tables and ONE leased worker loop. A fact enters as a
sealed envelope, becomes exactly one `reaction` row (dedup by constraint), is worked one step at a
time, and every touch of the outside world leaves an `effect_receipt` a retry consults before acting.

- **ADR:** the reaction table with receipts IS the engine; Dapr is a possible future executor of the
  same steps, never the foundation. Full design: docs/WORKFLOW-ARCHITECTURE-PRD.md + the published
  architecture page.
- **Isolation:** `src/flows/` (the engine) imports stdlib only at module scope — no meetings, no
  agent, no runtime, no third-party. Step implementations (`src/flows_steps/`) and flow definitions
  (`src/flows_defs/`) sit OUTSIDE the engine's import graph; the engine receives them as values.
- **No scheduler:** time is a column (`next_run_at`); the worker's `SKIP LOCKED` poll is the only
  clock consumer. Waits cost nothing; escalation is `blocked_deadline`, one column not a service.
- **Testing:** the whole failure matrix runs offline on stdlib sqlite with `FakeClock` and fake
  steps — zero domains attached. Postgres is the production dialect (see `schema.sql`).
  `pyproject.toml` is what puts that suite in CI: `gate:python` discovers a tree by `pyproject.toml`
  + `tests/`, so `make test` and the gate now run the same thing. `tests/test_contract_smokes.py`
  is the one exception — it asserts the LIVE stack shapes and skips itself when the stack is down.

Layering (dependency, not data): flows → domain HTTP APIs → runtime. Domains never know flows
exists — they only write outbox facts. Tactical retries (bot reconnects, webhook delivery) stay in
their components; strategic, crash-surviving coordination lives here.

## The mailbox is a door on the public internet

`src/flows_integrations/mailbox.py` turns real mail into facts, and `mail_policy.py` decides who
it will act for BEFORE it does. Three populations, and only the first two cost anything:

| sender | what happens |
|---|---|
| a known user | routed as before — the account already exists because they made it |
| inside `TINA_FLOWS_MAIL_DOMAINS` | a colleague at this deployment's own domain, provisioned as before |
| anybody else | no account, no agent turn, no model call — one `mail_quarantine` row, and at most one fixed line (a template, never a model) |

**Unset is not "everyone".** An empty allow-list means the mailbox's own domain, exactly as an
unset `TINA_FLOWS_ATTENDEE_DOMAINS` means the organizer's (PRD §16.2 — *outside the domain,
never*). `In-Reply-To` still says which conversation a reply belongs to and never says who the
sender is: a reply runs a turn only for that thread's own participant. An invite from an organizer
we cannot place records the meeting facts in the quarantine row and creates nothing (PRD decision
19 — *the workspace is established on the click, never for someone who never clicks*); a known
user can have it re-admitted through the operator's `POST /events`.

Two ceilings bound what the inbox can cost even when every sender is legitimate:
`TINA_FLOWS_MAIL_RATE_PER_SENDER` and `TINA_FLOWS_MAIL_RATE_GLOBAL` over
`TINA_FLOWS_MAIL_RATE_WINDOW_S`, counted on ADMITTED turns in `mail_turn` — so a flood of
strangers cannot exhaust the budget of the people who are allowed to use this.

An inbound body that IS allowed through is quote-stripped and length-capped at
`TINA_FLOWS_MAIL_BODY_MAX` (default 4000) before it travels as `mail.reply`'s `text` ref —
`mailbox.strip_quotes`, quotes off first so a reply does not spend its budget on text we sent
ourselves, and an explicit elision marker naming the control when it cuts. The text itself is
never altered otherwise. The *framing* half — the fenced, untrusted-labelled block with the
machinery note after it — belongs to the flow that puts the text in front of an agent
(`email_chat`, in `flows_defs/production_agent.py`), so a deployment that carries no agent domain
applies the cap and never builds a prompt at all.

## What is waiting is flows

`GET /queue/waiting` answers, for ONE person, what this engine is holding for them: the pending
reactions scoped to their uid AND their address, each naming the flow that produced it and carrying
a typed reason — `human` (blocked on an answer), `failed`, `not_present` (a domain this deployment
does not run, PRD decision 40.7), `pending`. PRD decision 42.2: *what is waiting IS flows*, so
nothing is unioned at the edge and no other domain contributes items — they publish events, and
flow definitions decide what waits. The projection is `src/flows_queue.py`.

Three flows exist for no other purpose than to put a row in that queue: `live_meeting` (a call is
happening now — pending until `meeting.completed` for the same meeting is admitted), `desk_setup`
and `desk_claim` (the two desk cards, both `needs=("agent",)`, so a deployment without the agent
domain has neither the events nor the reactions — there is no desk there to have a card on).

`desk_setup` and `desk_claim` react to `desk.unscaffolded` and `claim.proposed`, which flows
CONSUMES and does not publish — they are the agent domain's to publish, and they are deliberately
absent from this domain's `publishes_events` for that reason. The producer is agent-api: the first
on the call that CREATED a desk carrying no `.scaffolded`, the second at `POST /api/claims`, a
claim-aware route that owns the claim book and publishes one event per claim it actually added,
which is why that route exists at all. **Neither route, nor the publish-edge declaration that
carries them, is in this cut of the repository** — the agent-api control plane that serves them is
not here — so both entries in `contracts/flows.v1/carriers.json` are marked
`"published_by": "private"`, and `tests/test_carrier_census.py` checks that the mark is honest:
a carrier claiming it must have no declaration in this tree, so the flag comes off by force the
moment a producer lands here. The two consumer flows are likewise in the optional
`flows_defs/production_agent.py`. Both halves absent together is the deployment that carries no
agent domain, and not a gap in the queue.

**The words are not in the code.** Every sentence a person hears is a file in `behavior/queue/`,
resolved private-mount-first and read hot, and a pending reaction behavior says nothing about is
counted rather than spoken. `behavior/queue/README.md` is the contract.

## Two tiers at the door

`flows-api` answers to two kinds of caller and the difference is who the answer is about.

The **operator key** (`X-Flows-Operator-Key`, `TINA_FLOWS_API_KEY`) is the instance: it opens every
route, reads every reaction and steers any of them. It is what configures the machine, and there is
no per-person version of `POST /flows` or `POST /events`.

A **person's own TINA credential** opens the five routes that are about a person — `GET /flows`,
`GET /reactions`, `POST /reactions/{id}/{verb}`, `GET /queue/waiting`, `GET /timeline` — and the
subject is derived from
that credential by asking identity's `/internal/validate`, the same resolver the gateway asks. Not
a second resolver: flows is a second caller of the one that already exists. This is what the MCP
edge needs, because that edge forwards the caller's own credential and holds none of its own — so
without it the only way to make flows' four tools answer was to hand the edge the operator key, and
the operator key is not a person.

The header used to be `X-Flows-Admin-Key`, which reads as admin-api's token and is not one — a lane
start script carried a `changeme` for it because whoever wrote it exported admin-api's key under
this service's name. The old header is accepted for one release, with a deprecation line printed
once per process; a caller sending both is answered on the new one.

An unreachable identity answers **503**, never 401: not being able to ask who somebody is has not
established that their credential is bad.

## Meetings is optional, and so is the agent domain

Two of the three domains flows can reach are **capability** doors, and their absence is a shape of
deployment rather than a misconfiguration (PRD decision 40.7; decision 5 for meetings, agreed by
the founder). Unset means *that domain is not deployed*: the process boots, admits facts and serves
its queue, and the steps that would have reached the absent domain answer `<domain>:not_present` —
terminal, with the reason on the reaction, never a retry loop against a door that is not there.

| domain | key | steps that declare it |
|---|---|---|
| agent | `TINA_FLOWS_AGENT_API_URL` | thirteen, listed in `tests/test_no_agents.py` |
| meetings | `TINA_FLOWS_GATEWAY_URL` | `await_start` · `dispatch_bot` · `run_meeting` · `process_meeting` · `email_minutes` · `email_attendees` · `drop_to_attendees` · `prepare_meeting` |

**Presence is a configuration fact, never a probe.** A health check would make *"meeting-api is
restarting"* and *"there is no meeting-api"* the same answer, and only the second is a supported
product — the first is an outage, and it keeps the retry path it has always had.

Two things a reader should not have to discover. The meetings key still says **GATEWAY** because
flows reaches meetings *through the edge* today, which ADR-0037 forbids and which is a separate
change: the gateway resolves the caller's key and enriches every forward with the user's scopes,
workspaces and **limits**, and `POST /bots` enforces the per-user concurrent-bot cap out of that
last one — so calling meeting-api directly is not a rename. And the door resolves **at access**,
never at import (`flows_steps.common.meetings_door`): `from .common import GATEWAY` used to run the
refusal while `flows_steps/meeting.py` was still loading, so an unset door was an ImportError for
the whole step vocabulary, including every step with no interest in meetings.

**The class change does not close flows' `gate:domain-doors` entry, and the gate is right.** That
gate refuses a domain naming an EDGE before it looks at any class, so the entry closes on the
de-hop above and on nothing else; `scripts/domain-doors.allow.json` now says so, in place of a
ruling that promised this change would close it.

## Configuration

Every environment key this brick reads is declared once in `src/flows_config.py`, with its class
(`required-explicit` · `defaulted` · `capability`), its default and why it exists.
`tests/test_config_declaration.py` asserts BOTH directions — nothing read that is not declared,
and nothing declared that nothing reads. `core/flows` is not yet one of the five `config.v1`
adopted services (seam backlog B7/B9); this table is what makes that adoption a transcription.

## Carrying flows this repo does not publish

A deployment with flows of its own — a private onboarding ladder, a billing gate, anything — plugs
into the same engine and the same queue through three seams. Nothing about them is a fork of this
tree, and none of them lets a pack edit what is already here.

**1 · Flow versions as data.** `POST /flows` writes a `flow_version` row and the worker hot-loads it
within one refresh (`Registry.refresh_from_db`). Steps are referenced by NAME against the image's
reviewed vocabulary, and an unknown name is refused — the API never accepts code. So a flow that is
a re-ordering of steps that already exist needs nothing below.

**2 · Steps of its own — `TINA_FLOWS_DEFS_EXTRA`.** Comma-separated importable module names, each
exposing `build(reg, db)`, called last by `flows_defs.production.build` — after every flow in this
repo, so a pack composes on top and supersedes nothing. This is the seam that seam 1 deliberately
does not provide: the vocabulary stays closed to the API and open to the operator, the same split
`TINA_BEHAVIOR_DIR` already draws for prose.

```python
# acme_pack.py, on the deployment's own PYTHONPATH
from flows import Done, EventType

def build(reg, db):
    @reg.step
    def acme_step(ctx):
        return Done({"ok": True})
    reg.flow(name="acme", version=1, on=EventType("acme.happened"),
             steps=[reg.steps["acme_step"]])
```

A module named here and not importable is a **refusal to boot**, not a fallback: a deployment that
declares a pack and starts without it reacts to none of that pack's events, silently, for as long
as nobody looks.

**3 · Its own words — `TINA_BEHAVIOR_DIR`.** `flows_queue` reads `$TINA_BEHAVIOR_DIR/queue/<flow>.
<type>.md` before the showcase baked into the image, so a pack ships the sentences for its own flows
in that tree. A flow with no file is **counted and not spoken** — the copy is also the filter.

**Event types need no declaration.** There is no carrier allow-list on the intake: `POST /events`
refuses a type only when no flow reacts to it, and answers with the list that would have worked.
Register a flow on `acme.happened` and that type is admissible the same tick.

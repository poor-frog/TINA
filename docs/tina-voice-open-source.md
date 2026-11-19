# Open cited sources by voice

After TINA has finished an evidence-backed answer, the same identified caller can say
“TINA ơi, mở nguồn đó”, “Mở tài liệu đó” or “Mở đoạn quyết định đó”. If the answer has several
matching sources, TINA asks for an ordinal instead of choosing. Say “Mở nguồn số 2” (also
“nguồn số hai”). Terminal source cards now show **Nguồn số 1**, **Nguồn số 2**, and so on.
Ordinals follow the original evidence order of that answer. Multiple paragraphs in the same
document open that document; distinct transcript segments/meetings remain ambiguous.

The SDK `open_source` tool executes a server-selected context handle through the existing bounded
LiveKit plan/lookup/finalization bridge. It never accepts a URL, arbitrary workspace path or a
model-selected document. Selection uses the same transport caller's last source-bearing answer
in the current meeting/session/policy. That answer must have a completed microphone receipt from
the last two minutes. Queued/unheard/stopped answers, unknown callers, another caller and another
session cannot authorize navigation. Only a short anchored source-open command is routed this
way; source text and compound requests cannot turn themselves into UI actions. No LLM inference
is needed to choose from known cited sources. Normal questions retain the existing model/tool flow.

Meeting API revalidates every source reference at selection, lookup and finalization. A changed
or revoked source does not authorize an old target. Once the source-open acknowledgment finishes
playing, the owner-only runtime read can expose a content-free navigation hint for 60 seconds.
It contains the request/session/policy and timestamps, never source quotations or paths. An
authenticated owner POST to `/meetings/<id>/voice-assistant/navigation/<request>` revalidates
source access and returns the selected fresh source. A Redis transaction makes the claim once-only
across the owner's browser tabs. Policy/session changes, missing heartbeat, another active request,
artifact deletion and failed/stopped acknowledgment fence the claim.

The visible owner Terminal meeting view consumes only hints created after it mounted. It opens
a document through the existing workspace document handler. For transcript evidence, it clears
filters, chooses Original ASR, scrolls to the segment and briefly outlines/focuses it. Another
meeting's source opens its own meeting tab before revealing the segment. It does not start audio,
change sharing, create a file or open an external website. Hidden meetings, background windows,
open dialogs, expired hints, a changed runtime snapshot and unmounted views do not navigate.
The acknowledgment says the source is prepared rather than claiming the owner saw it. If the
owner has no meeting view open, use the existing **Nguồn** buttons manually; opening the view
later does not replay a stale navigation request. Extension remains a read-only evidence viewer
and does not claim owner navigation hints.

The existing ASR/VAD/KWS/VieNeu-TTS and source-verification pipelines remain unchanged. Source
navigation does not grant source permission and its acknowledgment is not factual history.
The private navigation record is short-lived Redis state, not canonical transcript/notes.

Automated checks cover same-caller heard selection, ambiguity/ordinals, source revocation,
policy/session/Stop fences, one owner claim, gateway auth/routing, document opening, current/other
meeting reveal and hidden/reloaded/unmounted views. Live Google Meet audio and actual browser
workbench focus remain separate acceptance checks.

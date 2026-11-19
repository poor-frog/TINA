# Compare explicitly shared meeting transcripts

In Settings → Voice assistant → Meeting overrides, choose the current room, open
**Other meeting transcripts**, choose up to four other meetings and save. The list is empty
by default for both new and existing rooms. Selection grants transcript reading aloud to everyone
in the current room; it does not share other meetings' Wiki, approved tasks, recordings or private
conversation histories. The current room's transcript remains a separate checkbox.

Only meetings owned by the current meeting owner are eligible. Read access through somebody else's
transcript share is not permission to redistribute that transcript into another room. Meeting API
validates distinct positive IDs, maximum four, no self-selection, ownership and non-deleted artifacts
before saving. The usual revision check and Stop on policy change apply. Every new question checks
ownership/deletion again. If a selected source becomes unavailable, remove it from room settings;
the answer path fails closed rather than silently claiming a comparison over missing evidence.

Ask “TINA ơi, so với cuộc họp tuần trước, deadline demo đã đổi chưa?” or “Đối chiếu quyết định
giữa meeting này và Sprint trước”. The `search_shared_meetings` SDK function tool searches only
current-authorized transcript candidates, including the current transcript if enabled. Existing
`search_meeting` and `get_recent_transcript` remain current-room-only. Model requests cannot add a
meeting ID. Public web/general routes never receive these private excerpts or a generated query
derived from them. The existing two-plan/four-tool/30-second retrieval budget remains unchanged.

Each excerpt retains meeting ID/title/start time, speaker and original segment/audio times. Other
meeting source keys are namespaced before chunking, preventing same-segment-ID collisions. Metadata
is bound into source fingerprints. Retrieval shares relevant anchor slots across meetings and the
optional reranker preserves up to two retrieved excerpts per represented meeting. Adjacent-context
reads cannot cross meeting boundaries, even when timestamps coincide. Generic whole-meeting recaps
still process only the current room; explicit comparisons use the scoped lookup loop. Retrieval
is bounded, not exhaustive coverage of every selected meeting.

Final generation is instructed to attribute both sides, distinguish proposals/decisions and avoid
assuming a newer timestamp means an older decision was replaced. Normal numeric/semantic verification
and source freshness checks remain mandatory. Selected source ownership, deleted artifacts, text
revisions, title/start metadata and room policy are reread before answer release. Each question has
fresh per-request source reads; the private chat Q&A cache is not reused for voice authorization.

Terminal and Extension source cards show each meeting's identity/date. A transcript source from
another meeting opens that source meeting in Terminal rather than trying to reveal a same-ID segment
in the current room. Current-room sources retain their existing transcript reveal. These links do
not bypass normal owner access checks. Source inspection may retain current-room quotes while marking
a revoked other-meeting quote unavailable; generation refuses an incomplete/revoked configured scope.

The existing ASR/VAD/KWS/TTS pipeline and selected LLM are unchanged. Automated tests cover policy
selection/CAS, ownership, deletion, namespaced collisions, current-room-only tools/recaps, fair source
retention, revocation during generation, source links and actual SDK tool registration. Real meeting
recognition, latency and comparison accuracy require separate provider/audio acceptance checks.

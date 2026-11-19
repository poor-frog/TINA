# Transcript document v1

Owner: meetings. The existing live transcript.v1 stays unchanged. This owner-only review document exposes original ASR text, conservative NFC/whitespace normalization, corrected text, append-only history and source-audio references when available.

`revision` counts accepted manual/restore/refinement revisions. PATCH requires `expected_revision` and `text` (null restores the original); stale writes return 409. Corrections require a terminal meeting and never replace original audio or ASR rows. Producer `start_ms`/`end_ms` are not word alignment. A Desktop refinement revision also records `job_id`, ASR `model` and the source WAV `audio_sha256`; only explicit Apply of a saved transcript-refinement.v1 proposal creates this kind.

Optional word times and word-level speaker attribution are served by the separate owner-only
`transcript-alignment.v1` view. This closed v1 document retains its segment-level time semantics.

Desktop appends immutable Float32 PCM chunks with session/channel/capture timestamps. Document audio references point to these chunks; segment playback retains gaps. Missing provenance returns an empty audio array. Meeting API lists actual recordings separately, without asserting channel/word alignment for mixed recordings.

Desktop: GET `/transcripts/{platform}/{native}/document`; PATCH `/transcripts/{platform}/{native}/segments/{segment_id}`; GET `/transcripts/{platform}/{native}/review`. Cloud: GET `/transcripts/by-id/{meeting_id}/document`; PATCH `/transcripts/by-id/{meeting_id}/segments/{segment_id}` via authenticated gateway. Raw history is owner-only. Ordinary REST transcript reads use the correction overlay; live Redis events remain original ASR.

Audio references aggregate matching frames per capture session/channel to keep document responses small. `chunk_count` counts the frames and `chunk_id` anchors one retained frame, not a concatenated audio file. Segment playback reads all matching frames and retains gaps.

Canonical text is now shared by ordinary reads and indexed search: the original ASR and correction
history remain the authority; PostgreSQL materializes accepted text/revision for GIN search and
Desktop maintains an atomic FTS5 projection. Metadata-only transcript-revision.v1 notifications
refresh exact snapshots after manual edits, refinement Apply and Restore. Live raw frames cannot
replace accepted revisions, including an accepted empty legacy Restore.

Applied bot refinement may include optional `preprocessing` in its immutable history entry: method/applied/gain_db/reason plus the actual prepared ASR input hash. The existing `audio_sha256` remains the original clip hash. This provenance survives starting a later job and Restore; original audio/text stay immutable. Legacy/Desktop revisions omit it.

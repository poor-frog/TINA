# Golden fixtures

`Refinement.json` is a completed second-pass ASR proposal before owner Apply. Run `node validate.mjs` from the contract directory.

`AudioCheck.json` covers optional check-only mode, diagnostics and non-applicable checked items.

`RetryableFailure.json` covers a sanitized failed ASR attempt with pinned backend and source.

`PreparedAudio.json` covers opt-in bounded gain with distinct original/prepared
input hashes and last-attempt HTTP duration. No original recording is modified.

`TextAudioReview.json` covers separate source and second-pass checks. Repeated text
coincides with mostly quiet original audio; this stays an advisory, unapplied proposal.

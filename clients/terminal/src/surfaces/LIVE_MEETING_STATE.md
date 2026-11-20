# Live meeting state surface

`LiveMeetingState.tsx` is the participant surface for the Meeting API's structured state. It displays
source-linked provisional items, reconciled summaries, topic relationships, independent extraction/
reasoning freshness, revision-checked field edits, approval proposals, and a paged archive. It never
reclassifies transcript content in the browser.

The explicit **Research documents** action calls the bounded shared-workspace research endpoint;
there is no private-workspace or web search action. The source is revalidated before meeting state
publication. A missing or revoked source is withheld rather than rendered from a stale cached excerpt.

The operator section is shown only to the existing allowlisted admin surface. Its per-meeting profiler
cache and retry API are separately internal-secret protected.

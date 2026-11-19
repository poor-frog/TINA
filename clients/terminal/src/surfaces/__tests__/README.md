# surfaces tests

Tests for terminal surface state, gateway websocket handling, and meeting actions. Fixtures live in `fixtures/`.

`chatgptConnection.test.tsx` waits for the asynchronous sign-in update and focus listener
to settle before simulating a return from the popup. It verifies that focus refreshes
account status while preserving the reconnect handoff for the still-connected old account,
without relying on CI timing or extending test timeouts.

`settingsModels.test.tsx` verifies that model settings hide manual thinking controls and clear
legacy effort pins when saving. Provider inference behavior is tested in the agent domain;
the language selector and phrase-overlay UI are covered by the [canvas tests](../../canvas/__tests__/README.md).

From the repository root, run `pnpm --dir clients/terminal test src/surfaces/__tests__/settingsModels.test.tsx`
for the settings regression or `pnpm --dir clients/terminal test src/surfaces/__tests__` for this suite.

`meetingMemory.test.tsx` also checks that the suggestions-only window filter hides/restores
conversation evidence locally without issuing additional API requests.

`meetingDialogs.test.tsx` checks all three native meeting dialogs consume Escape while open,
then release the workbench navigation shortcut after closing, including the real window-capture
keybinding service that attaches before the dialog handler.

`meetingHeaderControls.test.tsx` also checks recap metadata: a cached live-only time label
is removed after the meeting ends, or replaced with the recorded start time when available.

Transcript review tests also verify the check-only request, visible advisory reason,
quality filtering and absence of Apply for checked items.

The second-pass evidence regression verifies that a normal source with a suspicious
suggestion enters the review filter, shows separate source/suggestion checks, leaves
the draft unchanged and sends no automatic Apply. Owner edits invalidate the evidence.

The failed-refinement retry test verifies job-ID-only submission, preserved successful
suggestions and in-flight job progress without replacing mode/vocabulary.

The quiet-audio test verifies default-off behavior, explicit ASR opt-in, prepared-input
explanation and omission of normalization from check-only requests. Existing retry tests
continue to require job-ID-only submission, so changing local options cannot alter retry.

`meetingVoiceDrafts.test.tsx` checks explicit owner review, editable fields, failed refresh and stale revisions. `tasksVoiceRefresh.test.tsx` checks that approved voice tasks appear in Tasks without reopening the list.

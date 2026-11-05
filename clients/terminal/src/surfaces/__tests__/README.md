# surfaces tests

Tests for terminal surface state, gateway websocket handling, and meeting actions. Fixtures live in `fixtures/`.

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

The failed-refinement retry test verifies job-ID-only submission, preserved successful
suggestions and in-flight job progress without replacing mode/vocabulary.

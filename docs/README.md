# docs/ — where each kind of documentation lives

The constitutions, local workflow, and compliance notes are single-sourced in [`docs/docs/`](docs/).
No public documentation host is configured. Start at
[`docs/docs/governance/index.mdx`](docs/governance/index.mdx) ("How TINA governs itself").

What remains here, deliberately repo-side:

- [`adr/`](adr/) — the case law: decision records the constitutions cite (`lane:contract`).
- [`views/`](views/) — **generated** architecture projections (`architecture.dsl`, `.mmd`) —
  written by `pnpm arch:dsl` / `arch:viz`, drift-checked by `gate:dataflow`. Never hand-edit.
- [`test-scenarios/`](test-scenarios/) — internal manual test notes.
- [`tina-speech-plan.md`](tina-speech-plan.md) — proposed wake-word + shared TTS implementation
  checklist, reuse boundaries and acceptance gates; not a deployed runtime description.
- `ARCHITECTURE.md`, `DELIVERY*.md`, … — **pointer stubs** for historical source links; current
  content lives in `docs/docs/governance/`.

- [Bot-hosted Google Meet voice assistant](tina-meeting-voice.md): owner-approved sources, model cache and lifecycle.

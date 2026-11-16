# Windows Capture Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. The owner delegated implementation details, then authorized logical commits and pushing `feat/win-capture` only. Do not merge into main.

**Goal:** Run the existing TINA Capture app on Windows 11 with manual dual-source recording.

**Architecture:** A WASAPI backend feeds the existing capture protocol and Desktop pipeline. Platform-specific secret storage, shell integration and launch configuration adapt at the client boundary.

**Tech Stack:** Tauri 2, Rust, WASAPI, Node.js, Windows DPAPI.

**Spec:** `docs/superpowers/specs/2026-11-16-windows-capture-design.md`

## Global constraints

- Keep channels 999/1000, capture.v1 and sample-index.v1 unchanged.
- Authenticate the local server before opening audio devices. Preserve bounded queues, write timeouts and pause epochs.
- Preserve macOS code and the current deployment; no automatic audio recording or new model. Commit and push only the authorized feature branch.
- Work in the current clean checkout as authorized; do not create a second worktree or request another workflow choice.

## Review focus

- Paused/stopped audio must not be sent later.
- Device errors and timestamp discontinuities must not create fake continuous audio.
- A missing or invalid ingest secret must fail closed.
- Windows must not display macOS-only permissions or shortcuts as usable.
- Export must not overwrite existing notes; server credentials must not enter frontend or logs.

## Tasks

- [x] 1. Add failing tests for Windows secret paths/launcher configuration, shared protocol encoding, and platform UI. Run the focused tests and record failures.
- [x] 2. Reuse codec/transport and add Windows capture (`capture_windows.rs`), using timestamped WASAPI packets and bounded source workers. Add focused format/timeline/cancellation tests; run Rust checks/tests.
- [x] 3. Adapt `ingest_auth.rs`, `desktop-local.mjs` and its focused helper/tests for Windows DPAPI, ENV_FILE and host ASR endpoints. Keep credentials server-side.
- [x] 4. Adapt Tauri packaging, permission/help text, export/reveal and window close behavior for Windows; run UI tests and a Windows build.
- [x] 5. Update client/launcher documentation, architecture metadata/seal, run the relevant checks, and request a fresh review. Fix material findings and report remaining hardware/OS limitations.

## Evidence ledger

- Initial state: main at e6096de; working tree clean; graphify-out absent. Windows 11 with MSVC Build Tools, Rust and WebView2 installed. Backend stack already running in Docker/WSL.
- Branch: owner requested `feat/win-capture`; renamed branch accordingly. No commits or pushes.
- Task 1: protocol tests failed before extraction, then passed (2/2); platform tests failed before implementation, then passed. DPAPI helper tests 3/3 and UI/launcher suite 25/25.
- Task 2: native Windows compilation and 25 Rust tests passed. Added a timestamp-regression test, observed RED, fixed the clock check and observed GREEN. Common transport/codec extracted without changing macOS logic.
- Task 3: host deployment-URL test observed RED, then GREEN after adapting only the deployment selection; personal/custom selection preserved. Desktop dependency build and authenticated-ingest proxy test passed.
- Ruling: Windows uses original microphone PCM and reports absent Speex AEC, as the design specifies. Fn/automatic meeting detection/paste remain visibly unavailable; headphones are required for reliable echo control. Cost: not full macOS feature parity.
- Hardware evidence: WASAPI enumeration finds no default input endpoint. Windows reports only monitor and EDIFIER speaker outputs. No microphone recording was started. This needs a connected/selected microphone for dual-source hardware acceptance.

- Final review: fresh reviewer reported four Important issues (loopback buffer size, capture-time pause fence, unbounded activation join, Windows DOM selector). Fixed in one pass. Added delayed-packet, stalled-worker and actual-DOM regressions (observed RED then GREEN); removed unsupported GetBufferSize using the upstream API contract and retained fixed packet bounds. Final focused suites: Rust 29 passed/1 hardware test ignored; UI/launcher 26 passed; central transcription and authenticated proxy passed.
- Ruling: uncancellable Windows activation workers are detached after cancellation; when Windows eventually returns they see cancellation and retire without streaming. Cost: an OS-stalled activation thread may remain until app exit, but Stop and timeout stay bounded.
- Desktop background launch: automatic command review rejected Start-Process with ?blocked by policy? and no detailed reason. No workaround launched the background host. Build/tests continue; operator launch commands are documented.

- Final artifacts: release `tina-capture.exe` and NSIS `TINA Capture_0.1.0_x64-setup.exe` built successfully after all review fixes. Dataflow gate green (146 nodes/140 edges/19 carriers), architecture seal/views refreshed; JS syntax and whitespace checks clean. Graphify CLI is absent on both Windows and Ubuntu, and graphify-out does not exist, so its update could not run.
- User requested retaining the named feature branch; no merge into main. Commits and feature-branch push were subsequently authorized.

- Full Desktop suite: initially stopped on Node 24.11.1 Windows libuv UV_HANDLE_CLOSING after recording-e2e assertions passed. Reproduced that single test; upstream nodejs/node#56645 describes this shutdown issue. Downloaded and SHA-256 verified official Node 24.22.3 in the temporary directory, leaving system Node unchanged. Full @tina/desktop suite then passed including final recovery-process tests; desktop-e2e.live skipped because TINA_TX_KEY/EVAL_CACHE are absent. Windows guide documents the tested updated LTS.

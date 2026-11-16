# Windows Capture

The owner delegated implementation choices and requested Windows support in the existing Capture app.

## Scope

Support manual microphone and system-audio recording on Windows 11, with separate channels, pause/resume, live transcript and Markdown export. Preserve the macOS implementation. Keep capture.v1, sample-index.v1, loopback server authentication and explicit user-start unchanged. Do not automatically start recording for a hardware test.

## Approach

Extend the existing Tauri/Rust app. Use the Windows WASAPI API through the `wasapi` crate and its shared-mode audio conversion to mono 16 kHz. Reuse the existing binary codec and authenticated WebSocket transport. Windows audio needs its own worker lifecycle; it must preserve device timing, gaps and bounded cancellation. Use process-excluding loopback to avoid capturing the app's own sounds.

A separate Windows app would duplicate the UI and protocol; browser capture cannot provide the same native system-audio path. Neither is needed here.

The Desktop Node launcher runs natively on Windows, shares the server-owned configuration and ASR selection, and writes a per-user protected ingest secret. Adapt Docker-only ASR URLs at the Desktop boundary, not in core account settings. Windows stores the secret in LocalAppData protected by DPAPI. Native Rust decrypts it for the existing HMAC proof check.

Windows uses manual recording controls. macOS Fn, automatic meeting detection and automatic paste are not Windows features in this change. Keep their unsupported state visible. Do not claim Speex echo cancellation on Windows; report its absence and recommend headphones. No new transcription model or hosted service is introduced.

## Acceptance

Windows build and focused Rust/UI/launcher tests pass. Hardware checks confirm available WASAPI devices without recording; real audio testing requires an explicit user start. Existing pause/stop/authentication tests and UI tests remain green. Document launch/build commands, Windows limitations, and hardware verification gaps. Update architecture metadata and seal for the Windows client flow. Preserve the running server, credentials, existing user changes and Git history.

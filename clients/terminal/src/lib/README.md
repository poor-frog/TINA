# Terminal boundary helpers

`asrStatus.ts` validates the meetings-owned ASR status contract before diagnostics reach the browser.
`asrTelemetry.ts` keeps at most 100 content-free timing samples in the current browser page.
`chatgptPlanAuth.ts` supports the server-side ChatGPT connection flow.
Profile writes and disconnect go through the internal Agent API broker, which
coordinates them with refresh using the existing per-subject file lock and a
connection generation. Logout cancels pending states; old callback generations
cannot reconnect a removed account. Access and refresh tokens never appear in browser responses.
`completeChatGPTSignIn` serves both the automatic callback and an authenticated manual handoff.
Only the initiating TINA subject can consume pending OAuth state; an anonymous callback can show
a copyable callback URL without consuming it. Handoff codes stay in page/component memory only.

voiceActivity maps meeting-voice.v1 runtime and fresh KWS readiness to bounded presentation states; missing/expired data never implies listening.

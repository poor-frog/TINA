# Local speech implementation

`cli` and `session` own the opt-in host capture/replay lifecycle. The shared `tina_meeting_voice` package in `core/meetings/modules/voice-engine` owns bounded capture, per-input wake detection, VAD and model asset verification. The client calls the explicitly enrolled single-room coordinator only for `run`/`run-file`.

[`model-assets.json`](../../core/meetings/modules/voice-engine/tina_meeting_voice/model-assets.json) records the operator-downloaded Apache-2.0 model's provenance and hashes.

`coordinator` validates the anchored ASR wake prefix, including VieGem's unaccented `hay tina` spelling, before accepting question text. Acoustic detection remains `HEY_TINA` and runs locally in the participant; this spelling adaptation does not broaden the allowed sources. Shared capture keeps a bounded 1200 ms continuation window after the wake endpoint so a short pause does not discard the following question.

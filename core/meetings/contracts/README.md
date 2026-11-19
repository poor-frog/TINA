# contracts — published by `meetings`

Language-neutral contracts this domain owns (transcript · lifecycle · acts · invocation ·
service-authority · ASR status). Consumers reference them across the boundary (the legitimate seam); a domain
may depend on another domain's `contracts/` but never its `services/`/`modules/`. `gate:schema`
validates goldens ≡ schema.

`speech.v1` adds opt-in correlated playback receipts and the authorized single-room speech
pilot; the frozen legacy `acts.v1` command shapes remain unchanged.

`speech-room.v1` adds authenticated occupancy snapshots, atomic capture revisions and boot
epoch fencing for multiple enrolled host clients. Speech playback shapes stay unchanged.

- [`meeting-voice.v1`](meeting-voice.v1/README.md): owner-approved sources, bounded voice questions and ephemeral room status.

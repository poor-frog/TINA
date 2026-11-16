# Voice engine tests

Channel isolation, ambiguous capture, quiet gating and timeout tests use fakes without microphone access. Native startup and real meeting acceptance are separate checks.

`test_kws_shadow.py` checks 64-to-80 ms buffering, per-channel isolation, identity/clock/sample-gap
resets, bounded streams/cooldown, busy/quiet gating, checksum rejection and atomic local installation.
Intermittent participant metadata must preserve continuous audio history; conflicting known IDs
must reset it. Tests also verify that missing ASR identity cannot erase a same-channel acoustic call.
Wake events retain transport identity through a short metadata gap, but expire it after 1.5 seconds
and never carry it across a source reset.
Busy-state VAD tests require endpoint reports without a LISTENING transition or KWS rearm.
The bot TypeScript tests verify that KWS alone authorizes a caller, failures disable voice without affecting transcript, and Stop fences late events.

`test_turn_shadow.py` checks hash-pinned atomic model installation, bounded IPC, front padding,
Whisper normalization and Namo class-one probability. Model scores never authorize voice turn
boundaries. Real CPU inference is a separate smoke; no quality result is inferred from silence.

Setup tests also require verified cached Silero weights to be readable by a non-root worker without
downloading again; inference verification itself never changes a read-only model mount.
Filter-buffer tests cover both 160-sample NS hops and 128-sample DTLN hops, including delay
compensation, sub-hop input and final partial frames without sample loss.

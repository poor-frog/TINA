# Native noise suppression

`webrtc_ns.cc` exposes only 16 kHz mono, 160-sample (10 ms) WebRTC NS Low through a C ABI.
The bot links Ubuntu noble's `webrtc-audio-processing` 0.3.1-0ubuntu6, BSD-3-Clause. AEC, HPF
and AGC remain disabled. Docker builds the shim separately; the runtime contains no compiler.

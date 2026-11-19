# Third-party licenses — baked artifacts outside the dependency gate

## Experimental bot noise suppression

The bot links Ubuntu noble's `libwebrtc-audio-processing1` 0.3.1-0ubuntu6 (WebRTC / Google,
BSD-3-Clause; upstream PATENTS grant). The library's copyright notices remain at
`/usr/share/doc/libwebrtc-audio-processing1/copyright` in the image. The small local C ABI shim
enables only 16 kHz mono NS Low; no model weights or third-party Python bindings are fetched.

## Optional local wake-word client

Phase 3 adds the operator-downloaded Silero VAD model (MIT) and a host-only FastAPI/uvicorn/httpx
coordinator. The VAD URL, size and SHA-256 are pinned with the KWS manifest. Certifi's unchanged
MPL certificate bundle is covered by the scoped record in `license-exceptions.json`.

`clients/speech` uses pinned Sherpa-ONNX 2.0.1 (including its core package), SentencePiece
0.2.2 (Apache-2.0), sounddevice/PortAudio (MIT) and NumPy (BSD). The operator-downloaded
GigaSpeech 3.3M KWS archive declares Apache-2.0 in its README, retained in the local cache.
Exact archive/file hashes are in `clients/speech/tina_speech/model-assets.json`.
Weights and generated SAPI audio fixtures are not committed or baked into TINA images.

## Optional speech sidecar

`deploy/tts` installs VieNeu 3.8.3 and sea-g2p (Apache-2.0) in a separate, optional image.
Its operator-downloaded VieNeu-TTS-v3-Turbo and OpenMOSS MOSS-Audio-Tokenizer-Nano-ONNX
assets declare Apache-2.0 in their upstream model cards. Exact revisions/checksums are in
[`deploy/tts/model-assets.json`](deploy/tts/model-assets.json); cards travel with the private
read-only model cache. No weights, reference voices or eSpeak data are baked into TINA images.
The image retains the installed packages' upstream licence notices.
Transitive Category B packages (certifi, orjson, Python-SoXR and SoundFile's shared libsndfile)
remain unmodified separate packages/native libraries in this optional image; their scope and
disposition are recorded in [`license-exceptions.json`](license-exceptions.json). This is not
a claim that the complete SDK dependency tree is Apache-2.0.

`gate:licenses` (ADR-0004, `scripts/gates.mjs`) scans the resolved **npm** dependency
tree (`pnpm licenses list --json`) and the Python tree grows into `pip-licenses`. Neither
sees **non-dependency artifacts baked into the images** — model weights pulled from a model
hub, or a service binary built from source at image-build time. This file is the
packaging-side complement: every such artifact is recorded here with its license, mirrored
into the per-release SPDX SBOM (`scripts/sbom.mjs`), and — for baked binaries and pinned
container images — audited by **`gate:image-licenses`** against
[`image-licenses.json`](image-licenses.json) (#653).

The verbatim upstream license for each entry lives under [`licenses/`](licenses/) and is
copied into the image next to the artifact it covers, so the notice travels with the bytes.

The SPDX also inventories every package name in the Lite Dockerfile's final-stage `apt install`.
That is a source-level inventory: Docker source does not resolve Ubuntu package versions or
package licences, so those fields are emitted as `NOASSERTION` until an image-level scanner
enriches them. Builder-stage packages that do not cross into the final image are excluded.

## Native ASR Rust wrapper

Native ASR includes `sherpa-onnx` 1.13.8 (Apache-2.0), preserved under
[`core/meetings/services/native-asr/vendor/sherpa-onnx`](core/meetings/services/native-asr/vendor/sherpa-onnx).
The upstream [LICENSE](core/meetings/services/native-asr/vendor/sherpa-onnx/LICENSE),
original file hashes and [local patch notice](core/meetings/services/native-asr/vendor/sherpa-onnx/TINA-PATCH.md)
travel with the wrapper source. Native `sherpa-onnx-sys` remains pinned to registry 1.13.8.

## Native capture AEC

The default macOS `speex-aec` build feature uses `aec-rs-sys` 1.0.0
(MIT), which compiles the bundled SpeexDSP 1.2.1 Acoustic Echo Canceller (BSD-3-Clause).
The preserved upstream notices are [`licenses/aec-rs-sys-1.0.0.LICENSE.txt`](licenses/aec-rs-sys-1.0.0.LICENSE.txt)
and [`licenses/speexdsp-1.2.1.COPYING.txt`](licenses/speexdsp-1.2.1.COPYING.txt).
The app bundle includes these notices under `Contents/Resources/licenses`.

## Baked service binaries

| Artifact | Version | License | Source | Baked into | In-image path |
| --- | --- | --- | --- | --- | --- |
| `valkey` | `8.1.9` | BSD-3-Clause | [github.com/valkey-io/valkey](https://github.com/valkey-io/valkey) | `tina/tina-lite` | `/usr/local/bin/valkey-server`, `/usr/local/share/valkey/LICENSE` |

**`valkey`** — the internal cache / stream store (bus, scheduler, per-dispatch streams). Lite
builds `valkey-server` + `valkey-cli` from the pinned git tag in the `valkey-builder` stage of
[`deploy/lite/Dockerfile.lite`](deploy/lite/Dockerfile.lite) (glibc-matched to the final image;
an alpine/musl binary can't run there) and copies them onto `PATH`. Valkey is the Linux
Foundation's BSD-3-Clause fork of Redis 7.2.4 — it has `XAUTOCLAIM` (parity with compose/helm)
and keeps Lite off both jammy apt's stale Redis 6.0.16 and source-available Redis ≥7.4
(RSALv2/SSPLv1). compose and helm pin `valkey/valkey:8-alpine` (operator-pulled, recorded in
[`image-licenses.json`](image-licenses.json)). Full text:
[`licenses/valkey-8.1.9.COPYING.txt`](licenses/valkey-8.1.9.COPYING.txt).

> BSD-3-Clause is a Category-A (permissive) license under ADR-0004; baking it requires no
> exception, only that the notice be preserved — which this file and the in-image
> `/usr/local/share/valkey/LICENSE` satisfy.

## Baked model weights

| Artifact | Version (revision) | License | Source | Baked into | In-image path |
| --- | --- | --- | --- | --- | --- |
| `onnx-community/pyannote-segmentation-3.0` | `main` | MIT | [huggingface.co](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) | `tina/tina-bot`, `tina/tina-lite` | `/opt/hf-cache/LICENSE.pyannote-segmentation-3.0` |

**`onnx-community/pyannote-segmentation-3.0`** — the mixed (Zoom/Teams) speaker-diarization
lane segments speakers with this model, loaded OFFLINE from an image-baked HuggingFace cache
at `/opt/hf-cache` (see [`warm-hf-cache.mjs`](core/meetings/services/bot/warm-hf-cache.mjs)).
It is an ONNX conversion of the gated [`pyannote/segmentation-3.0`](https://huggingface.co/pyannote/segmentation-3.0);
the conversion is published MIT and **not** gated. The model card ships no LICENSE file of
its own, so the preserved notice is the [pyannote.audio](https://github.com/pyannote/pyannote-audio)
project's MIT license (`Copyright (c) 2020 CNRS`), whose copyright governs the weights. Full
text: [`licenses/onnx-community-pyannote-segmentation-3.0.LICENSE.txt`](licenses/onnx-community-pyannote-segmentation-3.0.LICENSE.txt).

> MIT is a Category-A (permissive) license under ADR-0004; baking it requires no exception,
> only that the copyright + permission notice be preserved — which this file and the baked
> `/opt/hf-cache/LICENSE.*` satisfy.

The shared `core/meetings/modules/voice-engine` reuses the existing pinned Sherpa-ONNX CPU KWS (Apache-2.0), SentencePiece and Silero VAD (MIT) assets from the host speech pilot. Models remain outside source/images in an operator-provisioned read-only cache; original notices are retained by the installer.

The isolated bot KWS runtime pins LiveKit WakeWord 2.1.1 (Apache-2.0) and ONNX Runtime 1.31.1
(MIT). The two retained local `tina-v1` ONNX detectors were fine-tuned from LiveKit's standard pretrained
encoder using VieNeu synthetic speech. Their sizes/hashes are pinned in
`core/meetings/modules/voice-engine/tina_meeting_voice/livekit-models.json`; weights are not committed
or baked into images. Upstream LICENSE and NOTICE are preserved in that package as `livekit.LICENSE`
and `livekit.NOTICE` and copied alongside the weights by `deploy/wakeword/install_local.py`.

## Optional self-hosted LiveKit Agents pilot

`deploy/livekit` pins LiveKit Agents 1.8.11 (Apache-2.0) and its SDK dependencies in `uv.lock`.
The separate `livekit/livekit-server:v1.13.11` upstream image is Apache-2.0. Upstream license and
package notices are retained in their installed distributions/images. This pilot uses custom
HTTP text/PCM I/O and no LiveKit Cloud Inference or proprietary noise cancellation plugin.

## Local voice semantic retrieval

Agent API bakes the INT8 ONNX conversion `Xenova/multilingual-e5-small` (MIT), revision
`761b726dd34fb83930e26aab4e9ac3899aa1fa78`, derived from `intfloat/multilingual-e5-small`.
Model/tokenizer SHA-256 values are pinned in `control_plane/voice_retrieval.py`. The notice is
`licenses/multilingual-e5-small.LICENSE.txt` and `/opt/tina/voice-retrieval/LICENSE.txt` in the image.
ONNX Runtime, NumPy and Tokenizers are control-plane-only runtime dependencies in the Python lock.

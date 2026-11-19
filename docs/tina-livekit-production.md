# Three-meeting voice production candidate

Target: three concurrent voice meetings on one self-hosted Agents worker process. Each meeting/bot
session owns an independent room, AgentSession, lock and caller context. A fourth meeting receives
503. Run a single replica/process; this change does not implement horizontal worker scheduling.
Native TINA remains available as the per-room owner-selected alternative.

## Startup and assets

`make all` builds the source checkout, prepares native MPS or Docker CUDA ASR, installs model assets,
checks images and activates Compose only after build/setup succeeds. New templates enable meeting
voice; existing configs must set `TINA_MEETING_VOICE=1`. If the selected main env has no TTS token,
Stack reads `deploy/tts/.env` with the same root `.env.keys` used for the main env. An optional local
TTS pair can override it. No decryption key is forwarded to containers or plaintext token entry needed. `make plan`
reports missing credentials without creating files; deployment fails closed when credentials are absent.

Supply the two pinned `hey_tina.onnx`/`tina_oi.onnx` files in `TINA_KWS_MODELS_DIR`, or keep an already
verified `meeting-voice-models` volume. The default local source is
`output/wakeword-training/tina-v1/models`. The installer imports from a read-only host bind, verifies
hashes again and uses the existing atomic cache installer. A clone does not recreate trained models.
A missing/corrupt cache and absent artifact source stop before application restart. Inference bots
mount the cache read-only and never download on meeting join.

## Health, readiness and throughput

Agents `/health` checks LiveKit server/Meeting API and reports capacity/session counts. `/ready`
also validates TTS credential shape, authenticated TTS `/ready` and PCM16/24kHz/mono metadata.
Compose and Meeting API voice preflight use `/ready`; no paid LLM request or synthesis runs in a
health loop. A full worker stays healthy, while admission rejects another meeting.

TTS keeps serialized native inference with six FIFO waiters, thirty-second queue wait and sixteen
bounded connections. Three meetings can each reserve current speech plus one lookahead. Cached
public acknowledgments/wait notices bypass native inference after authentication/validation, so
a long reply in another meeting does not hold the public notice queue. Private replies are not cached.

## Cancellation and restart

Meeting API remains the authoritative writer of the active Redis reservation and durable playback
receipts. Agents PCM validates `GET /bots/voice/{meeting}/{session}/turn/{request}?revision=...`
using only the scoped bot capability before synthesis, after taking the SDK lock, periodically while
streaming and before successful completion. Missing/replaced/Stop/revoked reservations refuse audio,
including when the Agents process has lost its in-memory Stop deque. No owner API key enters Agents.

SDK rooms are ephemeral. A restart abandons an in-flight request; the bot's existing error/Quiet
path releases the core turn and the next request gets a fresh UUID/session runtime. Source-valid
heard history is rebuilt from TINA, never from generated-but-unheard SDK output. This is not a
promise to resume or replay an interrupted reply automatically.

## Automated qualification

Run the unit/API suites and `python production_smoke.py` inside the built Agents worker. The smoke
opens three real local rooms, runs actual SDK tool loops, isolates different contexts with the same
speaker key, performs five rounds of three concurrent uncached VieNeu PCM streams over TCP, rejects
a fourth room, checks per-meeting Stop and quota-error recovery, recreates the runtime, refuses stale
audio and removes its own rooms. It reports first-PCM latency. Its Meeting API, LLM and playback
receipt authority are explicit synthetic fixtures; it does not write real meeting data or call a paid LLM.

A passing automated run is a production-candidate gate, not a full voice-quality certification.
Real Google Meet admission, user microphones/speakers, wake-word recall/false triggers, echo,
interruption timing, actual LLM quota and ASR accuracy under real meeting concurrency remain a
separate acceptance stage. Real-meeting testing is deferred at the operator's request.

## Release and rollback

Record source hashes, exact image IDs, selected deployment/profile, model artifact checksums and
test reports. Keep `.env`, keys, model weights, private audio and raw provider payloads out of Git
and public release artifacts. The trained KWS pack must be handed to new hosts through the operator's
approved artifact channel. A release must reference a reviewed commit and pinned local/registry image IDs.

Disable the affected room's Voice assistant or select native TINA to stop new Agents work, then
roll back pinned images while idle. Preserve volumes and source policies. Restore the previous
configuration intentionally; do not rotate keys or delete data volumes as a recovery shortcut.

### Moving the retained KWS pack to a new host

The local qualification output can contain `kws-models.tar.gz` with exactly the two ONNX files,
manifest and upstream LICENSE/NOTICE, plus a separate SHA-256 record. It contains no training audio
or credentials and is not uploaded automatically. Obtain the reviewed artifact through the operator's
approved channel, verify its checksum, then extract it into the default input directory:

```sh
mkdir -p output/wakeword-training/tina-v1/models
tar -xzf /path/to/reviewed/kws-models.tar.gz -C output/wakeword-training/tina-v1/models
make all
```

The runtime still checks the pinned ONNX hashes after import. A different newly trained model
requires an intentional manifest update; never bypass hash verification to make startup succeed.

`make doctor` checks desired managed ASR backends from enabled account demand, including native
MPS status. An unused stopped backend can be reported as idle. This deployment diagnostic does
not replace per-meeting capture/backend health for an already pinned session.

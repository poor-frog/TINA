"""Explicit Start/Stop microphone capture or deterministic WAV replay."""
import argparse
import json
from pathlib import Path
from queue import Empty
import sys
import time
import wave

import numpy as np

from tina_meeting_voice.assets import default_directory, install
from tina_meeting_voice.wakeword import BLOCK_SIZE, SAMPLE_RATE, CaptureQueue, SherpaKws, WakeDetector


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def wav_blocks(path):
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
            raise ValueError("WAV must be uncompressed mono PCM16 at 16000 Hz")
        while raw := audio.readframes(BLOCK_SIZE):
            yield np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    # Decode the final chunk's acoustic lookahead, without declaring a second utterance.
    for _ in range(20):
        yield np.zeros(BLOCK_SIZE, dtype=np.float32)


def detect(detector, blocks):
    count = 0
    for block in blocks:
        event = detector.feed(block)
        if event:
            count += 1
            emit(event.diagnostic())
    return count


def listen(detector, device, seconds):
    import sounddevice as sd
    sd.check_input_settings(device=device, channels=1, dtype="float32", samplerate=SAMPLE_RATE)
    capture = CaptureQueue()

    def callback(indata, frames, timing, status):
        if not capture.push(indata[:, 0], overflow=bool(status)):
            raise sd.CallbackAbort

    count = 0
    # Native callbacks enqueue copies only. Model inference always runs on this thread.
    with sd.InputStream(device=device, channels=1, samplerate=SAMPLE_RATE, dtype="float32",
                        blocksize=BLOCK_SIZE, callback=callback) as stream:
        emit({"event": "listening", "device": device, "sample_rate": SAMPLE_RATE,
              "keyword": "HEY_TINA", "duration_seconds": seconds or None})
        start = time.monotonic()
        while not seconds or time.monotonic() - start < seconds:
            if capture.failed:
                raise ValueError("Microphone overflow; stopped and disarmed. Choose another device or reduce CPU load")
            if not stream.active:
                raise ValueError("Microphone stream stopped; detector disarmed")
            try:
                block = capture.blocks.get(timeout=.1)
            except Empty:
                continue
            event = detector.feed(block)
            if event:
                count += 1
                emit(event.diagnostic())
        if capture.failed:
            raise ValueError("Microphone overflow; stopped and disarmed")
    return count


def parser():
    root = argparse.ArgumentParser(description="Local-only Hey TINA wake-word pilot; Ctrl+C stops microphone capture")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("devices", help="List input devices without recording")
    server = sub.add_parser("serve", help="Run the single-room authorized coordinator on loopback")
    server.add_argument("--config", type=Path, required=True)
    server.add_argument("--port", type=int, default=18006)
    for command in ("setup", "listen", "file", "run", "run-file"):
        p = sub.add_parser(command)
        p.add_argument("--model-dir", type=Path, default=default_directory())
        if command in ("listen", "run"):
            p.add_argument("--device", type=int, required=True, help="Explicit input index from devices")
            p.add_argument("--seconds", type=float, default=0, help="0: run until Ctrl+C")
        elif command in ("file", "run-file"):
            p.add_argument("wav", type=Path)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    detector = None
    try:
        if args.command == 'serve':
            from .coordinator import from_config
            import uvicorn
            uvicorn.run(from_config(args.config), host='127.0.0.1', port=args.port, access_log=False)
            return 0
        if args.command == "devices":
            import sounddevice as sd
            for index, device in enumerate(sd.query_devices()):
                if device["max_input_channels"]:
                    emit({"device": index, "name": device["name"], "channels": device["max_input_channels"],
                          "host_api": sd.query_hostapis(device["hostapi"])["name"]})
            return 0
        if args.command == "setup":
            install(args.model_dir)
            emit({"event": "model_ready", "directory": str(args.model_dir)})
            return 0
        if args.command in ("listen", "run") and (args.seconds < 0 or not np.isfinite(args.seconds)):
            raise ValueError("--seconds must be a finite non-negative number")
        if args.command in ('run', 'run-file'):
            from .session import SpeechSession, configured_client
            session = SpeechSession(args.model_dir, configured_client(), emit)
            try:
                if args.command == 'run':
                    listen(session, args.device, args.seconds)
                else:
                    for block in wav_blocks(args.wav):
                        session.feed(block)
                        # Replay one synthetic voice turn at capture speed; no microphone is opened.
                        time.sleep(len(block) / SAMPLE_RATE)
                    if session.state == 'CAPTURING':
                        raise ValueError('WAV ended before question endpoint; include at least one second trailing silence')
                    deadline = time.monotonic() + 330
                    while session.state not in ('ARMED', 'ERROR') and time.monotonic() < deadline:
                        session.feed(np.zeros(BLOCK_SIZE, dtype=np.float32))
                        time.sleep(BLOCK_SIZE / SAMPLE_RATE)
                    if session.state != 'ARMED': return 1
                return 0
            finally:
                session.close()
        detector = WakeDetector(SherpaKws(args.model_dir))
        start, cpu = time.perf_counter(), time.process_time()
        count = listen(detector, args.device, args.seconds) if args.command == "listen" else detect(detector, wav_blocks(args.wav))
        elapsed = time.perf_counter() - start
        cpu_seconds = time.process_time() - cpu
        emit({"event": "stopped", "detections": count, "audio_seconds": detector.samples / SAMPLE_RATE,
              "wall_seconds": round(elapsed, 4), "cpu_seconds": round(cpu_seconds, 4),
              "cpu_percent": round(cpu_seconds / max(elapsed, .0001) * 100, 2),
              "cpu_realtime_percent": round(cpu_seconds / max(detector.samples / SAMPLE_RATE, .0001) * 100, 2),
              "decode_padding_seconds": .4 if args.command == "file" else 0})
        return 0
    except KeyboardInterrupt:
        emit({"event": "stopped", "reason": "operator"})
        return 0
    except Exception as exc:
        # PortAudio's platform-specific device errors also fail closed here.
        print("tina-speech: " + str(exc), file=sys.stderr)
        return 1
    finally:
        if detector is not None:
            detector.close()


if __name__ == "__main__":
    raise SystemExit(main())

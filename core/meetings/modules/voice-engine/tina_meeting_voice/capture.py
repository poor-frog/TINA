"""Bounded question capture; preserve pre-roll and require an anchored ASR wake prefix."""
import io
import wave

import numpy as np

from .assets import verify_vad
from .wakeword import SAMPLE_RATE


class SileroVad:
    def __init__(self, directory):
        import sherpa_onnx as sherpa
        config = sherpa.VadModelConfig()
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        config.silero_vad.model = str(verify_vad(directory))
        config.silero_vad.min_silence_duration = .8
        config.silero_vad.min_speech_duration = .15
        config.silero_vad.max_speech_duration = 22
        self.vad = sherpa.VoiceActivityDetector(config, buffer_size_in_seconds=24)
        self.pending = np.array([], dtype=np.float32)
        self.last_end_sample = None

    def feed(self, audio):
        self.pending = np.concatenate([self.pending, audio])
        ended = False
        while len(self.pending) >= 512:
            self.vad.accept_waveform(self.pending[:512])
            self.pending = self.pending[512:]
            while not self.vad.empty():
                segment = self.vad.front
                self.last_end_sample = segment.start + len(segment.samples)
                ended = True
                self.vad.pop()
        return self.vad.is_speech_detected(), ended


class QuestionCapture:
    def __init__(self, event, vad):
        self.vad = vad
        # Keep the <=2 s local pre-roll, including the wake and any immediate question.
        # The pinned Python KWS API omits its absolute timestamp offset after silence;
        # do not crop a question using those relative token times. The coordinator
        # accepts only an ASR result beginning with the wake, never arbitrary prefix text.
        self.blocks = [event.pre_roll.copy()]
        self.initial = len(self.blocks[0])
        self.samples = self.initial
        self.started = False
        self.finished = False
        self.after_wake = self.initial
        # KWS may report after a short question has already entered the pre-roll.
        # Endpoint that speech too; ASR still requires wake + a nonempty question.
        active, ended = self.vad.feed(self.blocks[0])
        self.started = active or ended
        self.pre_roll_ended = ended and not active

    def feed(self, audio):
        if self.finished:
            raise ValueError("Capture already finished")
        block = np.asarray(audio, dtype=np.float32)
        if block.ndim != 1 or not 0 < len(block) <= 320 or not np.isfinite(block).all():
            raise ValueError("Invalid question audio block")
        self.samples += len(block)
        if self.samples - self.initial > 20 * SAMPLE_RATE:
            raise ValueError("Question exceeds 20 seconds")
        self.blocks.append(block.copy())
        active, ended = self.vad.feed(block)
        if ended:
            self.pre_roll_ended = True
        if active:
            self.pre_roll_ended = False
        if active and np.sqrt(np.mean(block ** 2)) >= .01 and self.samples > self.after_wake + 1600:
            self.started = True
        # VAD may have ended only the wake phrase before KWS reports it.
        buffered_end_ready = self.pre_roll_ended and self.samples - self.initial >= 1.2 * SAMPLE_RATE
        if self.started and buffered_end_ready and not active:
            self.finished = True
            return self.wav()
        if not self.started and self.samples - self.initial >= 5 * SAMPLE_RATE:
            raise ValueError("No question after wake phrase")
        return None

    def wav(self):
        output = io.BytesIO()
        pcm = np.rint(np.clip(np.concatenate(self.blocks), -1, 1) * 32767).astype("<i2").tobytes()
        with wave.open(output, "wb") as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(SAMPLE_RATE)
            out.writeframes(pcm)
        return output.getvalue()

"""One preset VieNeu ONNX CPU voice, exposed in the bot's PCM format."""
from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from speech_text import spoken_text, default_pronunciations

MODEL = "vieneu-v3-turbo"
SAMPLE_RATE = 24000
MAX_AUDIO_SECONDS = 120
PRESET_VOICE = "Trúc Ly"
ACK_TEXT = "Dạ, em nghe."
SUMMARY_NOTICE = "Em đang tổng hợp, bạn chờ một chút nhé."
# Keep these public phrases aligned with the bot's VOICE_NOTICES catalog.
WAKE_TEXTS = (ACK_TEXT, "Em đây, bạn nói đi.", "Dạ, bạn cứ nói nhé.", "Dạ, em đây.")
WAIT_TEXTS = ("Đợi em chút nhé.", "Em đang xử lý yêu cầu nhé.", "Em cần thêm một chút thời gian nhé.", "Chờ em một lát nhé.")
SUMMARY_TEXTS = (SUMMARY_NOTICE, "Em đang tổng hợp thông tin nhé.", "Em tổng hợp lại một chút nhé.", "Em gom lại các ý chính nhé.")
PROGRESS_TEXTS = ("Em đang tìm trong nội dung cuộc họp nhé.", "Em đang tìm trong tài liệu được chia sẻ nhé.",
                  "Em đang tìm thông tin trên web nhé.", "Em đang đọc kỹ phần liên quan nhé.", "Em đang soạn bản nháp nhé.")
# Keep old fixed phrases routable while existing bot images are still in use.
FIXED_TEXTS = WAKE_TEXTS + WAIT_TEXTS + SUMMARY_TEXTS + PROGRESS_TEXTS + (
    "Em chưa lấy được câu trả lời lúc này. Bạn có thể xem trạng thái trên TINA Terminal.",
    "Để em kiểm tra nhé.", "Em đang kiểm tra thông tin nhé.")


@lru_cache(maxsize=1)
def preset_voices():
    import vieneu
    data=json.loads((Path(vieneu.__file__).parent/'assets/voices_v3_turbo.json').read_text())['presets']
    return [{'id':name,'label':name,'region':value.get('region','')} for name,value in data.items()]


def selected_voice(voice='auto'):
    value=PRESET_VOICE if voice=='auto' else voice
    if value not in {row['id'] for row in preset_voices()}:raise ValueError('Choose a preset voice')
    return value


def verify_assets(directory: Path) -> None:
    """Check pinned snapshots before the offline SDK is allowed to load them."""
    from huggingface_hub import snapshot_download

    manifest = json.loads(Path(__file__).with_name("model-assets.json").read_text())
    for repo in manifest["repos"]:
        snapshot = Path(snapshot_download(repo["repo"], revision=repo["revision"],
                                         allow_patterns=[f["path"] for f in repo["files"]],
                                         cache_dir=str(directory / "hub"), local_files_only=True))
        for entry in repo["files"]:
            path = snapshot / entry["path"]
            data = path.read_bytes()
            if "sha256" in entry:
                actual = hashlib.sha256(data).hexdigest()
                expected = entry["sha256"]
            else:
                actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                expected = entry["git_blob"]
            if actual != expected:
                raise RuntimeError("TTS asset verification failed: " + entry["path"])
        # SDK requests main; the isolated offline cache must resolve only this pinned snapshot.
        ref = directory / "hub" / ("models--" + repo["repo"].replace("/", "--")) / "refs/main"
        if ref.read_text().strip() != repo["revision"]:
            raise RuntimeError("TTS offline cache reference does not match the manifest")


def pcm24(samples, rate: int) -> bytes:
    import numpy as np
    from scipy.signal import resample_poly
    from math import gcd

    audio = np.asarray(samples, dtype=np.float32)
    if (audio.ndim != 1 or not audio.size or not np.isfinite(audio).all()
            or rate <= 0 or audio.size > rate * MAX_AUDIO_SECONDS):
        raise ValueError("Invalid or oversized synthesized audio")
    if rate != SAMPLE_RATE:
        divisor = gcd(rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // divisor, rate // divisor)
    return np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


class Engine:
    def __init__(self, directory: Path):
        self.pronunciations = default_pronunciations()
        verify_assets(directory)
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from vieneu import Vieneu

        threads=int(os.environ.get('TINA_TTS_THREADS','2'))
        if not 1<=threads<=8:raise ValueError('TINA_TTS_THREADS must be between 1 and 8')
        self.tts = Vieneu(mode="v3turbo", backend="onnx", device="cpu", threads=threads,
                          backbone_repo="pnnbao-ump/VieNeu-TTS-v3-Turbo")

    def cached_public(self, text: str,voice='auto') -> bytes | None:
        return getattr(self, '_fixed_pcm', {}).get((selected_voice(voice),text)) if text in FIXED_TEXTS else None

    def synthesize(self, text: str, meeting_id: int | None = None,voice='auto',pronunciations=None) -> bytes:
        # Preset voice only: never accept an audio reference or user model path.
        cache = getattr(self, '_fixed_pcm', {})
        voice=selected_voice(voice);cached = self.cached_public(text,voice)
        if cached is not None:
            return cached
        glossary = getattr(self, 'pronunciations', default_pronunciations()).for_meeting(meeting_id)
        if pronunciations:glossary.update({k.casefold():v for k,v in pronunciations.items()})
        speech_text = text if text in FIXED_TEXTS else spoken_text(text, glossary)
        audio = self.tts.infer(speech_text, voice=voice, apply_watermark=False)
        pcm = pcm24(audio, self.tts.sample_rate)
        if text in FIXED_TEXTS:
            cache[(voice,text)] = pcm; self._fixed_pcm = cache
        return pcm

    def stream(self, text: str, meeting_id: int | None = None,voice='auto',pronunciations=None):
        import numpy as np
        import soxr
        voice=selected_voice(voice);cached = self.cached_public(text,voice)
        if cached is not None:
            yield cached
            return
        glossary = self.pronunciations.for_meeting(meeting_id)
        if pronunciations:glossary.update({k.casefold():v for k,v in pronunciations.items()})
        speech = text if text in FIXED_TEXTS else spoken_text(text, glossary)
        rate = self.tts.sample_rate
        resampler = soxr.ResampleStream(rate, SAMPLE_RATE, 1, dtype='float32', quality='HQ') if rate != SAMPLE_RATE else None
        chunks = self.tts.infer_stream(speech, voice=voice, apply_watermark=False)
        samples = 0
        public=[] if text in FIXED_TEXTS else None
        try:
            for chunk in chunks:
                audio = np.asarray(chunk, dtype=np.float32)
                if audio.ndim != 1 or not np.isfinite(audio).all(): raise ValueError('Invalid audio chunk')
                samples += audio.size
                if samples > rate * MAX_AUDIO_SECONDS: raise ValueError('Speech exceeds audio budget')
                if not audio.size: continue
                output = resampler.resample_chunk(audio) if resampler else audio
                if output.size:
                    pcm=np.rint(np.clip(output, -1, 1) * 32767).astype('<i2').tobytes()
                    if public is not None:public.append(pcm)
                    yield pcm
            if resampler:
                output = resampler.resample_chunk(np.array([], dtype=np.float32), last=True)
                if output.size:
                    pcm=np.rint(np.clip(output, -1, 1) * 32767).astype('<i2').tobytes()
                    if public is not None:public.append(pcm)
                    yield pcm
            if public is not None and public:
                if not hasattr(self,'_fixed_pcm'):self._fixed_pcm={}
                self._fixed_pcm[(voice,text)]=b''.join(public)
        finally:
            chunks.close()

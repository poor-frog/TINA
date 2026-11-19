"""Pinned VieGem CTC + KenLM, with FSMN intervals on the original sample clock."""
import json
import copy
import math
import os
import sys
from pathlib import Path
from types import MethodType

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gipformer.engine import HERE as GIPFORMER_HERE, RATE, read_audio, speech_ranges, verify_assets

HERE = Path(__file__).resolve().parent
MODEL = '5CD-AI/VieGem-ASR'


def name_biased_decoder(lm, weight):
    """Opt-in word-level name prior; never mutate the shared baseline decoder."""
    weight = float(weight)
    if not math.isfinite(weight) or not 0 <= weight <= 2:
        raise ValueError('TINA_VIEGEM_NAME_BIAS must be a finite value from 0 to 2')
    if weight == 0:
        return lm
    biased = copy.copy(lm)
    biased.bias_words = {'tina'}
    biased.bias_weight = weight
    # Upstream uses its LM vocabulary to penalize partial/OOV words. Admit the name as well
    # as boosting it; evaluate both effects because this can change competing hypotheses.
    if lm.vocab is not None:
        biased.vocab = lm.vocab | biased.bias_words
        biased.prefixes = lm.prefixes | {word[:i] for word in biased.bias_words for i in range(1, len(word) + 1)}
    return biased


def load_custom_words(file_path=None):
    if file_path is None:
        env_path = os.getenv('TINA_VIEGEM_CUSTOM_WORDS_FILE')
        file_path = Path(env_path) if env_path else HERE / 'custom_words.txt'
    else:
        file_path = Path(file_path)
    if not file_path.is_file():
        return []
    words = set()
    for line in file_path.read_text(encoding='utf-8').splitlines():
        line = line.strip().lower()
        if line and not line.startswith('#'):
            words.update(line.split())
    return sorted(words)


def contextual_biased_decoder(lm, custom_words=None, name_weight=0.0, custom_weight=1.0):
    name_weight, custom_weight = float(name_weight), float(custom_weight)
    if any(not math.isfinite(weight) or not 0 <= weight <= 2 for weight in (name_weight, custom_weight)):
        raise ValueError('VieGem bias weights must be finite values from 0 to 2')

    weights = {
        word.strip().lower(): custom_weight
        for word in custom_words or ()
        if custom_weight and word.strip() and word.strip().lower() != 'tina'
    }
    if name_weight:
        weights['tina'] = name_weight
    if not weights:
        return lm

    biased = copy.copy(lm)
    biased.bias_words = set(weights)
    biased.bias_weight = 0.0
    biased.bias_weights = weights
    if lm.vocab is not None:
        biased.vocab = lm.vocab | biased.bias_words
        biased.prefixes = (lm.prefixes or set()) | {
            word[:i] for word in biased.bias_words for i in range(1, len(word) + 1)
        }

    # Wrap only this copy so per-word weights do not modify the verified model decoder.
    base_word_score = type(lm)._word

    def word_score(self, state, word):
        state, score = base_word_score(self, state, word)
        return state, score + self.bias_weights.get(word, 0.0)

    biased._word = MethodType(word_score, biased)
    return biased


def verify_model_assets(directory):
    manifest = json.loads((HERE / 'model-assets.json').read_text())
    for group, spec in manifest.items():
        verify_assets(directory / group, spec['files'])
    vad_spec = json.loads((GIPFORMER_HERE / 'model-assets.json').read_text())
    verify_assets(directory / 'fsmn-vad', vad_spec['vad_files'])


class VieGemEngine:
    @classmethod
    def load(cls, directory):
        import torch
        from funasr import AutoModel
        from transformers import AutoTokenizer

        directory = Path(directory).resolve()
        verify_model_assets(directory)  # Verify code before importing it; all loading stays local.
        device = os.getenv('TINA_VIEGEM_DEVICE', 'mps')
        if device not in ('cpu', 'mps', 'cuda'):
            raise ValueError('TINA_VIEGEM_DEVICE must be cpu, mps or cuda')
        if device == 'mps' and not torch.backends.mps.is_available():
            raise RuntimeError('VieGem MPS requires an available Apple Metal device')
        if device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('VieGem CUDA requires an available NVIDIA device')
        torch.set_num_threads(2)
        sys.path.insert(0, str(directory / 'viegem'))
        from asr.model import CTCModel, ModelConfig
        from asr.text import Units
        from asr.lm_decode import LMDecoder

        checkpoint = torch.load(directory / 'viegem/viegem_asr.pt', map_location='cpu', weights_only=True)
        cfg = ModelConfig.from_dict(checkpoint['model_config'])
        if cfg.encoder_id != 'google/embeddinggemma-2':
            raise ValueError('Unexpected VieGem base model')
        cfg.encoder_id = str(directory / 'base')
        units = Units(checkpoint['gemma_ids'])
        tokenizer = AutoTokenizer.from_pretrained(cfg.encoder_id, local_files_only=True, trust_remote_code=False)
        model = CTCModel(cfg, units.gemma_ids)
        expected = set(model.trainable_state_dict())
        loaded = model.load_state_dict(checkpoint['model'], strict=False)
        if loaded.unexpected_keys or expected.intersection(loaded.missing_keys):
            raise ValueError('VieGem checkpoint does not cover the trained model parameters')
        del checkpoint
        model = model.float().eval().to(device)
        vad = AutoModel(model=str(directory / 'fsmn-vad'), device='cpu', disable_update=True,
                        disable_pbar=True, disable_log=True)
        lm = LMDecoder(str(directory / 'viegem/lm/viegem_lm.bin'),
                       unigrams=(directory / 'viegem/lm/viegem_lm.unigrams.txt').read_text().split(),
                       alpha=0.35, beta=1.5)
        weight = float(os.getenv('TINA_VIEGEM_NAME_BIAS', '0'))
        custom_weight = float(os.getenv('TINA_VIEGEM_CUSTOM_WEIGHT', '1.0'))
        lm = contextual_biased_decoder(lm, load_custom_words(), weight, custom_weight)
        engine = cls(vad, model, tokenizer, units, lm, device)
        engine.name_bias = weight
        engine.custom_bias_weight = custom_weight
        return engine

    def __init__(self, vad, model, tokenizer, units, lm, device):
        self.vad, self.model, self.tokenizer, self.units, self.lm, self.device = vad, model, tokenizer, units, lm, device
        self.pieces = ['', ''] + tokenizer.convert_ids_to_tokens(units.gemma_ids)

    def probabilities(self, pcm):
        import torch

        # Upstream feature extraction needs a complete analysis frame; padding is inference-only.
        minimum = self.model.mel.frame_length + 1
        x = torch.from_numpy(np.pad(pcm, (0, max(0, minimum - len(pcm))))[None]).to(self.device)
        with torch.inference_mode():
            logits, lengths = self.model(x, torch.tensor([x.shape[1]], device=self.device), streaming=False)
            probabilities = torch.log_softmax(logits[0, :int(lengths[0])].float(), -1).cpu().numpy()
        if not len(probabilities) or not np.isfinite(probabilities).all():
            raise RuntimeError('VieGem returned invalid CTC probabilities')
        return probabilities

    def decode_probabilities(self, probabilities, lm=None):
        return self.units.decode(self.tokenizer, (lm or self.lm).decode(probabilities, self.pieces, beam_width=32))

    def decode(self, pcm):
        return self.decode_probabilities(self.probabilities(pcm))

    def transcribe(self, content, silence_ms=1200):
        pcm, duration = read_audio(content)
        if not np.any(pcm):
            return {'text': '', 'duration': duration, 'segments': []}
        ranges = self.vad.generate(input=np.pad(pcm, (0, max(0, 3200 - len(pcm)))), cache={},
                                   is_final=True, fs=RATE, max_end_silence_time=silence_ms, disable_pbar=True)
        segments = []
        for start, end in speech_ranges(ranges, len(pcm)):
            text = self.decode(pcm[start:end]).strip()
            if len(text) > 10000:
                raise RuntimeError('ASR output exceeds limit')
            if text:
                segments.append({'start': start / RATE, 'end': min(duration, end / RATE), 'text': text})
        return {'text': ' '.join(s['text'] for s in segments), 'duration': duration, 'segments': segments}

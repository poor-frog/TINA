"""Separate local VieGem + KenLM endpoint; production preferences stay with the owner."""
import logging
import os
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from engine import VieGemEngine, MODEL
from http_worker import create_app

DEVICE = os.getenv('TINA_VIEGEM_DEVICE', 'mps')
PORT = int(os.getenv('TINA_VIEGEM_PORT', '18005'))
HOST = os.getenv('TINA_VIEGEM_HOST', '127.0.0.1')
DEFAULT_SILENCE_MS = max(100, min(2000, int(os.getenv('TINA_VIEGEM_SILENCE_MS', '500'))))
app = create_app(model_id=MODEL, name='VieGem + KenLM', prefix='TINA_VIEGEM',
                 default_directory=Path(__file__).resolve().parent.parent / 'models/viegem-fsmn',
                 load_engine=VieGemEngine.load, device=DEVICE, decoder='pytorch-ctc-kenlm', languages=('vi', 'en'),
                 default_silence_ms=DEFAULT_SILENCE_MS)

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=HOST, port=PORT, access_log=False)

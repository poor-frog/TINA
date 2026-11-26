#!/usr/bin/env python3
"""Install hash-verified ONNX/FSMN assets outside Git; never execute downloaded code."""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from asr_assets import fsmn_assets, install

MANIFEST = json.loads((HERE / 'model-assets.json').read_text())
DEFAULT = HERE.parent / 'models' / 'gipformer-fsmn'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=DEFAULT)
    parser.add_argument('--vad-source', type=Path, default=Path.home() / '.cache/modelscope/models/iic--speech_fsmn_vad_zh-cn-16k-common-pytorch/snapshots/master')
    args = parser.parse_args()
    for name, digest in MANIFEST['files'].items():
        install(args.directory / name, digest, f"https://huggingface.co/{MANIFEST['repo']}/resolve/{MANIFEST['revision']}/{name}")
        print(f'Verified Gipformer {name}', flush=True)
    vad = fsmn_assets()
    for name, digest in vad['files'].items():
        install(args.directory / 'fsmn-vad' / name, digest, f"https://modelscope.cn/models/{vad['repo']}/resolve/master/{name}", args.vad_source / name)
        print(f'Verified FSMN {name}', flush=True)
    print(f'Assets ready: {args.directory}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Download pinned VieGem code/weights and base assets; never import downloaded code."""
import argparse
import sys
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from asr_assets import fsmn_assets, install


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=HERE.parent / 'models/viegem-fsmn')
    args = parser.parse_args()
    manifest = json.loads((HERE / 'model-assets.json').read_text())
    for group, data in manifest.items():
        for name, digest in data['files'].items():
            install(args.directory / group / name, digest,
                              f"https://huggingface.co/{data['repo']}/resolve/{data['revision']}/{name}")
            print(f'Verified {group}/{name}', flush=True)
    vad = fsmn_assets()
    vad_source = Path.home() / '.cache/modelscope/models/iic--speech_fsmn_vad_zh-cn-16k-common-pytorch/snapshots/master'
    for name, digest in vad['files'].items():
        install(args.directory / 'fsmn-vad' / name, digest,
                          f"https://modelscope.cn/models/{vad['repo']}/resolve/master/{name}",
                          vad_source / name)
    print(f'Assets ready: {args.directory}', flush=True)


if __name__ == '__main__':
    main()

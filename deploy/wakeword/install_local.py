"""Install the retained local models into an operator-owned cache, never download."""
import argparse
import json
from pathlib import Path
import shutil
import tempfile

from tina_meeting_voice import kws_shadow


def install(source, cache):
    target = cache / 'livekit-tina-v1'
    if target.exists():
        kws_shadow.verify(target)
        # These two detectors were explicitly removed by the operator, including cached copies.
        for name in ('tina', 'e_tina'):
            (target / (name + '.onnx')).unlink(missing_ok=True)
        temporary = target / 'manifest.json.tmp'
        shutil.copyfile(Path(kws_shadow.__file__).with_name('livekit-models.json'), temporary)
        temporary.replace(target / 'manifest.json')
        return target
    kws_shadow.verify(source)
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.livekit-', dir=cache) as temporary:
        staged = Path(temporary)
        for name in kws_shadow.manifest()['models']:
            shutil.copyfile(source / (name + '.onnx'), staged / (name + '.onnx'))
        for name in ['LICENSE', 'NOTICE']:
            shutil.copyfile(Path(kws_shadow.__file__).with_name('livekit.' + name), staged / name)
        shutil.copyfile(Path(kws_shadow.__file__).with_name('livekit-models.json'), staged / 'manifest.json')
        kws_shadow.verify(staged)
        staged.rename(target)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path); parser.add_argument('cache', type=Path)
    args = parser.parse_args()
    print(json.dumps({'installed': str(install(args.source, args.cache)), 'mode': 'activation'}))

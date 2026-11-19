"""Small format/voice-isolation check; never trains or writes a production model."""
import hashlib
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from livekit.wakeword_train.data import load_clipsets
from train_local import build_dataset
import supervise_local


def main():
    with tempfile.TemporaryDirectory(prefix='tina-kws-format-') as tmp:
        root=Path(tmp);splits={'train':['a'],'validation':['b'],'test':['c']}
        (root/'voice_splits.json').write_text(json.dumps(splits))
        counts={s:{'positive':1,'adversarial':1,'speech':1} for s in splits}
        recipe={'counts':counts};phrase={'name':'tina','wakeword':'TINA'}
        rows=[]
        for split,voices in splits.items():
            for category in counts[split]:
                path=root/f'{split}-{category}.wav';sf.write(path,np.zeros(1600),16000,subtype='PCM_16')
                rows.append({'path':path.name,'split':split,'category':category,'voice':voices[0],
                    'text':'ti na' if category=='positive' else 'tin nhắn','onset_s':.01,'offset_s':.08,
                    'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        (root/'tina.manifest.json').write_text(json.dumps(rows))
        directory=build_dataset(root,phrase,recipe)
        clips=load_clipsets(str(directory))
        assert {k:len(v) for k,v in clips.items()}==counts['train']
        # The upstream Parquet schema stores seconds as float32: allow one sample of rounding.
        assert abs(int(clips['positive'].ends[0])-1280)<=1 and clips['positive'].clip(0).shape==(1600,)
        print(json.dumps({'upstream_parquet_format':True,'voice_splits_disjoint':True,'source_hashes_checked':True,'no_model_trained':True}))
    assert supervise_local.alive(os.getpid()) and not supervise_local.alive(0)
    with tempfile.TemporaryDirectory(prefix='tina-kws-supervisor-') as tmp:
        root=Path(tmp);recipe=root/'deploy/wakeword/training/phrases.json'
        recipe.parent.mkdir(parents=True);recipe.write_text(json.dumps({'phrases':[{'name':'tina'}]}))
        output=root/'output/wakeword-training/tina-v1';output.mkdir(parents=True)
        (output/'provenance.json').write_text('{}');(output/'STOP').touch()
        with patch('sys.argv',['supervise_local.py','--root',str(root)]), patch.object(supervise_local.subprocess,'run') as command:
            supervise_local.main()
            command.assert_called_once()
            assert command.call_args.args[0][-1]=='tina-kws-local-data'
        assert json.loads((output/'job-status.json').read_text())['phase']=='stopped_by_operator'
        print(json.dumps({'supervisor_stop_marker':True,'no_real_worker_stopped':True}))


if __name__=='__main__':main()

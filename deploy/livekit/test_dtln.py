import hashlib
import io
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from dtln import Dtln,HOP,DELAY
from dtln_assets import install,verify,ASSETS


class Model:
    def __init__(self,stage):self.stage=stage
    def get_inputs(self):return [SimpleNamespace(name='audio'),SimpleNamespace(name='state',shape=[1,2,128,2])]
    def run(self,_,inputs):
        # Identity overlap-add needs one quarter of each 75%-overlapped synthesis window.
        output=np.ones((1,1,257),dtype=np.float32) if self.stage==1 else inputs['audio']*.25
        return output,inputs['state']+1


def ns_stream(monkeypatch):
    directory=Path(__file__).resolve().parents[2]/'core/meetings/modules/voice-engine'
    monkeypatch.syspath_prepend(str(directory))
    from tina_meeting_voice.denoise import NsStream
    monkeypatch.setitem(sys.modules,'tina_ns',SimpleNamespace(NsStream=NsStream))
    return NsStream


def test_dtln_overlap_delay_blend_and_partial_tail_preserve_every_source_sample(monkeypatch):
    stream_class=ns_stream(monkeypatch)
    for sizes in ([1024]*5+[777],[1,127,129,17]):
        core=Dtln((Model(1),Model(2)));got=[]
        stream=stream_class(lambda seq,pcm:got.append((seq,pcm)),lambda:core,delay=DELAY,frame_size=HOP)
        source=np.random.default_rng(19).uniform(-.2,.2,sum(sizes)).astype(np.float32)
        at=0
        for i,size in enumerate(sizes):stream.feed(i,source[at:at+size]);at+=size
        stream.close()
        assert [len(pcm) for _,pcm in got]==list(sizes)
        np.testing.assert_allclose(np.concatenate([pcm for _,pcm in got]),source,atol=1e-7)
        assert core.closed


def test_shared_model_weights_never_share_channel_hidden_state():
    models=(Model(1),Model(2));first=Dtln(models);second=Dtln(models)
    first.process(np.ones(HOP,dtype=np.float32)*.1)
    assert np.any(first.states[0]) and not np.any(second.states[0])
    assert not np.shares_memory(first.input,second.input)
    first.close();second.process(np.zeros(HOP,dtype=np.float32));second.close()


def test_asset_preparation_checks_size_hash_and_world_readability(tmp_path,monkeypatch):
    import dtln_assets
    payload=b'synthetic-dtln';digest=hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(dtln_assets,'ASSETS',{'model.onnx':('pinned',len(payload),digest)})
    monkeypatch.setattr(dtln_assets.urllib.request,'urlopen',lambda *args,**kw:io.BytesIO(payload))
    install(tmp_path);verify(tmp_path)
    assert (tmp_path/'model.onnx').stat().st_mode&0o444==0o444
    (tmp_path/'model.onnx').write_bytes(b'modified')
    with pytest.raises(ValueError):verify(tmp_path)


def test_selected_dtln_reuses_stream_boundary_without_starting_webrtc(monkeypatch):
    from audio import NoiseStreams,noise_ready
    ns_stream(monkeypatch);monkeypatch.setenv('TINA_AUDIO_DENOISER','dtln')
    monkeypatch.setattr('dtln.sessions',lambda:(Model(1),Model(2)))
    assert noise_ready()['id']=='dtln' and noise_ready()['delay_samples']==384
    import base64
    states=NoiseStreams();raw=np.ones(1024,dtype='<f4')*.1
    outputs=[]
    for i in range(3):outputs.extend(states.feed({'seq':i,'channel':1,'stamp':1000+i*64,'startSample':i*1024,'audio':base64.b64encode(raw.tobytes()).decode()}))
    outputs.extend(states.flush())
    assert [item['seq'] for item in outputs]==[0,1,2]
    assert all(len(base64.b64decode(item['audio']))==raw.nbytes for item in outputs)

import base64
import hashlib
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest

from tina_meeting_voice import turn_assets
from tina_meeting_voice.turn_worker import TurnModels, evaluate


def test_shadow_request_validation_never_dispatches_invalid_audio():
    class Models:
        def predict(self,audio,text):
            assert text=='Xin chào' and len(audio)==1024
            return {'smart_probability':.8,'namo_probability':.6}
    body={'id':str(uuid4()),'text':'Xin chào','audio':base64.b64encode(np.zeros(1024,dtype='<f4')).decode()}
    assert evaluate(Models(),body)['id']==body['id']
    for update in ({'id':'bad'},{'text':''},{'audio':'bad!'},{'audio':base64.b64encode(b'x').decode()},
                   {'audio':base64.b64encode(np.array([np.nan],dtype='<f4')).decode()}):
        with pytest.raises((ValueError,TypeError)):evaluate(Models(),body|update)


def test_predict_uses_audio_front_padding_and_class_one_probability():
    models=object.__new__(TurnModels)
    def features(audio,**kwargs):
        assert len(audio)==128000 and np.all(audio[:-1600]==0) and np.all(audio[-1600:]==.2)
        assert kwargs['do_normalize'] and kwargs['sampling_rate']==16000
        return SimpleNamespace(input_features=np.zeros((1,80,800),dtype=np.float32))
    class Session:
        def __init__(self,output):self.output=output
        def run(self,_,inputs):return [self.output]
    models.extractor=features
    models.smart=Session(np.array([[.8]],dtype=np.float32))
    models.namo=Session(np.array([[0,2]],dtype=np.float32))
    models.tokenizer=SimpleNamespace(encode=lambda text:SimpleNamespace(ids=[1,2],attention_mask=[1,1]))
    result=models.predict(np.full(1600,.2,dtype=np.float32),'Xin chào')
    assert result['smart_probability']==pytest.approx(.8) and result['namo_probability']>.88


def test_atomic_hash_pinned_install_and_cache_reuse(monkeypatch,tmp_path):
    data=b'pinned-model'; expected={'url':'fixture','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    monkeypatch.setattr(turn_assets,'manifest',lambda:{'files':{'model.onnx':expected}})
    class Response:
        def __init__(self):self.parts=iter([data,b''])
        def read(self,_):return next(self.parts)
        def __enter__(self):return self
        def __exit__(self,*args):pass
    monkeypatch.setattr(turn_assets.urllib.request,'urlopen',lambda *a,**kw:Response())
    turn_assets.install(tmp_path); assert (tmp_path/'model.onnx').read_bytes()==data
    monkeypatch.setattr(turn_assets.urllib.request,'urlopen',lambda *a,**kw:pytest.fail('cache must not download'))
    turn_assets.install(tmp_path)
    (tmp_path/'model.onnx').write_bytes(b'modified')
    with pytest.raises(ValueError):turn_assets.verify(tmp_path)


def test_bad_download_does_not_replace_existing_asset(monkeypatch,tmp_path):
    original=tmp_path/'model.onnx'; original.write_bytes(b'original')
    monkeypatch.setattr(turn_assets,'manifest',lambda:{'files':{'model.onnx':{'url':'fixture','bytes':3,'sha256':'0'*64}}})
    import io
    monkeypatch.setattr(turn_assets.urllib.request,'urlopen',lambda *a,**kw:io.BytesIO(b'bad'))
    with pytest.raises(ValueError):turn_assets.install(tmp_path)
    assert original.read_bytes()==b'original'

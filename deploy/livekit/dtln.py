"""DTLN ONNX core, adapted from breizhn/DTLN real_time_processing_onnx.py (MIT).

Copyright (c) 2020 Nils L. Westhausen. Upstream MIT notice is pinned beside the weights.
"""
from functools import lru_cache
import numpy as np
from dtln_assets import DIRECTORY,verify

HOP=128
WINDOW=512
DELAY=WINDOW-HOP


@lru_cache(maxsize=1)
def sessions():
    import onnxruntime as ort
    verify()
    options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
    models=tuple(ort.InferenceSession(str(DIRECTORY/name),sess_options=options,providers=['CPUExecutionProvider'])
                 for name in ('model_1.onnx','model_2.onnx'))
    for model,length in zip(models,(257,WINDOW)):
        inputs=model.get_inputs()
        model.run(None,{inputs[0].name:np.zeros((1,1,length),dtype=np.float32),
                        inputs[1].name:np.zeros(inputs[1].shape,dtype=np.float32)})
    return models


class Dtln:
    def __init__(self,models=None):
        self.models=models if models is not None else sessions()
        self.inputs=[model.get_inputs() for model in self.models]
        self.states=[np.zeros(inputs[1].shape,dtype=np.float32) for inputs in self.inputs]
        self.input=np.zeros(WINDOW,dtype=np.float32);self.output=np.zeros(WINDOW,dtype=np.float32)
        self.dry=np.zeros(DELAY,dtype=np.float32);self.closed=False

    def process(self,pcm):
        if self.closed or len(pcm)!=HOP or not np.isfinite(pcm).all():raise ValueError('Invalid DTLN hop')
        self.input[:-HOP]=self.input[HOP:];self.input[-HOP:]=pcm
        spec=np.fft.rfft(self.input)
        mask,self.states[0]=self.models[0].run(None,{
            self.inputs[0][0].name:np.abs(spec).reshape(1,1,257).astype(np.float32),self.inputs[0][1].name:self.states[0]})
        filtered=np.fft.irfft(mask.reshape(257)*spec,n=WINDOW).astype(np.float32)
        block,self.states[1]=self.models[1].run(None,{
            self.inputs[1][0].name:filtered.reshape(1,1,WINDOW),self.inputs[1][1].name:self.states[1]})
        self.output[:-HOP]=self.output[HOP:];self.output[-HOP:]=0
        self.output+=block.reshape(WINDOW)
        dry=np.concatenate((self.dry,pcm));self.dry=dry[HOP:]
        # Keep half the aligned original speech to limit over-suppression of names/consonants.
        result=.5*self.output[:HOP]+.5*dry[:HOP]
        if not np.isfinite(result).all():raise RuntimeError('Invalid DTLN output')
        return np.clip(result,-1,1).astype(np.float32)

    def close(self):self.closed=True;self.states=[];self.models=();self.input=self.output=self.dry=np.array([],dtype=np.float32)


def stream(emit):
    from tina_ns import NsStream
    return NsStream(emit,Dtln,delay=DELAY,frame_size=HOP)

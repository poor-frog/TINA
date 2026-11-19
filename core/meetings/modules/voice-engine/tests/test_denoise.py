import numpy as np
from tina_meeting_voice.denoise import NsStream, DELAY, FRAME


class Delay:
    def __init__(self): self.buffer=np.zeros(DELAY,dtype=np.float32);self.closed=False
    def process(self,pcm):
        joined=np.concatenate([self.buffer,pcm]);self.buffer=joined[FRAME:];return joined[:FRAME]
    def close(self):self.closed=True


def test_fractional_10ms_frames_and_flush_preserve_every_sample_after_delay_compensation():
    for sizes in [[1024]*5,[1,159,161,63],[4096,17,16000]]:
        outputs=[];native=Delay();stream=NsStream(lambda seq,pcm:outputs.append((seq,pcm)),lambda:native)
        source=np.arange(sum(sizes),dtype=np.float32)/sum(sizes)
        offset=0
        for seq,size in enumerate(sizes):stream.feed(seq,source[offset:offset+size]);offset+=size
        stream.close()
        assert [seq for seq,_ in outputs]==list(range(len(sizes)))
        assert [len(pcm) for _,pcm in outputs]==sizes
        assert np.array_equal(np.concatenate([pcm for _,pcm in outputs]),source)
        assert native.closed


def test_channel_instances_do_not_share_noise_or_audio_state():
    a=[];b=[]
    first=NsStream(lambda _,pcm:a.append(pcm),Delay);second=NsStream(lambda _,pcm:b.append(pcm),Delay)
    first.feed(1,np.ones(1024,dtype=np.float32));second.feed(2,np.zeros(1024,dtype=np.float32))
    first.close();second.close()
    assert np.array_equal(a[0],np.ones(1024)) and not np.any(b[0])


def test_128_sample_model_hops_compensate_384_samples_without_losing_short_or_final_frames():
    class Delayed:
        def __init__(self):self.buffer=np.zeros(384,dtype=np.float32)
        def process(self,pcm):
            joined=np.concatenate([self.buffer,pcm]);self.buffer=joined[128:];return joined[:128]
        def close(self):pass
    for sizes in ([1024]*4+[777],[1,127,129,17]):
        got=[];stream=NsStream(lambda seq,pcm:got.append((seq,pcm)),Delayed,delay=384,frame_size=128)
        source=np.arange(sum(sizes),dtype=np.float32)/sum(sizes);offset=0
        for i,size in enumerate(sizes):stream.feed(i,source[offset:offset+size]);offset+=size
        stream.close()
        assert [len(pcm) for _,pcm in got]==list(sizes)
        np.testing.assert_array_equal(np.concatenate([pcm for _,pcm in got]),source)

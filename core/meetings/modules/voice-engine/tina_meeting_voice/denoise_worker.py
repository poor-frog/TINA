"""Bounded line IPC worker. Node retains source metadata/raw frames until processed acknowledgment."""
import base64
import json
import math
import sys
from .denoise import NativeNs, NsStream
import numpy as np


def main():
    states = {}
    def emit(seq, pcm):
        print(json.dumps({'seq':seq,'audio':base64.b64encode(pcm.astype('<f4').tobytes()).decode()},separators=(',',':')),flush=True)
    probe = NativeNs(); probe.close()
    print('{"ready":true}',flush=True)
    try:
        for line in sys.stdin.buffer:
            if len(line) > 100000: raise ValueError('NS frame exceeds bound')
            value = json.loads(line)
            if value.get('type') == 'flush': break
            channel, seq, stamp = value['channel'], value['seq'], value['stamp']
            if type(channel) is not int or not 0 <= channel < 65536 or type(seq) is not int or seq < 0 or not math.isfinite(stamp): raise ValueError('Invalid NS frame')
            pcm = np.frombuffer(base64.b64decode(value['audio'],validate=True),dtype='<f4')
            sample = value.get('startSample'); participant = value.get('participant')
            row = states.get(channel)
            discontinuous = row and (abs(stamp-row['end']) > 2 or (sample is not None and row['sample'] is not None and sample != row['sample'])
                                    or (participant and row['participant'] and participant != row['participant']))
            if discontinuous: row['stream'].close(); del states[channel]; row = None
            if row is None:
                if len(states) >= 16:
                    oldest = min(states,key=lambda key:states[key]['end']); states.pop(oldest)['stream'].close()
                row = {'stream':NsStream(emit)}; states[channel] = row
            row.update(end=stamp+len(pcm)/16,sample=sample+len(pcm) if sample is not None else None,participant=participant)
            row['stream'].feed(seq,pcm)
    finally:
        for row in states.values(): row['stream'].close()


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Noise suppression worker failed',file=sys.stderr);sys.exit(1)

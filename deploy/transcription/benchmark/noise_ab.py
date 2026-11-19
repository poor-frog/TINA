"""Matched NS off/Low experiment. Audio, references and hypotheses stay in a private external directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time

import numpy as np

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'core/meetings/modules/voice-engine'))


def prepare(directory, fleurs, meeting):
    import soundfile as sf
    if directory.resolve()==ROOT or ROOT in directory.resolve().parents: raise ValueError('Use an external private directory')
    directory.mkdir(parents=True,exist_ok=True);directory.chmod(0o700)
    rows=[];rng=np.random.default_rng(20261107)
    def save(pcm,group,reference):
        index=len(rows);path=directory/f'{index:03}.npy';np.save(path,pcm.astype(np.float32));path.chmod(0o600)
        rows.append({'id':index,'path':path.name,'group':group,'reference':reference,'sha256':hashlib.sha256(pcm.astype(np.float32).tobytes()).hexdigest()})
    source=json.loads(fleurs.read_text())
    for language,count in [('vi_vn',10),('en_us',5)]:
        selected=sorted([r for r in source['samples'] if r['config']==language and r['role']=='test'],key=lambda r:r['selection_index'])[:count]
        for row in selected:
            path=Path(row['path']);path=path if path.is_absolute() else fleurs.parent/path
            pcm,rate=sf.read(path,dtype='float32');assert rate==16000 and pcm.ndim==1
            save(pcm,language+'_clean',row['reference'])
            noise=np.convolve(rng.standard_normal(len(pcm)),np.ones(5)/5,'same')
            noise*=np.sqrt(np.mean(pcm**2)/10)/max(1e-12,np.sqrt(np.mean(noise**2)))
            noisy=pcm+noise;noisy*=min(1,.95/max(1e-12,np.max(np.abs(noisy))))
            save(noisy,language+'_synthetic_noise_10db',row['reference'])
    for row in json.loads(meeting.read_text()):
        pcm,rate=sf.read(row['path'],dtype='float32');assert rate==16000 and pcm.ndim==1
        save(pcm,row['kind'],row.get('reference'))
    save(np.zeros(32000,dtype=np.float32),'silence','')
    save(rng.standard_normal(32000).astype(np.float32)*.02,'noise_only','')
    (directory/'manifest.json').write_text(json.dumps({'seed':20261107,'fleurs_revision':source['parquet_revision'],'rows':rows},ensure_ascii=False,indent=2));(directory/'manifest.json').chmod(0o600)
    print(json.dumps({'prepared':len(rows)}),flush=True)


def filter_audio(directory):
    from tina_meeting_voice.denoise import NsStream,NativeNs,DELAY
    rows=json.loads((directory/'manifest.json').read_text())['rows'];measurements=[]
    # Calibrate the pinned library independently of speech/noise quality.
    impulse=np.zeros(16000,dtype=np.float32);impulse[8000]=.8;outputs=[]
    native=NativeNs()
    try:
        for i in range(0,len(impulse),160): outputs.append(native.process(impulse[i:i+160]))
    finally:native.close()
    assert int(np.argmax(np.abs(np.concatenate(outputs))))-8000==DELAY
    for row in rows:
        pcm=np.load(directory/row['path']);out=[];started=time.process_time()
        stream=NsStream(lambda seq,data:out.append(data))
        for i in range(0,len(pcm),1024):stream.feed(i,pcm[i:i+1024])
        stream.close();cpu=time.process_time()-started
        cleaned=np.concatenate(out);assert len(cleaned)==len(pcm) and np.isfinite(cleaned).all()
        target=directory/f'{row["id"]:03}.low.npy';np.save(target,cleaned);target.chmod(0o600)
        measurements.append({'id':row['id'],'input_samples':len(pcm),'output_samples':len(cleaned),'cpu_ms':cpu*1000,'cpu_realtime_percent':cpu/(len(pcm)/16000)*100,
            'output_sha256':hashlib.sha256(cleaned.tobytes()).hexdigest()})
    (directory/'filter.json').write_text(json.dumps({'library':'webrtc-audio-processing 0.3.1-0ubuntu6','level':'Low','algorithm_delay_samples':DELAY,
      'delay_compensated':True,'missing_or_added_samples':0,'clips':measurements},indent=2))
    print(json.dumps({'filtered':len(rows),'cpu_realtime_percent_median':statistics.median(r['cpu_realtime_percent'] for r in measurements),'algorithm_delay_samples':DELAY}),flush=True)


def evaluate(directory,model,output):
    from capture_frames import wav_bytes
    sys.path.insert(0,str(ROOT/'deploy/transcription'))
    if model=='viegem':
        from viegem.engine import VieGemEngine
        engine=VieGemEngine.load(ROOT/'deploy/transcription/models/viegem-fsmn')
    else:
        from gipformer.engine import GipformerEngine
        engine=GipformerEngine.load(ROOT/'deploy/transcription/models/gipformer-fsmn')
    rows=json.loads((directory/'manifest.json').read_text())['rows'];results=[]
    for row in rows:
        variants={}
        for mode in (['off','low'] if row['id']%2==0 else ['low','off']):
            path=directory/(row['path'] if mode=='off' else f'{row["id"]:03}.low.npy')
            pcm=np.load(path);start=time.perf_counter();answer=engine.transcribe(wav_bytes(pcm));text=answer['text']
            variants[mode]={'text':text,'seconds':time.perf_counter()-start,'text_sha256':hashlib.sha256(text.encode()).hexdigest(),
              'name_prefix':bool(re.match(r'^(?:tina(?:\s+ơi)?|ti na ơi|tiên na ơi|tinh anh ơi)(?=$|[^\w])',text.strip().casefold()))}
        results.append(row|{'variants':variants})
        print(json.dumps({'model':model,'completed':len(results),'total':len(rows)}),flush=True)
    private=directory/(model+'.private.json');private.write_text(json.dumps({'model':model,'rows':results},ensure_ascii=False));private.chmod(0o600)
    subprocess.run([str(ROOT/'.venv/asr-benchmark/bin/python'),__file__,'score',str(directory),'--model',model,'--output',str(output)],check=True)


def report(directory,model,output):
    from metrics import score
    data=json.loads((directory/(model+'.private.json')).read_text());groups={};public=[]
    for row in data['rows']:
        variants={}
        for mode,value in row['variants'].items():
            item={k:v for k,v in value.items() if k!='text'}
            if row['reference'] is not None:
                counts=score(row['reference'],value['text']);item['score']={k:v for k,v in counts.items() if not k.startswith('normalized_')}
            variants[mode]=item
            group=groups.setdefault(row['group'],{}).setdefault(mode,{'clips':0,'ref_words':0,'word_errors':0,'ref_chars':0,'char_errors':0,'name_prefixes':0,'nonempty':0})
            group['clips']+=1;group['name_prefixes']+=int(value['name_prefix']);group['nonempty']+=int(bool(value['text'].strip()))
            for key in ['ref_words','word_errors','ref_chars','char_errors']:group[key]+=item.get('score',{}).get(key,0)
        public.append({'id':row['id'],'group':row['group'],'input_sha256':row['sha256'],'text_changed':variants['off']['text_sha256']!=variants['low']['text_sha256'],'variants':variants})
    for modes in groups.values():
        for group in modes.values():
            group['wer']=group['word_errors']/group['ref_words'] if group['ref_words'] else None
            group['cer']=group['char_errors']/group['ref_chars'] if group['ref_chars'] else None
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps({'model':model,'default_enabled':False,'groups':groups,'filter':json.loads((directory/'filter.json').read_text()),'clips':public},indent=2)+'\n')
    print(json.dumps({'model':model,'groups':groups}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['prepare','filter','evaluate','score']);parser.add_argument('directory',type=Path)
    parser.add_argument('--fleurs',type=Path);parser.add_argument('--meeting',type=Path);parser.add_argument('--model',choices=['viegem','gipformer']);parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.mode=='prepare':prepare(args.directory,args.fleurs,args.meeting)
    elif args.mode=='filter':filter_audio(args.directory)
    elif args.mode=='evaluate':evaluate(args.directory,args.model,args.output)
    else:report(args.directory,args.model,args.output)


if __name__=='__main__':main()

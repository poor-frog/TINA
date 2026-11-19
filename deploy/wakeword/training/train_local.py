"""Build upstream-format datasets and sequentially fine-tune/export local TINA ONNX models."""
import argparse
from dataclasses import replace
import hashlib
import importlib.metadata
import json
import logging
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import yaml

from livekit.wakeword import WakeWordModel
from livekit.wakeword_train import WakeWordConfig
from livekit.wakeword_train.encoders import load_pretrained
from livekit.wakeword_train.loop import TrainConfig, default_aug, train, calibration_logit
from livekit.wakeword_train.export import calibrate, export_streaming
from livekit_wakeword_bench.dataset import ShardWriter


def emit(**value): print(json.dumps(value, ensure_ascii=False), flush=True)


def build_dataset(root, phrase, recipe):
    manifest = root / (phrase['name']+'.manifest.json')
    if not manifest.exists(): return None
    rows = json.loads(manifest.read_text())
    directory = root / 'datasets' / phrase['name'] / 'natural'
    if (directory/'complete.json').exists():return directory
    voice_splits=json.loads((root/'voice_splits.json').read_text())
    assert not set(voice_splits['train']) & set(voice_splits['test'])
    assert not set(voice_splits['train']) & set(voice_splits['validation'])
    assert not set(voice_splits['validation']) & set(voice_splits['test'])
    for split in recipe['counts']:
        writer=ShardWriter(directory, split,16000)
        counts={key:0 for key in recipe['counts'][split]}
        for index,row in enumerate(x for x in rows if x['split']==split):
            path=root/row['path']
            assert hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256']
            audio,sr=sf.read(path,dtype='float32');assert sr==16000 and audio.ndim==1
            assert row['voice'] in voice_splits[split]
            category=row['category'];counts[category]+=1
            writer.add(audio,{'id':f"{phrase['name']}-{split}-{index:05d}",'label':int(category=='positive'),
                'category':category,'wake_word':phrase['wakeword'],'text':row['text'],'phrase':row['text'],
                'provider':'vieneu-local','model':'vieneu-v3-turbo-3.8.3','voice_id':row['voice'],
                'voice_name':row['voice'],'held_out_voice':split=='test','text_form':'isolated',
                'onset_s':row['onset_s'],'offset_s':row['offset_s'],
                'phrase_onset_s':row['onset_s'],'phrase_offset_s':row['offset_s']})
        writer.flush();assert counts==recipe['counts'][split],(split,counts)
    cfg={'name':phrase['name'],'wake_word':phrase['wakeword'],'language':'vi','generator':'tina-local-vieneu',
         'splits':{s:{'n_positive':c['positive'],'n_adversarial':c['adversarial'],'n_speech':c['speech']} for s,c in recipe['counts'].items()}}
    (directory/'bench_config.yaml').write_text(yaml.safe_dump(cfg,allow_unicode=True))
    (directory/'complete.json').write_text(json.dumps({'counts':recipe['counts'],'generator':'local-vieneu','human_alignment':False})+'\n')
    return directory


def score_set(root, phrase, model_path, split):
    rows=json.loads((root/(phrase['name']+'.manifest.json')).read_text())
    model=WakeWordModel(models=[str(model_path)])
    results=[]
    for row in (r for r in rows if r['split']==split):
        audio,sr=sf.read(root/row['path'],dtype='float32');assert sr==16000
        scores=model.predict_clip(audio)
        score=float(max(scores.values()))
        results.append({'category':row['category'],'score':score,'duration_s':len(audio)/16000,
                        'voice':row['voice'],'audio_sha256':row['sha256']})
    positives=[r for r in results if r['category']=='positive'];neg=[r for r in results if r['category']!='positive']
    return {'split':split,'positive_clips':len(positives),'negative_clips':len(neg),
            'recall_at_0_5':sum(r['score']>=.5 for r in positives)/max(1,len(positives)),
            'negative_clip_activation_fraction_at_0_5':sum(r['score']>=.5 for r in neg)/max(1,len(neg)),
            'negative_audio_seconds':sum(r['duration_s'] for r in neg),
            'synthetic_heldout_voices_only':True,'real_meeting_evaluated':False,'scores':results}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--recipe',required=True)
    args=parser.parse_args();root=Path(args.output).resolve();recipe=json.loads(Path(args.recipe).read_text())
    assert importlib.metadata.version('livekit-wakeword')==recipe['upstream_version']
    assert torch.backends.mps.is_available(),'MPS is required for this local training run'
    torch.set_num_threads(4)
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(name)s %(levelname)s %(message)s')
    emit(event='training_environment',device='mps',torch=torch.__version__,trainer=recipe['upstream_version'])
    models=root/'models';models.mkdir(parents=True,exist_ok=True)
    # Upstream defaults keep full 5000-step recipe; train one phrase at a time, no synthetic shortcut exports.
    for phrase in recipe['phrases']:
        final=models/(phrase['name']+'.onnx')
        report=root/(phrase['name']+'.evaluation.json')
        if final.exists() and report.exists():continue
        if not final.exists():
            deadline=time.monotonic()+3600
            while build_dataset(root,phrase,recipe) is None:
                if time.monotonic()>deadline: raise RuntimeError('Local data generation did not finish within one hour')
                emit(event='waiting_for_local_data',name=phrase['name']);time.sleep(30)
            cfg=WakeWordConfig(wakeword=phrase['wakeword'],model_name=phrase['name'],language='vi',
                data_dir=root/'datasets'/phrase['name'],output_dir=models,steps=recipe['steps'],target_fpph=recipe['target_fpph'])
            cfg.save(root/(phrase['name']+'.yaml'))
            emit(event='training_started',name=phrase['name'],steps=cfg.steps,device='mps')
            started=time.monotonic()
            checkpoints=root/'checkpoints';checkpoints.mkdir(exist_ok=True)
            checkpoint=checkpoints/(phrase['name']+'-standard.pt')
            det=load_pretrained('standard').bake(cfg.wakeword)
            if checkpoint.exists():
                det.load_state_dict(torch.load(checkpoint,map_location='cpu',weights_only=True))
                emit(event='trained_checkpoint_resumed',name=phrase['name'])
            else:
                aug=default_aug(det)
                train_cfg=TrainConfig(steps=cfg.steps,workers=2,aug=replace(aug,p_party=.3))
                det=train(det,[str(root/'datasets'/phrase['name']/'natural')],train_cfg,device='mps',log_every=100)
                temporary=checkpoint.with_suffix('.tmp');torch.save(det.state_dict(),temporary);temporary.replace(checkpoint)
            emit(event='calibration_started',name=phrase['name'],target_fpph=cfg.target_fpph)
            threshold=calibration_logit(det,target_fpph=cfg.target_fpph,device='mps',aug=default_aug(det))
            export_streaming(calibrate(det.cpu(),threshold),final,metadata={
                'wake_word':cfg.wakeword,'language':'vi','threshold':'0.5','format':'livekit-wakeword-v2',
                'training_data':'local-vieneu-3.8.3','steps':str(cfg.steps)})
            emit(event='onnx_exported',name=phrase['name'],seconds=round(time.monotonic()-started,1),bytes=final.stat().st_size)
            torch.mps.empty_cache()
        validation=score_set(root,phrase,final,'validation');test=score_set(root,phrase,final,'test')
        report.write_text(json.dumps({'phrase':phrase['wakeword'],'model_name':phrase['name'],
            'sha256':hashlib.sha256(final.read_bytes()).hexdigest(),'steps':recipe['steps'],
            'local_tts':True,'livekit_cloud_used':False,'validation':validation,'test':test},ensure_ascii=False,indent=2)+'\n')
        emit(event='model_evaluated',name=phrase['name'],synthetic_test_recall=test['recall_at_0_5'],
             synthetic_negative_activation=test['negative_clip_activation_fraction_at_0_5'])
    emit(event='all_models_complete',models=[p['name']+'.onnx' for p in recipe['phrases']])


if __name__=='__main__': main()

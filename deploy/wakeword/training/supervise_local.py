"""Keep the requested long local training run alive across chat/terminal disconnects."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def alive(pid):
    if not pid: return False
    result=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
    return result.returncode==0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--trainer-pid',type=int,default=0)
    args=parser.parse_args();repo=Path(args.root).resolve();output=repo/'output/wakeword-training/tina-v1'
    recipe=repo/'deploy/wakeword/training/phrases.json';config=json.loads(recipe.read_text())
    models=[p['name'] for p in config['phrases']];pid=args.trainer_pid;child=None;attempts=0
    provenance=json.loads((output/'provenance.json').read_text())
    def status(phase,**extras):
        value={'phase':phase,'updated_at_epoch':time.time(),'trainer_pid':pid,'supervisor_pid':os.getpid(),
               'onnx_files':[name+'.onnx' for name in models if (output/'models'/f'{name}.onnx').exists()],**extras}
        temp=output/'job-status.tmp';temp.write_text(json.dumps(value,indent=2)+'\n');temp.replace(output/'job-status.json')
    while True:
        if (output/'STOP').exists():
            if alive(pid):os.kill(pid,signal.SIGINT)
            subprocess.run(['docker','--context','orbstack','stop','--timeout','10','tina-kws-local-data'],capture_output=True)
            status('stopped_by_operator');return
        if all((output/'models'/f'{name}.onnx').exists() and (output/f'{name}.evaluation.json').exists() for name in models):
            status('complete');return
        if not all((output/f'{name}.manifest.json').exists() for name in models):
            probe=subprocess.run(['docker','--context','orbstack','inspect','tina-kws-local-data','--format','{{.State.Running}}'],capture_output=True,text=True)
            if probe.returncode or probe.stdout.strip()!='true':
                command=['docker','--context','orbstack','run','-d','--rm','--init','--name','tina-kws-local-data',
                    '--cpus','3','--memory','4g','--network','none','--env','PYTHONPATH=/app',
                    '--mount','type=volume,source=tina-production_tts-models,target=/models,readonly',
                    '--mount',f'type=bind,source={recipe.parent},target=/recipe,readonly',
                    '--mount',f'type=bind,source={output},target=/output','--user','0:0','--entrypoint','python',
                    provenance['tts_image'],'/recipe/generate_local.py','--output','/output','--recipe','/recipe/phrases.json']
                result=subprocess.run(command,capture_output=True,text=True)
                if result.returncode:status('generation_restart_failed',exit_code=result.returncode);return
        if child and child.poll() is not None:pid=0;child=None
        if not alive(pid):
            if attempts>=2:status('training_failed_check_training_log');return
            env=dict(os.environ,PYTHONUNBUFFERED='1',OMP_NUM_THREADS='4',OPENBLAS_NUM_THREADS='1',
                     PYTORCH_MPS_HIGH_WATERMARK_RATIO='0.35',PYTORCH_MPS_LOW_WATERMARK_RATIO='0.25')
            with (output/'training.log').open('ab',buffering=0) as log:
                child=subprocess.Popen([str(repo/'.venv/wakeword-training/bin/python'),'-u',
                    str(recipe.parent/'train_local.py'),'--output',str(output),'--recipe',str(recipe)],
                    cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
            pid=child.pid;attempts+=1
        status('training',restart_attempts=attempts)
        time.sleep(15)


if __name__=='__main__':main()

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeakController } from './capture-bridge.js';
import {createTtsPlayback} from './tts-playback.js';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a stalled renderer bounds Stop and fences late unmute until mute is verified', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  let release!: (on:boolean)=>void, evaluations=0, played=0, stopped=0;
  const page={evaluate(_fn:unknown,args:{desiredOn:boolean}){
    evaluations++;
    return evaluations===1 ? new Promise<boolean>(resolve=>{release=resolve;}) : Promise.resolve(args.desiredOn);
  }};
  const controller=createSpeakController(page as never,{platform:'google_meet',voiceAgentEnabled:true} as never,
    ()=>({async speak(){played++;return 'completed';},stop(){stopped++;}}));
  const speaking=controller.speak('Synthetic probe');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(evaluations,1);
  const stop=assert.rejects(controller.stop(),/mute could not be verified/);
  await new Promise(resolve=>setImmediate(resolve));
  context.mock.timers.tick(5000);
  await stop;
  assert.equal(await speaking,'stopped');
  assert(stopped>0);assert.equal(played,0);
  assert.equal(evaluations,1,'timed-out evaluations stay serialized');
  release(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(evaluations,2,'the queued mute runs after the old evaluate resolves');
  assert.equal(played,0,'late unmute cannot start the cancelled audio');
  assert.equal(await controller.speak('Fresh request'),'completed');
  assert.equal(played,1);
});

test('stopping TTS mutes its sink but keeps the system microphone available to Meet', () => {
  const dir=mkdtempSync(join(tmpdir(),'tina-mic-gate-')),before=process.env.PATH;
  const log=join(dir,'calls');
  writeFileSync(join(dir,'pactl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TINA_TEST_PACTL_LOG"\n',{mode:0o700});
  const previousLog=process.env.TINA_TEST_PACTL_LOG;
  try {
    process.env.PATH=dir+':'+before;process.env.TINA_TEST_PACTL_LOG=log;
    createTtsPlayback().stop();
    assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['set-sink-mute tts_sink 1','set-source-mute virtual_mic 0']);
  } finally {
    process.env.PATH=before;
    if(previousLog===undefined)delete process.env.TINA_TEST_PACTL_LOG;else process.env.TINA_TEST_PACTL_LOG=previousLog;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('playback requires observed mic state, including delayed UI changes and rejected clicks', async () => {
  const previous = (globalThis as any).document;
  try {
    for (const mode of ['normal', 'delayed', 'device-recovery', 'decoy', 'disabled', 'refused', 'unknown', 'mute-refused']) {
      let on = false, calls = 0, started = 0, clicks = 0;
      let deviceReady=mode!=='device-recovery';
      if(!deviceReady)setTimeout(()=>{deviceReady=true;},70);
      const button = { disabled: mode === 'disabled',
        getAttribute(name: string) { return name === 'aria-label' ? !deviceReady ? 'Microphone problem. Show more info' : mode === 'unknown' ? 'Toggle microphone' : on ? 'Mute microphone' : 'Unmute microphone' : null; },
        click() {
          clicks++;
          if (mode === 'refused' || mode === 'disabled' || mode === 'mute-refused' && on) return;
          if (mode === 'delayed') setTimeout(() => { on = !on; }, 70);
          else on = !on;
        } };
      const decoy={getAttribute:()=> 'Microphone settings'};
      (globalThis as any).document = { querySelectorAll: () => mode==='decoy'?[decoy,button]:[button] };
      const page = { async evaluate(fn: any, arg: any) { return fn(arg); } };
      const controller = createSpeakController(page as any, {platform:'google_meet',voiceAgentEnabled:true} as any,
        () => ({ async speak(_, __, notify) { assert(on); calls++; notify?.(); return 'completed'; }, stop() {} }));
      const outcome = await controller.speak('Synthetic reply', 'auto', () => { started++; });
      const valid = ['normal', 'delayed', 'device-recovery', 'decoy'].includes(mode);
      assert.equal(outcome, valid ? 'completed' : 'failed', mode);
      assert.equal(started, valid || mode === 'mute-refused' ? 1 : 0, mode);
      assert.equal(calls, started, mode);
      if (valid) assert.equal(on, false);
      if (mode === 'disabled' || mode === 'unknown') assert.equal(clicks, 0);
      if (mode === 'mute-refused') await assert.rejects(controller.stop());
    }
  } finally { (globalThis as any).document = previous; }
});

test('Google Meet remote participant mute controls cannot establish the bot microphone state',async()=>{
  const previous=(globalThis as any).document;
  let on=false,remoteClicks=0,localClicks=0,spoken=0;
  const remote=(label:string)=>({getAttribute:(key:string)=>key==='aria-label'?label:null,click(){remoteClicks++;}});
  const local={disabled:false,getAttribute(key:string){
    if(key==='aria-label')return on?'Turn off microphone':'Turn on microphone';
    if(key==='data-is-muted')return String(!on);
    return null;
  },click(){localClicks++;on=!on;}};
  (globalThis as any).document={querySelectorAll:()=>[
    remote("You can't remotely mute a participant's microphone"),remote("Mute another participant's microphone"),local]};
  const page={async evaluate(fn:any,arg:any){return fn(arg);}};
  try{
    const controller=createSpeakController(page as any,{platform:'google_meet',voiceAgentEnabled:true} as any,
      ()=>({async speak(){assert(on);spoken++;return 'completed';},stop(){}}));
    assert.equal(await controller.speak('Synthetic reply'),'completed');
    assert.equal(spoken,1);assert.equal(remoteClicks,0);assert.equal(localClicks,2);assert.equal(on,false);
    await controller.stop();assert.equal(localClicks,2);
  }finally{(globalThis as any).document=previous;}
});

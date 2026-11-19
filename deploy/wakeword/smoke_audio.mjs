// Runs through the real bot entrypoint; no meeting or external TTS request is made.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createTtsPlayback} from '/app/core/meetings/services/bot/dist/tts-playback.js';

const pactl=(...args)=>execFileSync('pactl',args,{encoding:'utf8'}).trim();
const require=createRequire('/app/core/meetings/modules/remote-browser/package.json');
const {chromium}=require('playwright-extra');
const server=http.createServer((_,res)=>res.end('<!doctype html><title>Local audio probe</title>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context;
try {
  assert.equal(pactl('get-default-sink'),'meeting_rx');
  assert.equal(pactl('get-default-source'),'virtual_mic');
  assert.equal(pactl('get-source-mute','virtual_mic'),'Mute: no');
  context=await chromium.launchPersistentContext('/tmp/tina-audio-probe',{
    headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream']});
  const origin='http://127.0.0.1:'+server.address().port;
  await context.grantPermissions(['microphone'],{origin});
  const page=context.pages()[0];await page.goto(origin);
  await page.evaluate(async()=>{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    globalThis.probeStream=stream;
    const audio=new AudioContext(),analyser=audio.createAnalyser();audio.createMediaStreamSource(stream).connect(analyser);
    globalThis.probeRms=()=>{const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
      return Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/values.length);};
    await audio.resume();
  });
  const tone=Buffer.alloc(24000*2);
  for(let i=0;i<24000;i++)tone.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*8192),i*2);
  async function play(sink){
    const child=spawn('paplay',['--raw','--format=s16le','--rate=24000','--channels=1','--device='+sink],{stdio:['pipe','ignore','pipe']});
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('paplay failed')));});
    child.stdin.end(tone);await delay(300);
    const rms=await page.evaluate(()=>globalThis.probeRms());await done;return rms;
  }
  const receiveRms=await play('meeting_rx');assert(receiveRms<.001,'remote playback leaked into virtual mic');
  pactl('set-sink-mute','tts_sink','0');
  const ttsRms=await play('tts_sink');assert(ttsRms>.01,'TTS did not reach virtual microphone');
  createTtsPlayback().stop();
  assert.equal(pactl('get-source-mute','virtual_mic'),'Mute: no');
  assert.equal(pactl('get-sink-mute','tts_sink'),'Mute: yes');
  console.log(JSON.stringify({real_chromium_microphone:true,receive_isolated:true,
    receive_rms:receiveRms,tts_rms:ttsRms,source_stays_available:true,tts_sink_muted_after_stop:true,live_meeting:false}));
} finally {await context?.close();server.close();}

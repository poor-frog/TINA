import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCaptureBridge } from './capture-bridge.js';

test('64 ms is limited to voice-enabled Google Meet; the bridge keeps sample clocks and both audio branches', async () => {
  for (const [platform, voiceAgentEnabled, expected] of [
    ['google_meet', true, 1024], ['google_meet', false, 4096], ['zoom', true, 4096], ['teams', true, 4096],
  ] as const) {
    let selected: number | undefined;
    const callbacks = new Map<string, (...args: any[]) => void>();
    const captured: any[][] = [], voice: any[][] = [];
    const page = { async exposeFunction(name: string, fn: (...args: any[]) => void) { callbacks.set(name, fn); },
      async evaluate(_: unknown, args: any) { if (args?.captureBufferSize) selected = args.captureBufferSize; } };
    const stop = await startCaptureBridge(page as any,
      {platform, voiceAgentEnabled, botName:'TINA', transcribeEnabled:true} as any,
      {feedAudio(...args: any[]) { captured.push(args); }} as any, undefined, undefined, undefined,
      (...args) => { voice.push(args); });
    try {
      assert.equal(selected, expected);
      if (platform === 'google_meet') {
        callbacks.get('__tinaNamedAudioData')!(2, 'Speaker', Array(1024).fill(.1), 1800000000000, null, 2048);
        assert.equal(captured[0][2].length, 1024); assert.equal(captured[0][3], 1800000000000);
        assert.equal(captured[0][5], 2048); assert.equal(voice[0][1].length, 1024);
        assert.equal(voice[0][4],2048, 'sample clocks reach diagnostics without changing transcript audio');
      }
    } finally { await stop(); }
  }
});

test('experimental filter receives a copy path after raw archive and feeds identical cleaned PCM to ASR/VAD',async()=>{
  const callbacks=new Map<string,(...args:any[])=>void>(),raw:any[]=[],asr:Float32Array[]=[],vad:Float32Array[]=[];
  const page={async exposeFunction(name:string,fn:(...args:any[])=>void){callbacks.set(name,fn);},async evaluate(){}};
  const stop=await startCaptureBridge(page as any,{platform:'google_meet',botName:'TINA',voiceAgentEnabled:true} as any,
    {feedAudio(_:number,__:unknown,pcm:Float32Array){asr.push(pcm);}} as any,
    {captureFrame(value:any){raw.push(value);}} as any,undefined,undefined,
    (_,pcm)=>{vad.push(pcm);},(frame,deliver)=>deliver(frame.pcm.map(v=>v*.5)));
  try{
    callbacks.get('__tinaNamedAudioData')!(0,'Speaker',Array(1024).fill(.1),1800000000000,null,0);
    const archived=Buffer.from(raw[0].pcm,'base64');assert.equal(archived.readFloatLE(0),Math.fround(.1));
    assert.equal(asr[0][0],Math.fround(.05));assert.equal(vad[0],asr[0]);
  }finally{await stop();}
});

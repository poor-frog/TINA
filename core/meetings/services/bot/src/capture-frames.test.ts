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

test('gmeet page bridge uses resolvedSpeaker (including sole-participant) and logs audible-unresolved diagnostics', async () => {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const fed: any[][] = [];
  const observations: any[] = [];
  const botLogs: string[] = [];
  let onAudioCb: ((index: number, pcm: Float32Array, timeline?: { captureMs: number; startSample: number }) => void) | undefined;
  let currentResolved: { name: string; participantId?: string; via: 'glow' | 'linger' | 'sole-participant' } | undefined = {
    name: 'JKY LEE',
    participantId: 'spaces/x/devices/348',
    via: 'sole-participant',
  };
  let speakersDestroyed = false;

  const prevGlobal = {
    TinaBrowserUtils: (globalThis as any).TinaBrowserUtils,
    logBot: (globalThis as any).logBot,
    __tinaGmeetCapture: (globalThis as any).__tinaGmeetCapture,
    __tinaGmeetSpeakers: (globalThis as any).__tinaGmeetSpeakers,
    __tinaGmeetHealthTimer: (globalThis as any).__tinaGmeetHealthTimer,
    __tinaNamedAudioData: (globalThis as any).__tinaNamedAudioData,
    __tinaPerSpeakerAudioData: (globalThis as any).__tinaPerSpeakerAudioData,
    __tinaObservation: (globalThis as any).__tinaObservation,
    __tinaRemoteAudioReady: (globalThis as any).__tinaRemoteAudioReady,
  };

  try {
    (globalThis as any).logBot = (m: string) => botLogs.push(m);
    (globalThis as any).TinaBrowserUtils = {
      createGmeetSpeakers: () => ({
        resolvedSpeaker: () => currentResolved,
        litNames: () => [],
        participantForName: () => undefined,
        getState: () => ({
          tiles: [{ id: 'spaces/x/devices/348', name: 'JKY LEE', self: false, speaking: false }],
          speakingNow: [],
          participantCount: 1,
          selectorStats: { knownClassHits: {}, lastKnownHitMs: 0 },
        }),
        destroy: () => { speakersDestroyed = true; },
      }),
      createGmeetCapture: (opts: any) => {
        onAudioCb = opts.onAudio;
        return { async start() {}, stop() {} };
      },
    };

    const page = {
      async exposeFunction(name: string, fn: (...args: any[]) => void) {
        callbacks.set(name, fn);
        (globalThis as any)[name] = fn;
      },
      async evaluate(fn: (arg?: any) => any, arg?: any) {
        return await fn(arg);
      },
    };

    const stop = await startCaptureBridge(
      page as any,
      { platform: 'google_meet', voiceAgentEnabled: true, botName: 'TINA', transcribeEnabled: true } as any,
      { feedAudio(...args: any[]) { fed.push(args); } } as any,
      { captureFrame() {}, captureObservation(rec: any) { observations.push(rec); } } as any,
    );

    try {
      assert.ok(onAudioCb, 'capture bridge registered gmeet onAudio callback');
      // 1) Sole-participant fallback carries speaker name + participant_id into pipeline.feedAudio
      onAudioCb!(3, new Float32Array(1024).fill(0.1), { captureMs: 1800000000100, startSample: 0 });
      assert.equal(fed.length, 1);
      assert.equal(fed[0][0], 3);
      assert.equal(fed[0][1], 'JKY LEE');
      assert.equal(fed[0][4], 'spaces/x/devices/348');

      // 2) Audible frame with unresolved speaker emits gmeet-speakers diagnostic observation
      currentResolved = undefined;
      onAudioCb!(3, new Float32Array(1024).fill(0.1), { captureMs: 1800000000200, startSample: 1024 });
      assert.equal(fed.length, 2);
      assert.equal(fed[1][1], undefined);
      const diag = observations.find((o) => o.source === 'gmeet-speakers' && o.observation?.type === 'audible-unresolved');
      assert.ok(diag, 'audible-unresolved diagnostic observation emitted');
      assert.equal(diag.observation.channel, 3);
      assert.ok(botLogs.some((m) => m.includes('gmeet-speakers audible-unresolved')));
    } finally {
      await stop();
    }
    assert.equal(speakersDestroyed, true);
    assert.equal((globalThis as any).__tinaGmeetHealthTimer, null);
  } finally {
    Object.assign(globalThis as any, prevGlobal);
  }
});

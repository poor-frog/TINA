import assert from 'node:assert/strict';
import vm from 'node:vm';
import {WORKLET_SRC,createPcmCaptureNode} from './pcm-capture.js';
let Processor:any;
const messages:any[]=[];
const sandbox:any={AudioWorkletProcessor:class{port={postMessage:(x:any)=>messages.push(x)}},Float32Array,currentFrame:0,registerProcessor:(_name:string,p:any)=>{Processor=p}};
vm.runInNewContext(WORKLET_SRC,sandbox);
const processor=new Processor();
for(let i=0;i<64;i++){sandbox.currentFrame=i*128;processor.process([[new Float32Array(128).fill(.1)]]);}
assert.deepEqual(messages.map(m=>m.startFrame),[0,4096]);
sandbox.currentFrame=12000;
for(let i=0;i<32;i++){sandbox.currentFrame=12000+i*128;processor.process([[new Float32Array(128).fill(.2)]]);}
assert.equal(messages[2].startFrame,12000);
let node:any;
(globalThis as any).AudioWorkletNode=class{port:any={};constructor(){node=this}};
const received:any[]=[];
const old=Date.now;Date.now=()=>10000;
const context:any={currentTime:0,sampleRate:16000,audioWorklet:{addModule:async()=>{}}};
await createPcmCaptureNode(context,(pcm,timeline)=>received.push({pcm,timeline}),'local-worklet');
for(const data of messages){Date.now=()=>999999;node.port.onmessage({data});}
Date.now=old;
assert.deepEqual(received.map(r=>r.timeline.startSample),[0,4096,12000]);
assert.equal(received[1].timeline.captureMs,10256);
assert.equal(received[2].timeline.captureMs,10750);
assert.deepEqual(received[0].pcm,new Float32Array(4096).fill(.1));
console.log('worklet sample clock: callbacks delayed, frame gaps and source timestamps OK');

const originalPerformance=globalThis.performance;
let performanceMs=500;
Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>performanceMs}});
try {
  Date.now=()=>10000;
  const output={contextTime:0,performanceTime:0};
  const clockContext:any={currentTime:0,sampleRate:16000,audioWorklet:{addModule:async()=>{}},
    getOutputTimestamp:()=>output};
  const timed:any[]=[];
  await createPcmCaptureNode(clockContext,(_pcm,timeline)=>timed.push(timeline),'local-worklet');
  output.contextTime=60;
  output.performanceTime=70500;
  performanceMs=70500;
  Date.now=()=>80000;
  node.port.onmessage({data:{pcm:new Float32Array(1024),startFrame:60*16000}});
  assert.equal(timed[0].captureMs,80000,'device correlation corrects a ten-second audio clock lag');
  output.contextTime=66;
  output.performanceTime=76500;
  performanceMs=76500;
  Date.now=()=>86000;
  node.port.onmessage({data:{pcm:new Float32Array(1024),startFrame:60*16000+1024}});
  assert.equal(timed[1].captureMs,80064,'a queued frame retains its capture time instead of becoming fresh');
  assert.equal(timed[1].startSample,1024,'clock correction preserves source sample positions');
} finally {
  Date.now=old;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:originalPerformance});
}
console.log('device audio clock: drift correction preserves delayed frames and sample offsets');

for (const bufferSize of [1024, 4096]) {
  const outputs: any[] = [];
  const scope: any = { AudioWorkletProcessor: class { port = { postMessage: (value: any) => outputs.push(value) }; },
    Float32Array, currentFrame: 0, registerProcessor: (_: string, ctor: any) => { scope.Processor = ctor; } };
  vm.runInNewContext(WORKLET_SRC, scope);
  const worklet = new scope.Processor({processorOptions:{bufferSize}});
  const input = Float32Array.from({length: 16384}, (_, i) => Math.sin(i / 33));
  for (let start = 0; start < input.length; start += 128) {
    scope.currentFrame = start; worklet.process([[input.subarray(start, start + 128)]]);
  }
  assert.equal(outputs.length, input.length / bufferSize);
  const restored = new Float32Array(input.length);
  for (const value of outputs) { assert.equal(value.pcm.length, bufferSize); restored.set(value.pcm, value.startFrame); }
  assert.deepEqual(restored, input, 'both sizes preserve exact samples, order and source offsets');
  scope.currentFrame = 20000; worklet.process([[new Float32Array(128)]]);
  for (let start = 21024; start < 21024 + bufferSize; start += 128) {
    scope.currentFrame = start; worklet.process([[new Float32Array(128)]]);
  }
  assert.equal(outputs.at(-1).startFrame, 21024, 'a discontinuity cannot merge stale partial audio');
  assert.throws(() => new scope.Processor({processorOptions:{bufferSize: 513}}));
}
console.log('PCM frame A/B: 64/256 ms preserve samples and timestamps without duplication');

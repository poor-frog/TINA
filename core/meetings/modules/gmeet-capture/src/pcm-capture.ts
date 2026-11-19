/**
 * AudioWorklet PCM capture — THE replacement for ScriptProcessorNode.
 *
 * ScriptProcessorNode runs its callback on the MAIN THREAD and, when the page is
 * busy (Meet rendering + several concurrent captures + STT round-trips), it
 * DUPLICATES or drops audio buffers. That doubled/overlapping PCM is exactly the
 * "stutter" heard in the captured audio (mic AND per-participant) — Whisper was
 * faithfully transcribing garbled input. An AudioWorklet runs on the dedicated
 * audio render thread, so it can't be starved by main-thread load.
 *
 * Contract-faithful: the ctx must already be at the target rate (16 kHz); this
 * emits fixed-size Float32 frames at that rate (4096 default, 1024 for the voice bot).
 */

const BLOCK = 4096;
/** The registered processor name — also exported so a host that ships the worklet
 *  as its own file (see WORKLET_SRC) keeps one source of truth for the name. */
export const PCM_WORKLET_PROCESSOR = 'tina-pcm-capture';

// Worklet runs in its own realm — authored as a string. The body is the SINGLE
// SOURCE OF TRUTH for the processor; it is loaded one of two ways:
//   - moduleUrl given  → addModule(moduleUrl): the host ships THIS source as a
//     real file (a web_accessible_resource under MV3) and passes its URL via
//     chrome.runtime.getURL(...). REQUIRED under MV3's extension-page CSP, which
//     forbids `blob:` in script-src/worker-src ("Unable to load a worklet's
//     module") — the offscreen ch1000 mic path was silently blocked by it.
//   - no moduleUrl     → blob: URL fallback. Works in the bot / in-page MAIN
//     world (no extension CSP there), so those paths need no shipped file.
// Exported so the extension build can emit it verbatim as the shipped worklet.
export const WORKLET_SRC = `
class TinaPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this._block = options?.processorOptions?.bufferSize ?? ${BLOCK};
    if (![1024, ${BLOCK}].includes(this._block)) throw new Error('Unsupported PCM buffer size');
    this._buf = new Float32Array(this._block); this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) {this._n=0;return true;}
    if(this._endFrame!==undefined && this._endFrame!==currentFrame)this._n=0;
    this._endFrame=currentFrame+ch.length;
    for (let i = 0; i < ch.length; i++) {
      if(this._n===0)this._startFrame=currentFrame+i;
      this._buf[this._n++] = ch[i];
      if (this._n === this._block) { this.port.postMessage({pcm:this._buf,startFrame:this._startFrame}); this._buf = new Float32Array(this._block); this._n = 0; }
    }
    return true;
  }
}
registerProcessor('${PCM_WORKLET_PROCESSOR}', TinaPcmCapture);
`;

// The processor name can only be registered ONCE per AudioContext — track which
// contexts already loaded the module (callers may create several nodes per ctx).
export interface PcmTimeline { startSample:number; captureMs:number }
const moduled = new WeakSet<AudioContext>();

/**
 * Create an AudioWorklet capture node on `ctx` (which must be at 16 kHz). The
 * caller connects its source to the returned node and the node to
 * `ctx.destination` (to keep it pulled). `onPcm` receives a bufferSize-sized
 * Float32Array per frame — already a fresh copy, safe to forward without cloning.
 *
 * `moduleUrl` (optional) is the URL the worklet module is fetched from. Pass a
 * web_accessible_resource URL (chrome.runtime.getURL('tina-pcm-worklet.js')) under
 * MV3, where the `blob:` fallback is CSP-blocked. Omit it (bot / in-page MAIN
 * world) to use the inline blob: URL. The module stays chrome-agnostic — the host
 * owns the URL.
 */
export async function createPcmCaptureNode(
  ctx: AudioContext,
  onPcm: (pcm: Float32Array, timeline?:PcmTimeline) => void,
  moduleUrl?: string,
  bufferSize = BLOCK,
): Promise<AudioWorkletNode> {
  if (![1024, BLOCK].includes(bufferSize)) throw new Error('Unsupported PCM buffer size');
  if (!moduled.has(ctx)) {
    if (moduleUrl) {
      await ctx.audioWorklet.addModule(moduleUrl);
    } else {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    }
    moduled.add(ctx);
  }
  // Force mono downmix (the old ScriptProcessor used 1 input channel).
  const node = new AudioWorkletNode(ctx, PCM_WORKLET_PROCESSOR, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { bufferSize },
  });
  const epochMs=Date.now()-ctx.currentTime*1000;
  const performanceEpochMs = Date.now() - performance.now();
  let firstFrame:number|undefined;
  node.port.onmessage = (e:MessageEvent) => {
    if(e.data instanceof Float32Array) {onPcm(e.data);return;} // old worklet during extension reload
    const {pcm,startFrame}=e.data ?? {};
    if(!(pcm instanceof Float32Array)||!Number.isSafeInteger(startFrame)||startFrame<0)return;
    firstFrame ??= startFrame as number;
    const frameTime = startFrame / ctx.sampleRate;
    const output = ctx.getOutputTimestamp?.();
    const contextTime = output?.contextTime ?? 0;
    const performanceTime = output?.performanceTime ?? 0;
    // AudioContext time can drift or pause relative to the wall clock. Correlate the
    // source sample with the device clock while preserving delayed frame timestamps.
    const captureMs = Number.isFinite(contextTime) && contextTime > 0
      && Number.isFinite(performanceTime) && performanceTime > 0
      ? performanceEpochMs + performanceTime + (frameTime - contextTime) * 1000
      : epochMs + frameTime * 1000;
    onPcm(pcm,{startSample:startFrame-firstFrame,captureMs});
  };
  return node;
}

/**
 * gmeet-capture golden — the PURE cores (no DOM): the glow→name binding decision and the energy↔glow
 * channel binder. The DOM capture itself (pcm/audio/glow scraping) is validated LIVE (extension/bot in
 * a real Meet), so this golden pins the attribution logic that has no business touching a page.
 * Run: npm test  or  npx tsx src/gmeet-capture.test.ts
 */
import { pickBoundName } from "./gmeet-capture-v1.js";
import { GmeetChannelBinder } from "./gmeet-channel-binder.js";
import { createGmeetCapture } from "./gmeet-capture.js";

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); if (!cond) failed++; };

// pickBoundName — honest binding: a name only when EXACTLY one tile is lit.
check("one tile lit → that name", pickBoundName(["Alice"]) === "Alice");
check("no tile lit → undefined (silence/settling)", pickBoundName([]) === undefined);
check("two tiles lit → undefined (overlap is ambiguous — never guess)", pickBoundName(["Alice", "Bob"]) === undefined);

// GmeetChannelBinder — each channel binds to the tile whose glow tracks its audio energy.
const b = new GmeetChannelBinder({ tauMs: 2500, loudThreshold: 0.02, minScore: 2.5 });
b.recordGlow("Alice", false, 0);                          // Alice's solo: she glows while channel 0 is loud
for (let t = 0; t <= 600; t += 100) b.nameForChannel(0, t, 0.5);
b.recordGlow("Alice", true, 650);
b.recordGlow("Bob", false, 700);                          // Bob's solo: he glows while channel 1 is loud
for (let t = 700; t <= 1300; t += 100) b.nameForChannel(1, t, 0.5);
check("channel 0 ↔ Alice (energy tracked her glow)", b.nameForChannel(0, 1350, 0) === "Alice");
check("channel 1 ↔ Bob", b.nameForChannel(1, 1350, 0) === "Bob");

const b2 = new GmeetChannelBinder({ minScore: 2.5 });
b2.recordGlow("Zoe", false, 0);
b2.nameForChannel(7, 0, 0.5);                             // a single loud frame → score 1 < minScore
check("below the confidence floor → UNKNOWN (leak-free, never a guess)", b2.nameForChannel(7, 10, 0) === undefined);

// Drive the shared bot/extension PCM callback without hardware or a browser.
{
  const g = globalThis as any;
  let node: any;
  class Stream {
    id = 'quiet-capture-test';
    getAudioTracks() { return [{ id: 'quiet-track', addEventListener() {} }]; }
  }
  class Context {
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
  }
  class Worklet {
    port = { onmessage: null as any };
    constructor(_ctx: unknown, _name: string, options: any) { node = this; this.options = options; }
    options: any;
    connect() {}
  }
  g.AudioContext = Context; g.AudioWorkletNode = Worklet; g.MediaStream = Stream;
  g.document = { querySelectorAll: () => [{ paused: false, srcObject: new Stream() }] };
  const pcms: Float32Array[] = [];
  const capture = createGmeetCapture({ bufferSize: 1024, onAudio: (_index, pcm) => pcms.push(pcm) });
  try {
    await capture.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    check('capture forwards the requested frame size to the worklet processor', node.options.processorOptions.bufferSize === 1024);
    node.port.onmessage({ data: new Float32Array(4096) });
    node.port.onmessage({ data: new Float32Array(4096).fill(1 / 32768) });
    check('default capture rejects silence and PCM16 residue', pcms.length === 0);
    node.port.onmessage({ data: new Float32Array(4096).fill(0.0005) });
    check('default capture retains quiet speech below the old peak gate', pcms.length === 1);
  } finally { capture.stop(); }
}

if (failed) { console.error(`\n❌ gmeet-capture: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ gmeet-capture: pure cores pass — honest glow binding + energy↔glow channel correlation. (DOM capture is live-validated.)`);

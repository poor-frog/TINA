/**
 * L3 boundary — Teams speaker hints cross the page→Node boundary (#498 C4).
 *
 * Launches the REAL bridge wiring end-to-end, no meeting and no display:
 *   1. asserts the built browser bundle (dist/browser-utils.global.js) exposes
 *      createTeamsSpeakers (the regression that shipped seg_N: the brick missing
 *      from the bundle);
 *   2. headless Chromium (the same launchPersistentBrowser the bot uses) loads a
 *      static fixture page with a Teams-shaped DOM — a participant tile carrying
 *      the voice-level-stream-outline signal — plus a 1:1-layout tile WITHOUT the
 *      outline (the #481 two-party class: no signal ⇒ no hint, never a wrong one);
 *   3. startCaptureBridge (the real function) wires the page; the fixture toggles
 *      the vdi-frame-occlusion speaking signal; the test asserts the hints arrive
 *      Node-side with the participant's NAME, epoch tMs, and start/end order.
 *
 * Where headless Chromium cannot launch (no playwright browser in the env) the test
 * SKIPS LOUDLY with exit 0 — the same green-or-skip shape as gate:stack.
 * Run: npx tsx src/capture-bridge.boundary.test.ts
 */
import { execSync } from 'node:child_process';
import http, { type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { launchPersistentBrowser, type BrowserContext } from '@tina/remote-browser';
import { buildBotBrowserArgs, createSpeakController, shouldPersistAuthSession, startCaptureBridge } from './capture-bridge.js';
import type { BotPipeline, HintCounters } from './pipeline.js';
import type { Invocation } from './config.js';
import { createTtsPlayback, type TtsPlayback } from './tts-playback.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(HERE, '..');
const BUNDLE = join(BOT_DIR, 'dist', 'browser-utils.global.js');

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html><html><body>
  <div data-tid="participant-tile" id="alice-tile">
    <span title="Alice Fixture">Alice Fixture</span>
    <div data-tid="voice-level-stream-outline" id="alice-outline"></div>
  </div>
  <!-- #481 two-party (1:1) layout class: the outline indicator never renders.
       The watcher must emit NO hint for this tile (no signal ⇒ silence, not a guess). -->
  <div data-tid="participant-tile" id="bob-tile">
    <span title="Bob OneToOne">Bob OneToOne</span>
  </div>
</body></html>`;

async function verifyTtsStopBehavior(): Promise<void> {
  const authBotArgs = buildBotBrowserArgs(true);
  const anonBotArgs = buildBotBrowserArgs(false);
  check('authenticated bot browser args omit --incognito and keep --disable-dev-shm-usage + autoplay',
    !authBotArgs.includes('--incognito')
    && authBotArgs.includes('--disable-dev-shm-usage')
    && authBotArgs.includes('--autoplay-policy=no-user-gesture-required'),
    JSON.stringify(authBotArgs));
  check('anonymous bot browser args preserve --incognito and --disable-dev-shm-usage',
    anonBotArgs.includes('--incognito') && anonBotArgs.includes('--disable-dev-shm-usage'),
    JSON.stringify(anonBotArgs));
  const featureFlags = authBotArgs.filter((a) => a.startsWith('--disable-features='));
  check('buildBotBrowserArgs coalesces --disable-features into a single flag containing all features',
    featureFlags.length === 1
    && featureFlags[0].includes('IsolateOrigins')
    && featureFlags[0].includes('site-per-process')
    && featureFlags[0].includes('VizDisplayCompositor'),
    JSON.stringify(featureFlags));
  check('shouldPersistAuthSession only writes back on completed meetings',
    shouldPersistAuthSession({ status: 'completed', completionReason: 'stopped' }) === true
    && shouldPersistAuthSession({ status: 'failed', completionReason: 'auth_session_missing' }) === false
    && shouldPersistAuthSession({ status: 'failed', completionReason: 'awaiting_admission_rejected' }) === false
    && shouldPersistAuthSession(undefined) === false,
    'write-back guard mismatch');

  const previousPath = process.env.PATH;
  const previousUrl = process.env.TTS_SERVICE_URL;
  const previousToken = process.env.TTS_API_TOKEN;
  const previousDocument = (globalThis as any).document;
  const isolatedBin = mkdtempSync(join(tmpdir(), 'tina-tts-no-bin-'));
  process.env.PATH = isolatedBin; // prevent pactl from touching a host audio device in this test
  delete process.env.TTS_SERVICE_URL;
  delete process.env.TTS_API_TOKEN;

  try {
    let micLabel = 'Unmute microphone';
    let micClicks = 0;
    const micButton = {
      getAttribute(name: string) { return name === 'aria-label' ? micLabel : null; },
      click() {
        micClicks++;
        micLabel = micLabel === 'Unmute microphone' ? 'Mute microphone' : 'Unmute microphone';
      },
    };
    (globalThis as any).document = {
      querySelector: (selector: string) => selector === '#microphone-button' ? micButton : null,
      querySelectorAll: () => [micButton],
    };
    const page = {
      async evaluate(fn: (args: unknown) => unknown, args: unknown) { return fn(args); },
    } as unknown as import('@tina/remote-browser').Page;
    const idleTts: TtsPlayback = { async speak() {}, stop() {} };
    const controller = createSpeakController(
      page,
      { platform: 'teams', meetingUrl: '', botName: 'TINA', redisUrl: 'redis://unused', voiceAgentEnabled: true } as Invocation,
      () => idleTts,
    );
    await controller.stop();
    check('speak_stop leaves an already-muted meeting microphone muted',
      micLabel === 'Unmute microphone' && micClicks === 0, `label=${micLabel}, clicks=${micClicks}`);
    const speechLogs: string[] = [];
    const realConsoleLog = console.log;
    console.log = (...args: unknown[]) => { speechLogs.push(args.map(String).join(' ')); };
    try {
      await controller.speak('private speech marker');
    } finally {
      console.log = realConsoleLog;
    }
    check('speech logs retain metadata but not the spoken text',
      speechLogs.some((line) => line.includes('characters')) && !speechLogs.join('\n').includes('private speech marker'),
      speechLogs.join('\n'));

    let requestReceivedResolve!: () => void;
    const requestReceived = new Promise<void>((resolve) => { requestReceivedResolve = resolve; });
    let socketClosedResolve!: () => void;
    const socketClosed = new Promise<void>((resolve) => { socketClosedResolve = resolve; });
    let response: ServerResponse | undefined;
    const server = http.createServer((req, res) => {
      response = res;
      req.resume();
      req.socket.once('close', socketClosedResolve);
      requestReceivedResolve();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.TTS_SERVICE_URL = url;
    const playback = createTtsPlayback(() => {}, { setMute: () => {} } as never);
    const speaking = playback.speak('private speech that should stop');
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    const requestStarted = await Promise.race([
      requestReceived.then(() => true),
      new Promise<boolean>((resolve) => { requestTimeout = setTimeout(() => resolve(false), 1000); }),
    ]);
    if (requestTimeout) clearTimeout(requestTimeout);
    if (!requestStarted) {
      check('speak: local TTS request reaches its server', false);
      playback.stop();
      await speaking;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    playback.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const aborted = await Promise.race([
      socketClosed.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 500); }),
    ]);
    if (timeout) clearTimeout(timeout);
    check('speak_stop aborts an outstanding TTS HTTP request', aborted, `aborted=${aborted}`);
    if (response && !response.writableEnded && !response.destroyed) {
      response.writeHead(503);
      response.end();
    }
    await speaking;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousUrl === undefined) delete process.env.TTS_SERVICE_URL;
    else process.env.TTS_SERVICE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TTS_API_TOKEN;
    else process.env.TTS_API_TOKEN = previousToken;
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
    rmSync(isolatedBin, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await verifyTtsStopBehavior();
  // ── 1) the bundle carries the Teams brick (the shipped regression) ──
  if (!existsSync(BUNDLE)) execSync('node build-browser-utils.mjs', { cwd: BOT_DIR, stdio: 'inherit' });
  const bundleHasTeams = execSync(`grep -c createTeamsSpeakers ${JSON.stringify(BUNDLE)} || true`).toString().trim() !== '0';
  check('browser bundle exposes createTeamsSpeakers', bundleHasTeams);

  // ── 2) headless browser (green-or-skip where chromium is absent) ──
  const dataDir = mkdtempSync(join(tmpdir(), 'tina-boundary-'));
  let context: BrowserContext;
  let page;
  try {
    ({ context, page } = await launchPersistentBrowser({ dataDir, args: ['--no-sandbox', '--mute-audio'], headless: true }));
  } catch (e) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(e as Error).message?.split('\n')[0]}`);
    process.exit(failed === 0 ? 0 : 1);
  }
  try {
    await context.addInitScript({ path: BUNDLE });
    const pageLogs: string[] = [];
    await context.exposeFunction('logBot', (m: string) => pageLogs.push(String(m)));

    // The REAL bridge over a stub pipeline capturing what crosses the boundary.
    const hints: { name: string; tMs: number; isEnd?: boolean }[] = [];
    const hintCounters: HintCounters = { received: 0, matched: 0, missed: 0 };
    const pipeline: BotPipeline = {
      async start() { /* stub */ }, async stop() { /* stub */ },
      feedAudio() { /* stub */ }, feedMixedAudio() { /* stub */ },
      recordHint(name, tMs, isEnd) { hintCounters.received++; hints.push({ name, tMs, isEnd }); },
      hintCounters,
    };
    const inv: Invocation = {
      platform: 'teams', meetingUrl: 'https://teams.fixture.test/m', botName: 'TINA',
      redisUrl: 'redis://localhost:6379', transcribeEnabled: false,
    };
    await page.setContent(FIXTURE);
    // setContent does not re-run context init scripts in this launch shape, so load the
    // SAME prebuilt bundle into the fixture document directly (identical bytes to what
    // addInitScript injects on a real navigation).
    await page.addScriptTag({ path: BUNDLE });
    // tsx transpiles this test with esbuild keepNames, whose `__name` helper leaks into
    // page.evaluate-serialized functions; shim it page-side so the REAL bridge code
    // (which ships helper-free via tsc) runs unmodified under the test runner.
    await page.evaluate('globalThis.__name = globalThis.__name || ((t, v) => t);');
    const stop = await startCaptureBridge(page, inv, pipeline);

    // Fixture drives the speaking signal: occlusion class ON (start) → OFF (end).
    await sleep(600);   // observer attach + initial silent state past the 200ms hysteresis
    await page.evaluate(`document.getElementById('alice-outline').classList.add('vdi-frame-occlusion')`);
    await sleep(900);   // 200ms hysteresis + 300ms debounce + margin
    await page.evaluate(`document.getElementById('alice-outline').classList.remove('vdi-frame-occlusion')`);
    await sleep(900);
    await stop();

    // ── 3) the assertions: hints crossed with name, epoch clock, order ──
    check('page-side watcher started (hop 1 visible in page logs)', pageLogs.some((l) => l.includes('[TeamsSpeakers]')), JSON.stringify(pageLogs.slice(0, 3)));
    const alice = hints.filter((h) => h.name === 'Alice Fixture');
    check('speaker hints crossed the boundary for the outlined tile', alice.length >= 2, JSON.stringify(hints));
    // The watcher reports the tile's initial silent state first (an END-shaped hint),
    // then the scripted transitions: START on occlusion, END on its removal — in order.
    const firstStart = alice.findIndex((h) => h.isEnd === false);
    check('a START hint (isEnd=false) crossed for the speaking transition', firstStart >= 0, JSON.stringify(alice));
    check('an END hint follows the START (transition order intact)', firstStart >= 0 && alice.slice(firstStart + 1).some((h) => h.isEnd === true), JSON.stringify(alice));
    check('hint tMs is epoch ms (same clock domain as audio)', alice.every((h) => Math.abs(h.tMs - Date.now()) < 60_000), JSON.stringify(alice.map((h) => h.tMs)));
    check('bot self-name and the signal-less 1:1 tile emit NO hints',
      !hints.some((h) => h.name.includes('TINA') || h.name === 'Bob OneToOne'), JSON.stringify(hints));
    check('pipeline-received counter moved with the arrivals', hintCounters.received === hints.length && hintCounters.received > 0, JSON.stringify(hintCounters));
  } finally {
    await context.close().catch(() => { /* best-effort */ });
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? '\n✅ capture-bridge boundary: all green' : `\n❌ capture-bridge boundary: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('❌ FAIL —', e?.stack || e); process.exit(1); });

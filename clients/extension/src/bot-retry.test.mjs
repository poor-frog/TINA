import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { dataset: {}, listeners: {}, value: '',
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(name, value) { (this.attributes ??= {})[name] = value; } });
  return elements.get(id);
};
const calls = [];
let ok = true;
const context = {
  console, URL, URLSearchParams, AbortSignal, Date,
  document: { getElementById: element },
  setTimeout: () => 1, clearTimeout() {},
  chrome: { runtime: { sendMessage: async () => ({ ok: true, token: 'test-token' }) },
    storage: { onChanged: { addListener() {} } }, tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } } },
  fetch: async (url, options) => { calls.push({ url, options }); return { ok }; },
};
const source = readFileSync(new URL('./viewer.ts', import.meta.url), 'utf8').replace('void init();', '') + `
  globalThis.retryProbe = {
    set(row) { config.account = { key: 'test-session', gateway: config.botGatewayUrl }; activeMeeting = {platform:'google_meet',nativeMeetingId:'abc-defg-hij'};
      meetings = [row]; sendBotState = null; syncFailedBotState(); bindSettings(); },
    state() { return sendBotState; }, cancelBotRetry,
  };
`;
const result = await build({ stdin: { contents: source, loader: 'ts', resolveDir: new URL('.', import.meta.url).pathname },
  bundle: true, write: false, format: 'iife', platform: 'browser', plugins: [{ name: 'unused-views', setup(b) {
    b.onResolve({filter: /^\.\/(voice-activity-view|transcript-feed|translation)$/}, args => ({path: args.path, namespace:'fake'}));
    b.onLoad({filter: /.*/, namespace:'fake'}, () => ({contents:
      'export const createVoiceActivity=()=>({}),createTranscriptFeed=()=>({}),watchTranslation=()=>()=>{};', loader:'js'}));
  } }],
});
vm.createContext(context);
vm.runInContext(result.outputFiles[0].text, context);
const row = {id:1, platform:'google_meet', nativeMeetingId:'abc-defg-hij', status:'failed', startMs:1,
  autoRetry: {state:'scheduled', attempt:1, max_attempts:3}};
context.retryProbe.set(row);
assert.equal(element('sendBotBtn').textContent, 'Cancel retry');
assert.equal(element('sendBotBtn').disabled, false);
element('sendBotBtn').listeners.click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls[0].options.method, 'DELETE');
assert.match(calls[0].url, /\/bots\/google_meet\/abc-defg-hij$/);
assert.equal(context.retryProbe.state().phase, 'error');
assert.equal(element('sendBotBtn').textContent, 'Send Bot Again');
assert.match(element('sendBotStatus').textContent, /cancelled/);
ok = false;
context.retryProbe.set(row);
await context.retryProbe.cancelBotRetry();
assert.equal(context.retryProbe.state().phase, 'retrying');
assert.equal(element('sendBotBtn').textContent, 'Cancel retry');
context.retryProbe.set({...row,autoRetry:{state:'not_retryable',attempt:1,max_attempts:3},
  joinFailureSummary:'Google Meet blocked the bot before an admission request could be sent.'});
assert.equal(element('sendBotStatus').textContent,'Google Meet blocked the bot before an admission request could be sent.');
console.log('PASS viewer retry cancellation and failed-cancel recovery');

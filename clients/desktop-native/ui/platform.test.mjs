import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const scope = {};
vm.runInNewContext(readFileSync(new URL('./capture-settings.js', import.meta.url), 'utf8'), scope);
test('Windows presents manual capture, Explorer and Windows permissions', () => {
  const copy = scope.TinaCaptureSettings.platformPresentation('windows');
  assert.equal(copy.name, 'Windows');
  assert.equal(copy.reveal, 'Show in Explorer');
  assert.equal(copy.automaticPaste, false);
  assert.match(copy.dictation, /Start dictation/);
  assert.doesNotMatch(copy.privacy, /macOS|ScreenCaptureKit/);
});
test('macOS keeps its existing shortcut and Finder presentation', () => {
  const copy = scope.TinaCaptureSettings.platformPresentation('macos');
  assert.equal(copy.reveal, 'Show in Finder');
  assert.equal(copy.automaticPaste, true);
});

test('Windows permission refresh completes against the actual app markup', async () => {
  // Reuse the workspace's existing DOM test dependency; no runtime dependency is added.
  const { JSDOM } = createRequire(new URL('../../terminal/package.json', import.meta.url))('jsdom');
  const dom = new JSDOM(readFileSync(new URL('./index.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  try {
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    dom.window.eval(readFileSync(new URL('./capture-settings.js', import.meta.url), 'utf8'));
    dom.window.eval(`const $=id=>document.getElementById(id); let capturePlatform='macos';
      const invoke=async()=>({platform:'windows',microphone:'not-determined',accessibility:false,screenAudio:true});
      ${app.slice(app.indexOf('function showPermission('), app.indexOf('function renderSettingsNetwork('))}`);
    await dom.window.eval('refreshPermissions(null)');
    assert.equal(dom.window.document.getElementById('settings-show-app').closest('.settings-details').hidden, true);
    assert.match(dom.window.document.getElementById('settings-screen-audio-status').textContent, /WASAPI/);
    assert.match(dom.window.document.getElementById('settings-microphone-status').textContent, /Not confirmed/);
  } finally { dom.window.close(); }
});

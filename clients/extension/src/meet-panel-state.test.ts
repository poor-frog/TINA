import assert from 'node:assert/strict';
import { currentGoogleMeetBot, isTerminalBotStatus } from './meet-panel-state';
import type { BotMeeting } from './bot-transcript';
import { pinScope, pinSource, pinsFromStorage } from './meet-pins';

const meeting = (id: number, nativeMeetingId: string, status: string, startMs: number, platform = 'google_meet'): BotMeeting => ({
  id, nativeMeetingId, status, startMs, platform, title: `Meet ${id}`,
});

assert.equal(isTerminalBotStatus('stopped'), true);
assert.equal(isTerminalBotStatus('active'), false);
assert.equal(currentGoogleMeetBot([
  meeting(1, 'abc-defg-hij', 'completed', 300),
  meeting(2, 'ABC-DEFG-HIJ', 'active', 200),
  meeting(3, 'abc-defg-hij', 'active', 100, 'zoom'),
], 'abc-defg-hij')?.id, 2, 'active run for the exact Google Meet room wins over terminal and other-platform rows');
assert.equal(currentGoogleMeetBot([
  meeting(1, 'abc-defg-hij', 'completed', 200),
  meeting(2, 'abc-defg-hij', 'stopped', 300),
], 'abc-defg-hij')?.id, 2, 'latest saved run is available when no Bot is active');
assert.equal(currentGoogleMeetBot([meeting(1, 'other-room', 'active', 300)], 'abc-defg-hij'), null);

const gateway = 'http://127.0.0.1:28056';
const cfg = { botGatewayUrl: gateway, account: { id: '7', email: 'fixture@example.test',
  key: 'a'.repeat(43), gateway, terminal: 'http://127.0.0.1:23000' } };
const run = meeting(12, 'abc-defg-hij', 'active', 400);
const prefix = await pinScope(cfg, run);
const anotherRun = await pinScope(cfg, { ...run, id: 13 });
assert.notEqual(prefix, anotherRun);
assert.notEqual(prefix, await pinScope({ ...cfg, account: { ...cfg.account, id: '8' } }, run));
assert.notEqual(prefix, await pinScope({ ...cfg, botGatewayUrl: 'http://127.0.0.1:28057' }, run));
assert.equal(prefix.includes(cfg.account.key), false);
const source = { segment_id: 's1', text: 'Đã chốt.', absolute_start_time: '2026-11-21T10:00:01Z',
  absolute_end_time: '2026-11-21T10:00:02Z', completed: true };
const pin = pinSource(source)!;
assert.equal(pinSource({ ...source, completed: false }), undefined);
assert.equal(pinSource({ ...source, segment_id: 'legacy:12:0' }), undefined);
assert.deepEqual(pinsFromStorage(prefix, {
  [prefix + 's1']: { ...pin, label: 'Kết luận' },
  [anotherRun + 's1']: pin,
  [prefix + 'bad']: pin,
}), [{ segmentId: 's1', timeMs: Date.parse(source.absolute_start_time), label: 'Kết luận' }]);

console.log('Meet panel: exact Bot/room matching and lifecycle status passed');

assert.equal(prefix, await pinScope({ ...cfg, account: { ...cfg.account, key: 'b'.repeat(43) } }, run));

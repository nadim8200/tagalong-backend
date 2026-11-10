import test from 'node:test';
import assert from 'node:assert/strict';
import { ocThread } from '../driverlink.js';

test('OC thread: welcome pinned first, then texts, app messages and the driver\'s steps, oldest first', () => {
  const link = { sentAt: '2026-11-05T20:26:00Z', sentBy: 'nadim', sentVia: 'RingCentral text (held: training mode)', sentTo: '+13057475175', openedAt: '2026-11-05T20:40:00Z', openedVia: 'app', infoAt: '2026-11-05T20:41:00Z' };
  const log = [
    { type: 'text', kind: 'driver-checkin', to: '+13057475175', text: 'Are you checked in?', by: 'Jarvis (driver check-in)', at: '2026-11-06T16:32:00Z', held: true },
    { type: 'text', kind: 'app-message', to: 'driver app', text: 'dup of chat', at: '2026-11-06T15:00:00Z' },
    { type: 'text', kind: 'app-message', to: 'driver app', text: 'held app msg', at: '2026-11-06T15:05:00Z', held: true },
    { type: 'reply', from: '+13057475175', text: 'yes door 4', at: '2026-11-06T16:40:00Z' },
    { type: 'text', kind: 'call-ahead', to: '+13055550000', text: 'to the receiver, not the driver', at: '2026-11-06T16:00:00Z' },
  ];
  const chat = [{ id: 'm1', from: 'driver', by: 'justin (app)', text: 'Got it, leaving the yard now', at: '2026-11-06T15:58:00Z' }, { id: 'm2', from: 'dispatch', by: 'nadim', text: 'dup of chat', at: '2026-11-06T15:00:00Z', readAt: 'x' }];
  const t = ocThread({ link, chat, log, phone: '(305) 747-5175', consent: { at: '2026-11-05T20:41:00Z', how: 'checked "I agree to texts" in the TagAlong app' }, firstPingAt: '2026-11-05T20:42:00Z', welcomeText: 'Florida Beauty Flora dispatch: Hi Justin… Load code: 934896.' });
  assert.equal(t.first.text, 'Florida Beauty Flora dispatch: Hi Justin… Load code: 934896.');
  assert.equal(t.first.held, true); assert.equal(t.first.by, 'nadim');
  const texts = t.messages.map((m) => m.text);
  assert.deepEqual(texts, ['Opened the link in the TagAlong app', 'Added their truck, trailer and phone', 'Agreed to texts', 'Started sharing location', 'dup of chat', 'held app msg', 'Got it, leaving the yard now', 'Are you checked in?', 'yes door 4']);
  assert.equal(t.messages.filter((m) => m.text === 'dup of chat').length, 1, 'app messages come from the chat once');
  assert.ok(!texts.includes('to the receiver, not the driver'));
  // a logged welcome wins over the rebuilt one; a resend shows in the thread
  const t2 = ocThread({ link, log: [{ type: 'text', kind: 'tracking-link', to: '+13057475175', text: 'first', by: 'gio', at: '2026-11-05T20:00:00Z' }, { type: 'text', kind: 'tracking-link', to: '+13057475175', text: 'again', by: 'gio', at: '2026-11-05T21:00:00Z' }], phone: '3057475175', welcomeText: 'rebuilt' });
  assert.equal(t2.first.text, 'first'); const again = t2.messages.find((m) => m.text === 'again'); assert.equal(again.resend, true); assert.ok(!t2.messages.some((m) => m.text === 'rebuilt' || m.text === 'first'));
  assert.equal(ocThread({}).first, null);
});

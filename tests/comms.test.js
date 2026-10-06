import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, routeReply } from '../comms.js';

test('registered texts: company name, load, STOP line', () => {
  const a = messageFor('confirm-stop', { trip: '624268', stopLabel: 'stop 3 (Example Produce, Lawrence MA)', phone: '+17867233912' });
  assert.match(a, /^Florida Beauty Flora dispatch: please confirm stop 3 .* on load 624268 was delivered\. Reply YES/);
  assert.match(a, /Reply STOP to opt out\.$/);
  const b = messageFor('pod-request', { trip: '624268', link: 'https://mytagalong.app/t/abc' });
  assert.match(b, /signed POD and BOL for load 624268\. Upload photos here: https:\/\/mytagalong\.app\/t\/abc/);
  assert.equal(messageFor('marketing', {}), null);
});

test('driver replies: YES confirms the stop asked about; any reply is logged on the driver\'s load', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const asks = [
    { trip: '624268', kind: 'confirm-stop', stopKey: '3.0|EXAMPLE|LAWRENCE|MA', stopLabel: 'stop 3', phone: '3055550117', at: '2026-10-06T14:00:00Z' },
    { trip: '624100', kind: 'confirm-stop', stopKey: 'x', phone: '3055550117', at: '2026-10-01T14:00:00Z' },   // too old
  ];
  const driverPhones = new Map([['3055550199', ['624300']]]);
  const yes = routeReply({ from: '+1 (305) 555-0117', text: 'Yes delivered' }, { asks, driverPhones, now });
  assert.deepEqual(yes.trips, ['624268']);
  assert.equal(yes.confirm.stopKey, '3.0|EXAMPLE|LAWRENCE|MA');
  const other = routeReply({ from: '+13055550117', text: 'running 30 min late' }, { asks, driverPhones, now });
  assert.equal(other.confirm, null);
  const known = routeReply({ from: '+13055550199', text: 'at the receiver' }, { asks, driverPhones, now });
  assert.deepEqual(known.trips, ['624300']);
  assert.deepEqual(routeReply({ from: '+19995550000', text: 'hi' }, { asks, driverPhones, now }).trips, []);
});

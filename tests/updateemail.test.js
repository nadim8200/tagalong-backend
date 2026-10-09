import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, renderUpdateEmail, autoFollowUps, hm, etTime } from '../updateemail.js';

const NOW = Date.parse('2026-10-09T16:00:00Z');   // Fri Oct 9, 12:00 PM ET
const item = (over = {}) => ({ trip: { tripNumber: '624571', status: 'DEPSHIP', powerUnit: '2094', trailer: '7351', ...(over.trip || {}) },
  freightBills: over.bills || [{ billNumber: 'B180401', billToName: 'PASSION GROWERS', endZoneDescription: 'XENIA, OH, 45385', pieces: 40, actualDelivery: null }],
  _samsara: { location: 'Fort Valley, GA, 31030', gpsAt: new Date(NOW - 4 * 60000).toISOString(), speedMph: 63, driver1: 'Romane Williams', hos: { status: 'driving', driveLeftMin: 125 }, ...(over.live || {}) } });
const eta = (etaMs, apptMs) => ({ stops: [{ label: 'XENIA, OH, 45385', etaMs, apptMs, apptFrom: 'truckmate-appt' }] });

test('snapshot: delayed / being verified / delivered, from live data only', () => {
  const late = loadSnapshot(item(), { eta: eta(NOW + 6 * 3600000, NOW + 4 * 3600000), now: NOW });
  assert.equal(late.status, 'Delayed'); assert.equal(hm(late.lateMin), '2h');
  const stale = loadSnapshot(item({ live: { gpsAt: new Date(NOW - 200 * 60000).toISOString() } }), { eta: eta(NOW + 3600000, null), now: NOW });
  assert.equal(stale.status, 'Being verified'); assert.equal(stale.verify, 'last GPS position is 3h 20m old');
  const noEta = loadSnapshot(item(), { eta: null, now: NOW });
  assert.equal(noEta.verify, 'no live ETA for this stop yet');
  const done = loadSnapshot(item({ bills: [{ billNumber: 'B1', billToName: 'X', endZoneDescription: 'XENIA, OH, 45385', pieces: 40, actualDelivery: '2026-10-09T10:15:00' }] }), { now: NOW });
  assert.equal(done.status, 'Delivered'); assert.equal(done.quantity, '40 pieces'); assert.equal(done.podVerified, false);
  assert.equal(etTime(done.deliveredAt), 'Fri, Oct 9, 10:15 AM ET', 'Ohio is Eastern');
});

test('email: subject format, action first, appointment vs ETA, customer vs internal, plain text, no POD claim', () => {
  const s1 = loadSnapshot(item(), { eta: eta(NOW + 6 * 3600000, NOW + 4 * 3600000), now: NOW });
  const s2 = loadSnapshot(item({ trip: { tripNumber: '624572' }, bills: [{ billNumber: 'B2', billToName: 'PASSION GROWERS', endZoneDescription: 'XENIA, OH', pieces: 12, actualDelivery: '2026-10-09T08:00:00' }] }), { now: NOW });
  const cust = renderUpdateEmail({ audience: 'customer', customer: 'Passion Growers', destination: 'Xenia, OH', snaps: [s2, s1], followUps: autoFollowUps([s1, s2]), now: NOW });
  assert.equal(cust.subject, 'Passion Growers | 1 delivered · 1 delayed | Fri, Oct 9, 2026');
  assert.ok(cust.text.indexOf('DELAYED') < cust.text.indexOf('DELIVERED'), 'loads needing action first');
  assert.match(cust.text, /Appointment: Fri, Oct 9, 4:00 PM ET/); assert.match(cust.text, /Estimated arrival: Fri, Oct 9, 6:00 PM ET · about 2h after the appointment/);
  assert.match(cust.text, /GPS: Updated 4m ago/);
  assert.doesNotMatch(cust.text, /Romane|Drive time|Duty/, 'no driver or hours for customers');
  assert.doesNotMatch(cust.text, /POD/, 'never claims a POD that is not on file');
  assert.match(cust.text, /DISPATCH FOLLOW-UP\n- Trip 624571 is running about 2h behind the appointment/);
  assert.match(cust.html, /max-width:600px/); assert.match(cust.html, /#FEF3C7/); assert.match(cust.html, /#DCFCE7/);
  const internal = renderUpdateEmail({ audience: 'internal', customer: 'Passion Growers', snaps: [s1], now: NOW });
  assert.match(internal.text, /Driver: Romane Williams/); assert.match(internal.text, /Drive time left: 2h 5m/);
});

test('SOP rows: trailer temperature, map link, miles; completed: clean bill / lumper / detention', () => {
  const live = { lat: 39.9, lng: -75.1, tempF: 34, setpointF: 34 };
  const s = loadSnapshot(item({ live }), { eta: { stops: [{ label: 'XENIA, OH, 45385', etaMs: NOW + 3600000, apptMs: NOW + 7200000, miles: 61.4 }] }, now: NOW, stage: 'Rolling' });
  const t = renderUpdateEmail({ snaps: [s], now: NOW, headline: "Rolling. We'll keep you posted." }).text;
  assert.match(t, /Trailer temperature: 34°F · set 34°F/); assert.match(t, /Miles to go: 61 mi/); assert.match(t, /maps\.google\.com\/\?q=39\.9,-75\.1/);
  const done = item({ bills: [{ billNumber: 'B1', billToName: 'X', endZoneDescription: 'XENIA, OH, 45385', pieces: 40, actualDelivery: '2026-10-09T10:15:00' }] });
  done._waits = { 'XENIA, OH, 45385': { arrivedAt: '2026-10-09T09:00:00Z', leftAt: '2026-10-09T13:20:00Z', minutes: 260 } };
  const d = loadSnapshot(done, { now: NOW, notes: ['empty, paid lumper $185 cash'] });
  const dt = renderUpdateEmail({ snaps: [d], now: NOW }).text;
  assert.match(dt, /Exceptions: None reported \(clean bill\)/); assert.match(dt, /Lumper: \$185/); assert.match(dt, /Detention: In Fri, Oct 9, 5:00 AM ET · Out Fri, Oct 9, 9:20 AM ET · 4h 20m/);
});

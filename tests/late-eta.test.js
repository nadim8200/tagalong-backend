import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateArrival, evaluateBoard } from '../watchtower.js';

const H = 3600000;
const NOW = Date.parse('2026-10-06T18:20:00Z');

test('solo: out of hours → 10h reset; 70-hour cycle nearly used → 34h restart', () => {
  // 550 mi = 10 h of driving; 0 drive left now → 10 h rest, 10 h drive + 30-min break
  const reset = (estimateArrival(550, { driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 3000, now: NOW }) - NOW) / H;
  assert.ok(reset > 20 && reset < 21, `reset ${reset}`);
  // 629 mi = 11.4 h: more than one 11-hour day → a second reset
  const two = (estimateArrival(629, { driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 3000, now: NOW }) - NOW) / H;
  assert.ok(two > 31 && two < 33, `two ${two}`);
  const restart = (estimateArrival(629, { driveLeftMin: 600, shiftLeftMin: 700, cycleLeftMin: 120, now: NOW }) - NOW) / H;
  assert.ok(restart > 45, `restart ${restart}`);                     // 2 h, then 34 h restart, then the rest
});

test('team: both clocks used — rolling ~nonstop when one is fresh, waits when both are out', () => {
  const fresh = (estimateArrival(730, { team: true, driveLeftMin: 520, shiftLeftMin: 600, partner: { driveLeftMin: 660, shiftLeftMin: 840 }, now: NOW }) - NOW) / H;
  assert.ok(fresh > 13 && fresh < 14.5, `fresh ${fresh}`);           // 13.3 h of driving, no reset
  const bothOut = (estimateArrival(200, { team: true, driveLeftMin: 0, shiftLeftMin: 0, partner: { driveLeftMin: 0, shiftLeftMin: 0 }, now: NOW }) - NOW) / H;
  assert.ok(bothOut > 13, `bothOut ${bothOut}`);                    // must rest before anyone drives
});

const geo = (zip) => ({ 60148: { lat: 41.88, lng: -88.0 }, 33178: { lat: 25.83, lng: -80.36 }, 37086: { lat: 36.0, lng: -86.58 }, 33018: { lat: 25.91, lng: -80.33 } }[zip] || null);
const ctx = (extra = {}) => ({ now: NOW, geo, unitState: () => ({}), ...extra });
const trip = (n, status, bill, live, { trip: tExtra = {}, ...extra } = {}) => ({ trip: { tripNumber: n, status, powerUnit: '1', ...tExtra }, freightBills: [bill], _samsara: { gpsAt: '2026-10-06T18:19:00Z', speedMph: 0, ...live }, ...extra });
const codes = (b, c) => evaluateBoard({ trips: [b] }, c || ctx()).filter((a) => /late-risk|appt-passed/.test(a.code));

test('truck at the consignee (ARRCONS): no late alert', () => {
  const b = trip('624303', 'ARRCONS', { billNumber: 'B180342', endZoneDescription: 'MIAMI, FL, 33178', pieces: 1, deliverBy: '2026-10-06T06:00:00', deliverByEnd: '2026-10-06T06:00:00' }, { lat: 25.8, lng: -80.31, hos: { driveLeftMin: 0, status: 'onDuty' } });
  assert.deepEqual(codes(b), []);
});

test('appointment already passed → one "passed, not delivered" alert, not "will miss by 19h"', () => {
  const b = trip('624313', 'DEPSHIP', { billNumber: 'H5038089', endZoneDescription: 'LA VERGNE, TN, 37086', pieces: 1, deliverBy: '2026-10-05T19:00:00', deliverByEnd: '2026-10-05T19:00:00' }, { lat: 36.07, lng: -87.39, hos: { driveLeftMin: 0, status: 'personalConveyance' } });
  const a = codes(b);
  assert.deepEqual(a.map((x) => x.code), ['appt-passed']);
  assert.match(a[0].title, /^Due time passed at LA VERGNE, TN — .* ago, not delivered/);
});

test('TruckMate due time alone is a warning ("may miss"), a confirmed appointment is critical', () => {
  const late = (src) => trip('624326', 'DEPSHIP', { billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148', pieces: 1, deliverBy: '2026-10-07T04:00:00', deliverByEnd: '2026-10-07T04:00:00', ...(src === 'appt' ? { deliveryApptReq: 'True' } : {}) }, { lat: 34.77, lng: -84.97, hos: { driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 3000, status: 'sleeperBed' } });
  const due = codes(late('due'));
  assert.equal(due[0].severity, 'warning'); assert.match(due[0].title, /^May miss LOMBARD, IL due time/);
  const appt = codes(late('appt'));
  assert.equal(appt[0].severity, 'critical'); assert.match(appt[0].title, /^Will miss LOMBARD, IL appointment/);
});

test('real road miles are used when known', () => {
  const b = trip('624304', 'DEPSHIP', { billNumber: 'B2', endZoneDescription: 'MIAMI, FL, 33178', pieces: 1, deliverBy: '2026-10-06T21:00:00', deliverByEnd: '2026-10-06T21:00:00', deliveryApptReq: 'True' }, { lat: 26.7, lng: -80.1, hos: { driveLeftMin: 600, shiftLeftMin: 700 } });
  const asked = [];
  const slow = ctx({ roadMiles: (a, g) => { asked.push(g); return 400; } });   // pretend a 400-mile detour
  const a = codes(b, slow);
  assert.ok(asked.length > 0);
  assert.match(a[0].detail, /^400 mi/);
});

import { boardEtas } from '../watchtower.js';
test('cards get the same stop ETAs the alerts use', () => {
  const b = { trips: [trip('624304', 'DEPSHIP', { billNumber: 'B2', endZoneDescription: 'MIAMI, FL, 33178', pieces: 1 }, { lat: 26.7, lng: -80.1, hos: { driveLeftMin: 600, shiftLeftMin: 700 } }, { trip: { driver2: 'X' } })] };
  const e = boardEtas(b, ctx())['624304'];
  assert.equal(e.team, true); assert.equal(e.stops[0].zip, '33178');
  assert.ok(e.stops[0].etaMs > NOW && e.stops[0].miles > 50);
});

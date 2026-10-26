import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateArrival, evaluateBoard } from '../watchtower.js';

const H = 3600000;
const NOW = Date.parse('2026-10-06T18:20:00Z');

test('solo: out of hours → 10h reset; 70-hour cycle nearly used → 34h restart', () => {
  // 600 mi = 10 h of driving at 60 mph; 0 drive left now → 10 h rest, 10 h drive + 30-min break
  const reset = (estimateArrival(600, { driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 3000, now: NOW }) - NOW) / H;
  assert.ok(reset > 20 && reset < 21, `reset ${reset}`);
  // 686 mi = 11.4 h: more than one 11-hour day → a second reset
  const two = (estimateArrival(686, { driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 3000, now: NOW }) - NOW) / H;
  assert.ok(two > 31 && two < 33, `two ${two}`);
  const restart = (estimateArrival(686, { driveLeftMin: 600, shiftLeftMin: 700, cycleLeftMin: 120, now: NOW }) - NOW) / H;
  assert.ok(restart > 45, `restart ${restart}`);                     // 2 h, then 34 h restart, then the rest
});

test('team: both clocks used — rolling ~nonstop when one is fresh, waits when both are out', () => {
  const fresh = (estimateArrival(796, { team: true, driveLeftMin: 520, shiftLeftMin: 600, partner: { driveLeftMin: 660, shiftLeftMin: 840 }, now: NOW }) - NOW) / H;
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
  const slow = ctx({ roadMiles: (a, g) => { asked.push(g); return 440; } });   // pretend a 440-mile detour
  const a = codes(b, slow);
  assert.ok(asked.length > 0);
  assert.match(a[0].detail, /^440 mi/);
});

import { boardEtas } from '../watchtower.js';
test('cards get the same stop ETAs the alerts use', () => {
  const b = { trips: [trip('624304', 'DEPSHIP', { billNumber: 'B2', endZoneDescription: 'MIAMI, FL, 33178', pieces: 1 }, { lat: 26.7, lng: -80.1, hos: { driveLeftMin: 600, shiftLeftMin: 700 } }, { trip: { driver2: 'X' } })] };
  const e = boardEtas(b, ctx())['624304'];
  assert.equal(e.team, true); assert.equal(e.stops[0].zip, '33178');
  assert.ok(e.stops[0].etaMs > NOW && e.stops[0].miles > 50);
});


test('unloading uses the solo driver\'s 14-hour shift; Samsara\'s break-due is used; teams swap (15 min)', async () => {
  const { planArrivals } = await import('../watchtower.js');
  // solo, fresh: 4 stops 100 mi apart with 3 h unloading each → the shift runs out before the 4th → 10 h rest
  const four = planArrivals([1, 2, 3, 4].map(() => ({ miles: 109, dwellMin: 180 })), { driveLeftMin: 660, shiftLeftMin: 840, now: NOW }).map((x) => (x - NOW) / H);
  assert.ok(four[2] < 12, `3rd stop ${four[2]}`); assert.ok(four[3] > 20, `4th stop after a rest: ${four[3]}`);
  // break due in 30 min → the 30-minute break comes after 30 min of driving, not after 8 h
  const soon = (planArrivals([{ miles: 120 }], { driveLeftMin: 600, shiftLeftMin: 700, breakInMin: 30, now: NOW })[0] - NOW) / H;
  assert.ok(soon > 2.4 && soon < 2.6, `break included: ${soon}`);
  const none = (planArrivals([{ miles: 120 }], { driveLeftMin: 600, shiftLeftMin: 700, now: NOW })[0] - NOW) / H;
  assert.ok(none < 2.1, `no break due: ${none}`);
  // team: 1100 mi (20 h) → one swap at ~11 h, 15 min added
  const team = (planArrivals([{ miles: 1200 }], { team: true, driveLeftMin: 660, shiftLeftMin: 840, partner: { driveLeftMin: 660, shiftLeftMin: 840 }, now: NOW })[0] - NOW) / H;
  assert.ok(team > 20.2 && team < 20.4, `team ${team}`);
  // parked 8 h already, out of hours → only 2 h of rest left before it rolls
  const rest = (planArrivals([{ miles: 60 }], { driveLeftMin: 0, shiftLeftMin: 0, restDoneMin: 480, now: NOW })[0] - NOW) / H;
  assert.ok(rest > 2.9 && rest < 3.1, `rest credit ${rest}`);
});

test('parked 38 mi out with a 6 AM appointment: ETA is the appointment, marked parked + waiting', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');                          // Sat 8 PM Eastern
  const it = { trip: { tripNumber: '9', status: 'DEPSHIP', powerUnit: '2213' },
    freightBills: [{ billNumber: 'B1', endZoneDescription: 'KINSTON, NC, 28501', pieces: 1, deliverBy: '2026-10-25T06:00:00', deliverByEnd: '2026-10-25T06:00:00', deliveryApptReq: 'True' }],
    _samsara: { gpsAt: '2026-10-24T23:59:00Z', speedMph: 0, lat: 35.7, lng: -77.6, hos: { driveLeftMin: 300, shiftLeftMin: 400 } } };
  const e = boardEtas({ trips: [it] }, { now, geo: () => ({ lat: 35.26, lng: -77.58 }), unitState: () => ({ stoppedSince: now - 90 * 60000 }) })['9'];
  assert.equal(e.stops[0].waitingForAppt, true);
  assert.equal(e.stops[0].parkedSinceMs, now - 90 * 60000);
  assert.equal(e.stops[0].etaMs, Date.parse('2026-10-25T10:00:00Z'));
});

test('team ETA: the driver at the wheel drives first; the co-driver\'s rest already taken counts (truck 2404, Oct 26)', async () => {
  const { planArrivals } = await import('../watchtower.js');
  const H = 3600000; const NOW = Date.parse('2026-10-26T20:11:00Z');
  // driver 1 (Justice) in the sleeper since 7 AM ET with 5 min left on his old clocks; driver 2 (Fidaleo) driving, 3h24 left
  const opts = { team: true, driveLeftMin: 5, shiftLeftMin: 5, cycleLeftMin: 917, status: 'sleeperBed', restSinceMs: Date.parse('2026-10-26T11:00:00Z'), partner: { status: 'driving', driveLeftMin: 204, shiftLeftMin: 314, cycleLeftMin: 1301 }, now: NOW };
  const [cranston] = planArrivals([{ miles: 452 }], opts).map((x) => (x - NOW) / H);
  // 452 mi at 60 mph = 7.5h of driving, one 15-min swap, no 10-hour wait
  assert.ok(cranston > 7.5 && cranston < 8.1, `Cranston in ${cranston.toFixed(2)}h`);
  // without knowing when his rest began, the old answer (wait for a whole 10h) — still what it does with no logs
  const [old] = planArrivals([{ miles: 452 }], { ...opts, restSinceMs: null }).map((x) => (x - NOW) / H);
  assert.ok(old > 14, `no rest info → ${old.toFixed(2)}h`);
  // solo driver out of hours, 9h into the sleeper → rolls in 1h
  const [solo] = planArrivals([{ miles: 60 }], { team: false, driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 900, status: 'sleeperBed', restSinceMs: NOW - 9 * H, now: NOW }).map((x) => (x - NOW) / H);
  assert.ok(solo > 1.9 && solo < 2.1, `solo ${solo.toFixed(2)}h`);
});

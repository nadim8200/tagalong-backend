import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetTime, clock, trackAnalysis, reportRow, buildReport, fromMiamiYard } from '../outbound.js';
import { evaluateBoard } from '../watchtower.js';

const YARD = { lat: 25.8026, lng: -80.3102 };   // 3315 NW 70th Ave
const at = (iso) => Date.parse(iso);
// a GPS breadcrumb every 2 minutes: [minutesAfterStart, lat, lng, place?]
const crumbs = (start, list) => list.map(([m, lat, lng, place, mph = 0]) => ({ t: new Date(at(start) + m * 60000).toISOString(), lat, lng, mph, place: place || null }));

test('handwritten dispatch times on the trip sheet', () => {
  assert.equal(clock(parseSheetTime('2026-10-06', '19:00')), '7:00 pm');
  assert.equal(clock(parseSheetTime('2026-10-06', '8:30')), '8:30 pm');                  // evening
  assert.equal(parseSheetTime('2026-10-06', '2:00') > parseSheetTime('2026-10-06', '23:00'), true);   // after midnight
  assert.equal(parseSheetTime('2026-10-06', null), null);
});

test('GPS: departure from the yard, an unscheduled stop in Florida, then out of Florida', () => {
  const pts = crumbs('2026-10-07T00:00:00Z', [
    [0, 25.8026, -80.3102], [10, 25.8030, -80.3110], [18, 25.8062, -80.3180],           // in the yard
    [20, 25.85, -80.30, null, 55], [30, 26.10, -80.20, null, 60],                                   // left ~8:20 pm
    [60, 26.70, -80.10, 'Lake Worth, FL'], [70, 26.701, -80.101, 'Lake Worth, FL'], [95, 26.70, -80.10, 'Lake Worth, FL'],   // 35+ min stop
    [100, 27.0, -80.2, null, 62], [400, 30.9, -81.6, 'Kingsland, GA', 60],                    // into Georgia
  ]);
  const a = trackAnalysis(pts, { yards: [YARD, { lat: 25.8062, lng: -80.3180 }] });
  assert.equal(clock(a.departedMs), '8:20 pm');
  assert.equal(a.stops.length, 1); assert.ok(a.stops[0].minutes >= 35); assert.match(a.stops[0].place, /Lake Worth/);
  assert.ok(a.leftFloridaMs);
  // the same stop is fine when it's a Florida delivery on the trip sheet
  assert.equal(trackAnalysis(pts, { yards: [YARD, { lat: 25.8062, lng: -80.3180 }], stopCities: ['LAKE WORTH'] }).stops.length, 0);
});

test('report rows: yellow when dispatch → departure is over 30 min; NO GPS without GPS', () => {
  const it = (n, disp) => ({ trip: { tripNumber: n, powerUnit: '2606', trailer: '2029', origZoneDesc: 'MIAMI TERMINAL' },
    _manifest: { dateLoaded: '2026-10-06', dispatchTime: disp, pickupAt: '2026-10-06T20:30', truck: '2606', trailer: '2029', drivers: [{ name: 'Patrick Forbes', id: '1776' }, { name: 'Wilmar Lozano', id: '7344' }],
      stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL' }, { action: 'DELIVER', city: 'KINSTON', state: 'NC' }, { action: 'DELIVER', city: 'WALTHAM', state: 'MA' }] },
    _samsara: { location: 'I 95, Robeson County, NC, 28383' } });
  assert.equal(fromMiamiYard(it('1', '19:00')), true);
  const slow = reportRow(it('624481', '19:00'), { departedMs: at('2026-10-07T00:18:00Z'), stops: [] });   // 8:18 pm
  assert.equal(slow.dispatch, '7:00 pm'); assert.equal(slow.departure, '8:18 pm'); assert.equal(slow.slow, true);
  assert.equal(slow.puAppt, '8:30 pm'); assert.equal(slow.destination, 'WALTHAM MA'); assert.equal(slow.location, 'Robeson County, NC');
  assert.equal(slow.drivers, 'PATRICK FORBES (1776) WILMAR LOZANO (7344)');
  const quick = reportRow(it('624482', '20:00'), { departedMs: at('2026-10-07T00:18:00Z'), stops: [] });
  assert.equal(quick.slow, false);
  assert.equal(reportRow(it('624483', '20:00'), null).departure, 'NO GPS');
  assert.equal(reportRow(it('624485', '20:00'), { departedMs: null, seenInYard: false, inYardNow: false, points: 40, stops: [] }).departure, 'NOT SEEN IN YARD');
  const parked = reportRow(it('624484', '20:00'), { departedMs: null, inYardNow: true, seenInYard: true, points: 30, stops: [] });
  const rep = buildReport([slow, quick, parked], '2026-10-06');
  assert.equal(rep.subject, 'OUTBOUND 3 TRIP SHEETS - TUE 10/06/26');
  assert.match(rep.html, /Tuesday Trip sheets/); assert.match(rep.html, /All loads left the yard except truck 2606/);
  assert.match(rep.html, /background:#ffff66/); assert.match(rep.html, /FLOWERS \(FLORIDA\)/);
});

test('live alert: stopped 20+ min in Florida after leaving the yard, not a trip stop — even in the sleeper', () => {
  const now = at('2026-10-07T02:00:00Z');
  const item = { trip: { tripNumber: '624481', status: 'DEPSHIP', powerUnit: '2606', origZoneDesc: 'MIAMI TERMINAL' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'WALTHAM, MA, 02453' }],
    _samsara: { lat: 26.70, lng: -80.10, gpsAt: '2026-10-07T01:59:00Z', speedMph: 0, location: 'Lake Worth, FL', hos: { status: 'sleeperBerth', driveLeftMin: 600 } } };
  const run = (mins, live = {}) => evaluateBoard({ trips: [{ ...item, _samsara: { ...item._samsara, ...live } }] }, { now, geo: () => null, unitState: () => ({ stoppedSince: now - mins * 60000 }) });
  const a = run(25).find((x) => x.code === 'unscheduled-stop');
  assert.match(a.title, /Unscheduled stop leaving Florida — 25m/); assert.equal(a.severity, 'warning');
  assert.equal(run(65).find((x) => x.code === 'unscheduled-stop').severity, 'critical');
  assert.equal(run(10).find((x) => x.code === 'unscheduled-stop'), undefined);
  assert.equal(run(25, { lat: 25.8027, lng: -80.3103 }).find((x) => x.code === 'unscheduled-stop'), undefined);   // still in the yard
  assert.equal(run(65).filter((x) => x.code === 'stopped').length, 0);                                         // no double alert
});

test('no Florida-stop alert for loads that are not Miami outbound (Ocala → Mebane, Pierson → Bartow)', () => {
  const now = at('2026-10-07T02:00:00Z');
  const live = { lat: 28.06, lng: -82.30, gpsAt: '2026-10-07T01:59:00Z', speedMph: 0, location: 'Thonotosassa, FL', hos: { status: 'offDuty', driveLeftMin: 600 } };
  const trip = (n, orig, dest) => ({ trip: { tripNumber: n, status: 'DEPSHIP', powerUnit: n, origZoneDesc: orig }, freightBills: [{ billNumber: `B${n}`, endZoneDescription: dest }], _samsara: live });
  const alerts = evaluateBoard({ trips: [trip('624449', 'OCALA, FL, 34470', 'MEBANE, NC, 27302'), trip('624455', 'PIERSON, FL, 32180', 'BARTOW, FL, 33830')] }, { now, geo: () => null, unitState: () => ({ stoppedSince: now - 325 * 60000 }) });
  assert.equal(alerts.filter((a) => a.code === 'unscheduled-stop').length, 0);
});

test('a truck on several unclosed loads gets its truck alerts once — on its current load', () => {
  const now = at('2026-10-07T02:00:00Z');
  const live = { lat: 35.8, lng: -77.0, gpsAt: '2026-10-07T01:59:00Z', speedMph: 12, location: 'Robersonville, NC', hos: { status: 'driving', driveLeftMin: 0, shiftLeftMin: 0 } };
  const trip = (n, status, dest) => ({ trip: { tripNumber: n, status, powerUnit: '930' }, freightBills: [{ billNumber: `B${n}`, endZoneDescription: dest }], _samsara: live });
  const alerts = evaluateBoard({ trips: [trip('624128', 'DEPSHIP', 'MIAMI, FL, 33122'), trip('624195', 'DEPSHIP', 'HIALEAH, FL, 33018'), trip('624500', 'DISP', 'MIAMI, FL, 33122')] }, { now, geo: () => null, unitState: () => ({}) });
  const hos = alerts.filter((a) => a.code === 'hos-low');
  assert.equal(hos.length, 1);
  assert.equal(hos[0].trip, '624195');                                           // newest rolling load
});

test('truck 2618 on 10/07: the yard at 3315 NW 70th Ave and the 74th Ave lot are the yard — departure measured, no fake stops', () => {
  const pts = crumbs('2026-10-07T23:20:00Z', [
    [0, 25.8062, -80.3180, '3400 Northwest 74th Avenue, Miami, FL'], [16, 25.8062, -80.3181, '3400 Northwest 74th Avenue, Miami, FL'],
    [20, 25.8026, -80.3102, '3315 Northwest 70th Avenue, Miami, FL'], [200, 25.8027, -80.3103, '3315 Northwest 70th Avenue, Miami, FL'],
    [204, 25.82, -80.29, null, 45], [230, 26.3, -80.15, null, 64],
  ]);
  const a = trackAnalysis(pts);
  assert.equal(a.seenInYard, true); assert.ok(a.departedMs);
  assert.deepEqual(a.stops, [], 'yard time is not an unscheduled stop');
});

import { MIAMI_YARDS, MIAMI_TERMINAL } from '../watchtower.js';
test('the Miami yard is 2355 NW 70th Ave, plus the 3315 NW 70th Ave lot and the cooler at 3400 NW 74th Ave', () => {
  assert.deepEqual(MIAMI_TERMINAL, { lat: 25.7947, lng: -80.3099 });
  assert.equal(MIAMI_YARDS.length, 3);
  // a truck picked up at the cooler and leaving from there: departure measured, cooler time is yard time
  const pts = crumbs('2026-10-08T23:00:00Z', [[0, 25.7947, -80.3099], [30, 25.8062, -80.3180, '3400 Northwest 74th Avenue (cooler)'], [90, 25.8062, -80.3181], [95, 25.84, -80.31, null, 40], [120, 26.2, -80.17, null, 63]]);
  const a = trackAnalysis(pts);
  assert.equal(clock(a.departedMs), clock(Date.parse('2026-10-09T00:35:00Z'))); assert.deepEqual(a.stops, []);
});

test('truck 2618 on 10/07: out to Doral and back before the real departure — the departure is the last time it left the yard', () => {
  const pts = crumbs('2026-10-07T22:00:00Z', [
    [0, 25.8026, -80.3102], [35, 25.8100, -80.3500, null, 30],                         // 6:35 pm out
    [40, 25.8460, -80.3400, '2019 Northwest 89th Place, Doral, FL'], [66, 25.8461, -80.3401, 'Doral'],
    [83, 25.8062, -80.3180, 'cooler'], [99, 25.8062, -80.3181, 'cooler'],                // 7:23–7:39 pm cooler
    [103, 25.8026, -80.3102, 'lot'], [306, 25.8027, -80.3103, 'lot'],                    // 7:43–11:06 pm lot
    [310, 25.83, -80.29, null, 45], [340, 26.3, -80.15, null, 64],                      // leaves for good
  ]);
  const a = trackAnalysis(pts);
  assert.equal(new Date(a.departedMs).toISOString(), '2026-10-08T03:10:00.000Z');       // 11:10 pm Eastern
  assert.deepEqual(a.stops, [], 'the Doral run before departure is not a stop on the trip');
});

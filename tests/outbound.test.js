import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetTime, clock, trackAnalysis, reportRow, buildReport, fromMiamiYard } from '../outbound.js';
import { evaluateBoard } from '../watchtower.js';

const YARD = { lat: 25.795, lng: -80.33 };
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
    [0, 25.795, -80.33], [10, 25.796, -80.331], [18, 25.80, -80.33],           // in the yard
    [20, 25.85, -80.30, null, 55], [30, 26.10, -80.20, null, 60],                                   // left ~8:20 pm
    [60, 26.70, -80.10, 'Lake Worth, FL'], [70, 26.701, -80.101, 'Lake Worth, FL'], [95, 26.70, -80.10, 'Lake Worth, FL'],   // 35+ min stop
    [100, 27.0, -80.2, null, 62], [400, 30.9, -81.6, 'Kingsland, GA', 60],                    // into Georgia
  ]);
  const a = trackAnalysis(pts, { yard: YARD });
  assert.equal(clock(a.departedMs), '8:20 pm');
  assert.equal(a.stops.length, 1); assert.ok(a.stops[0].minutes >= 35); assert.match(a.stops[0].place, /Lake Worth/);
  assert.ok(a.leftFloridaMs);
  // the same stop is fine when it's a Florida delivery on the trip sheet
  assert.equal(trackAnalysis(pts, { yard: YARD, stopCities: ['LAKE WORTH'] }).stops.length, 0);
});

test('report rows: yellow when dispatch → departure is over 30 min; NOT TRACKING without GPS', () => {
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
  assert.equal(reportRow(it('624483', '20:00'), null).departure, 'NOT TRACKING');
  const parked = reportRow(it('624484', '20:00'), { departedMs: null, inYardNow: true, stops: [] });
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
  assert.equal(run(25, { lat: 25.796, lng: -80.331 }).find((x) => x.code === 'unscheduled-stop'), undefined);   // still in the yard
  assert.equal(run(65).filter((x) => x.code === 'stopped').length, 0);                                         // no double alert
});

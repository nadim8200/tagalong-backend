import test from 'node:test';
import assert from 'node:assert/strict';
import { isFlowerLoad, flowerRow, buildFlowerReport } from '../flowerreport.js';

const NOW = Date.parse('2026-10-07T11:00:00Z');   // Wed 7:00 AM Eastern
const load = (n, extra = {}) => ({ trip: { tripNumber: n, status: 'DEPSHIP', powerUnit: '2606', trailer: '2029', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'WALTHAM, MA, 02453' },
  freightBills: [{ billNumber: 'M5038379', endZoneDescription: 'KINSTON, NC, 28501' }, { billNumber: 'M5038440', endZoneDescription: 'WALTHAM, MA, 02453' }],
  _manifest: { stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL', city: 'Miami', state: 'FL' }, { action: 'DELIVER', customer: 'ALCOCK WHOLESALE FLOWERS', city: 'KINSTON', state: 'NC', tmPlace: 'KINSTON, NC' }, { action: 'DELIVER', customer: 'BOKHARY FARMS LLC *', city: 'WALTHAM', state: 'MA' }] },
  _samsara: { location: 'I 95, Robeson County, NC, 28383', gpsAt: '2026-10-07T10:55:00Z', speedMph: 66, driver1: 'Patrick Forbes', driver2: 'Wilmar Lozano' }, ...extra });
const eta = { stops: [{ label: 'KINSTON, NC, 28501', etaMs: Date.parse('2026-10-07T14:00:00Z'), apptMs: Date.parse('2026-10-07T13:00:00Z') }, { label: 'WALTHAM, MA, 02453', etaMs: Date.parse('2026-10-08T12:00:00Z') }], passed: [] };

test('flower loads vs broker loads', () => {
  assert.equal(isFlowerLoad(load('1')), true);
  assert.equal(isFlowerLoad({ trip: { tripNumber: '2', origZoneDesc: 'WEST PALM BEACH, FL, 33404' }, freightBills: [{ billNumber: 'B180400' }] }), false);
  assert.equal(isFlowerLoad({ trip: { tripNumber: '3', origZoneDesc: 'VENTURA TERMINAL' }, freightBills: [] }), true);
});

test('each load: where the truck is, next stop + ETA, last stop, late and why', () => {
  const r = flowerRow(load('624481'), eta, [{ code: 'late-risk', severity: 'critical', title: 'Will miss ALCOCK (KINSTON, NC) appointment by ~1h' }], NOW);
  assert.equal(r.state, 'LATE'); assert.match(r.why, /Will miss ALCOCK/);
  assert.equal(r.from, 'Miami, Florida'); assert.equal(r.drivers, 'Patrick Forbes & Wilmar Lozano');
  assert.match(r.now, /^Robeson County, NC \(5m ago\) · 66 mph$/);
  assert.equal(r.next, 'ALCOCK WHOLESALE FLOWERS, KINSTON, NC'); assert.equal(r.nextEta, 'Wed, Oct 7, 10:00 AM Eastern');
  assert.equal(r.final, 'WALTHAM, MA'); assert.equal(r.progress, '0 of 2 stops done');
  assert.equal(flowerRow(load('2'), eta, [], NOW).state, 'ON TIME');
  assert.equal(flowerRow(load('3', { _breakdown: { on: true } }), eta, [], NOW).state, 'BREAKDOWN');
  assert.equal(flowerRow(load('4', { _samsara: {} }), null, [], NOW).state, 'NO GPS');
});

test('the email: late first, counts in the subject, estimate disclaimer', () => {
  const rows = [flowerRow(load('624480'), eta, [], NOW), flowerRow(load('624481'), eta, [{ code: 'late-risk', severity: 'critical', title: 'Will miss' }], NOW), flowerRow(load('624482'), eta, [{ code: 'late-risk', severity: 'warning', title: 'May miss' }], NOW)];
  const rep = buildFlowerReport(rows, NOW);
  assert.equal(rep.subject, 'Flower loads update — Wed, 10/07, 7:00 AM · 1 late, 1 at risk, 1 on time');
  assert.deepEqual(rep.rows.map((r) => r.trip), ['624481', '624482', '624480']);
  assert.match(rep.html, /in each delivery's local time/);
});

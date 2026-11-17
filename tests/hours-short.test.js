import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBoard } from '../watchtower.js';

// Truck 2403 (Nov 17): parked in Mettawa, IL with 1 min of drive left, Sendik's in Milwaukee still to deliver, then Gustavo's
// Arrive Logistics pickup. SYNTHETIC numbers in that shape.
const NOW = Date.parse('2026-11-17T15:40:00Z');
const geo = (zip) => ({ 53223: { lat: 43.17, lng: -87.98 }, 60062: { lat: 42.13, lng: -87.83 }, 30344: { lat: 33.68, lng: -84.45 } }[zip] || null);
const ctx = (extra = {}) => ({ now: NOW, geo, unitState: () => ({}), ...extra });
const bills = (delivered = true) => [
  { billNumber: 'G5062999', endZoneDescription: 'NORTHBROOK, IL, 60062', billToName: 'CLESEN WHOLESALE', pieces: 343, temperature: 35, actualDelivery: delivered ? '2026-11-17T09:51:14' : null },
  { billNumber: 'G5062971', endZoneDescription: 'MILWAUKEE, WI, 53223', billToName: "SENDIK'S FOOD MARKETS-WI", pieces: 72, temperature: 35 },
];
const load = ({ hos, hos2 = null, speedMph = 0, driver2 = null, extra = {}, delivered = true } = {}) => ({
  trip: { tripNumber: '627206', status: 'DEPCONS', powerUnit: '2403', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'MILWAUKEE, WI, 53223', ...(driver2 ? { driver2 } : {}) },
  freightBills: bills(delivered),
  _samsara: { gpsAt: '2026-11-17T15:39:00Z', speedMph, lat: 42.28, lng: -87.88, driver1: 'Ilyas Qureshi', hos, ...(hos2 ? { hos2 } : {}) },
  ...extra,
});
const short = (it, c) => evaluateBoard({ trips: [it] }, c || ctx()).filter((a) => a.code === 'hours-short');

test('out of hours with the last delivery still to go: says which stop, the restart, the new ETA — and the next load it pushes', () => {
  const nx = { trip: '627311', status: 'ASSGN', from: 'ELK GROVE VILLAGE, IL', to: 'FONTANA, CA' };
  const [a] = short(load({ hos: { driveLeftMin: 1, shiftLeftMin: 19, status: 'offDuty' }, extra: { _tmNext: [nx] } }));
  assert.ok(a, 'raised');
  assert.equal(a.severity, 'critical');                                  // flowers, and a next load waiting
  assert.match(a.title, /^Out of hours before the load is done — 1 stop left \(flowers\)/);
  assert.match(a.detail, /Ilyas Qureshi has 1m of drive time, 19m of shift/);
  assert.match(a.detail, /Won't make it on this clock: MILWAUKEE, WI\./);   // (with a trip sheet: "SENDIK'S … (MILWAUKEE, WI)")
  assert.match(a.detail, /Earliest back on the road: ~/);
  assert.match(a.detail, /New ETA for the last delivery:/);
  assert.match(a.detail, /Next load: TruckMate trip 627311 \(ELK GROVE VILLAGE, IL → FONTANA, CA\) — its pickup can't start before ~/);
  assert.equal(a.unit, '2403');
});

test('a broker load Gus sent (not in TruckMate yet) is named as the next load', () => {
  const nb = { rc: { broker: 'Arrive Logistics', loadNumber: '10041856', pickup: { city: 'Elk Grove Village, IL', date: '11/17', time: '14:00' } } };
  const [a] = short(load({ hos: { driveLeftMin: 1, shiftLeftMin: 19, status: 'offDuty' }, extra: { _nextLoad: [nb] } }));
  assert.match(a.detail, /Next load: Arrive Logistics 10041856 pickup Elk Grove Village, IL 11\/17 14:00 \(not in TruckMate yet\)/);
});

test('stays open while the truck sits on its break (hos-low only fires while moving)', () => {
  const parked = evaluateBoard({ trips: [load({ hos: { driveLeftMin: 0, shiftLeftMin: 0, status: 'sleeperBerth' } })] }, ctx({ unitState: () => ({ stoppedSince: NOW - 3 * 3600000 }) }));
  assert.equal(parked.filter((a) => a.code === 'hours-short').length, 1);
  assert.equal(parked.filter((a) => a.code === 'hos-low').length, 0);
});

test('no alert when the clock covers what is left, on a long haul with resets ahead, or at the last stop', () => {
  assert.equal(short(load({ hos: { driveLeftMin: 300, shiftLeftMin: 400, status: 'driving' }, speedMph: 55 })).length, 0, 'plenty of hours');
  // Atlanta → Northbrook + Milwaukee ≈ 15 h of driving: needs a reset no matter what — normal, not news
  const far = load({ hos: { driveLeftMin: 60, shiftLeftMin: 90, status: 'driving' }, speedMph: 55, delivered: false });
  far._samsara.lat = 33.75; far._samsara.lng = -84.39;
  assert.equal(short(far).length, 0, 'long haul');
  const there = load({ hos: { driveLeftMin: 0, shiftLeftMin: 0, status: 'onDuty' } });
  there._samsara.lat = 43.17; there._samsara.lng = -87.98;
  assert.equal(short(there).length, 0, 'at the last stop');
});

test('a team counts both drivers: one fresh driver covers it', () => {
  const t = load({ hos: { driveLeftMin: 1, shiftLeftMin: 19, status: 'offDuty' }, hos2: { driveLeftMin: 600, shiftLeftMin: 700, status: 'onDuty' }, driver2: '102' });
  assert.equal(short(t).length, 0);
});

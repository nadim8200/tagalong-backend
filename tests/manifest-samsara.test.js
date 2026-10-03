import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyStops, sheetChanges, compareWithTruckMate } from '../manifest.js';
import { indexSnapshot, correlate } from '../samsara.js';

test('repeated city visits keep distinct stop keys; sub-stops keep order', () => {
  const ks = keyStops([
    { stopNumber: 3, customer: 'Ashland Addison', city: 'Chicago', state: 'IL' },
    { stopNumber: 4, customer: 'Chicago Flower Exchange', city: 'Chicago', state: 'IL' },
    { stopNumber: 8, customer: 'Carbone RJ Co', city: 'Chelsea', state: 'MA' },
    { stopNumber: 8, subStop: true, customer: 'Direct Flowers of Boston', city: 'Chelsea', state: 'MA' },
  ]).map((s) => s.key);
  assert.equal(new Set(ks).size, 4);
  assert.ok(ks[2].startsWith('8.0|') && ks[3].startsWith('8.1|'));
});

test('re-upload reports removed/added stops without moving them', () => {
  const ch = sheetChanges({ stops: [{ stopNumber: 2, customer: 'A', city: 'X', state: 'GA' }] }, { stops: [{ stopNumber: 2, customer: 'B', city: 'X', state: 'GA' }] });
  assert.equal(ch.added.length, 1); assert.equal(ch.removed.length, 1);
});

test('sheet vs TruckMate: multi-zip city totals and extra stop', () => {
  const d = compareWithTruckMate(
    { tripNumber: '1', truck: '2605', trailer: '7145', stops: [{ action: 'DELIVER', city: 'Amarillo', state: 'TX', pieces: 331 }] },
    { trip: { powerUnit: '2605', trailer: '7145' }, freightBills: [{ endZoneDescription: 'AMARILLO, TX, 79106', pieces: 148 }, { endZoneDescription: 'AMARILLO, TX, 79110', pieces: 183 }, { endZoneDescription: 'ROGERS, AR, 72756', pieces: 61 }] },
  );
  assert.deepEqual(d.map((x) => x.kind), ['not-on-sheet']);
});

test('Samsara correlate: per-driver clocks with source time and ELD vehicle; zero stays zero; missing stays null', () => {
  const snap = {
    fetchedAt: '2026-10-03T03:00:00.000Z',
    drivers: [{ id: 'd1', name: 'Driver One', username: '6362' }, { id: 'd2', name: 'Driver Two', username: '9481' }],
    vehicles: [], trailers: [], reefer: [], reeferRead: {},
    stats: [{ id: 'v1', name: '2605', gps: { latitude: 25.9, longitude: -80.2, speedMilesPerHour: 0, time: '2026-10-03T02:59:00Z' }, engineState: { value: 'Off', time: 't' }, fuelPercent: { value: 0, time: 't' }, defLevelMilliPercent: { value: 18000, time: 't' }, obdOdometerMeters: { value: 160934.4 } }],
    hos: [
      { driver: { id: 'd1', name: 'Driver One' }, currentVehicle: { name: '2605' }, currentDutyStatus: { hosStatusType: 'driving' }, clocks: { drive: { driveRemainingDurationMs: 0 }, shift: { shiftRemainingDurationMs: 3600000 } } },
      { driver: { id: 'd2', name: 'Driver Two' }, currentDutyStatus: { hosStatusType: 'sleeperBerth' }, clocks: { drive: {}, shift: {} } },
    ],
  };
  const live = correlate({ trip: { powerUnit: '2605', driver: '6362', driver2: '9481' } }, indexSnapshot(snap));
  assert.equal(live.hos.driveLeftMin, 0);
  assert.equal(live.hos.shiftLeftMin, 60);
  assert.equal(live.hos.vehicle, '2605');
  assert.equal(live.hos.at, '2026-10-03T03:00:00.000Z');
  assert.equal(live.hos2.driveLeftMin, null);
  assert.equal(live.hos2.status, 'sleeperBerth');
  assert.equal(live.fuelPct, 0);
  assert.equal(live.defPct, 18);
  assert.equal(live.odometerMi, 100);
  assert.equal(live.engineLoadPct, null);
  assert.equal(live.sourceAt, '2026-10-03T03:00:00.000Z');
});

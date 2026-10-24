import test from 'node:test';
import assert from 'node:assert/strict';
import { initMiles, openStops, resolvePoint } from '../miles.js';

const PLACES = { 'DERRY, NH 03038': { lat: 42.88, lng: -71.33 }, 'BOSTON, MA 02118': { lat: 42.34, lng: -71.07 }, HARTFORD: { lat: 41.76, lng: -72.68 } };
const geocode = async (q) => PLACES[String(q).toUpperCase()] || null;
const board = [{
  trip: { tripNumber: 625717, powerUnit: '2403', driver2: '', freightBills: [
    { billToName: 'Direct Flowers of Boston', endZoneDescription: 'BOSTON, MA 02118', pieces: 37 },
    { billToName: 'Carbone Derry', endZoneDescription: 'DERRY, NH 03038', pieces: 12 },
    { billToName: 'Delivered Co', endZoneDescription: 'HARTFORD', pieces: 5, actualDelivery: '2026-10-22T10:00' },
  ] },
  _samsara: { lat: 40.71, lng: -74.0, location: 'New York, NY', gpsAt: '2026-10-23T20:00:00Z', hos: { driveLeftMin: 600, shiftLeftMin: 700 } },
  _manifest: { stops: [{ action: 'DELIVER', city: 'BOSTON', stopNumber: 1 }, { action: 'DELIVER', city: 'DERRY', stopNumber: 2 }] },
}];

test('openStops: undelivered stops in trip-sheet order', () => {
  const s = openStops(board[0]);
  assert.deepEqual(s.map((x) => x.customers[0]), ['Direct Flowers of Boston', 'Carbone Derry']);
  assert.equal(s[0].boxes, 37);
});

test('openStops: a misspelled sheet city still orders by the matched TruckMate place (n)', () => {
  const it = { trip: { freightBills: [{ billToName: 'B', endZoneDescription: 'CLIFTON, NJ, 07011', pieces: 1 }, { billToName: 'A', endZoneDescription: 'PISCATAWAY, NJ, 08854', pieces: 1 }] },
    _manifest: { stops: [{ n: 2, action: 'DELIVER', city: 'PISTACAWAY', tmPlace: 'PISCATAWAY, NJ' }, { n: 3, action: 'DELIVER', city: 'CLIFTON', tmPlace: 'CLIFTON, NJ' }] } };
  assert.deepEqual(openStops(it).map((x) => x.customers[0]), ['A', 'B']);
});

test('resolvePoint: hub, truck GPS, customer on a load, missing truck', async () => {
  assert.match((await resolvePoint('Miami', { board, geocode })).label, /Miami hub/);
  assert.match((await resolvePoint('our Ventura hub', { board, geocode })).label, /Ventura/);
  const t = await resolvePoint('2403', { board, geocode });
  assert.equal(t.truck, '2403'); assert.equal(t.lat, 40.71);
  assert.match((await resolvePoint('carbone derry', { board, geocode })).label, /Carbone Derry/);
  assert.ok((await resolvePoint('9999', { board, geocode })).missing);
});

test('ask: Google driving miles when the key works; estimate (about) without one', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ routes: [{ distanceMeters: 1609340, duration: '36000s' }] }) });
  const m = initMiles({ db: null, env: { GOOGLE_MAPS_KEY: 'k' }, fetchFn, geocoder: geocode, now: () => Date.parse('2026-10-23T20:00:00Z') });
  const r = await m.ask({ from: '2403', to: 'Carbone Derry' }, board);
  assert.equal(r.found, true); assert.equal(r.miles, 1000); assert.equal(r.driving_miles, true);
  assert.match(r.drive_time, /10h 0m/); assert.ok(r.truck_eta_with_hours_of_service);
  const est = initMiles({ db: null, env: {}, fetchFn: async () => { throw new Error('no'); }, geocoder: geocode });
  const e = await est.ask({ from: 'Miami', to: '2403' }, board);
  assert.equal(e.driving_miles, false); assert.ok(e.miles > 1000);
});

test('ask: a truck alone → miles to each stop left, leg by leg', async () => {
  let n = 0;
  const fetchFn = async () => { n += 1; return { ok: true, json: async () => ({ routes: [{ distanceMeters: 1609340 * (n === 1 ? 0.2 : 0.05), duration: '3600s' }] }) }; };
  const m = initMiles({ db: null, env: { GOOGLE_MAPS_KEY: 'k' }, fetchFn, geocoder: geocode });
  const r = await m.ask({ truck: '2403' }, board);
  assert.equal(r.trip, '625717');
  assert.deepEqual(r.stops.map((s) => s.miles_from_truck), [200, 250]);
  assert.equal(r.total_miles, 250);
});

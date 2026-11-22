import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingNoTrip, fleetFromIndex } from '../watchtower.js';

const NOW = Date.parse('2026-11-22T14:30:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const truck = (unit, lat, lng, mph, extra = {}) => ({ unit, lat, lng, speedMph: mph, at: at(1), location: 'somewhere', ...extra });
const board = { trips: [{ trip: { tripNumber: '627656', powerUnit: '4504', status: 'DEPSHIP' } }, { trip: { tripNumber: '627000', powerUnit: '2210', status: 'DELVD' } }] };

test('a truck rolling on the road with no open trip: an alert after 10 minutes, with the last trip it was on (Nov 22)', () => {
  const fleet = [
    truck('4504', 31.57, -81.43, 74),                 // on trip 627656: fine
    truck('2210', 35.2, -90.9, 65, { driver: 'Jamar Gloster' }),   // Arkansas, its only trip is delivered → no open trip
    truck('2216', 25.9, -80.4, 60),                   // Miami area
    truck('2617', 28.2, -81.9, 70),                   // Central Florida
    truck('3519', 34.95, -89.85, 55),                 // at the Memphis yard (Olive Branch)
    truck('2609', 34.3, -119.2, 50),                  // Ventura
    truck('2012', 41.9, -71.5, 5),                    // Rhode Island, parked
    truck('807', 40.1, -75.2, 62, { at: at(40) }),    // old GPS
  ];
  let r = rollingNoTrip(fleet, board, { now: NOW, lastTrips: { 2210: { trip: '627000', lane: 'MIAMI TERMINAL → LITTLE ROCK, AR' } } });
  assert.deepEqual(r.alerts, [], 'just seen: wait to be sure');
  assert.deepEqual(Object.keys(r.seen), ['2210']);
  r = rollingNoTrip(fleet, board, { now: NOW + 11 * 60000, seen: r.seen, lastTrips: { 2210: { trip: '627000', lane: 'MIAMI TERMINAL → LITTLE ROCK, AR' } } });
  assert.equal(r.alerts.length, 1);
  const a = r.alerts[0];
  assert.deepEqual([a.id, a.code, a.severity, a.unit], ['no-trip:2210', 'no-trip-rolling', 'critical', '2210']);
  assert.match(a.title, /^Truck 2210 rolling with no trip — somewhere \(65 mph\)$/);
  assert.match(a.detail, /Jamar Gloster driving/); assert.match(a.detail, /Last trip on the board: 627000 \(MIAMI TERMINAL → LITTLE ROCK, AR\)/); assert.match(a.detail, /nearest hub \(Memphis \(Olive Branch\)\)/);
  r = rollingNoTrip([truck('2210', 35.2, -90.9, 0)], board, { now: NOW + 12 * 60000, seen: r.seen });
  assert.deepEqual([r.alerts.length, Object.keys(r.seen).length], [0, 0], 'stopped: clears');
});

test('the fleet from the Samsara index: one row per truck with who is driving it', () => {
  const idx = { statsByUnit: { 4504: { name: '4504', gps: { latitude: 31.5, longitude: -81.4, speedMilesPerHour: 74, time: at(0), reverseGeo: { formattedLocation: 'I 95, South Newport, GA' } } } },
    hosById: { 1: { driverName: 'Ferney Urrego', status: 'driving', vehicle: '4504' }, 2: { driverName: 'Wilber Echeverri', status: 'sleeperBed', vehicle: '4504' } } };
  assert.deepEqual(fleetFromIndex(idx), [{ unit: '4504', lat: 31.5, lng: -81.4, speedMph: 74, at: at(0), location: 'I 95, South Newport, GA', driver: 'Ferney Urrego' }]);
  assert.deepEqual(fleetFromIndex(null), []);
});

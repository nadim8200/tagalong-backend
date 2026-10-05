import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFleet } from '../fleetmap.js';

const now = Date.parse('2026-10-05T15:00:00Z');
const ago = (m) => new Date(now - m * 60000).toISOString();

test('fleet map: trucks from Samsara, fresher FMC00A wins, customer TagAlong cars never shown, OC phone included', () => {
  const idx = {
    statsByUnit: {
      2210: { id: 1, name: '2210', gps: { latitude: 36.9, longitude: -120.0, speedMilesPerHour: 0, headingDegrees: 90, time: ago(1), reverseGeo: { formattedLocation: 'Madera, CA' } }, engineState: { value: 'Off' } },
      2403: { id: 2, name: '2403', gps: { latitude: 25.7, longitude: -80.3, speedMilesPerHour: 0, time: ago(40) }, engineState: { value: 'Off' } },
      2611: { id: 3, name: '2611', gps: { latitude: 30.3, longitude: -81.6, speedMilesPerHour: 62, headingDegrees: 10, time: ago(2) }, engineState: { value: 'On' } },
    },
    vehByUnit: { 2210: { staticAssignedDriver: { name: 'Nestor Londono' } } },
    trailerAssets: { 9001: '175352', 9002: '7338' },
    reeferByKey: { 175352: { tempF: 34.5, setpointF: 34 } },
  };
  const traccar = {
    2403: { lat: 25.8, lng: -80.2, speedMph: 55, course: 180, gpsAt: ago(1), engine: 'On', location: 'Doral, FL' },
    'mom-camry': { lat: 26, lng: -80, gpsAt: ago(1), engine: 'On' },
  };
  const trips = [
    { trip: { tripNumber: '623952', powerUnit: '2210', trailer: '175352', destZoneDesc: 'CLOVIS, CA' } },
    { trip: { tripNumber: '624248', powerUnit: '2611', trailer: '7338', driver: 'CROJAS' }, _samsara: { driver1: 'Carlos Rojas' } },
    { trip: { tripNumber: '624257', powerUnit: 'OC1016', trailer: 'RR53153' }, _oc: { carrier: { name: 'Zeal Xpress Inc' } }, _samsara: { source: 'driver app', lat: 41.7, lng: -72.6, speedMph: 61, gpsAt: ago(3), location: 'Hartford, CT' } },
  ];
  const trailerLoc = { byId: { 9001: { lat: 36.9, lng: -120.0, at: ago(10), speedMph: 0 } }, source: 'asset location stream' };
  const f = buildFleet({ trips, idx, traccar, trailerLoc, now });
  assert.deepEqual(f.trucks.map((t) => t.unit), ['2210', '2403', '2611', 'OC1016']);
  const by = Object.fromEntries(f.trucks.map((t) => [t.unit, t]));
  assert.equal(by['2210'].state, 'parked'); assert.equal(by['2210'].trip, '623952'); assert.equal(by['2210'].driver, 'Nestor Londono');
  assert.equal(by['2403'].source, 'FMC00A'); assert.equal(by['2403'].state, 'moving');
  assert.equal(by['2611'].driver, 'Carlos Rojas'); assert.equal(by['2611'].state, 'moving');
  assert.equal(by.OC1016.source, 'Driver phone'); assert.equal(by.OC1016.oc, 'Zeal Xpress Inc');
  assert.ok(!f.trucks.some((t) => /camry/i.test(t.unit)), 'consumer cars never on the fleet map');
  const tr = Object.fromEntries(f.trailers.map((t) => [t.trailer, t]));
  assert.equal(tr['175352'].source, 'Samsara'); assert.equal(tr['175352'].tempF, 34.5); assert.equal(tr['175352'].hitched, true);
  assert.equal(tr['7338'].source, 'With truck 2611'); assert.equal(tr['7338'].lat, 30.3);
  assert.equal(tr.RR53153.source, 'With truck OC1016');
});

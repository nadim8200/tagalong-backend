import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, readPing, tripFor, authorized, initMacroPoint } from '../macropoint.js';

const board = [
  { trip: { tripNumber: '624815', powerUnit: 'OC978', status: 'DEPSHIP' }, _oc: { truck: 'OC978' }, freightBills: [{ billNumber: 'M5042635', billToName: 'NATIVE CHICAGO - LOMBARD', endZoneDescription: 'LOMBARD, IL, 60148' }] },
  { trip: { tripNumber: '624741', powerUnit: 'OC03', status: 'DEPSHIP' }, _ratecon: { data: { loadNumber: 'RXO-24261611', referenceNumbers: ['PO 88123'] } }, freightBills: [] },
];

test('reads MacroPoint messages in XML, JSON, form or query string', () => {
  const xml = '<?xml version="1.0"?><LocationUpdate><ID>624815</ID><Coordinates><Latitude>41.8781</Latitude><Longitude>-87.6298</Longitude></Coordinates><Location><City>Chicago</City><State>IL</State><Postal>60601</Postal></Location><LocationDateTimeUTC>2026-10-13T20:15:00</LocationDateTimeUTC><DataSource>ELD</DataSource></LocationUpdate>';
  const a = readPing(flatten(xml));
  assert.deepEqual([a.orderId, a.lat, a.lng, a.city, a.state, a.source, a.at], ['624815', 41.8781, -87.6298, 'Chicago', 'IL', 'ELD', Date.parse('2026-10-13T20:15:00Z')]);
  const json = readPing(flatten({ order: { orderId: 'RXO-24261611' }, location: { latitude: '35.1', longitude: '-90.0', locationDateTimeUtc: '2026-10-13T20:00:00Z' } }));
  assert.equal(json.orderId, 'RXO-24261611'); assert.equal(json.lat, 35.1);
  const form = readPing(flatten('ID=M5042635&Latitude=40.0&Longitude=-86.0&TripEvent=Arrived&StopName=Lombard'));
  assert.equal(form.event, 'Arrived'); assert.equal(form.stop, 'Lombard');
  const q = readPing(flatten('', { id: '624741', lat: '33', lon: '-84' }));
  assert.equal(q.lng, -84);
  assert.equal(readPing(flatten('<x><ID>1</ID></x>')), null);                       // nothing to use
  assert.equal(readPing(flatten({ ID: '1', Latitude: '0', Longitude: '0' })), null); // 0,0 is not a place
});

test('the Load ID matches our trip: trip number, TruckMate bill, broker load # or reference', () => {
  assert.equal(tripFor('624815', board), '624815');
  assert.equal(tripFor('M5042635', board), '624815');
  assert.equal(tripFor('rxo 24261611', board), '624741');
  assert.equal(tripFor('PO88123', board), '624741');
  assert.equal(tripFor('99999', board), null);
  // the office's Load IDs (Oct 13): "624741 NATIVE…" / "624815" match; a 5-digit "12380" doesn't
  assert.equal(tripFor('624741 NATIVE LOMBARD', board), '624741');
  assert.equal(tripFor('12380', board), null);
});

test('callbacks need the Basic login or the URL key; nothing is open by default', () => {
  const basic = (u, p) => ({ get: (h) => (h === 'authorization' ? `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` : undefined), query: {} });
  const env = { MACROPOINT_CALLBACK_USER: 'mp', MACROPOINT_CALLBACK_PASSWORD: 's3cret', MACROPOINT_CALLBACK_KEY: 'k123' };
  assert.equal(authorized(basic('mp', 's3cret'), env).ok, true);
  assert.equal(authorized(basic('mp', 'wrong'), env).ok, false);
  assert.equal(authorized({ get: () => undefined, query: { key: 'k123' } }, env).ok, true);
  assert.equal(authorized({ get: () => undefined, query: {} }, {}).code, 503);
});

test('a ping lands on the OC trip: position for the ETA / map / Jarvis; unknown loads are kept for review', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const routes = {}; const app = { post: (p, h) => { routes[`POST ${p}`] = h; }, get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; } };
  const T = Date.parse('2026-10-13T20:30:00Z');
  const mp = initMacroPoint(app, { requireAdmin: () => {}, db, getBoard: async () => ({ trips: board }), env: { MACROPOINT_CALLBACK_KEY: 'k123' }, now: () => T });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const r1 = res(); await routes['POST /macropoint/callback']({ query: { key: 'k123' }, get: () => undefined, body: '<LocationUpdate><ID>624815</ID><Latitude>41.88</Latitude><Longitude>-87.63</Longitude><City>Chicago</City><State>IL</State><LocationDateTimeUTC>2026-10-13T20:15:00</LocationDateTimeUTC></LocationUpdate>' }, r1);
  assert.deepEqual(r1.body, { ok: true, used: true, trip: '624815' });
  const r2 = res(); await routes['POST /macropoint/callback']({ query: {}, get: () => undefined, body: '<x/>' }, r2);
  assert.equal(r2.code, 401);
  const r3 = res(); await routes['POST /macropoint/callback']({ query: { key: 'k123' }, get: () => undefined, body: { ID: 'ZZ-1', Latitude: '30', Longitude: '-90' } }, r3);
  assert.equal(r3.body.used, false);
  const trips = JSON.parse(JSON.stringify(board));
  await mp.overlay('florida-beauty', trips);
  assert.equal(trips[0]._samsara.source, 'MacroPoint'); assert.equal(trips[0]._samsara.lat, 41.88); assert.equal(trips[0]._samsara.location, 'Chicago, IL');
  assert.equal(trips[0]._macropoint.fresh, true);
  assert.equal(trips[1]._macropoint, undefined);
  const { isOcLoad } = await import('../voice.js');
  assert.equal(isOcLoad(trips[0]), false);           // tracked by MacroPoint → customers hear it again
  assert.equal(isOcLoad(trips[1]), true);
  const st = res(); await routes['GET /truckmate/macropoint/status']({}, st);
  assert.deepEqual(st.body.unmatched.map((x) => x.orderId), ['ZZ-1']);
});

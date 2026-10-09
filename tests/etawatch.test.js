import test from 'node:test';
import assert from 'node:assert/strict';
import { initEtaWatch, loadsForCustomer } from '../etawatch.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const load = (trip, customer, delivered = false) => ({ trip: { tripNumber: trip, status: 'DEPSHIP', powerUnit: '2617', trailer: '7150' }, freightBills: [{ billNumber: `B${trip}`, billToName: customer, endZoneDescription: 'PHILADELPHIA, PA, 19148', actualDelivery: delivered ? '2026-10-09T08:00:00' : null }], _samsara: { lat: 39.9, lng: -75.2, gpsAt: new Date().toISOString(), location: 'I-95, PA', speedMph: 60 } });

test('customer names find their running loads', () => {
  const items = [load('624102', 'NATIVE FLOWER CO'), load('624103', 'PRODUCE JUNCTION INC'), load('624104', 'MAIN WHOLESALE'), load('624105', 'NATIVE FLOWER CO', true)];
  assert.deepEqual(loadsForCustomer('Native', items), ['624102'], 'delivered ones are skipped');
  assert.deepEqual(loadsForCustomer('Produce Junction', items), ['624103']);
  assert.deepEqual(loadsForCustomer('xx', items), []);
});

test('ETA updates: first one now, again after N hours, a last "delivered" one, then it stops', async () => {
  const db = memDb(); const sent = [];
  const app = { get: () => {}, delete: () => {} };
  const w = initEtaWatch(app, { requireAuth: () => {}, db, sendMail: async (m) => { sent.push(m); } });
  let items = [load('624102', 'NATIVE FLOWER CO'), load('624103', 'PRODUCE JUNCTION INC')];
  const r = await w.add({ customers: ['Native', 'Produce Junction'], to: ['ntellez@floridabeauty.us'], everyHours: 3, by: 'Nadim' }, items);
  assert.equal(r.ok, true); assert.deepEqual(r.watch.trips.sort(), ['624102', '624103']);
  assert.equal(sent.length, 2); assert.match(sent[0].subject, /^Location update/); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  const t0 = Date.now();
  await w.run({ items, now: t0 + 60 * 60000 });
  assert.equal(sent.length, 2, 'not yet 3 hours');
  await w.run({ items, now: t0 + 3.1 * 3600000 });
  assert.equal(sent.length, 4);
  items = [load('624102', 'NATIVE FLOWER CO', true), load('624103', 'PRODUCE JUNCTION INC', true)];
  await w.run({ items, now: t0 + 4 * 3600000 });
  assert.equal(sent.length, 6); assert.match(sent[5].subject, /^✅ Load delivered/);
  assert.deepEqual(await db.get('taEtaWatch:florida-beauty', []), [], 'all delivered → the schedule ends');
  assert.equal((await w.add({ customers: ['Nobody Here'], to: ['x@y.com'] }, items)).ok, false);
});

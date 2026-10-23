import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceDays, slimClient, mergeClients, buildFences, fencesAsAddresses, syncDue, initArtisClients } from '../artisclients.js';
import { applyArtisTo } from '../profiles.js';
import { matchGeofence } from '../stopvisits.js';

// shaped like ARTIS My Clients (test data only)
const RAW = [{ client_id: '02281', name: 'DESIGNERS CHOICE BOSTON', address_1: '52 INDUSTRIAL DRIVE', address_2: '', city: 'BOSTON', province: 'MA', postal_code: '02136', posLat: '42.23888888888889', posLong: '-71.13444444444445', business_phone: '(617) 555-0100', fax_phone: '617-555-0199', clientTypeInfo: { client_is_consingee: true, client_is_bill_to: true, isFlowerClient: true, creditStatus: 'CREDIT', apptReq: false }, client_status: 'A', serviceDays: '<strong>MO</strong> TU <strong>WE</strong> <strong>FR</strong>', warehouseName: 'Miami' },
  { client_id: '51999', name: 'NEW FLORIST NOT IN TRUCKMATE', address_1: '1 MAIN ST', city: 'TAMPA', province: 'FL', postal_code: '33601', posLat: '', posLong: '', business_phone: '', clientTypeInfo: { apptReq: true }, client_status: 'A', serviceDays: '' }];

test('ARTIS customers: delivery days, coordinates, phones; merged into TruckMate\'s list without losing emails', () => {
  assert.deepEqual(serviceDays(RAW[0].serviceDays), ['MO', 'WE', 'FR']);
  const a = RAW.map(slimClient);
  assert.deepEqual([a[0].id, a[0].lat, a[0].lng, a[0].phone, a[0].fax, a[0].zip], ['02281', 42.238889, -71.134444, '6175550100', '6175550199', '02136']);
  assert.equal(a[1].lat, null); assert.equal(a[1].apptReq, true);
  const tm = [{ id: '02281', name: 'DESIGNERS CHOICE BOSTON', city: 'BOSTON', state: 'MA', emails: ['orders@dc.example'], contacts: ['RICAR'], phones: [] }];
  const m = mergeClients(tm, a);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].emails, ['orders@dc.example']); assert.equal(m[0].lat, 42.238889); assert.deepEqual(m[0].serviceDays, ['MO', 'WE', 'FR']);
  assert.equal(m[1].name, 'NEW FLORIST NOT IN TRUCKMATE');
});

test('profiles get ARTIS data under `artis` (+ customer ID, business phone); new customers get a profile', () => {
  const a = RAW.map(slimClient);
  const store = { p1: { id: 'p1', key: 'customer|DESIGNERS CHOICE BOSTON|', type: 'customer', name: 'DESIGNERS CHOICE BOSTON', contacts: [{ id: 'c1', email: 'orders@dc.example', edited: true }], locations: [], sources: ['client list'], aliases: [], loads: [] } };
  const r = applyArtisTo(store, a, '2026-10-23T09:00:00Z');
  const p = r.all.p1;
  assert.equal(p.clientId, '02281'); assert.equal(p.artis.address, '52 INDUSTRIAL DRIVE'); assert.equal(p.artis.zip, '02136');
  assert.deepEqual(p.artis.serviceDays, ['MO', 'WE', 'FR']);
  assert.equal(p.contacts.find((c) => c.phone === '6175550100').source, 'ARTIS');
  assert.equal(p.contacts[0].email, 'orders@dc.example', 'existing contact untouched');
  assert.equal(r.created, 1); assert.equal(r.updated, 2);
});

test('geofences from ARTIS coordinates; a dispatcher\'s radius / pin / off survive the next sync; stop tracking uses them', () => {
  const a = RAW.map(slimClient);
  let f = buildFences(a, {}, 't1');
  assert.deepEqual(Object.keys(f), ['02281']);
  assert.equal(f['02281'].radiusM, 300);
  f['02281'] = { ...f['02281'], radiusM: 500, edited: true, editedBy: 'Rosa' };
  f = buildFences(a, f, 't2');
  assert.equal(f['02281'].radiusM, 500); assert.equal(f['02281'].edited, true);
  const addr = fencesAsAddresses(f);
  assert.equal(addr[0].geofence.circle.radiusMeters, 500);
  const stop = { customer: 'DESIGNERS CHOICE BOSTON', city: 'BOSTON', state: 'MA' };
  assert.equal(matchGeofence(stop, addr).source, 'Customer geofence');
  // Samsara has the same place → Samsara's (drawn by hand) wins
  const sam = { id: 's1', name: 'Designers Choice Boston', formattedAddress: '52 Industrial Dr, Boston, MA 02136', geofence: { circle: { latitude: 42.2389, longitude: -71.1344, radiusMeters: 120 } } };
  assert.equal(matchGeofence(stop, [...addr, sam]).source, 'Samsara address');
  assert.equal(syncDue({}, Date.parse('2026-10-23T09:30:00Z')), '2026-10-23');   // 5:30 AM ET
  assert.equal(syncDue({ day: '2026-10-23' }, Date.parse('2026-10-23T15:00:00Z')), null);
});

test('daily sync: profiles, client list and geofences; the Geofences tab searches and edits', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, d) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d), set: async (k, v) => m.set(k, v), update: async (k, fn, d) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d); m.set(k, v); return v; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  let saved = null; let applied = null;
  const c = initArtisClients(app, { requireAuth: (q, r, n) => n(), db, artisWeb: { ready: () => true, fetchText: async () => `<script>\n var shipperClients = ${JSON.stringify(RAW)}\n</script>` }, clients: { all: () => [], save: async (l) => { saved = l; } }, profiles: { applyArtis: async (l) => { applied = l; return l.length; } } });
  const r = await c.sync();
  assert.deepEqual(r, { customers: 2, fences: 1, profilesUpdated: 2, clientList: 2 });
  assert.equal(saved.length, 2); assert.equal(applied[0].id, '02281');
  const call = async (key, req) => { let out; let code = 200; await routes[key]({ query: {}, params: {}, body: {}, user: { name: 'Rosa' }, ...req }, { status(x) { code = x; return this; }, json(j) { out = j; } }); return { code, out }; };
  const list = await call('GET /truckmate/geofences', { query: { q: 'boston designers' } });
  assert.equal(list.out.matching, 1);
  const ed = await call('PUT /truckmate/geofences/:id', { params: { id: '2281' }, body: { radiusM: 450, active: false } });
  assert.equal(ed.out.radiusM, 450); assert.equal(ed.out.active, false); assert.equal(ed.out.editedBy, 'Rosa');
  assert.equal((await call('PUT /truckmate/geofences/:id', { params: { id: '02281' }, body: { radiusM: 9000 } })).code, 400);
  assert.deepEqual(await c.asAddresses(), [], 'turned off → not used for stop tracking');
});

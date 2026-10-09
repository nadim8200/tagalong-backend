import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initBrokerTrack, publicView, isFinished } from '../brokertrack.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const NOW = Date.parse('2026-10-09T03:00:00Z');
const load = (n, extra = {}) => ({ trip: { tripNumber: n, status: 'DEPSHIP', powerUnit: `T${n}`, trailer: `R${n}`, destZoneDesc: 'WEST PALM BEACH, FL, 33401' }, _samsara: { lat: 26.123456, lng: -80.2, gpsAt: new Date(NOW - 5 * 60000).toISOString(), speedMph: 55, location: 'I-95, Fort Lauderdale, FL', driver1: 'Frankie Patterson', driver1Info: { name: 'Frankie Patterson', phone: '+13055550100' }, hos: { status: 'driving', driveLeftMin: 300 } }, _ratecon: { data: { loadNumber: `L-${n}` } }, ...extra });

function fakeApp() { const routes = {}; return { routes, get: (p, fn) => { routes[p] = fn; } }; }
async function call(app, token) { let out = null; const res = { set() {}, status() { return res; }, json(j) { out = j; } }; await app.routes['/track/:token']({ params: { token } }, res); return out; }

test('the page shows only this load and this truck — nothing about the driver or other loads', () => {
  const v = publicView(load('624318'), { now: NOW });
  assert.equal(v.trip, '624318');
  assert.equal(v.loadNumber, 'L-624318');
  assert.deepEqual(v.position, { lat: 26.1235, lng: -80.2, place: 'Fort Lauderdale, FL', at: new Date(NOW - 5 * 60000).toISOString(), moving: true, mph: 55 });
  const all = JSON.stringify(v);
  for (const secret of ['Frankie', '3055550100', 'driveLeft', 'driving', 'hos']) assert.ok(!all.includes(secret), secret);
});

test('each link opens its own load only; after delivery the link is dead for good', async () => {
  const db = memDb(); const app = fakeApp();
  const board = { trips: [load('624318'), load('624338')] };
  const t = initBrokerTrack(app, { db, getBoard: async () => board, env: { APP_URL: 'https://mytagalong.app' }, now: () => NOW });
  const a = await t.linkFor('florida-beauty', '624318');
  const b = await t.linkFor('florida-beauty', '624338');
  assert.match(a, /^https:\/\/mytagalong\.app\/s\/[\w-]{16}$/);
  assert.notEqual(a, b);
  assert.equal(await t.linkFor('florida-beauty', '624318'), a, 'same link for the same load');
  const va = await call(app, a.split('/s/')[1]);
  assert.equal(va.trip, '624318');
  assert.ok(!JSON.stringify(va).includes('624338'), 'no other load');
  assert.deepEqual(await call(app, 'nope'), { active: false, error: 'This tracking link is not valid.' });
  board.trips[0].trip.status = 'DELVD';
  assert.deepEqual(await call(app, a.split('/s/')[1]), { active: false, ended: 'delivered', trip: '624318' });
  board.trips[0].trip.status = 'DEPSHIP';   // even if the status flips back, the ended link stays ended
  assert.equal((await call(app, a.split('/s/')[1])).active, false);
  assert.notEqual(await t.linkFor('florida-beauty', '624318'), a, 'a new load run gets a new link');
});

test('finished = delivered / cancelled, or off the board', () => {
  assert.equal(isFinished(null), true);
  assert.equal(isFinished({ trip: { status: 'CANC' } }), true);
  assert.equal(isFinished({ trip: { status: 'DEPSHIP' } }), false);
});

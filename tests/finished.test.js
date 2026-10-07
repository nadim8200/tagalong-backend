import test from 'node:test';
import assert from 'node:assert/strict';
import { finishReason, isSure, initFinished } from '../finished.js';

const T = (n, status, extra = {}) => ({ trip: { tripNumber: n, status, powerUnit: extra.unit || '2401' }, freightBills: extra.bills || [{ billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148' }], ...extra.more });

test('finished on facts: TruckMate delivered, every bill, every / last stop geofence; truck moved on is only a hint', () => {
  assert.equal(finishReason(T('1', 'DELVD')), 'TruckMate: delivered');
  assert.equal(finishReason(T('1', 'DEPCONS', { bills: [{ actualDelivery: 'x' }, { actualDelivery: 'y' }] })), 'every stop delivered (TruckMate)');
  const sheet = { _manifest: { stops: [{ stopNumber: 2, action: 'DELIVER', key: 'a', city: 'MACON' }, { stopNumber: 3, action: 'DELIVER', key: 'b', customer: 'FT MILL FLOWERS', city: 'ROCK HILL' }] } };
  assert.equal(finishReason(T('1', 'ARRCONS', { more: { ...sheet, _visits: { a: { state: 'completed' }, b: { state: 'completed' } } } })), 'every stop visited (geofence)');
  assert.match(finishReason(T('1', 'ARRCONS', { more: { ...sheet, _visits: { b: { state: 'completed' } } } })), /^last stop visited — FT MILL FLOWERS/);
  assert.equal(finishReason(T('1', 'ARRCONS', { more: { ...sheet, _visits: { a: { state: 'completed' } } } })), null);
  const old = T('624326', 'DEPSHIP'); const nw = T('624407', 'DEPSHIP');
  const r = finishReason(old, [old, nw]);
  assert.equal(r, 'truck 2401 moved on to trip 624407'); assert.equal(isSure(r), false);
  assert.equal(finishReason(T('9', 'DEPSHIP', { unit: 'OC1016', more: { _oc: {} } }), [T('9', 'DEPSHIP', { unit: 'OC1016' }), T('99', 'DEPSHIP', { unit: 'OC1016' })]), null, 'never for outside-carrier codes');
});

test('sweep: sure ones leave the board (+ Delivered + rundown), hints stay with a suggestion; mark / reopen', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const done = []; const recorded = [];
  const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h.at(-1); } };
  const f = initFinished(app, { requireAuth: () => {}, db, onFinished: (site, rec, reason) => done.push(reason), recordFinished: async (site, it, reason) => recorded.push(reason) });
  const items = [T('1', 'DELVD'), T('624326', 'DEPSHIP'), T('624407', 'DEPSHIP'), T('5', 'DEPSHIP', { unit: '9' })];
  await f.sweep('fb', items);
  assert.deepEqual(items.map((i) => i.trip.tripNumber), ['624326', '624407', '5']);
  assert.equal(items[0]._finishHint, 'Probably finished — truck 2401 moved on to trip 624407');
  assert.deepEqual(done, ['TruckMate: delivered']); assert.deepEqual(recorded, ['TruckMate: delivered']);
  const res = { json() {}, status() { return this; } };
  await routes['/truckmate/trips/:trip/finish']({ params: { trip: '5' }, body: { reason: 'carrier confirmed by phone' }, query: { site: 'fb' }, user: { name: 'Ana' } }, res);
  const again = [T('1', 'DELVD'), T('5', 'DEPSHIP', { unit: '9' })];
  await f.sweep('fb', again);
  assert.deepEqual(again, [], 'finished ones stay finished even if TruckMate keeps sending them');
  await routes['/truckmate/trips/:trip/reopen']({ params: { trip: '1' }, body: {}, query: { site: 'fb' }, user: { name: 'Ana' } }, res);
  const back = [T('1', 'DELVD')];
  await f.sweep('fb', back);
  assert.equal(back.length, 1, 'reopened by a person → not auto-finished again');
});

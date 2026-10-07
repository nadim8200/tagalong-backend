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

test('sweep: sure ones leave the board (+ Delivered + rundown), moved-on loads go to Not closed; mark / reopen', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const done = []; const recorded = [];
  const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h.at(-1); }, get: () => {}, put: () => {} };
  const f = initFinished(app, { requireAuth: () => {}, db, onFinished: (site, rec, reason) => done.push(reason), recordFinished: async (site, it, reason) => recorded.push(reason) });
  const items = [T('1', 'DELVD'), T('624326', 'DEPSHIP'), T('624407', 'DEPSHIP'), T('5', 'DEPSHIP', { unit: '9' })];
  const r1 = await f.sweep('fb', items);
  assert.deepEqual(items.map((i) => i.trip.tripNumber), ['624407', '5']);
  assert.deepEqual(r1.unclosed.map((u) => [u.trip, u.by, u.unit, u.newTrip]), [['624326', 'truck', '2401', '624407']]);
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

import { movedOn } from '../finished.js';
test('not closed: truck or trailer on a newer load; emails dispatch once, then a daily reminder; drops off when TruckMate closes it', async () => {
  const L = (n, status, unit, trailer) => ({ trip: { tripNumber: n, status, powerUnit: unit, trailer, origZoneDesc: 'BEDFORD, NH, 03110', destZoneDesc: 'HIALEAH, FL, 33018' }, freightBills: [{ billNumber: `B${n}`, endZoneDescription: 'HIALEAH, FL, 33018' }] });
  assert.equal(movedOn(L('624195', 'DEPSHIP', '930', '7317'), [L('624195', 'DEPSHIP', '930', '7317'), L('624500', 'DISP', '930', '7400')]), null, 'only assigned, not picked up yet');
  assert.equal(movedOn(L('624195', 'DEPSHIP', '', '7317'), [L('624195', 'DEPSHIP', '', '7317'), L('624500', 'ARRSHIP', '931', '7317')]).by, 'trailer');
  assert.equal(movedOn(L('624494', 'DEPSHIP', '2206', '7296'), [L('624494', 'DEPSHIP', '2206', '7296'), L('624496', 'DEPSHIP', '2619', '7296')]), null, 'its truck is still on it — a trailer swap, not a forgotten load');
  const at = (L0, iso) => ({ ...L0, _times: { statusHistory: [{ status: 'DEPSHIP', at: iso }] } });
  const a = at(L('624188', 'ARRCONS', '2208', '7001'), '2026-10-06T22:00:00Z'); const b = at(L('624190', 'ARRCONS', '2208', '7001'), '2026-10-06T23:00:00Z');
  assert.equal(movedOn(a, [a, b]), null, 'two trips picked up together ride the same truck');
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const mails = [];
  let clock = Date.parse('2026-10-07T13:00:00Z');                              // 9 AM Eastern
  const app = { post: () => {}, get: () => {}, put: () => {} };
  const f = initFinished(app, { requireAuth: () => {}, db, mailer: { ready: () => true, send: async (x) => mails.push(x) }, env: { UNCLOSED_EMAILS: 'off' }, now: () => clock });
  await db.set('taUnclosedCfg', { to: ['dispatch@floridabeauty.us'], time: '08:00' });
  const board = () => [L('624128', 'DEPSHIP', '930', '7309'), L('624195', 'DEPSHIP', '930', '7317'), L('624600', 'DEPSHIP', '930', '7320')];
  const items = board();
  const r = await f.sweep('florida-beauty', items, { 624128: {}, 624195: {}, 624600: {} });
  assert.deepEqual(items.map((i) => i.trip.tripNumber), ['624600'], 'only the current load stays on the board');
  assert.equal(r.unclosed.length, 2);
  await f.notify('florida-beauty');
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /2 loads not closed in TruckMate/);
  assert.match(mails[0].html, /truck 930 is now on trip 624600, but trip 624128 .* is still open in TruckMate/);
  await f.notify('florida-beauty');
  assert.equal(mails.length, 1, 'no repeat the same day');
  clock += 24 * 3600000;                                                       // next morning
  await f.notify('florida-beauty');
  assert.equal(mails.length, 2); assert.match(mails[1].subject, /^Reminder: 2 loads still not closed/);
  // TruckMate closes 624128 → it leaves the list
  await f.sweep('florida-beauty', [L('624195', 'DEPSHIP', '930', '7317'), L('624600', 'DEPSHIP', '930', '7320')], { 624195: {}, 624600: {} });
  assert.deepEqual(Object.keys(await db.get('taUnclosed:florida-beauty', {})), ['624195']);
});

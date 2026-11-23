import test from 'node:test';
import assert from 'node:assert/strict';
import { dvrUnit, loadsOfUnit, whereIs, dueReminders, reminderMessage, initYardDvr } from '../yarddvr.js';

const NOW = Date.parse('2026-11-23T03:00:00Z');
const R = { id: 'd1', at: '2026-11-22T15:00:00Z', by: 'Ferney Urrego', part: 'reefer', category: 'reefer', text: 'Reefer cycling off at night', truck: '4504', trailer: '18094', trip: '627656', status: 'open' };
const T = (n, status, unit, trailer, dest) => ({ trip: { tripNumber: n, status, powerUnit: unit, trailer, origZoneDesc: 'WALTHAM, MA', destZoneDesc: dest } });
const ITEMS = [T('627700', 'DEPSHIP', '4504', '7280', 'WINCHESTER, MA'), T('627800', 'DISP', '2001', '18094', 'MIAMI, FL, 33122'), T('627656', 'DELVD', '4504', '18094', 'MELBOURNE, FL')];
const hubOf = (it) => (/MIAMI/.test(it.trip.destZoneDesc) ? 'MIAMI' : null);

test('a DVIR\'s unit, its loads on the board and where it is', () => {
  assert.deepEqual(dvrUnit(R), { kind: 'trailer', unit: '18094' }, 'a reefer problem is the trailer\'s');
  assert.deepEqual(dvrUnit({ ...R, part: 'truck' }), { kind: 'truck', unit: '4504' });
  const l = loadsOfUnit(ITEMS, { kind: 'trailer', unit: '18094' });
  assert.equal(l.next.trip, '627800'); assert.equal(l.now, null, 'a delivered load is not its load');
  assert.equal(whereIs({ trailers: [{ trailer: '18094', location: 'Miami, FL', truck: '2001' }] }, { kind: 'trailer', unit: '18094' }).hitchedTo, '2001');
});

test('reminders: once when it\'s dispatched to come down to a yard, once about an hour out', () => {
  const r1 = dueReminders(R, { items: ITEMS, hubOf, etas: {}, sent: {}, now: NOW });
  assert.deepEqual(r1.map((x) => [x.kind, x.trip, x.yard]), [['dispatched', '627800', 'Miami yard']]);
  assert.deepEqual(dueReminders(R, { items: ITEMS, hubOf, sent: { 'd1|627800|dispatched': 'x' }, now: NOW }), [], 'sent already');
  const rolling = [T('627800', 'DEPSHIP', '2001', '18094', 'MIAMI, FL, 33122')];
  const near = dueReminders(R, { items: rolling, hubOf, etas: { 627800: { stops: [{ etaMs: NOW + 50 * 60000 }] } }, sent: { 'd1|627800|dispatched': 'x' }, now: NOW });
  assert.deepEqual(near.map((x) => x.kind), ['near']);
  assert.deepEqual(dueReminders(R, { items: rolling, hubOf, etas: { 627800: { stops: [{ etaMs: NOW + 3 * 3600000 }] } }, sent: { 'd1|627800|dispatched': 'x' }, now: NOW }), [], '3 h out: not yet');
  assert.deepEqual(dueReminders({ ...R, status: 'completed' }, { items: ITEMS, hubOf, now: NOW }), [], 'work done: no reminders');
  const m = reminderMessage(R, { kind: 'near', trip: '627800', yard: 'Miami yard', etaMs: NOW + 50 * 60000 }, rolling[0]);
  assert.match(m.subject, /Trailer 18094 · Reefer unit \(reefer\) — about 1 hour from the Miami yard/);
  assert.match(m.text, /Open DVIR from Ferney Urrego/);
});

test('the routes: open list with location and next load; Completed moves it (who, when, note); reminders go out once', async () => {
  const s = { 'taDvr:florida-beauty': { d1: R } };
  const db = { enabled: true, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => (s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d)) };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.pop(); }, post: (p, ...h) => { routes[`POST ${p}`] = h.pop(); } };
  const mails = []; const texts = [];
  const d = initYardDvr(app, { requireAuth: () => {}, db, getBoard: async () => ({ trips: ITEMS }), getFleet: async () => ({ trailers: [{ trailer: '18094', location: '7379 NW 31st St, Miami, FL', gpsAt: 'x' }] }), hubOf, env: { NODE_ENV: 'test', JWT_SECRET: 'k' }, now: () => NOW, sendMail: async (m) => mails.push(m), sendText: async (o) => texts.push(o) });
  const call = async (key, { query = {}, params = {}, body = {} } = {}) => { const out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes[key]({ query, params, body, user: { name: 'Nadim' } }, res); return out; };
  const open = (await call('GET /truckmate/yard-dvrs')).body.dvrs;
  assert.equal(open.length, 1); assert.equal(open[0].where.location, '7379 NW 31st St, Miami, FL'); assert.equal(open[0].next.trip, '627800'); assert.equal(open[0].by, 'Ferney Urrego');
  assert.deepEqual(await d.remind(), ['d1|627800|dispatched']);
  assert.equal(mails.length, 1); assert.deepEqual(mails[0].to, ['ntellez@floridabeauty.us']); assert.equal(texts[0].to, '3055040711');
  assert.deepEqual(await d.remind(), [], 'once');
  await call('POST /truckmate/yard-dvrs/:id/complete', { params: { id: 'd1' }, body: { note: 'Replaced the door seal' } });
  assert.equal((await call('GET /truckmate/yard-dvrs')).body.dvrs.length, 0);
  const done = (await call('GET /truckmate/yard-dvrs', { query: { status: 'completed' } })).body.dvrs;
  assert.equal(done[0].completedBy, 'Nadim'); assert.equal(done[0].completedNote, 'Replaced the door seal');
  assert.equal((await call('POST /truckmate/yard-dvrs/:id/complete', { params: { id: 'nope' } })).status, 404);
});

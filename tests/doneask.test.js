import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, dueAsks, initDoneAsk, REASK_MS, OPEN_MS, handoffEmail } from '../doneask.js';

const T = (n, more = {}, trip = {}) => ({ trip: { tripNumber: n, driver: '2000', driver2: '', powerUnit: '2219', destZoneDesc: 'SANTA ANA, CA, 92705', ...trip }, ...more });

test('who gets asked: a "Probably finished" load on the board, or one in Not closed — company crews only', () => {
  const board = {
    trips: [T('627335', { _finishGuess: 'flowers delivered, trailer now on trip 627349' }), T('1', {}), T('2', { _finishGuess: 'x', _oc: true }), T('3', { _finishGuess: 'x' }, { powerUnit: 'OC LOAD' }), T('4', { _finishGuess: 'x' }, { driver: '', driver2: '' })],
    unclosed: [{ trip: '627100', by: 'truck', unit: '2401', newTrip: '627300', driver: '3730', driver2: '2000', dest: 'MIAMI, FL, 33122' }],
  };
  assert.deepEqual(candidates(board), [
    { trip: '627335', codes: ['2000'], why: 'flowers delivered, trailer now on trip 627349', place: 'SANTA ANA, CA' },
    { trip: '627100', codes: ['3730', '2000'], why: 'truck 2401 is on trip 627300, TruckMate still has this load open', place: 'MIAMI, FL' },
  ]);
});

test('asked once; again after 2 h with no answer, then not again; after a No, again 12 h later if it still looks finished', () => {
  const c = [{ trip: '627335', codes: ['2000'], why: 'w', place: 'SANTA ANA, CA' }];
  const t0 = Date.parse('2026-11-18T19:00:00Z');
  let r = dueAsks(c, {}, t0);
  assert.equal(r.send.length, 1); assert.equal(r.asks['627335'].count, 1);
  assert.equal(dueAsks(c, r.asks, t0 + REASK_MS - 1).send.length, 0);
  r = dueAsks(c, r.asks, t0 + REASK_MS);
  assert.deepEqual(r.send.map((x) => x.again), [true]);
  assert.equal(dueAsks(c, r.asks, t0 + 5 * REASK_MS).send.length, 0, 'asked twice: the card waits for dispatch');
  const said = { ...r.asks, 627335: { ...r.asks['627335'], answer: { choice: 'no', at: new Date(t0).toISOString() } } };
  assert.equal(dueAsks(c, said, t0 + OPEN_MS - 1).send.length, 0);
  assert.equal(dueAsks(c, said, t0 + OPEN_MS).send.length, 1);
  assert.deepEqual(Object.keys(dueAsks([], said, t0 + 4 * 86400000).asks), [], 'old asks for loads gone are dropped');
});

test('the app: the push opens the question; Yes closes the load with the driver\'s name; No or words keep it open', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const pushes = []; const finished = [];
  const now = Date.parse('2026-11-18T19:38:00Z');
  const board = { trips: [T('627335', { _finishGuess: 'flowers delivered, trailer now on trip 627349' }), T('627334', { _finishGuess: 'last stop visited' }, { driver: '3100' })], unclosed: [] };
  const d = initDoneAsk(null, { db, getBoard: async () => board, notify: async (code, msg) => pushes.push([code, msg]), finishTrip: async (...a) => finished.push(a), env: { NODE_ENV: 'test' }, now: () => now });
  await d.process('fb');
  assert.deepEqual(pushes[0], ['2000', { title: 'Jarvis has a question', body: 'Is load 627335 to SANTA ANA, CA delivered? Tap to answer.', data: { tab: 'now', ask: 'done', trip: '627335' } }]);
  assert.deepEqual(await d.openFor('2000', 'fb'), { trip: '627335', place: 'SANTA ANA, CA', why: 'flowers delivered, trailer now on trip 627349', askedAt: new Date(now).toISOString() });
  assert.equal((await d.answer('627335', '9999', { choice: 'yes' }, 'fb')).code, 404, 'only its crew');
  assert.equal((await d.answer('627335', '2000', { choice: 'maybe', text: '' }, 'fb')).code, 400);
  assert.deepEqual(await d.answer('627334', '3100', { choice: null, text: 'Still at the receiver, unloading', by: 'Ana' }, 'fb'), { ok: true, finished: false, emailed: false });
  assert.equal(finished.length, 0, 'words alone never close it');
  assert.deepEqual(await d.answer('627335', '2000', { choice: 'yes', by: 'Julio' }, 'fb'), { ok: true, finished: true, emailed: false });
  assert.deepEqual(finished[0], ['fb', '627335', 'driver confirmed delivery in the app — Julio', 'Julio']);
  assert.equal(await d.openFor('2000', 'fb'), null, 'answered: no more pop-up');
  assert.deepEqual(await d.answer('627335', '2000', { choice: 'no' }, 'fb'), { ok: true, already: true });
});

test('driver says Yes → Inbound gets "driver reported empty" with what the truck is on now, and what to update in TruckMate', async () => {
  const { emptyEmail, nowOn } = await import('../doneask.js');
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const item = { trip: { tripNumber: '627243', powerUnit: '3519', driver: '5682', origZoneDesc: 'MIAMI, FL, 33122', destZoneDesc: 'NORTH LITTLE ROCK, AR, 72117' }, _finishGuess: 'left the last delivery — NORTH LITTLE ROCK (GPS)',
    _tmNext: [{ trip: '627388', status: 'ARRSHIP', from: 'NEW ALBANY, MS, 38652', to: 'LAKELAND, FL, 33801' }] };
  const mails = []; const finished = [];
  const d = initDoneAsk(null, { db, getBoard: async () => ({ trips: [item], unclosed: [] }), notify: async () => {}, finishTrip: async (...a) => finished.push(a), sendMail: async (x) => mails.push(x), recipients: async () => ['inbound-dispatch@floridabeauty.us'], env: { NODE_ENV: 'test' }, now: () => Date.parse('2026-11-18T22:00:00Z') });
  await d.process('fb');
  const r = await d.answer('627243', '5682', { choice: 'yes', by: 'Jose Rosa' }, 'fb');
  assert.deepEqual(r, { ok: true, finished: true, emailed: true });
  assert.deepEqual(mails[0].to, ['inbound-dispatch@floridabeauty.us']);
  assert.equal(mails[0].subject, 'Driver reported empty — load 627243 done, truck 3519 on load 627388');
  assert.match(mails[0].text, /Jose Rosa reported in the driver app that load 627243 \(MIAMI, FL → NORTH LITTLE ROCK, AR\) is fully delivered/);
  assert.match(mails[0].text, /Truck 3519 is now on load 627388 \(NEW ALBANY, MS → LAKELAND, FL\)/);
  assert.match(mails[0].text, /Please update the system: close load 627243 as delivered, and make sure load 627388 shows as started on truck 3519/);
  // not started yet / only a rate con / nothing
  assert.equal(nowOn({ _tmNext: [{ trip: '627400', status: 'ASSGN', from: 'A, FL', to: 'B, GA' }] }).text, 'on the way to pick up load 627400 (A, FL → B, GA)');
  assert.equal(nowOn({ _nextLoad: [{ rc: { broker: 'Arrive', loadNumber: '10041856', pickup: { city: 'Bedford Park, IL' }, delivery: { city: 'Vernon, CA' } } }] }).text, 'on the way to pick up Arrive load 10041856 (Bedford Park, IL → Vernon, CA) — not in TruckMate yet');
  assert.match(emptyEmail({ trip: { tripNumber: '1', powerUnit: '2001' } }, { by: 'Ana' }, '1').text, /empty — no next load on the board yet[\s\S]*close load 1 as delivered\./);
  // No → no email
  mails.length = 0;
});

test('the driver already tapped "Delivered" at every delivery stop: no second question — Delivered + the Inbound email', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  m.set('taMilestones:fb', { 627400: { ms: {}, fences: { 'pickup:0': { leftAt: 'x' }, 'delivery:s1': { inAt: 'a', leftAt: 'b' } } }, 627401: { ms: {}, fences: { 'delivery:s1': { leftAt: 'b' }, 'delivery:s2': { leftAt: 'c' } } } });
  m.set('taDriverCheckins:fb', { 627400: { steps: { 'delivered:s1': { at: '2026-11-18T21:30:00Z', by: 'Jose Rosa' } } }, 627401: { steps: { 'delivered:s1': { at: '2026-11-18T21:30:00Z', by: 'Ana' } } } });
  const board = { trips: [T('627400', { _finishGuess: 'left the rate con\'s delivery address — Smart Foodservice, Vernon, CA (GPS)' }), T('627401', { _finishGuess: 'x' }, { driver: '3100' })], unclosed: [] };
  const pushes = []; const finished = []; const mails = [];
  const d = initDoneAsk(null, { db, getBoard: async () => board, notify: async (code, msg) => pushes.push([code, msg.data.trip]), finishTrip: async (...a) => finished.push(a), sendMail: async (x) => mails.push(x), recipients: async () => ['inbound-dispatch@floridabeauty.us'], env: { NODE_ENV: 'test' }, now: () => Date.parse('2026-11-18T22:00:00Z') });
  await d.process('fb');
  assert.deepEqual(finished.map((f) => f[1]), ['627400']);
  assert.equal(finished[0][2], 'driver confirmed delivery in the app (Delivered check-in) — Jose Rosa');
  assert.equal(mails.length, 1);
  assert.deepEqual(pushes, [['3100', '627401']], 'one stop of two tapped: the driver is asked');
  await d.process('fb');
  assert.equal(finished.length, 1, 'once');
});

// "I'm done with this load" (Nov 22, Ferney Urrego on truck 4504) — SYNTHETIC
test('I\'m done with this load: delivered closes it like Yes; dropped / release tells Inbound; Jarvis stops asking about it', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.pop(); }, post: (p, ...h) => { routes[`POST ${p}`] = h.pop(); } };
  const finished = []; const mails = []; const pushes = [];
  const board = { trips: [T('627656', { _finishGuess: 'left the last delivery' }, { driver: '0986', driver2: '2473', status: 'ARRCONS', powerUnit: '4504', trailer: '18094', destZoneDesc: 'MELBOURNE, FL, 32934' }), T('627549', {}, { driver: '0986', status: 'ARRCONS', powerUnit: '4504', trailer: '18094' })], unclosed: [] };
  const d = initDoneAsk(app, { db, requireDriver: () => {}, getBoard: async () => board, notify: async (c, x) => pushes.push(x.data.trip), finishTrip: async (...a) => finished.push(a), sendMail: async (x) => mails.push(x), recipients: async () => ['inbound@floridabeauty.us'], env: { NODE_ENV: 'test' }, now: () => Date.parse('2026-11-23T01:30:00Z') });
  const call = async (trip, body, code = '0986') => { let out; const res = { status: (c) => ({ json: (j) => { out = { c, ...j }; } }), json: (j) => { out = j; } }; await routes['POST /driver/me/loads/:trip/wrapup']({ params: { trip }, body, driver: { code, name: 'Ferney Urrego' } }, res); return out; };
  assert.equal((await call('627656', { how: 'maybe' })).c, 400);
  assert.equal((await call('627656', { how: 'delivered' }, '7777')).c, 404, 'only their own load');
  const r = await call('627656', { how: 'delivered', where: 'Melbourne' });
  assert.equal(r.finished, true); assert.equal(finished[0][1], '627656'); assert.match(finished[0][2], /driver confirmed delivery in the app \("I'm done with this load"\) — Ferney Urrego: "at Melbourne"/);
  await d.process();
  assert.deepEqual(pushes, [], 'no "is it delivered?" push after the driver said so');
  const r2 = await call('627549', { how: 'dropped', where: 'Miami cooler' });
  assert.equal(r2.emailed, true); assert.match(mails.pop().subject, /^Driver dropped the trailer — load 627549, truck 4504/);
  assert.deepEqual(Object.keys(m.get('taDriverHandoff:florida-beauty')).sort(), ['627549', '627656']);
  assert.match(handoffEmail(board.trips[1], { how: 'release', where: 'Pompano yard', by: 'Ferney' }, '627549').subject, /did a release/);
});

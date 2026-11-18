import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, dueAsks, initDoneAsk, REASK_MS, OPEN_MS } from '../doneask.js';

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
  assert.deepEqual(await d.answer('627334', '3100', { choice: null, text: 'Still at the receiver, unloading', by: 'Ana' }, 'fb'), { ok: true, finished: false });
  assert.equal(finished.length, 0, 'words alone never close it');
  assert.deepEqual(await d.answer('627335', '2000', { choice: 'yes', by: 'Julio' }, 'fb'), { ok: true, finished: true });
  assert.deepEqual(finished[0], ['fb', '627335', 'driver confirmed delivery in the app — Julio', 'Julio']);
  assert.equal(await d.openFor('2000', 'fb'), null, 'answered: no more pop-up');
  assert.deepEqual(await d.answer('627335', '2000', { choice: 'no' }, 'fb'), { ok: true, already: true });
});

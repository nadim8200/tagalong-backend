import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueAsks, ltlFinishedAt, initPickupAsk } from '../pickupask.js';

const NOW = Date.parse('2026-11-14T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ltl = (extra = {}) => ({ trip: { tripNumber: '627056', powerUnit: '2604', driver: '5262', driver2: '9450', status: 'DEPCONS', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-12', stops: [] },
  freightBills: [{ billNumber: 'M1', endZoneDescription: 'BOSTON, MA' }], _stopFlow: { total: 2, done: 2, completedAt: iso(NOW - 40 * 60000), stops: [] }, ...extra });
const next = (speed = 45, gpsAt = NOW - 2 * 60000) => ({ trip: { tripNumber: '627200', powerUnit: '2604', driver: '5262', driver2: '9450', status: 'DISP', origZoneDesc: 'NORTON, MA' }, freightBills: [{ billNumber: 'B180999' }],
  _samsara: { speedMph: speed, gpsAt: iso(gpsAt) }, _ratecon: { stops: [{ type: 'pickup', city: 'Norton', state: 'MA', date: '2026-11-14', time: '14:00' }] } });

test('LTL run finished in the app + the truck rolling again → ask the crew about the next load, once', () => {
  assert.equal(ltlFinishedAt(ltl()), iso(NOW - 40 * 60000));
  assert.equal(ltlFinishedAt(ltl({ _stopFlow: { total: 2, done: 1, stops: [] } })), null, 'not every stop done');
  assert.equal(dueAsks([ltl(), next(3)], {}, NOW).asks.length, 0, 'parked: wait');
  assert.equal(dueAsks([ltl(), next(45, NOW - 60 * 60000)], {}, NOW).asks.length, 0, 'GPS from before the run ended');
  const r = dueAsks([ltl(), next()], {}, NOW);
  assert.deepEqual(r.asks.map((a) => [a.trip, a.afterTrip, a.codes.join('+')]), [['627200', '627056', '5262+9450']]);
  // the LTL load left the board: still remembered
  const r2 = dueAsks([next()], { done: { 627056: r.done['627056'] } }, NOW);
  assert.equal(r2.asks.length, 1);
  assert.equal(dueAsks([ltl(), next()], { done: { 627056: { ...r.done['627056'], askedFor: '627200' } } }, NOW).asks.length, 0, 'once');
});

test('the driver answers in the app: Yes, or No with why (required) → saved once, dispatch email', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const pushes = []; const emails = [];
  const a = initPickupAsk(null, { db, getBoard: async () => ({ trips: [ltl(), next()] }), notify: async (c, msg) => pushes.push([c, msg]), onAnswer: async (t, ans) => { emails.push([t, ans]); return { emailed: true }; }, env: { NODE_ENV: 'test' }, now: () => NOW });
  await a.process(); await a.process();
  assert.equal(pushes.length, 2, 'both drivers, once'); assert.equal(pushes[0][1].title, 'Rolling to your next pickup?'); assert.equal(pushes[0][1].data.ask, 'pickup');
  assert.equal((await a.openFor('5262')).trip, '627200');
  assert.equal(await a.openFor('1111'), null);
  assert.equal((await a.answer('627200', '5262', { rolling: false, comment: '' })).code, 400, 'No needs a reason');
  assert.equal((await a.answer('627200', '7777', { rolling: true })).code, 404, 'not their load');
  assert.equal((await a.answer('627200', '5262', { rolling: false, comment: 'Waiting on my 10-hour reset, rolling at 6 PM', by: 'Bryan' })).emailed, true);
  assert.deepEqual(emails[0], ['627200', { rolling: false, comment: 'Waiting on my 10-hour reset, rolling at 6 PM', by: 'Bryan', at: iso(NOW) }]);
  assert.equal((await a.answer('627200', '9450', { rolling: true })).already, true, 'the co-driver can\'t answer twice');
  assert.equal(await a.openFor('9450'), null, 'answered: the pop-up goes away');
});

test('an hour before any pickup the crew is asked in the app too (not when they already checked in at the shipper)', () => {
  const at = (min) => NOW + min * 60000;
  const load = { trip: { tripNumber: '627300', powerUnit: '2216', driver: '9001', status: 'DISP' }, freightBills: [{ billNumber: 'B1' }], _ratecon: { pickups: [{ name: 'Home Market Foods', city: 'Norton', state: 'MA', date: '2026-11-14', time: '10:40' }] } };
  assert.equal(dueAsks([load], {}, at(-60)).asks.length, 0, 'more than an hour out');
  const r = dueAsks([load], {}, NOW);
  assert.deepEqual(r.asks.map((a) => [a.trip, a.before, a.afterTrip]), [['627300', true, null]]);
  assert.equal(dueAsks([load], { taps: { 627300: { steps: { 'at-shipper': { at: iso(NOW) } } } } }, NOW).asks.length, 0, 'already at the shipper');
  assert.equal(dueAsks([load], { asks: { 627300: { askedAt: iso(NOW) } } }, NOW).asks.length, 0, 'once');
});

test('the load card shows what the driver last said in the app', async () => {
  const { appStatus } = await import('../pickupfollow.js');
  assert.equal(appStatus({}, {}, null), null);
  assert.equal(appStatus({}, {}, { answer: { rolling: true, at: iso(NOW - 60000), by: 'Wilson' } }).label, 'Heading to pickup');
  const s = appStatus({}, { 'at-shipper': { at: iso(NOW), by: 'Wilson' } }, { answer: { rolling: true, at: iso(NOW - 60000) } });
  assert.deepEqual([s.label, s.tone, s.src], ['At shipper', 'wait', 'driver app']);
  assert.equal(appStatus({}, { 'at-shipper': { at: iso(NOW - 9e5) }, loaded: { at: iso(NOW) } }).label, 'Loaded & leaving');
  assert.equal(appStatus({ _stopFlow: { total: 9, done: 3, stops: [{ doneAt: iso(NOW) }] } }, {}).label, 'Stop 3 of 9 done');
  assert.equal(appStatus({}, { 'arrived:BOSTON': { at: iso(NOW - 9e5) }, 'delivered:BOSTON': { at: iso(NOW) } }).label, 'Delivered');
});

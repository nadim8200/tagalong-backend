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
  // trip 626845: truck 2611 got an empty move to the YARD (no bills) — it is still on its way to Oxnard, not on a new load
  const yard = { trip: { tripNumber: '626907', status: 'ARRSHIP', powerUnit: '2611', trailer: '', destZoneDesc: 'YARD' }, freightBills: [] };
  const ox = L('626845', 'DEPCONS', '2611', '7136');
  assert.equal(movedOn(ox, [ox, yard]), null, 'an empty yard move is not a new load');
  assert.equal(movedOn(ox, [ox, { ...yard, trip: { ...yard.trip, destZoneDesc: 'MIAMI TERMINAL' } }]), null);
  assert.equal(finishReason(ox, [ox, { ...yard, trip: { ...yard.trip, status: 'DEPSHIP' } }]), null);
  assert.equal(movedOn(ox, [ox, L('626990', 'DEPSHIP', '2611', '7400')]).newTrip, '626990', 'a real load still counts');
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

test('Jarvis by truck number: the real load, not the truck\'s empty yard move', async () => {
  const { findLoad } = await import('../voice.js');
  const yard = { trip: { tripNumber: '626907', status: 'ARRSHIP', powerUnit: '2611', destZoneDesc: 'YARD' }, freightBills: [] };
  const ox = { trip: { tripNumber: '626845', status: 'DEPCONS', powerUnit: '2611', trailer: '7136', destZoneDesc: 'OXNARD, CA' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'OXNARD, CA, 93030' }] };
  assert.equal(findLoad([yard, ox], { truck: '2611' }).item.trip.tripNumber, '626845');
});

test('an LTL whose flowers look delivered (truck moved on, or trailer on a newer trip) stays on the board as "Probably finished" until the driver or dispatch says so (Nov 18)', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const recorded = [];
  const f = initFinished({ post: () => {}, get: () => {}, put: () => {} }, { requireAuth: () => {}, db, recordFinished: async (site, it, reason) => recorded.push([it.trip.tripNumber, reason]) });
  const ltl = T('627178', 'DEPSHIP', { unit: '733', more: { _flowerPhase: { phase: 'delivered' } } });
  const next = T('627311', 'ARRSHIP', { unit: '733' });
  const items = [ltl, next];
  const r = await f.sweep('fb', items);
  assert.deepEqual(items.map((i) => i.trip.tripNumber), ['627178', '627311'], 'a guess never takes it off the board');
  assert.equal(recorded.length, 0);
  assert.equal(r.unclosed.length, 0, 'not "Not closed" either');
  assert.equal(ltl._finishGuess, 'flowers delivered, truck 733 now on trip 627311');
  assert.equal(ltl._finishHint, 'Probably finished — flowers delivered, truck 733 now on trip 627311');
  const trl = T('627080', 'DEPCONS', { unit: '4551', more: { _flowerPhase: { phase: 'next-load', by: '627246' } } });
  // the driver was asked and said not yet → the card says so
  m.set('taDoneAsk:fb', { asks: { 627080: { askedAt: '2026-11-18T19:38:00Z', answer: { choice: 'no', text: 'two stops left in Ohio', by: 'Julio' } } } });
  const items2 = [trl];
  await f.sweep('fb', items2);
  assert.equal(items2.length, 1);
  assert.equal(trl._finishHint, 'Probably finished — flowers delivered, trailer now on trip 627246 · 📱 Julio: No, still rolling with it — "two stops left in Ohio"');
  // the driver (or dispatch) says Yes → Delivered
  await f.finishNow('fb', '627080', 'driver confirmed delivery in the app — Julio', 'Julio');
  const items3 = [T('627080', 'DEPCONS', { unit: '4551', more: { _flowerPhase: { phase: 'next-load', by: '627246' } } })];
  await f.sweep('fb', items3);
  assert.equal(items3.length, 0, 'finished by the driver → off the board');
});

test('GPS left every delivery place (a broker load with no trip sheet) → "Probably finished", the driver is asked; never closed by itself', async () => {
  const { leftEveryDelivery } = await import('../finished.js');
  const it = { trip: { tripNumber: '627243', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'NORTH LITTLE ROCK, AR, 72117' }] };
  assert.equal(leftEveryDelivery(it, { 627243: { ms: { 'left:NORTH LITTLE ROCK, AR, 72117': { at: 'x' } } } }), 'left the last delivery — NORTH LITTLE ROCK (GPS)');
  assert.equal(leftEveryDelivery(it, { 627243: { ms: {} } }), null);
  const m = new Map([['taMilestones:fb', { 627243: { ms: { 'left:NORTH LITTLE ROCK, AR, 72117': { at: 'x' } } } }]]);
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const f = initFinished({ post: () => {}, get: () => {}, put: () => {} }, { requireAuth: () => {}, db });
  const items = [JSON.parse(JSON.stringify(it))];
  await f.sweep('fb', items);
  assert.equal(items.length, 1);
  assert.equal(items[0]._finishGuess, 'left the last delivery — NORTH LITTLE ROCK (GPS)');
});

test('a broker load whose truck parked at the rate con\'s delivery address and left (geofence) → "Probably finished", driver asked', async () => {
  const { leftEveryDelivery } = await import('../finished.js');
  const it = { trip: { tripNumber: '627400', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'VERNON, CA, 90058' }],
    _ratecon: { data: { deliveries: [{ name: 'Smart Foodservice', address: '2600 E 50th St', city: 'Vernon', state: 'CA' }] } } };
  assert.equal(leftEveryDelivery(it, { 627400: { ms: {}, fences: { 'pickup:0': { leftAt: 'x' }, 'delivery:s1': { inAt: 'a', leftAt: 'b' } } } }), 'left the rate con\'s delivery address — Smart Foodservice, Vernon, CA (GPS)');
  assert.equal(leftEveryDelivery(it, { 627400: { ms: {}, fences: { 'delivery:s1': { inAt: 'a' } } } }), null, 'still at the receiver');
  assert.equal(leftEveryDelivery(it, { 627400: { ms: {}, fences: { 'pickup:0': { leftAt: 'x' } } } }), null, 'only the pickup');
});

test('TruckMate went quiet on the last stop (completed there; the connector stops sending it) + GPS left → Delivered (Nov 19)', async () => {
  const { quietDone, QUIET_MS } = await import('../finished.js');
  const NOW = Date.parse('2026-11-19T14:30:00Z');
  const it = { trip: { tripNumber: '627168', status: 'ARRCONS', activeLeg: '2', legCount: '2', powerUnit: '2211' }, freightBills: [{ billNumber: 'B180991', endZoneDescription: 'WEST PALM BEACH, FL, 33404' }] };
  const rec = { updatedAt: NOW - 27 * 3600000 };
  const g = 'left the last delivery — WEST PALM BEACH (GPS)';
  assert.equal(quietDone(it, rec, g, null, NOW), 'completed in TruckMate — at the last consignee (ARRCONS), left the last delivery — WEST PALM BEACH (GPS), no TruckMate change for 27h');
  assert.equal(quietDone(it, { updatedAt: NOW - QUIET_MS + 60000 }, g, null, NOW), null, 'TruckMate still talking');
  assert.equal(quietDone(it, rec, null, null, NOW), null, 'no GPS sign it left');
  assert.equal(quietDone({ trip: { ...it.trip, activeLeg: '8', legCount: '9' } }, rec, g, null, NOW), null, 'not the last leg (LTL mid-route)');
  assert.equal(quietDone({ trip: { ...it.trip, status: 'DEPSHIP' } }, rec, g, null, NOW), null, 'not at the consignee');
  assert.equal(quietDone({ trip: { ...it.trip, powerUnit: 'OC1013' } }, rec, g, null, NOW), null, 'outside carrier');
  assert.equal(quietDone(it, rec, g, { answer: { choice: 'no' } }, NOW), null, 'driver said not yet');
  const two = { trip: { ...it.trip, status: 'DEPCONS', activeLeg: '3', legCount: '3', powerUnit: '39' }, freightBills: [{ billNumber: 'T085707', endZoneDescription: 'OXNARD, CA, 93036' }, { billNumber: 'T085707-AA', endZoneDescription: 'SANTA PAULA, CA, 93060', actualDelivery: '2026-11-18T16:50:59' }] };
  assert.equal(quietDone(two, rec, 'left the last delivery — SANTA PAULA (GPS)', null, NOW), null, 'one stop delivered in TruckMate, the other still open (627375)');
  // in the sweep: leaves the board for Delivered, with the reason
  const m = new Map([['taMilestones:fb', { 627168: { ms: { 'left:WEST PALM BEACH, FL, 33404': { at: 'x' } } } }]]);
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const done = [];
  const f = initFinished({ post: () => {}, get: () => {}, put: () => {} }, { requireAuth: () => {}, db, now: () => NOW, recordFinished: async (s, i, r) => done.push(r) });
  const items = [JSON.parse(JSON.stringify(it))];
  await f.sweep('fb', items, { 627168: rec });
  assert.equal(items.length, 0);
  assert.match(done[0], /^completed in TruckMate/);
  assert.match(m.get('taFinished:fb')['627168'].reason, /no TruckMate change for 27h/);
});

test('dispatcher closes a load by hand: completed → Delivered + rundown; taken off the board → listed as not delivered, no rundown (Nov 19)', async () => {
  const m = new Map([['taTruckMateActive:fb', { trips: { 625241: { item: { trip: { tripNumber: '625241' } } }, 627421: { item: { trip: { tripNumber: '627421' } } } } }]]);
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const rundowns = []; const recorded = []; const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h.at(-1); }, get: () => {}, put: () => {} };
  initFinished(app, { requireAuth: () => {}, db, onFinished: (s, rec, reason) => rundowns.push(reason), recordFinished: async (s, it, reason) => recorded.push(reason) });
  const out = []; const res = { json(v) { out.push(v); }, status() { return this; } };
  await routes['/truckmate/trips/:trip/finish']({ params: { trip: '625241' }, body: { reason: 'cancelled by the broker', remove: true }, query: { site: 'fb' }, user: { name: 'Ana' } }, res);
  await routes['/truckmate/trips/:trip/finish']({ params: { trip: '627421' }, body: { reason: 'POD in' }, query: { site: 'fb' }, user: { name: 'Ana' } }, res);
  assert.deepEqual(out.map((o) => o.reason), ['taken off the board (not delivered) by Ana — cancelled by the broker', 'marked finished by Ana — POD in']);
  assert.deepEqual(recorded, out.map((o) => o.reason));
  assert.deepEqual(rundowns, ['marked finished by Ana — POD in'], 'no rundown for a load taken off the board');
  assert.equal(m.get('taFinished:fb')['625241'].removed, true);
});

test('a load with a staff POD email for only some stops never breaks the sweep (Nov 22: the board kept finished loads)', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, set: async (k, v) => { store[k] = v; }, update: async (k, fn, d) => (store[k] = fn(store[k] ?? d)) };
  const f = initFinished({ get() {}, put() {}, post() {} }, { requireAuth: () => {}, db });
  const items = [
    { trip: { tripNumber: '627587', status: 'DEPCONS', powerUnit: '2302' }, freightBills: [{ endZoneDescription: 'A, TN', actualDelivery: 'x' }, { endZoneDescription: 'MEMPHIS, TN' }], _staffPod: { at: '2026-11-23T00:37:01Z', by: 'Liz', whole: false } },
    { trip: { tripNumber: '627656', status: 'ARRCONS', powerUnit: '4504' }, freightBills: [{ endZoneDescription: 'MELBOURNE, FL' }], _staffPod: { at: '2026-11-22T22:15:21Z', by: 'Diego Diaz', whole: true } },
  ];
  await f.sweep('florida-beauty', items, {});
  assert.deepEqual(items.map((x) => x.trip.tripNumber), ['627587']);
  assert.match(items[0]._finishHint, /^Probably finished — delivered — POD emailed by Liz/);
});

test('one time: loads the first POD-email rule closed come back to the board and off Delivered', async () => {
  const store = { 'taFinished:florida-beauty': { 627606: { at: 'x', reason: 'delivered — POD emailed by Diego Diaz, Sun (staff email)', by: 'AI Dispatcher', auto: true }, 627001: { at: 'x', reason: 'TruckMate: delivered', auto: true } },
    'taTruckMateDelivered:florida-beauty': { items: [{ tripNumber: '627606', reason: 'delivered — POD emailed by Diego Diaz, Sun (staff email)' }, { tripNumber: '627001', reason: 'TruckMate: delivered' }] } };
  const db = { enabled: true, get: async (k, d) => store[k] ?? d, set: async (k, v) => { store[k] = v; }, update: async (k, fn, d) => (store[k] = fn(store[k] ?? d)) };
  const f = initFinished({ get() {}, put() {}, post() {} }, { requireAuth: () => {}, db });
  const items = [{ trip: { tripNumber: '627606', status: 'DISP', powerUnit: '2018' }, freightBills: [{ endZoneDescription: 'ATLANTA, GA' }] }];
  await f.sweep('florida-beauty', items, {});
  assert.equal(items.length, 1, 'back on the board');
  assert.deepEqual(Object.keys(store['taFinished:florida-beauty']), ['627001']);
  assert.deepEqual(store['taTruckMateDelivered:florida-beauty'].items.map((x) => x.tripNumber), ['627001']);
  assert.deepEqual(store.taFinishedPodFix1.undone, ['627606']);
});

test('the truck\'s later load is the one picked up later, not the one booked later (Nov 22, truck 2094)', async () => {
  const { movedOn } = await import('../finished.js');
  // 627542 (Mountaire NC → FL) was booked first but picked up Nov 22; 627568 (Pelham → Salisbury) picked up Nov 20 and delivered
  const old = { trip: { tripNumber: '627568', status: 'ARRCONS', powerUnit: '2094', trailer: '2080' }, freightBills: [{ billNumber: 'B181068' }], _times: { createdAt: '2026-11-20T02:51:00Z', statusHistory: [{ status: 'DEPSHIP', at: '2026-11-20T11:52:34Z' }, { status: 'ARRCONS', at: '2026-11-21T03:43:28Z' }] } };
  const now = { trip: { tripNumber: '627542', status: 'DEPSHIP', powerUnit: '2094', trailer: '2077' }, freightBills: [{ billNumber: 'B181061' }], _times: { createdAt: '2026-11-19T18:00:00Z', statusHistory: [{ status: 'DEPSHIP', at: '2026-11-22T04:07:40Z' }] } };
  assert.deepEqual(movedOn(old, [old, now]), { by: 'truck', unit: '2094', newTrip: '627542', newStatus: 'DEPSHIP' });
  assert.equal(movedOn(now, [old, now]), null, 'the load he is running is not "not closed"');
  // neither picked up yet: the created time decides (createdAt, not the trip number)
  const a = { trip: { tripNumber: '627700', status: 'DEPSHIP', powerUnit: '1' }, _times: { createdAt: '2026-11-22T01:00:00Z' } };
  const b = { trip: { tripNumber: '627600', status: 'DEPSHIP', powerUnit: '1' }, _times: { createdAt: '2026-11-23T01:00:00Z' } };
  assert.equal(movedOn(a, [a, b]).newTrip, '627600');
});

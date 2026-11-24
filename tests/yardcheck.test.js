import test from 'node:test';
import assert from 'node:assert/strict';
import { yardClock, expectedUnits, cleanRow, compareCheck, dueNow, initYardCheck, checksByDay } from '../yardcheck.js';

const REPORT = { hubs: [{ key: 'MIAMI', trailers: [{ trailer: '07280', unitOn: true, setF: 34, returnF: 35, onLoad: '627700', source: 'Thermo King' }, { trailer: '18094', unitOn: false, onLoad: null }] }, { key: 'VENTURA', trailers: [{ trailer: '262041' }] }] };
const TRUCKS = { hubs: [{ key: 'MIAMI', trucks: [{ unit: '4504', trip: '627700', drivers: [{ name: 'Ferney Urrego' }], gpsAt: 'x' }] }] };

test('the yard\'s clock: morning 4 AM–4 PM, night 4 PM–4 AM (after midnight counts for the evening before)', () => {
  assert.deepEqual(yardClock(Date.parse('2026-11-22T12:00:00Z'), 'America/New_York'), { day: '2026-11-22', shift: 'morning', hour: 7 });
  assert.equal(yardClock(Date.parse('2026-11-22T23:00:00Z'), 'America/New_York').shift, 'night');
  assert.deepEqual(yardClock(Date.parse('2026-11-23T06:30:00Z'), 'America/New_York'), { day: '2026-11-22', shift: 'night', hour: 1 });
  assert.equal(yardClock(Date.parse('2026-11-23T02:00:00Z'), 'America/Los_Angeles').shift, 'night', 'Ventura is on Pacific time');
});

test('the sheet starts with what GPS says is in the yard; the check flags not found, not on GPS, reefer and damage', () => {
  const exp = expectedUnits(REPORT, TRUCKS, 'MIAMI');
  assert.deepEqual(exp.map((u) => `${u.kind}:${u.unit}`), ['trailer:7280', 'trailer:18094', 'truck:4504']);
  const rows = [
    cleanRow({ unit: '7280', kind: 'trailer', here: true, loaded: 'loaded', reeferOn: true, setF: 34, tempF: 41, fuelPct: '62' }),
    cleanRow({ unit: '18094', kind: 'trailer', here: false }),
    cleanRow({ unit: 'TL 7366', kind: 'trailer', here: true, loaded: 'loaded', reeferOn: false, damage: 'rear door seal torn', photos: ['abcdefabcdef', 'bad'], added: true }),
  ];
  assert.equal(rows[2].unit, '7366'); assert.deepEqual(rows[2].photos, ['abcdefabcdef']);
  const r = compareCheck(exp, rows);
  assert.deepEqual(r.missing.map((m) => m.unit), ['18094', '4504']);
  assert.deepEqual(r.extra, [{ unit: '7366', kind: 'trailer' }]);
  assert.deepEqual(r.reefer.map((x) => [x.unit, x.why]), [['7280', 'reading 41°F, set 34°F'], ['7366', 'loaded, reefer off']]);
  assert.deepEqual(r.damage, [{ unit: '7366', kind: 'trailer', note: 'rear door seal torn', photos: 1 }]);
  assert.deepEqual(r.unchecked, []);   // the sheet starts empty: a GPS unit nobody added is "on GPS but not added"
  assert.ok(r.missing.some((m) => m.unit === '4504'));
  assert.equal(r.counts.here, 2); assert.equal(r.counts.loaded, 2);
});

test('the routes: send a check (sent again → replaced), today\'s morning / night and late ones, photos', async () => {
  const s = {}; const db = { enabled: true, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => (s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d)) };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.pop(); }, post: (p, ...h) => { routes[`POST ${p}`] = h.pop(); } };
  let clock = Date.parse('2026-11-22T13:00:00Z');   // 8 AM in Miami
  initYardCheck(app, { requireAuth: () => {}, db, report: async () => REPORT, trucks: async () => TRUCKS, now: () => clock });
  const call = async (key, { body = {}, query = {}, params = {} } = {}) => { const out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; }, set() {}, send(b) { out.sent = b; } }; await routes[key]({ body, query, params, user: { name: 'Yard Miami' } }, res, () => {}); return out; };
  assert.equal((await call('POST /truckmate/yard-checks', { body: { yard: 'X', rows: [] } })).status, 400);
  assert.equal((await call('POST /truckmate/yard-checks', { body: { yard: 'MIAMI', rows: [{ unit: '7280' }] } })).status, 400, 'nothing marked');
  const a = await call('POST /truckmate/yard-checks', { body: { yard: 'MIAMI', rows: [{ unit: '7280', kind: 'trailer', here: true }, { unit: '18094', kind: 'trailer', here: false }] } });
  assert.equal(a.body.check.shift, 'morning'); assert.equal(a.body.check.missing, 2, '18094 not here + truck 4504 never added');
  await call('POST /truckmate/yard-checks', { body: { yard: 'MIAMI', rows: [{ unit: '7280', kind: 'trailer', here: true }, { unit: '18094', kind: 'trailer', here: true }] } });
  assert.equal(s.taYardChecks.list.length, 1, 'one per yard, day and shift'); assert.deepEqual(s.taYardChecks.list[0].result.missing.map((m) => m.unit), ['4504']); assert.ok(s.taYardChecks.list[0].updated);
  clock = Date.parse('2026-11-23T04:30:00Z');       // 11:30 PM Miami, no night check yet
  const g = await call('GET /truckmate/yard-checks', { query: { yard: 'MIAMI' } });
  assert.equal(g.body.today.morning.by, 'Yard Miami'); assert.equal(g.body.today.night, null); assert.equal(g.body.today.late.night, true);
  assert.equal(g.body.expected.length, 3); assert.deepEqual(g.body.yards.map((y) => y.key), ['MIAMI', 'VENTURA']);
  assert.equal((await call('POST /truckmate/yard-checks/photos', { body: { dataUrl: 'data:text/plain;base64,aGk=' } })).status, 400);
  const p = await call('POST /truckmate/yard-checks/photos', { body: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' } });
  assert.match(p.body.id, /^[a-f0-9]{12}$/);
  assert.ok((await call('GET /truckmate/yard-checks/photos/:id', { params: { id: p.body.id } })).sent);
  assert.ok(dueNow([], 'VENTURA', clock).shiftNow);
});

test('the design\'s fields (Nov 22): seen, office readiness, partial load, inside, condition / access, class, comments — saved and counted', () => {
  const rows = [
    cleanRow({ unit: '18094', kind: 'trailer', seen: true, readiness: 'assigned', loaded: 'loaded', inside: 'clean', reeferOn: true, setF: 34, tempF: 35, comments: 'Sealed · Assigned' }),
    cleanRow({ unit: '7304', kind: 'trailer', seen: true, readiness: 'available', loaded: 'empty', inside: 'cleaning' }),
    cleanRow({ unit: '4504', kind: 'truck', seen: true, readiness: 'hold', loaded: 'partial', condition: 'clear', access: 'blocked', companyTruck: true, localTruck: true, comments: 'Blocked by 7304', notes: 'PM due Monday' }),
    cleanRow({ unit: '2094', kind: 'truck', seen: true, readiness: 'down', condition: 'issue', ownerOperator: true, inside: 'clean', readinessX: 1 }),
    cleanRow({ unit: '9999', kind: 'truck', seen: false, readiness: 'bogus' }),
  ];
  assert.equal(rows[2].loaded, 'partial'); assert.equal(rows[3].inside, null, 'inside is for trailers'); assert.equal(rows[4].readiness, null);
  const r = compareCheck([{ unit: '9999', kind: 'truck' }], rows);
  assert.deepEqual(r.readiness, { available: { trucks: 0, trailers: 1 }, assigned: { trucks: 0, trailers: 1 }, hold: { trucks: 1, trailers: 0 }, down: { trucks: 1, trailers: 0 } });
  assert.deepEqual(r.classes, { companyTruck: 1, localTruck: 1, ownerOperator: 1, outsideCarrier: 0 });
  assert.deepEqual(r.observations.map((o) => [o.unit, o.why]), [['7304', 'needs cleaning'], ['4504', 'blocked in, on hold — needs attention'], ['2094', 'down — cannot use']]);
  assert.deepEqual(r.damage.map((d) => d.unit), ['2094'], 'a visible issue on a truck');
  assert.deepEqual(r.missing.map((m) => m.unit), ['9999'], 'on GPS, not ticked Seen');
  assert.equal(r.counts.partial, 1);
  assert.equal(rows[2].notes, 'PM due Monday'); assert.equal(rows[0].notes, null, 'truck comments are for trucks');
  assert.equal(r.observations[1].comments, 'Blocked by 7304 · PM due Monday');
});

test('the calendar: one yard\'s checks in a month, by day, morning first', () => {
  const mk = (id, yard, day, shift) => ({ id, yard, day, shift, by: 'Luis', at: `${day}T12:00:00Z`, result: { counts: { here: 3 }, missing: [], extra: [], reefer: [], damage: [], unchecked: [] } });
  const d = checksByDay([mk('a', 'MIAMI', '2026-11-22', 'night'), mk('b', 'MIAMI', '2026-11-22', 'morning'), mk('c', 'VENTURA', '2026-11-22', 'morning'), mk('e', 'MIAMI', '2026-10-30', 'night')], 'MIAMI', '2026-11');
  assert.deepEqual(Object.keys(d), ['2026-11-22']);
  assert.deepEqual(d['2026-11-22'].map((x) => x.shift), ['morning', 'night']);
  assert.equal(d['2026-11-22'][0].here, 3);
});

test('the summary email: totals, readiness, needs attention, against GPS, every unit; sent on submit and as a mock', async () => {
  const { yardCheckEmail, mockYardCheck } = await import('../yardcheckemail.js');
  const m = yardCheckEmail(mockYardCheck(Date.parse('2026-11-23T04:30:00Z')), { dvrUnits: new Set(['trailer:18094']) });
  assert.equal(m.subject, 'Yard check // Miami yard // night // 5 trucks · 5 trailers · 5 need attention');
  assert.match(m.html, /Trucks in the yard/); assert.match(m.html, /3 company · 1 local · 1 owner op · 0 OC/);
  assert.match(m.html, /2 loaded · 2 empty · 1 partial/);
  assert.match(m.html, /<b>Truck 2405<\/b> · hold, issue found, blocked in/);
  assert.match(m.html, /<b>Trailer 18094<\/b> · reefer 41°F \/ set 34°F, DVIR open/);
  assert.ok(!/Against GPS|On GPS, not found/.test(m.html + m.text), 'no Against GPS in the email (Nov 23)');
  assert.match(m.text, /Every unit:\n- Truck 2405/);
  assert.ok(!/<script/i.test(yardCheckEmail({ yard: 'MIAMI', shift: 'night', by: '<script>x</script>', checkedAt: new Date().toISOString(), rows: [] }).html), 'typed text is escaped');
  // sent on submit, and the mock on request
  const s = {}; const db = { enabled: true, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => (s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d)) };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.pop(); }, post: (p, ...h) => { routes[`POST ${p}`] = h.pop(); } };
  const sent = [];
  initYardCheck(app, { requireAuth: () => {}, db, report: async () => REPORT, trucks: async () => TRUCKS, now: () => Date.parse('2026-11-22T13:00:00Z'), env: {}, sendMail: async (x) => sent.push(x) });
  const call = async (key, body) => { const out = {}; await routes[key]({ body, query: {}, params: {}, user: { name: 'Luis' } }, { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }); return out; };
  await call('POST /truckmate/yard-checks', { yard: 'MIAMI', rows: [{ unit: '7280', kind: 'trailer', here: true }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']); assert.match(sent[0].subject, /^Yard check \/\/ Miami yard \/\/ morning/);
  const p = await call('POST /truckmate/yard-checks/email-preview', {});
  assert.deepEqual(p.body.to, ['ntellez@floridabeauty.us']); assert.match(sent[1].subject, /Luis|5 trucks/);
});

test('a truck in the shop, one needing the dealer, one at the dealer with its days counted from the day it went (Nov 24)', async () => {
  const { dealerDays } = await import('../yardcheck.js');
  const shop = cleanRow({ unit: '2216', kind: 'truck', here: true, condition: 'shop' });
  const need = cleanRow({ unit: '2217', kind: 'truck', here: true, condition: 'dealer' });
  const at = cleanRow({ unit: '2218', kind: 'truck', here: true, condition: 'dealer', atDealer: true, dealerSince: '2026-11-20' });
  const back = cleanRow({ unit: '2219', kind: 'truck', here: true, atDealer: false, dealerSince: '2026-11-20' });
  assert.deepEqual([shop.condition, need.condition, at.atDealer, at.dealerSince, back.dealerSince], ['shop', 'dealer', true, '2026-11-20', null]);
  assert.equal(cleanRow({ unit: '9', kind: 'trailer', condition: 'shop', atDealer: true }).atDealer, false);
  assert.equal(dealerDays('2026-11-20', '2026-11-24'), 4);
  const r = compareCheck([], [shop, need, at, back], '2026-11-24');
  assert.deepEqual(r.observations.map((o) => [o.unit, o.why]), [['2216', 'in the shop'], ['2217', 'needs the dealer'], ['2218', 'at the dealer (4 days)']]);
});

test('issues added one by one stay a list on the unit (Nov 24)', () => {
  const r = cleanRow({ unit: '2618', kind: 'truck', here: true, readiness: 'available', issues: ['Needs wash', ' ', 'Left mirror cracked'], comments: 'Needs wash · Left mirror cracked' });
  assert.deepEqual(r.issues, ['Needs wash', 'Left mirror cracked']);
  assert.equal(r.comments, 'Needs wash · Left mirror cracked');
  assert.deepEqual(cleanRow({ unit: '1', kind: 'truck' }).issues, []);
});

test('units on a load in TruckMate: the trip, where it goes and the last open bill\'s delivery date; finished trips left out (Nov 24)', async () => {
  const { unitLoads } = await import('../yardcheck.js');
  const active = { trips: {
    a: { item: { trip: { tripNumber: 627700, trailer: '07280', powerUnit: '4504', destZoneDesc: 'WINCHESTER, MA', status: 'ARRCONS' }, freightBills: [{ deliverBy: '2026-11-23T00:00:00', actualDelivery: '2026-11-23T10:00:00' }, { deliverBy: '2026-11-25T08:00:00' }, { deliverBy: '2026-11-24T00:00:00' }] } },
    b: { item: { trip: { tripNumber: 627001, trailer: '18094' }, freightBills: [{ deliverBy: '2026-11-20', actualDelivery: '2026-11-20T09:00' }] } } } };
  const m = unitLoads(active);
  assert.deepEqual(m['trailer:7280'], { trip: '627700', to: 'WINCHESTER, MA', deliverBy: '2026-11-25T08:00', status: 'ARRCONS' });
  assert.equal(m['truck:4504'].trip, '627700');
  assert.equal(m['trailer:18094'], undefined);
});

test('the shared draft: cards merge card by card, the newer one wins, a removed card stays removed (Nov 24)', async () => {
  const { mergeDraft } = await import('../yardcheck.js');
  let d = mergeDraft({}, { rows: [{ id: 'a', unit: '4504', kind: 'truck', updatedAt: 100 }, { id: 'b', unit: '7304', kind: 'trailer', updatedAt: 100 }] }, 1000);
  d = mergeDraft(d, { rows: [{ id: 'a', unit: '4504', readiness: 'hold', updatedAt: 200 }] }, 1100);        // phone 1 edits a
  d = mergeDraft(d, { rows: [{ id: 'a', unit: '4504', readiness: 'available', updatedAt: 150 }] }, 1200);    // an older copy from phone 2 loses
  assert.equal(d.rows.a.readiness, 'hold');
  d = mergeDraft(d, { removed: ['b'] }, 1300);
  d = mergeDraft(d, { rows: [{ id: 'b', unit: '7304', updatedAt: 120 }] }, 1400);                         // a stale copy doesn't bring it back
  assert.equal(d.rows.b, undefined);
  d = mergeDraft(d, { rows: [{ id: 'c', unit: '2216', kind: 'truck' }] }, 1500);
  assert.equal(d.rows.c.updatedAt, 0);
  d = mergeDraft(d, { rows: [{ id: 'a', unit: '4504', readiness: 'available' }] }, 1600);                    // a carried copy never beats an edit
  assert.equal(d.rows.a.readiness, 'hold');
  assert.deepEqual(Object.keys(d.rows).sort(), ['a', 'c']);
});

test('the shared draft routes: two devices fill one sheet; sending the check clears it (Nov 24)', async () => {
  const s = {}; const db = { enabled: true, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => (s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d)) };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.pop(); }, post: (p, ...h) => { routes[`POST ${p}`] = h.pop(); } };
  let clock = Date.parse('2026-11-22T13:00:00Z');   // 8 AM in Miami
  initYardCheck(app, { requireAuth: () => {}, db, report: async () => REPORT, trucks: async () => TRUCKS, now: () => clock });
  const call = async (key, { body = {}, query = {}, params = {} } = {}) => { const out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; }, set() {}, send(b) { out.sent = b; } }; await routes[key]({ body, query, params, user: { name: 'Yard Miami' } }, res, () => {}); return out; };
  assert.equal((await call('POST /truckmate/yard-checks', { body: { yard: 'X', rows: [] } })).status, 400);
  const q = { yard: 'MIAMI', day: '2026-11-22', shift: 'morning' };
  assert.equal((await call('GET /truckmate/yard-checks/draft', { query: { yard: 'MIAMI' } })).status, 400);
  await call('POST /truckmate/yard-checks/draft', { body: { ...q, rows: [{ id: 'p1', unit: '7280', kind: 'trailer', here: true, updatedAt: 10 }] } });       // the iPad
  const pc = await call('POST /truckmate/yard-checks/draft', { body: { ...q, rows: [{ id: 'p2', unit: '4504', kind: 'truck', here: true, updatedAt: 11 }] } });   // the office computer
  assert.deepEqual(pc.body.rows.map((r) => r.unit).sort(), ['4504', '7280']);
  assert.deepEqual((await call('GET /truckmate/yard-checks/draft', { query: q })).body.rows.length, 2);
  await call('POST /truckmate/yard-checks', { body: { yard: 'MIAMI', draftDay: '2026-11-22', rows: [{ unit: '7280', kind: 'trailer', here: true }] } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual((await call('GET /truckmate/yard-checks/draft', { query: q })).body.rows, []);
});

test('shop updates: each update with when it should be ready, newest first; a trailer can be in the shop (Nov 24)', async () => {
  const { addShopUpdate, unitKey } = await import('../yardcheck.js');
  let l = addShopUpdate([], { text: 'Waiting on turbo actuator', eta: '2026-11-26T15:00', by: 'Luis' }, Date.parse('2026-11-24T20:00:00Z'));
  l = addShopUpdate(l, { text: 'Part arrived, installing', by: 'Mechanic' }, Date.parse('2026-11-25T14:00:00Z'));
  assert.deepEqual(l.map((u) => [u.text, u.eta, u.by]), [['Part arrived, installing', null, 'Mechanic'], ['Waiting on turbo actuator', '2026-11-26T15:00', 'Luis']]);
  assert.equal(addShopUpdate(l, { text: '  ' }), null);
  assert.equal(addShopUpdate([], { eta: '2026-11-27' })[0].eta, '2026-11-27');
  assert.equal(unitKey('trailer', 'TL 07280'), 'trailer:7280');
  assert.equal(cleanRow({ unit: '7280', kind: 'trailer', condition: 'shop' }).condition, 'shop');
  assert.equal(cleanRow({ unit: '7280', kind: 'trailer', condition: 'issue' }).condition, null);
});

test('a local truck counts as local, never as available (Nov 24)', () => {
  const r = cleanRow({ unit: '935', kind: 'truck', here: true, readiness: 'available', localTruck: true });
  assert.deepEqual([r.localTruck, r.readiness], [true, null]);
  const c = compareCheck([], [r, cleanRow({ unit: '2216', kind: 'truck', here: true, readiness: 'available' })]);
  assert.deepEqual([c.readiness.available.trucks, c.classes.localTruck], [1, 1]);
  assert.equal(cleanRow({ unit: '935', kind: 'truck', readiness: 'hold', localTruck: true }).readiness, 'hold');
});

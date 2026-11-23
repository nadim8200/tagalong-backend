import test from 'node:test';
import assert from 'node:assert/strict';
import { yardClock, expectedUnits, cleanRow, compareCheck, dueNow, initYardCheck } from '../yardcheck.js';

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

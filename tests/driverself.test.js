import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSelf, applySelfPhones } from '../driverself.js';
import { mergeRoster } from '../driverauth.js';
import { cleanPretrip, dvrEmail } from '../dvr.js';

test('my profile: cleaned — cell first, 10-digit numbers, email checked, at least one cell (Nov 26)', () => {
  const c = cleanSelf({ name: '  Juan   Avila ', phones: [{ number: '(305) 555-0199', label: 'Home' }, { number: '1-786-555-0142', label: 'Cell' }], email: 'Juan@Gmail.com', emergency: { name: 'Ana', phone: '305 555 0100' } });
  assert.deepEqual(c.profile.phones, [{ number: '7865550142', label: 'Cell' }, { number: '3055550199', label: 'Home' }]);
  assert.equal(c.profile.name, 'Juan Avila'); assert.equal(c.profile.email, 'juan@gmail.com'); assert.deepEqual(c.profile.emergency, { name: 'Ana', phone: '3055550100' });
  assert.equal(c.photo, undefined, 'no picture sent → the old one stays');
  assert.match(cleanSelf({ name: 'J', phones: [{ number: '305555', label: 'Cell' }] }).error, /10-digit/);
  assert.match(cleanSelf({ name: 'J', phones: [{ number: '3055550199', label: 'Home' }] }).error, /cell/);
  assert.match(cleanSelf({ name: 'J', phones: [{ number: '3055550199', label: 'Cell' }], email: 'nope' }).error, /email/);
  assert.match(cleanSelf({ name: 'J', phones: [{ number: '3055550199', label: 'Cell' }], photo: 'javascript:alert(1)' }).error, /picture/);
  assert.equal(cleanSelf({ name: 'J', phones: [{ number: '3055550199', label: 'Cell' }], photo: null }).photo, null);
});

test('the driver\'s own cell wins: on the board (texts, calls, Jarvis) and first on the roster (sign-in, Driver profiles)', () => {
  const items = [{ trip: { tripNumber: '1', driver: '0612', driver2: '0700' }, _samsara: { driver1Info: { id: '9', name: 'Juan', phone: '+13055550000' }, driver2Info: { name: 'Leo', phone: '3055551111' } } }];
  applySelfPhones(items, { 612: { phones: [{ number: '7865550142', label: 'Cell' }] } });
  assert.equal(items[0]._samsara.driver1Info.phone, '7865550142'); assert.equal(items[0]._samsara.driver1Info.samsaraPhone, '+13055550000');
  assert.equal(items[0]._samsara.driver2Info.phone, '3055551111', 'the co-driver keeps Samsara\'s');
  const r = mergeRoster([{ code: '0612', name: 'JUAN AVILA', phone: '3055550000' }], {}, {}, { 612: { name: 'Juan Avila', phones: [{ number: '7865550142', label: 'Cell' }], email: 'j@x.com', updatedAt: '2026-11-26T12:00:00Z' } });
  assert.equal(r[0].phone, '7865550142'); assert.deepEqual(r[0].phones.map((x) => x.from), ['driver', 'samsara']);
  assert.equal(r[0].name, 'Juan Avila'); assert.equal(r[0].email, 'j@x.com'); assert.equal(r[0].samsaraDiffers, true);
});

test('pre-trip: problems become DVIRs on the unit; untouched items are OK; a problem needs a note (Nov 26)', () => {
  const c = cleanPretrip({ truck: '4504', trailer: '7280', trip: '627700', items: [{ key: 'tlights', status: 'bad', note: 'Right marker burned', safe: true, checked: true }, { key: 'reefer', status: 'bad', note: 'Door switch', safe: false }, { key: 'tires', status: 'ok' }, { key: 'nope', status: 'bad' }] });
  assert.equal(c.pretrip.items.length, 3);
  assert.deepEqual(c.problems.map((p) => [p.part, p.category, p.trailer, p.unsafe]), [['trailer', 'lights', '7280', false], ['reefer', 'reefer', '7280', true]]);
  assert.match(cleanPretrip({ truck: '1', trailer: '2', items: [{ key: 'doors', status: 'bad', note: '' }] }).error, /Doors and seals/);
  assert.match(cleanPretrip({ truck: '1', items: [{ key: 'doors', status: 'bad', note: 'torn' }] }).error, /trailer/);
  const m = dvrEmail({ ...c.problems[1], source: 'pretrip', by: 'Juan', at: '2026-11-26T12:00:00Z' });
  assert.match(m.subject, /^PRE-TRIP DVIR \/\/ REEFER 7280 \/\/ REEFER UNIT \/\/ NOT SAFE TO DRIVE \/\/ TRIP 627700$/);
  assert.match(m.html, /DRIVER SAYS NOT SAFE TO DRIVE/);
});

test('a driver\'s reports: DVIRs, pre-trip problems and breakdowns, open / closed, newest first (Nov 26)', async () => {
  const { driverReports } = await import('../driverreports.js');
  const dvrs = { a: { id: 'a', driverCode: '0612', part: 'trailer', trailer: '7280', category: 'lights', itemLabel: 'Lights', source: 'pretrip', text: 'Marker burned', at: '2026-11-26T12:00:00Z', status: 'open', files: [{}] },
    b: { id: 'b', driverCode: '612', part: 'truck', truck: '4504', category: 'tires', text: 'Low tire', at: '2026-11-20T12:00:00Z', status: 'completed', completedAt: '2026-11-21T10:00:00Z', completedBy: 'Luis', completedNote: 'Replaced' },
    c: { id: 'c', driverCode: '0999', part: 'truck', category: 'air', at: '2026-11-25T12:00:00Z' } };
  const breakdowns = { k: { id: 'k', driverCode: '0612', part: 'reefer', trailer: '7280', category: 'nostart', status: 'stopped', at: '2026-11-24T12:00:00Z', closed: 'resolved', closedAt: '2026-11-24T15:00:00Z', closedBy: 'Mary' } };
  const r = driverReports('0612', { dvrs, breakdowns, pretrips: [{ driverCode: '0612', at: '2026-11-26T12:00:00Z' }, { driverCode: '0999' }], now: Date.parse('2026-11-26T13:00:00Z') });
  assert.deepEqual(r.list.map((x) => [x.id, x.from, x.unit, x.problem, x.status]), [['a', 'Pre-trip', 'Trailer 7280', 'Lights', 'open'], ['k', 'Breakdown', 'Reefer · trailer 7280', "Reefer won't start", 'closed'], ['b', 'DVIR', 'Truck 4504', 'Tires', 'closed']]);
  assert.deepEqual(r.counts, { total: 3, dvrs: 2, breakdowns: 1, open: 1, closed: 2, pretrips: 1, last30: 3, lastPretripAt: '2026-11-26T12:00:00Z' });
  assert.equal(r.list[2].closedNote, 'Replaced'); assert.equal(r.list[1].closedNote, 'Resolved');
});

test('a DVIR goes to the Breakdowns tab as a road call; completing that road call closes the DVIR (Nov 26)', async () => {
  const { initRoadCalls } = await import('../roadcall.js');
  const { initDvr } = await import('../dvr.js');
  const kv = new Map();
  const db = { enabled: true, pool: { query: async () => ({ rows: [] }) }, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); }, update: async (k, fn, d) => { const v = fn(kv.has(k) ? kv.get(k) : d); kv.set(k, v); return v; } };
  const routes = {}; const app = { get() {}, put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; } };
  const rcs = initRoadCalls(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), sendMail: null });
  initDvr(app, { db, secret: 's', requireDriver: (q, r, n) => n(), requireAuth: (q, r, n) => n(), sendMail: async () => {}, recipients: async () => ['x@floridabeauty.us'] });
  const res = () => { const out = {}; return { out, status() { return this; }, json(b) { Object.assign(out, b); return this; } }; };
  const r1 = res();
  await routes['POST /driver/me/pretrip']({ driver: { code: '0612', name: 'Juan' }, body: { truck: '4504', trailer: '7280', trip: '627700', items: [{ key: 'doors', status: 'bad', note: 'Seal torn', safe: true }] } }, r1);
  assert.equal(r1.out.problems, 1);
  const [rc] = await rcs.list();
  assert.equal(Object.values(kv.get('taDvr:florida-beauty'))[0].roadCall, rc.id);
  assert.match(rc.details, /^Pre-trip DVIR · Trailer 7280 · Doors and seals \(fix when back\): Seal torn/);
  const statusRoute = Object.keys(routes).find((k) => /roadcalls\/:id$/.test(k));
  await routes[statusRoute]({ params: { id: rc.id }, body: { status: 'completed' }, user: { name: 'Mary' } }, res());
  const dvr = Object.values(kv.get('taDvr:florida-beauty'))[0];
  assert.equal(dvr.status, 'completed'); assert.equal(dvr.completedBy, 'Mary'); assert.match(dvr.completedNote, /Road call .* completed/);
});

test('the other way: closing the DVIR (yard check card / Yard → DVIRs) completes its road call; a breakdown\'s road call stays (Nov 26)', async () => {
  const { initRoadCalls } = await import('../roadcall.js');
  const { initDvr } = await import('../dvr.js');
  const { initYardDvr } = await import('../yarddvr.js');
  const kv = new Map();
  const db = { enabled: true, pool: { query: async () => ({ rows: [] }) }, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); }, update: async (k, fn, d) => { const v = fn(kv.has(k) ? kv.get(k) : d); kv.set(k, v); return v; } };
  const routes = {}; const app = { get() {}, put() {}, post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const rcs = initRoadCalls(null, { db, getBoard: async () => ({ trips: [] }), sendMail: null });
  initDvr(app, { db, secret: 's', requireDriver: (q, r, n) => n(), requireAuth: (q, r, n) => n(), sendMail: async () => {}, recipients: async () => ['x@floridabeauty.us'] });
  initYardDvr(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), hubOf: () => null, sendMail: async () => {}, sendText: async () => {} });
  const res = { status() { return this; }, json() { return this; } };
  await routes['/driver/me/pretrip']({ driver: { code: '0612', name: 'Juan' }, body: { truck: '4504', trailer: '7280', trip: '627700', items: [{ key: 'doors', status: 'bad', note: 'Seal torn' }, { key: 'tlights', status: 'bad', note: 'Marker out' }] } }, res);
  const [a, b] = Object.values(kv.get('taDvr:florida-beauty'));
  assert.equal(a.roadCall, b.roadCall, 'both problems on one road call (same truck / trip)');
  await routes['/truckmate/yard-dvrs/:id/complete']({ params: { id: a.id }, body: { note: 'New seal' }, user: { name: 'Luis' } }, res);
  assert.equal((await rcs.list())[0].status !== 'completed', true, 'one DVIR still open → the road call stays open');
  await routes['/truckmate/yard-dvrs/:id/complete']({ params: { id: b.id }, body: {}, user: { name: 'Luis' } }, res);
  assert.equal((await rcs.list())[0].status, 'completed');
  // a breakdown's road call is never closed from a DVIR
  const bk = await rcs.open({ trip: '627800', truck: '39', source: 'app', report: 'bk1', details: 'Tire' });
  kv.set('taDvr:florida-beauty', { ...kv.get('taDvr:florida-beauty'), z: { id: 'z', part: 'truck', truck: '39', category: 'tires', status: 'open', roadCall: bk.id, at: '2026-11-26T12:00:00Z' } });
  await routes['/truckmate/yard-dvrs/:id/complete']({ params: { id: 'z' }, body: {}, user: { name: 'Luis' } }, res);
  assert.notEqual((await rcs.list()).find((x) => x.id === bk.id).status, 'completed');
});

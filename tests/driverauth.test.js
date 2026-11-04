import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { initDriverAuth, loadsFor, pinProblem, sealPin, openPin } from '../driverauth.js';

const SECRET = 's';
const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const trip = (n, status, driver) => ({ trip: { tripNumber: n, status, driver, driver2: null, powerUnit: '4504', trailer: '7136', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [{ billNumber: 'M5055135', endZoneDescription: 'EAST POINT, GA', billToName: 'ATLANTA FLOWER', pieces: 12 }] });
const BOARD = [trip('626265', 'DEPSHIP', '0986'), trip('626300', 'DISP', '986'), trip('626200', 'DELVD', '0986'), trip('626301', 'DEPSHIP', '2473')];
const FRANK = { code: '0986', name: 'Frank U', phone: '(305) 555-0100' };

function setup({ roster = [FRANK] } = {}) {
  const db = mem(); const routes = {}; let clock = 1e12; let list = roster;
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAdmin = (req, res, next) => requireAuth(req, res, () => (req.user.admin || req.user.companyAdmin ? next() : res.status(403).json({ error: 'Admins only.' })));
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  initDriverAuth(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, requireAdmin, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => list, getBoard: async () => ({ trips: BOARD }), docsLink: async (site, t) => `https://x/t/tok-${t}`, now: () => clock });
  const call = async (key, { body = {}, params = {}, token = null, ip = '1.1.1.1' } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } };
    const req = { body, params, ip, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
    return out;
  };
  const login = async (pin = '2580') => { const first = await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '305-555-0100', pin } }); if (first.status === 428) return (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '305-555-0100', newPin: pin } })).body.token; return first.body.token; };
  return { db, call, login, at: (ms) => { clock = ms; }, now: () => clock, setRoster: (r) => { list = r; } };
}

test('a driver\'s loads by TruckMate driver ID: rolling now, booked next, never finished ones', () => {
  const l = loadsFor('0986', BOARD);
  assert.deepEqual(l.current.map((x) => x.trip), ['626265']); assert.deepEqual(l.next.map((x) => x.trip), ['626300'], '986 and 0986 are the same driver');
  assert.equal(l.current[0].stops[0].pieces, 12);
});

test('first sign-in makes a PIN; after that the ID, cell and PIN; and they stay signed in', async () => {
  const h = setup();
  const first = await h.call('POST /driver/auth/login', { body: { driverId: '986', phone: '3055550100' } });
  assert.equal(first.status, 428); assert.equal(first.body.createPin, true);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '986', phone: '3055550100', newPin: '1234' } })).status, 400, 'too easy');
  const made = await h.call('POST /driver/auth/login', { body: { driverId: '986', phone: '3055550100', newPin: '2580' } });
  assert.equal(made.status, 200);
  assert.ok(!JSON.stringify(h.db.s).includes('2580'), 'never stored as written');
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '1111' } })).status, 401);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '1357' } })).status, 401, 'a PIN on file can\'t be replaced at sign-in');
  const r = await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } });
  assert.equal(r.status, 200); assert.equal(r.body.name, 'Frank U');
  const t = jwt.decode(r.body.token);
  assert.equal(t.role, 'driver'); assert.ok(t.exp - t.iat >= 3600 * 24 * 3650, 'until they sign out');
  const me = await h.call('GET /driver/me', { token: r.body.token });
  assert.equal(me.body.driverId, '0986'); assert.deepEqual(me.body.current.map((x) => x.trip), ['626265']);
});

test('PIN rules, and the PIN is kept encrypted but readable by admins', () => {
  for (const p of ['123', '12345', 'abcd', '0000', '1234', '4321', '6789']) assert.ok(pinProblem(p), p);
  for (const p of ['2580', '1357', '9024']) assert.equal(pinProblem(p), null, p);
  const sealed = sealPin('2580', 'k');
  assert.ok(!sealed.includes('2580')); assert.equal(openPin(sealed, 'k'), '2580'); assert.throws(() => openPin(sealed, 'other'));
});

test('only admins see a PIN, give a new one, or clear it; a new PIN signs the driver out', async () => {
  const h = setup();
  const token = await h.login();
  const admin = jwt.sign({ role: 'dispatcher', companyAdmin: true, name: 'Ronen' }, SECRET);
  const dispatch = jwt.sign({ role: 'dispatcher', name: 'Gio' }, SECRET);
  assert.equal((await h.call('POST /admin/driver-pins/:id/show', { token: dispatch, params: { id: '0986' } })).status, 403, 'not regular dispatch');
  assert.equal((await h.call('GET /admin/driver-pins', { token: dispatch })).status, 403);
  const list = (await h.call('GET /admin/driver-pins', { token: admin })).body.drivers;
  assert.deepEqual(list[0], { driverId: '0986', name: 'Frank U', cell: '•••0100', hasPin: true, pinSetAt: list[0].pinSetAt, pinSetBy: 'Frank U' });
  assert.equal((await h.call('POST /admin/driver-pins/:id/show', { token: admin, params: { id: '986' } })).body.pin, '2580');
  h.at(h.now() + 1000);
  const fresh = (await h.call('POST /admin/driver-pins/:id/new', { token: admin, params: { id: '0986' } })).body.pin;
  assert.equal(pinProblem(fresh), null);
  assert.equal((await h.call('GET /driver/me', { token })).status, 401, 'signed out by the new PIN');
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: fresh } })).status, 200);
  await h.call('POST /admin/driver-pins/:id/clear', { token: admin, params: { id: '0986' } });
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: fresh } })).status, 428, 'cleared: they make a new one');
});

test('the driver changes their own PIN with the current one', async () => {
  const h = setup();
  const token = await h.login();
  h.at(h.now() + 1000);
  assert.equal((await h.call('POST /driver/me/pin', { token, body: { current: '9999', next: '1357' } })).status, 401);
  const r = await h.call('POST /driver/me/pin', { token, body: { current: '2580', next: '1357' } });
  assert.equal(r.status, 200);
  assert.equal((await h.call('GET /driver/me', { token })).status, 401, 'the old session is out');
  assert.equal((await h.call('GET /driver/me', { token: r.body.token })).status, 200, 'this phone stays in');
});

test('a wrong ID or cell is refused, and repeated tries are stopped', async () => {
  const h = setup();
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3059999999' } })).status, 401);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '2473', phone: '3055550100' } })).status, 401);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '', phone: '3055550100' } })).status, 400);
  for (let i = 0; i < 10; i += 1) await h.call('POST /driver/auth/login', { body: { driverId: String(1000 + i), phone: '3055550100' }, ip: `9.9.9.${i}` }); // eslint-disable-line no-await-in-loop
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100' } })).status, 429, 'that cell, too many wrong tries');
  h.at(h.now() + 16 * 60000);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100' } })).status, 428, 'after 15 minutes');
});

test('only their own loads; a driver who left, or whose cell changed, is out; other logins are refused', async () => {
  const h = setup();
  const token = await h.login();
  assert.deepEqual((await h.call('POST /driver/me/loads/:trip/link', { token, params: { trip: '626265' } })).body, { token: 'tok-626265' });
  assert.equal((await h.call('POST /driver/me/loads/:trip/link', { token, params: { trip: '626301' } })).status, 404, 'someone else\'s load');
  assert.equal((await h.call('GET /driver/me', { token: jwt.sign({ role: 'dispatcher' }, SECRET) })).status, 403);
  h.setRoster([{ ...FRANK, phone: '3051112222' }]);
  assert.equal((await h.call('GET /driver/me', { token })).status, 401, 'cell changed');
  h.setRoster([]);
  assert.equal((await h.call('GET /driver/me', { token })).status, 401, 'left');
});

test('their paperwork history: loads they had, nobody else\'s', async () => {
  const h = setup();
  const token = await h.login();
  await h.call('GET /driver/me', { token });
  h.db.s['taDriverPaperwork:florida-beauty'] = [{ trip: '626265', kind: 'pod', bill: 'M5055135', confirmation: 'FB-1', docIds: [1] }, { trip: '626301', kind: 'pod', confirmation: 'FB-2' }];
  const p = (await h.call('GET /driver/me/paperwork', { token })).body.paperwork;
  assert.deepEqual(p.map((x) => x.confirmation), ['FB-1']); assert.equal(p[0].docIds, undefined);
});

test('a driver sees the load message dispatch sent on each load and taps OK', async () => {
  const { initDriverAuth: init } = await import('../driverauth.js');
  const db = mem(); const routes = {}; const okd = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const sheets = { visible: (x) => !!x, get: async (t) => (t === '626265' ? { trip: t, bill: 'B1', stops: [{ kind: 'pickup', name: 'QUIRCH FOODS', city: 'MIAMI', state: 'FL' }] } : null), forDriver: async (x) => (x ? { ...x, stops: x.stops.map((s) => ({ ...s, map: 'm' })) } : null), dropped: async (t, by, o) => (t === '626265' ? { by, ...o } : null), confirm: async (t, by) => { okd.push([t, by]); return t === '626265' ? { confirmedAt: 'now' } : null; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => [FRANK], getBoard: async () => ({ trips: BOARD }), sheets });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '2580' } });
  const token = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } })).body.token;
  const me = await call('GET /driver/me', { token });
  assert.equal(me.body.current[0].sheet.stops[0].map, 'm'); assert.deepEqual(me.body.next, [], 'a next load dispatch hasn\'t sent stays off the tab');
  assert.equal((await call('POST /driver/me/loads/:trip/ok', { token, params: { trip: '626265' } })).body.ok, true);
  assert.deepEqual(okd, [['626265', 'Frank U']]);
  assert.equal((await call('POST /driver/me/loads/:trip/ok', { token, params: { trip: '626301' } })).status, 404, 'not theirs');
  assert.equal((await call('POST /driver/me/loads/:trip/ok', { token, params: { trip: '626300' } })).status, 404, 'no sheet yet');
  const drop = await call('POST /driver/me/loads/:trip/dropped', { token, params: { trip: '626265' }, body: { pickedUp: '7301' } });
  assert.deepEqual(drop.body.dropped, { by: 'Frank U', pickedUp: '7301', truck: '4504', trailer: '7136' });
  assert.equal((await call('POST /driver/me/loads/:trip/dropped', { token, params: { trip: '626300' } })).status, 404, 'no yard set');
});

test('driver phones: registered on the profile, dispatch messages reach both drivers, unread counts per load', async () => {
  const { initDriverAuth: init } = await import('../driverauth.js');
  const db = mem(); const routes = {}; const sent = []; let board = [trip('626265', 'DEPSHIP', '0986')];
  board[0].trip.driver2 = '2473';
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  const push = { sendToTokens: async (tokens, m) => { sent.push({ to: tokens.map((t) => t.token), ...m }); return []; } };
  const d = init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => [FRANK, { code: '2473', name: 'Ana B', phone: '3055550200' }], getBoard: async () => ({ trips: board }), push, unreadFor: async (site, t) => (t === '626265' ? 2 : 0) });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '2580' } });
  const token = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } })).body.token;
  assert.equal((await call('POST /driver/me/push', { token, body: { token: 'short' } })).status, 400);
  await call('POST /driver/me/push', { token, body: { token: 'a'.repeat(64), platform: 'ios' } });
  assert.equal((await call('GET /driver/me', { token })).body.current[0].unread, 2);
  await d.notifyTrip('626265', 'Call the receiver 1 hour before', 'Haraft J Sierra (console)');
  assert.equal(sent.length, 1, 'only 0986 has a phone signed in; 2473 has none'); assert.equal(sent[0].title, 'Haraft J Sierra · trip 626265'); assert.equal(sent[0].data.tab, 'chat');
  const held = init({ get() {}, post() {}, put() {}, delete() {} }, { requireAuth, secret: 'k', db, sign: () => 'x', roster: async () => [], getBoard: async () => ({ trips: board }), push, training: { hold: async () => ({ held: true }) } });
  assert.deepEqual(await held.notify('0986', { title: 't', body: 'b' }), { held: true }, 'training mode holds it');
});

test('the Next load tab shows only loads a dispatcher sent; the load they are on always shows', async () => {
  const { initDriverAuth: init } = await import('../driverauth.js');
  const db = mem(); const routes = {};
  const store = { '626300': { trip: '626300', fromRateCon: true, stops: [] } };   // Jarvis's draft, not sent
  const sheets = { get: async (t) => store[t] || null, visible: (x) => !!x && !(x.fromRateCon && !x.sentAt), forDriver: async (x) => x };
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => [FRANK], getBoard: async () => ({ trips: BOARD }), sheets });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '2580' } });
  const token = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } })).body.token;
  let me = (await call('GET /driver/me', { token })).body;
  assert.deepEqual([me.current.map((l) => l.trip), me.next.map((l) => l.trip)], [['626265'], []], 'not sent yet: no next load');
  assert.equal(me.current[0].sheet, null);
  store['626300'] = { ...store['626300'], sentAt: '2026-11-03T22:00:00Z' };
  me = (await call('GET /driver/me', { token })).body;
  assert.deepEqual(me.next.map((l) => l.trip), ['626300'], 'sent: it shows');
});

test('the console\'s Driver app section: each driver signed in or not, notifications, last in the app; the load sent, notified, opened, confirmed', async () => {
  const { initDriverAuth: init, driverAppView } = await import('../driverauth.js');
  const db = mem(); const routes = {}; let clock = Date.parse('2026-11-03T20:00:00Z');
  const board = [trip('626265', 'DEPSHIP', '0986'), trip('626300', 'DISP', '0986')]; board[0].trip.driver2 = '5555';
  const store = { '626300': { trip: '626300', by: 'Geo', sentAt: '2026-11-03T19:00:00Z', stops: [] }, '626265': { trip: '626265', fromRateCon: true, stops: [] } };
  const sheets = { all: async () => store, get: async (t) => store[t] || null, visible: (x) => !!x && !(x.fromRateCon && !x.sentAt), forDriver: async (x) => x };
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  const push = { sendToTokens: async () => [] };
  const d = init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => [FRANK], getBoard: async () => ({ trips: board }), sheets, push, now: () => clock });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  const staff = jwt.sign({ id: 1, name: 'Geo', role: 'dispatcher' }, SECRET);
  let v = (await call('GET /truckmate/driver-app', { token: staff })).body.trips;
  assert.deepEqual(v['626265'].drivers.map((x) => [x.code, x.onList, x.hasCell, x.signedIn]), [['986', true, true, false], ['5555', false, false, false]], '5555 isn\'t on the driver list: they can\'t sign in');
  assert.equal(v['626265'].sent, null, 'Jarvis\'s unsent draft isn\'t sent');
  assert.deepEqual(v['626300'].sent, { at: '2026-11-03T19:00:00Z', by: 'Geo' });
  await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '2580' } });
  const token = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } })).body.token;
  await call('POST /driver/me/push', { token, body: { token: 'a'.repeat(64) } });
  await call('GET /driver/me', { token });
  assert.equal(await d.notifyTrip('626300', 'New load: trip 626300', 'Geo'), 'sent');
  assert.equal((await call('POST /driver/me/loads/:trip/opened', { token, params: { trip: '626201' } })).status, 404, 'not their load');
  await call('POST /driver/me/loads/:trip/opened', { token, params: { trip: '626300' }, body: { sentAt: '2026-11-03T19:00:00Z' } });
  v = (await call('GET /truckmate/driver-app', { token: staff })).body.trips['626300'];
  assert.deepEqual([v.drivers[0].signedIn, v.drivers[0].notifications, v.drivers[0].lastSeenAt], [true, true, '2026-11-03T20:00:00.000Z']);
  assert.equal(v.pushed.result, 'sent'); assert.equal(v.opened.by, 'Frank U');
  // dispatch sends it again: it isn't "opened" until the driver looks at the new one
  store['626300'] = { ...store['626300'], sentAt: '2026-11-03T21:00:00Z', confirmedAt: '2026-11-03T21:05:00Z', confirmedBy: 'Frank U' };
  v = (await call('GET /truckmate/driver-app', { token: staff })).body.trips['626300'];
  assert.equal(v.opened, null); assert.equal(v.confirmed.by, 'Frank U');
  assert.equal(driverAppView({ trip: { tripNumber: '1', driver: null } }).drivers.length, 0, 'no driver on the load');
});

test('driver profiles: dispatch adds a driver Samsara doesn\'t have, more cells, a name; any of their cells signs them in; outsiders can\'t see it', async () => {
  const { initDriverAuth: init, mergeRoster } = await import('../driverauth.js');
  const db = mem(); const routes = {};
  const board = [trip('626265', 'DEPSHIP', '0986'), trip('626300', 'DISP', '7777')];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => [FRANK], getBoard: async () => ({ trips: board }) });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  const staff = jwt.sign({ id: 1, name: 'Geo', role: 'dispatcher' }, SECRET);
  const outsider = jwt.sign({ id: 9, name: 'Broker', role: 'customer', company: 'other' }, SECRET);
  assert.equal((await call('GET /truckmate/driver-profiles', { token: outsider })).status, 403);
  let list = (await call('GET /truckmate/driver-profiles', { token: staff })).body.drivers;
  assert.deepEqual(list.map((d) => [d.code, d.onList, d.truck, d.current && d.current.trip, d.next && d.next.trip]), [['0986', true, '4504', '626265', null], ['7777', false, '4504', null, '626300']], 'on a load first; 7777 is only in TruckMate');
  assert.equal((await call('PUT /truckmate/driver-profiles/:code', { token: staff, params: { code: '7777' }, body: { name: 'New Driver', phones: [] } })).status, 400, 'a new driver needs a cell');
  assert.equal((await call('PUT /truckmate/driver-profiles/:code', { token: staff, params: { code: '7777' }, body: { name: 'New Driver', phones: [{ number: '12345' }] } })).status, 400);
  assert.equal((await call('PUT /truckmate/driver-profiles/:code', { token: outsider, params: { code: '7777' }, body: { name: 'X', phones: [{ number: '3055550300' }] } })).status, 403);
  await call('PUT /truckmate/driver-profiles/:code', { token: staff, params: { code: '7777' }, body: { name: 'New Driver', phones: [{ number: '(305) 555-0300', label: 'Cell' }] } });
  await call('PUT /truckmate/driver-profiles/:code', { token: staff, params: { code: '0986' }, body: { name: '', phones: [{ number: '305-555-0101', label: 'Wife' }, { number: '3055550100' }] } });
  list = (await call('GET /truckmate/driver-profiles', { token: staff })).body.drivers;
  const frank = list.find((d) => d.code === '0986'); const nd = list.find((d) => d.code === '7777');
  assert.deepEqual(frank.phones.map((x) => [x.number, x.from]), [['3055550100', 'samsara'], ['3055550101', 'console']], 'Samsara\'s cell stays first; the same number isn\'t added twice');
  assert.equal(frank.name, 'Frank U', 'no name given: Samsara\'s stays');
  assert.deepEqual([nd.name, nd.onList, nd.updatedBy], ['New Driver', true, 'Geo']);
  // the new driver signs in with their cell; Frank with his second one
  assert.equal((await call('POST /driver/auth/login', { body: { driverId: '7777', phone: '3055550300', newPin: '2580' } })).status, 200);
  assert.equal((await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550101', newPin: '2580' } })).status, 200);
  const t = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550101', pin: '2580' } })).body.token;
  assert.equal((await call('GET /driver/me', { token: t })).status, 200);
  // dispatch removes that cell: that phone is signed out
  await call('PUT /truckmate/driver-profiles/:code', { token: staff, params: { code: '0986' }, body: { phones: [] } });
  assert.equal((await call('GET /driver/me', { token: t })).status, 401);
  assert.deepEqual(mergeRoster([{ code: '0986', name: 'A', phone: null }], {}).map((d) => d.phone), [null]);
});

test('every Samsara driver is saved the first time we see them; one who leaves Samsara keeps their profile and signs in until dispatch removes them', async () => {
  const { initDriverAuth: init } = await import('../driverauth.js');
  const db = mem(); const routes = {}; let samsara = [FRANK];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  init(app, { rosterCacheMs: 0, appCacheMs: 0, requireAuth, secret: 'k', db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => samsara, getBoard: async () => ({ trips: [] }) });
  const call = async (key, { body = {}, params = {}, token = null } = {}) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const req = { body, params, ip: '1', headers: token ? { authorization: `Bearer ${token}` } : {} }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  const staff = jwt.sign({ id: 1, name: 'Geo', role: 'dispatcher' }, SECRET);
  await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', newPin: '2580' } });
  const t = (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100', pin: '2580' } })).body.token;
  assert.equal(Object.keys(db.s['taDriverSamsara:florida-beauty']).length, 1, 'saved the first time we saw them');
  assert.equal((await call('DELETE /truckmate/driver-profiles/:code', { token: staff, params: { code: '0986' } })).status, 409, 'Samsara still has them');
  samsara = [];   // gone from Samsara
  assert.equal((await call('GET /driver/me', { token: t })).status, 200, 'they still sign in');
  const d = (await call('GET /truckmate/driver-profiles', { token: staff })).body.drivers.find((x) => x.code === '0986');
  assert.deepEqual([d.name, d.saved, d.samsara, d.onList, d.phones[0].label], ['Frank U', true, false, true, 'Samsara (saved)']);
  assert.equal((await call('DELETE /truckmate/driver-profiles/:code', { token: staff, params: { code: '0986' } })).status, 200);
  assert.equal((await call('GET /driver/me', { token: t })).status, 401, 'removed: signed out');
  assert.equal((await call('GET /truckmate/driver-profiles', { token: staff })).body.drivers.length, 0);
});

test('the driver list and the console\'s Driver app view are shared, not rebuilt on every request', async () => {
  const { initDriverAuth: init } = await import('../driverauth.js');
  const db = mem(); const routes = {}; let rosterReads = 0; let boardReads = 0; let t = 1e12;
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const requireAuth = (req, res, next) => { req.user = { id: 1, role: 'dispatcher' }; return next(); };
  init(app, { requireAuth, secret: 'k', db, sign: () => 'x', roster: async () => { rosterReads += 1; return [FRANK]; }, getBoard: async () => { boardReads += 1; return { trips: BOARD }; }, now: () => t });
  const call = async (key) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h({ headers: {}, params: {}, query: {} }, res, next); }; await next(); return out; };
  await Promise.all([call('GET /truckmate/driver-app'), call('GET /truckmate/driver-app'), call('GET /truckmate/driver-app')]);
  assert.equal(boardReads, 1, 'three consoles at once: one board read');
  assert.equal(rosterReads, 1);
  t += 20000; await call('GET /truckmate/driver-app');
  assert.equal(boardReads, 1, 'within 30 seconds: shared');
  t += 70000; await call('GET /truckmate/driver-app');
  assert.equal(boardReads, 2); assert.equal(rosterReads, 2, 'a minute later: fresh');
});

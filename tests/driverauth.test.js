import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { initDriverAuth, loadsFor } from '../driverauth.js';

const SECRET = 's';
const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const trip = (n, status, driver) => ({ trip: { tripNumber: n, status, driver, driver2: null, powerUnit: '4504', trailer: '7136', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [{ billNumber: 'M5055135', endZoneDescription: 'EAST POINT, GA', billToName: 'ATLANTA FLOWER', pieces: 12 }] });
const BOARD = [trip('626265', 'DEPSHIP', '0986'), trip('626300', 'DISP', '986'), trip('626200', 'DELVD', '0986'), trip('626301', 'DEPSHIP', '2473')];
const FRANK = { code: '0986', name: 'Frank U', phone: '(305) 555-0100' };

function setup({ roster = [FRANK] } = {}) {
  const db = mem(); const routes = {}; let clock = 1e12; let list = roster;
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = (req, res, next) => { try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'x' }); } return next(); };
  initDriverAuth(app, { requireAuth, db, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), roster: async () => list, getBoard: async () => ({ trips: BOARD }), docsLink: async (site, t) => `https://x/t/tok-${t}`, now: () => clock });
  const call = async (key, { body = {}, params = {}, token = null, ip = '1.1.1.1' } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } };
    const req = { body, params, ip, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
    return out;
  };
  const login = async () => (await call('POST /driver/auth/login', { body: { driverId: '0986', phone: '305-555-0100' } })).body.token;
  return { db, call, login, at: (ms) => { clock = ms; }, now: () => clock, setRoster: (r) => { list = r; } };
}

test('a driver\'s loads by TruckMate driver ID: rolling now, booked next, never finished ones', () => {
  const l = loadsFor('0986', BOARD);
  assert.deepEqual(l.current.map((x) => x.trip), ['626265']); assert.deepEqual(l.next.map((x) => x.trip), ['626300'], '986 and 0986 are the same driver');
  assert.equal(l.current[0].stops[0].pieces, 12);
});

test('sign in with the driver ID and cell dispatch has, and stay signed in', async () => {
  const h = setup();
  const r = await h.call('POST /driver/auth/login', { body: { driverId: '986', phone: '3055550100' } });
  assert.equal(r.status, 200); assert.equal(r.body.name, 'Frank U');
  const t = jwt.decode(r.body.token);
  assert.equal(t.role, 'driver'); assert.ok(t.exp - t.iat >= 3600 * 24 * 3650, 'until they sign out');
  const me = await h.call('GET /driver/me', { token: r.body.token });
  assert.equal(me.body.driverId, '0986'); assert.deepEqual(me.body.current.map((x) => x.trip), ['626265']);
});

test('a wrong ID or cell is refused, and repeated tries are stopped', async () => {
  const h = setup();
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3059999999' } })).status, 401);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '2473', phone: '3055550100' } })).status, 401);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '', phone: '3055550100' } })).status, 400);
  for (let i = 0; i < 10; i += 1) await h.call('POST /driver/auth/login', { body: { driverId: String(1000 + i), phone: '3055550100' }, ip: `9.9.9.${i}` }); // eslint-disable-line no-await-in-loop
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100' } })).status, 429, 'that cell, too many wrong tries');
  h.at(h.now() + 16 * 60000);
  assert.equal((await h.call('POST /driver/auth/login', { body: { driverId: '0986', phone: '3055550100' } })).status, 200, 'after 15 minutes');
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

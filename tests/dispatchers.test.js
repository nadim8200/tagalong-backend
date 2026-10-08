import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { initDispatchers } from '../dispatchers.js';

const SECRET = 'test-secret';
const hashPassword = (pw) => { const salt = randomBytes(8).toString('hex'); return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`; };
const verifyPassword = (pw, stored) => { const [salt, h] = String(stored).split(':'); const a = Buffer.from(h, 'hex'); const b = scryptSync(pw, salt, 64); return a.length === b.length && timingSafeEqual(a, b); };
function requireAuth(req, res, next) {
  try { req.user = jwt.verify(String(req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'Not signed in.' }); }
  return next();
}
function harness() {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const routes = {};
  const app = {}; ['get', 'post', 'put', 'delete'].forEach((v) => { app[v] = (p, ...h) => { routes[`${v.toUpperCase()} ${p}`] = h; }; });
  const api = initDispatchers(app, { requireAuth, db, hashPassword, verifyPassword, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), setCookie: () => {} });
  const call = async (key, { token, body = {}, params = {} } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } };
    const req = { body, params, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const hs = routes[key]; let i = 0;
    const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); };
    await next();
    return out;
  };
  return { api, call };
}
const tok = (u) => jwt.sign(u, SECRET);

test('admins create dispatchers; dispatchers sign in and reach dispatch; customers cannot; a turned-off dispatcher is locked out at once', async () => {
  const { api, call } = harness();
  const admin = tok({ id: 1, role: 'admin', admin: true, name: 'Nadim' });
  const customer = tok({ id: 77, role: 'owner' });
  assert.equal((await call('POST /admin/dispatchers', { token: customer, body: { name: 'Rosa', email: 'rosa@floridabeauty.us', password: 'secret123' } })).status, 403);
  const made = await call('POST /admin/dispatchers', { token: admin, body: { name: 'Rosa Reategui', email: 'Rosa@FloridaBeauty.us', password: 'secret123' } });
  assert.equal(made.status, 200); assert.equal(made.body.email, 'rosa@floridabeauty.us'); assert.equal(made.body.pass, undefined, 'password hash never leaves the server');
  assert.equal((await call('POST /admin/dispatchers', { token: admin, body: { name: 'X', email: 'rosa@floridabeauty.us', password: 'secret123' } })).status, 409);
  assert.equal((await call('POST /auth/dispatcher/login', { body: { email: 'rosa@floridabeauty.us', password: 'wrong' } })).status, 401);
  const login = await call('POST /auth/dispatcher/login', { body: { email: 'rosa@floridabeauty.us', password: 'secret123' } });
  assert.equal(login.status, 200); assert.equal(login.body.role, 'dispatcher');
  const exp = jwt.decode(login.body.token).exp - jwt.decode(login.body.token).iat;
  assert.equal(exp, 30 * 24 * 3600, 'dispatcher sessions last 30 days');
  // guarding a dispatch route
  const guard = async (token) => { let ok = false; let status = 200; const res = { status(c) { status = c; return this; }, json() {} }; await api.requireDispatch({ headers: { authorization: `Bearer ${token}` } }, res, () => { ok = true; }); return ok ? 200 : status; };
  assert.equal(await guard(login.body.token), 200);
  assert.equal(await guard(admin), 200);
  assert.equal(await guard(customer), 403, 'a TagAlong customer cannot reach dispatch');
  // turned off → locked out on the next request, even with a valid token
  await call('PUT /admin/dispatchers/:id', { token: admin, params: { id: made.body.id }, body: { active: false } });
  assert.equal(await guard(login.body.token), 401);
  assert.equal((await call('POST /auth/dispatcher/login', { body: { email: 'rosa@floridabeauty.us', password: 'secret123' } })).status, 401);
  await call('DELETE /admin/dispatchers/:id', { token: admin, params: { id: made.body.id } });
  assert.deepEqual((await call('GET /admin/dispatchers', { token: admin })).body, []);
});

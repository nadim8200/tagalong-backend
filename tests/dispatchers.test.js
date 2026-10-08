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
function harness(opts = {}) {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const routes = {};
  const app = {}; ['get', 'post', 'put', 'delete'].forEach((v) => { app[v] = (p, ...h) => { routes[`${v.toUpperCase()} ${p}`] = h; }; });
  const sent = [];
  const api = initDispatchers(app, { requireAuth, db, hashPassword, verifyPassword, sign: (u, exp) => jwt.sign(u, SECRET, { expiresIn: exp }), setCookie: () => {}, ...(opts.mail ? { mail: { ready: () => true, send: async (m) => { sent.push(m); } } } : {}) });
  const call = async (key, { token, body = {}, params = {} } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } };
    const req = { body, params, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const hs = routes[key]; let i = 0;
    const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); };
    await next();
    return out;
  };
  return { api, call, sent };
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
  assert.equal(login.body.mustChange, true, 'first sign-in: set your own password');
  assert.equal(await guard(login.body.token), 403, 'nothing works until they change it');
  assert.equal((await call('POST /auth/dispatcher/password', { token: login.body.token, body: { current: 'secret123', next: 'secret123' } })).status, 400, 'not the one the admin gave');
  assert.equal((await call('POST /auth/dispatcher/password', { token: login.body.token, body: { current: 'nope', next: 'Gardenia2026' } })).status, 401);
  assert.equal((await call('POST /auth/dispatcher/password', { token: login.body.token, body: { current: 'secret123', next: 'Gardenia2026' } })).status, 200);
  assert.equal(await guard(login.body.token), 200);
  assert.equal(await guard(admin), 200);
  assert.equal(await guard(customer), 403, 'a TagAlong customer cannot reach dispatch');
  // turned off → locked out on the next request, even with a valid token
  await call('PUT /admin/dispatchers/:id', { token: admin, params: { id: made.body.id }, body: { active: false } });
  assert.equal(await guard(login.body.token), 401);
  assert.equal((await call('POST /auth/dispatcher/login', { body: { email: 'rosa@floridabeauty.us', password: 'Gardenia2026' } })).status, 401);
  await call('DELETE /admin/dispatchers/:id', { token: admin, params: { id: made.body.id } });
  assert.deepEqual((await call('GET /admin/dispatchers', { token: admin })).body, []);
});

test('dispatcher logins: console only, and never its settings', async () => {
  const { dispatcherMayUse } = await import('../dispatchers.js');
  // working loads — allowed
  for (const [m, p] of [['GET', '/truckmate/active'], ['POST', '/truckmate/hold/624194'], ['PUT', '/truckmate/status-mail/624194'], ['POST', '/watchtower/ack'], ['POST', '/jarvis/chat'], ['POST', '/ringcentral/sms'], ['POST', '/ringcentral/call'], ['GET', '/truckmate/profiles'], ['GET', '/truckmate/outbound/settings'], ['POST', '/truckmate/outbound/send'], ['GET', '/auth/me'], ['POST', '/push/register']]) assert.equal(dispatcherMayUse(m, p), null, `${m} ${p}`);
  // settings — admin only
  for (const [m, p] of [['PUT', '/truckmate/outbound/settings'], ['PUT', '/watchtower/config'], ['POST', '/voice/setup'], ['PUT', '/truckmate/activity/push'], ['PUT', '/truckmate/profiles/abc'], ['POST', '/truckmate/profiles/import'], ['DELETE', '/truckmate/profiles/abc'], ['PUT', '/truckmate/milestones/settings'], ['PUT', '/truckmate/config']]) assert.equal(dispatcherMayUse(m, p), 'settings', `${m} ${p}`);
  // outside the console
  for (const [m, p] of [['GET', '/devices'], ['DELETE', '/account'], ['POST', '/loads'], ['POST', '/admin/dispatchers'], ['PUT', '/ringcentral/from-number'], ['PUT', '/ringcentral/config'], ['GET', '/assistant/board']]) assert.equal(dispatcherMayUse(m, p), 'outside', `${m} ${p}`);
});

test('passwords: admin resets with a temporary password or an email link; nobody ever sees a password the dispatcher chose', async () => {
  const { call, sent } = harness({ mail: true });
  const admin = tok({ id: 1, role: 'admin', admin: true, name: 'Nadim' });
  const made = (await call('POST /admin/dispatchers', { token: admin, body: { name: 'Leo', email: 'leo@floridabeauty.us', password: 'Welcome2026' } })).body;
  const login = (await call('POST /auth/dispatcher/login', { body: { email: 'leo@floridabeauty.us', password: 'Welcome2026' } })).body;
  await call('POST /auth/dispatcher/password', { token: login.token, body: { current: 'Welcome2026', next: 'Hibiscus77' } });
  // admin: temporary password (shown once) → must change again at the next sign-in
  const r = await call('POST /admin/dispatchers/:id/reset', { token: admin, params: { id: made.id } });
  assert.match(r.body.tempPassword, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
  const again = (await call('POST /auth/dispatcher/login', { body: { email: 'leo@floridabeauty.us', password: r.body.tempPassword } })).body;
  assert.equal(again.mustChange, true);
  const list = (await call('GET /admin/dispatchers', { token: admin })).body;
  assert.equal(list[0].pass, undefined); assert.equal(list[0].reset, undefined);
  assert.ok(!JSON.stringify(list).includes('Hibiscus77'), 'the dispatcher\'s own password is never shown');
  assert.deepEqual(list[0].passwordLog.map((x) => x.how), ['temporary password set by admin', 'changed by the dispatcher', 'first password set by admin']);
  assert.equal(list[0].logins.length, 2);
  // forgot password → email link → new password, link works once
  assert.equal((await call('GET /auth/dispatcher/forgot')).body.available, true);
  const f = await call('POST /auth/dispatcher/forgot', { body: { email: 'leo@floridabeauty.us' } });
  assert.match(f.body.message, /If that email has a dispatcher account/);
  assert.equal((await call('POST /auth/dispatcher/forgot', { body: { email: 'nobody@x.com' } })).body.message, f.body.message, 'same answer for unknown emails');
  assert.equal(sent.length, 1);
  const token = sent[0].html.match(/reset=([a-f0-9]+)/)[1];
  assert.equal((await call('POST /auth/dispatcher/reset', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await call('POST /auth/dispatcher/reset', { body: { token, password: 'Orchid2026x' } })).status, 200);
  assert.equal((await call('POST /auth/dispatcher/reset', { body: { token, password: 'Orchid2026y' } })).status, 400, 'used once');
  const fresh = (await call('POST /auth/dispatcher/login', { body: { email: 'leo@floridabeauty.us', password: 'Orchid2026x' } })).body;
  assert.equal(fresh.mustChange, false);
});

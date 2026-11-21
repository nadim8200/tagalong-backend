import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, isIncoming, initSmsHook, HOOK_PATH, FILTER } from '../smshook.js';

const memDb = () => { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; };
const fakeApp = () => { const routes = {}; return { routes, post: (p, ...h) => { routes[`POST ${p}`] = h; }, get: (p, ...h) => { routes[`GET ${p}`] = h; } }; };
const call = async (h, { headers = {}, body = {} } = {}) => { const out = { status: 200, headers: {} }; const res = { status(c) { out.status = c; return this; }, set(k, v) { out.headers[k] = v; return this; }, end() { out.ended = true; return this; }, json(j) { out.body = j; } }; await h[h.length - 1]({ get: (k) => headers[k], body, user: { role: 'admin' } }, res); return out; };
const NOW = Date.parse('2026-11-21T03:00:00Z');

test('the registration: keep it, renew it before it expires, make it again if RingCentral dropped or paused it', () => {
  assert.equal(plan(null, NOW), 'create');
  assert.equal(plan({ id: 's1', status: 'Active', expirationTime: '2026-12-15T00:00:00Z' }, NOW), 'keep');
  assert.equal(plan({ id: 's1', status: 'Active', expirationTime: '2026-11-22T00:00:00Z' }, NOW), 'renew');
  assert.equal(plan({ id: 's1', status: 'Blacklisted', expirationTime: '2026-12-15T00:00:00Z' }, NOW), 'create');
  assert.equal(plan({ id: 's1', status: 'Suspended' }, NOW), 'create');
});

test('the webhook: answers the validation handshake; an event without our secret is refused; an incoming text starts the check', async () => {
  const db = memDb(); const app = fakeApp(); let checks = 0; const calls = [];
  const rc = { configFor: async () => ({ fromNumber: '+17867233912' }), api: async (o, path, init = {}) => { calls.push([path, init.method || 'GET', init.body ? JSON.parse(init.body) : null]); return { id: 'sub-1', status: 'Active', expirationTime: '2026-12-21T03:00:00Z' }; } };
  const hook = initSmsHook(app, { db, ringcentral: rc, onText: () => { checks += 1; }, requireAuth: (q, s, n) => n(), env: { NODE_ENV: 'test' }, now: () => NOW });
  assert.equal(await hook.ensure(), 'created');
  const [path, method, body] = calls[0];
  assert.equal(path, '/restapi/v1.0/subscription'); assert.equal(method, 'POST');
  assert.deepEqual(body.eventFilters, [FILTER]); assert.equal(body.deliveryMode.transportType, 'WebHook');
  assert.equal(body.deliveryMode.address, `https://tagalong-backend-fdzx.onrender.com${HOOK_PATH}`);
  const token = body.deliveryMode.verificationToken; assert.ok(token && token.length >= 32);
  const h = app.routes[`POST ${HOOK_PATH}`];
  const v = await call(h, { headers: { 'Validation-Token': 'abc' } });
  assert.equal(v.status, 200); assert.equal(v.headers['Validation-Token'], 'abc');
  assert.equal((await call(h, { headers: { 'Verification-Token': 'wrong' }, body: { body: { direction: 'Inbound' } } })).status, 401);
  assert.equal(checks, 0);
  assert.equal((await call(h, { headers: { 'Verification-Token': token }, body: { body: { direction: 'Inbound', id: 9 } } })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(checks, 1, 'the check runs right away');
  await call(h, { headers: { 'Verification-Token': token }, body: { body: { direction: 'Outbound' } } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(checks, 1, 'our own sends don\'t start a check');
  assert.equal(await hook.ensure(), 'kept');
  const st = await call(app.routes['GET /admin/sms-hook']);
  assert.equal(st.body.id, 'sub-1'); assert.equal(st.body.hasToken, true); assert.equal(st.body.token, undefined, 'the secret never leaves the server');
});

test('texting not set up on the company line: nothing is registered', async () => {
  const hook = initSmsHook(fakeApp(), { db: memDb(), ringcentral: { configFor: async () => ({}), api: async () => { throw new Error('no'); } }, onText: () => {}, env: { NODE_ENV: 'test' } });
  assert.equal(await hook.ensure(), 'skipped');
  assert.equal(isIncoming({ body: { direction: 'Inbound' } }), true);
});

test('when RingCentral says no, its answer is kept for the admin view; a later success clears it', async () => {
  const db = memDb(); const app = fakeApp(); let fail = true;
  const rc = { configFor: async () => ({ fromNumber: '+17867233912' }), api: async () => { if (fail) throw new Error('RingCentral 403: In order to call this API endpoint, application needs to have [SubscriptionWebhook] permission'); return { id: 'sub-2', status: 'Active', expirationTime: '2026-12-21T03:00:00Z' }; } };
  const hook = initSmsHook(app, { db, ringcentral: rc, onText: () => {}, requireAuth: (q, s, n) => n(), env: { NODE_ENV: 'test' }, now: () => NOW });
  assert.equal(await hook.tryEnsure(), 'failed');
  let st = await call(app.routes['GET /admin/sms-hook']);
  assert.match(st.body.lastError, /SubscriptionWebhook/);
  fail = false;
  const r = await call(app.routes['POST /admin/sms-hook/retry']);
  assert.equal(r.body.step, 'created'); assert.equal(r.body.id, 'sub-2'); assert.equal(r.body.lastError, undefined);
});

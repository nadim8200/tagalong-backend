import test from 'node:test';
import assert from 'node:assert/strict';
import { initPhone, pickCallerId, seal, open } from '../phone.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const setup = (over = {}) => {
  const db = mem(); const routes = {}; const asked = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const fetchFn = over.fetchFn || (async (url, init = {}) => {
    asked.push(url.replace('https://platform.ringcentral.com', ''));
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.endsWith('/restapi/oauth/token')) { assert.match(String(init.body), /code_verifier=v1/); return ok({ access_token: 'at' }); }
    if (url.endsWith('/sip-provision')) return ok({ sipInfo: [{ username: 'u', password: 'p', authorizationId: 'a', domain: 'sip.ringcentral.com', outboundProxy: 'x:8083' }] });
    if (url.endsWith('/extension/~')) return ok({ extensionNumber: '101', name: 'ronen koubi' });
    if (url.includes('/phone-number')) return ok({ records: [{ phoneNumber: '+17867233912', usageType: 'DirectNumber', features: ['CallerId'] }, { phoneNumber: '+13053955415', usageType: 'MainCompanyNumber', features: ['CallerId', 'SmsSender'] }] });
    return ok({});
  });
  initPhone(app, { requireAuth: (q, r, n) => n(), db, secret: 's', clientId: 'cid', activity: { lookup: async () => ({ role: 'driver', name: 'Frank U', trips: ['626265'] }) }, fetchFn, env: {} });
  const call = async (key, req) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  return { db, call, asked };
};
const geo = { id: 7, name: 'Geo', role: 'dispatcher' };

test('caller ID: the company number when the extension may use it, else its own', () => {
  assert.equal(pickCallerId([{ phoneNumber: '+1786', usageType: 'DirectNumber', features: ['CallerId'] }, { phoneNumber: '+1305', usageType: 'MainCompanyNumber', features: ['CallerId'] }]), '+1305');
  assert.equal(pickCallerId([{ phoneNumber: '+1786', usageType: 'DirectNumber', features: ['CallerId'] }, { phoneNumber: '+1305', usageType: 'MainCompanyNumber', features: [] }]), '+1786');
  assert.deepEqual(open(seal({ a: 1 }, 'k'), 'k'), { a: 1 });
});

test('a dispatcher connects their RingCentral line once; only they get it back; the sign-in code never reaches the log', async () => {
  const { db, call, asked } = setup();
  const req = { user: geo, body: { code: 'c1', codeVerifier: 'v1', redirectUri: 'https://mytagalong.app/rc-callback.html' } };
  const r = await call('POST /ringcentral/phone/connect', req);
  assert.deepEqual(r.body, { ok: true, ext: '101', name: 'ronen koubi', callerId: '+13053955415' });
  assert.deepEqual(req.body, { connecting: true }, 'the activity log sees no code');
  assert.ok(asked.includes('/restapi/oauth/revoke'), 'the RingCentral token is thrown away');
  assert.doesNotMatch(JSON.stringify(db.s), /"password"/, 'stored encrypted');
  const mine = await call('GET /ringcentral/phone/sip', { user: geo });
  assert.equal(mine.body.sipInfo.username, 'u');
  assert.equal((await call('GET /ringcentral/phone/sip', { user: { id: 8, role: 'dispatcher' } })).body.connected, false, 'another dispatcher doesn\'t get it');
  assert.equal((await call('GET /ringcentral/phone/sip', { user: { id: 9, role: 'customer' } })).status, 403);
  await call('POST /ringcentral/phone/disconnect', { user: geo });
  assert.equal((await call('GET /ringcentral/phone/sip', { user: geo })).body.connected, false);
  assert.deepEqual((await call('GET /truckmate/phone/who', { user: geo, query: { n: '(305) 555-0100' } })).body, { role: 'driver', name: 'Frank U', detail: null, trips: ['626265'] });
});

test('RingCentral refusing the sign-in is explained', async () => {
  const { call } = setup({ fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'Invalid code verifier' }) }) });
  const r = await call('POST /ringcentral/phone/connect', { user: geo, body: { code: 'c', codeVerifier: 'v', redirectUri: 'r' } });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Invalid code verifier');
});

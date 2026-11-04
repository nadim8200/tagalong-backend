import test from 'node:test';
import assert from 'node:assert/strict';
import { initAutoRecord, toRecord, hookToken } from '../autorecord.js';

const evt = (parties, sid = 's-1') => ({ event: '/restapi/v1.0/account/1/telephony/sessions', body: { telephonySessionId: sid, parties } });

test('which party to record: one of our extensions, answered, not already recording', () => {
  assert.equal(toRecord(evt([{ id: 'p1', extensionId: '101', status: { code: 'Proceeding' } }])), null, 'still ringing');
  assert.equal(toRecord(evt([{ id: 'p0', status: { code: 'Answered' } }])), null, 'the outside party (no extension)');
  assert.deepEqual(toRecord(evt([{ id: 'p0', status: { code: 'Answered' } }, { id: 'p1', extensionId: '101', direction: 'Outbound', status: { code: 'Answered' } }])), { session: 's-1', party: 'p1', direction: 'Outbound' });
  assert.equal(toRecord(evt([{ id: 'p1', extensionId: '101', status: { code: 'Answered' }, recordings: [{ id: 'r', active: true }] }])), null, 'already recording');
  assert.equal(toRecord({}), null);
});

test('the webhook: RingCentral checks the address, only RingCentral can post, an answered call is recorded once', async () => {
  const routes = {}; const asked = [];
  const app = { post: (p, h) => { routes[p] = h; } };
  const rc = { configFor: async () => ({}), accessToken: async () => 'tok' };
  const fetchFn = async (url, init = {}) => { asked.push([init.method || 'GET', url.replace('https://platform.ringcentral.com', '')]); return { ok: true, status: 200, json: async () => ({}) }; };
  const ar = initAutoRecord(app, { rc, secret: 's', publicUrl: 'https://api.example', fetchFn, start: false });
  const call = async (headers, body) => { const out = { status: 200, headers: {} }; const res = { set(k, v) { out.headers[k] = v; return this; }, status(c) { out.status = c; return this; }, end() { return this; } }; routes['/ringcentral/webhook/telephony']({ headers, body }, res); await new Promise((r) => setTimeout(r, 5)); return out; };
  const v = await call({ 'validation-token': 'abc' }, {});
  assert.equal(v.headers['Validation-Token'], 'abc');
  assert.equal((await call({ 'verification-token': 'wrong' }, evt([]))).status, 403);
  const ans = evt([{ id: 'p1', extensionId: '101', status: { code: 'Answered' } }]);
  await call({ 'verification-token': hookToken('s') }, ans);
  await call({ 'verification-token': hookToken('s') }, ans);
  assert.deepEqual(asked, [['POST', '/restapi/v1.0/account/~/telephony/sessions/s-1/parties/p1/recordings']], 'pressed once');
  assert.equal(ar.status().started, 1);
});

test('the subscription is made, kept, renewed before it runs out; a missing permission is explained', async () => {
  let subs = []; const asked = []; let t = Date.parse('2026-11-04T00:00:00Z');
  const fetchFn = async (url, init = {}) => {
    const path = url.replace('https://platform.ringcentral.com', ''); asked.push(`${init.method || 'GET'} ${path}`);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (path === '/restapi/v1.0/subscription' && !init.method) return ok({ records: subs });
    if (path === '/restapi/v1.0/subscription' && init.method === 'POST') { const b = JSON.parse(init.body); const s = { id: 'sub1', status: 'Active', expirationTime: new Date(t + 7 * 86400000).toISOString(), deliveryMode: b.deliveryMode, eventFilters: b.eventFilters }; subs = [s]; return ok(s); }
    if (path.endsWith('/renew')) { subs[0].expirationTime = new Date(t + 7 * 86400000).toISOString(); return ok(subs[0]); }
    return ok({});
  };
  const ar = initAutoRecord({ post() {} }, { rc: { configFor: async () => ({}), accessToken: async () => 'tok' }, secret: 's', publicUrl: 'https://api.example', fetchFn, start: false, now: () => t });
  await ar.ensure();
  assert.deepEqual(subs[0].eventFilters, ['/restapi/v1.0/account/~/telephony/sessions']);
  assert.equal(subs[0].deliveryMode.address, 'https://api.example/ringcentral/webhook/telephony');
  assert.equal(subs[0].deliveryMode.verificationToken, hookToken('s'));
  asked.length = 0; await ar.ensure();
  assert.deepEqual(asked, ['GET /restapi/v1.0/subscription'], 'fresh: left alone');
  t += 6 * 86400000; asked.length = 0; await ar.ensure();
  assert.ok(asked.includes('POST /restapi/v1.0/subscription/sub1/renew'), 'renewed before it ends');
  const denied = initAutoRecord({ post() {} }, { rc: { configFor: async () => ({}), accessToken: async () => 'tok' }, secret: 's', publicUrl: 'https://api.example', fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ message: 'In order to call this API endpoint, application needs to have [SubscriptionWebhook] permission' }) }), start: false });
  await denied.ensure();
  assert.match(denied.status().lastError, /Webhook Subscriptions/);
  assert.equal(initAutoRecord({ post() {} }, { rc: null, secret: 's', publicUrl: 'x', start: false }).status().on, false);
});

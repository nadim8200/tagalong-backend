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
    if (url.endsWith('/restapi/oauth/token')) { assert.match(String(init.body), /code_verifier=v1/); return ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }); }
    if (url.endsWith('/sip-provision')) return ok({ sipInfo: [{ username: 'u', password: 'p', authorizationId: 'a', domain: 'sip.ringcentral.com', outboundProxy: 'x:8083' }] });
    if (url.endsWith('/extension/~')) return ok({ id: 'ext7', extensionNumber: '101', name: 'ronen koubi' });
    if (url.endsWith('/telephony/conference')) return ok({ session: { id: 's-conf', voiceCallToken: 'join-token' } });
    if (/\/telephony\/sessions\//.test(url) && init.method === 'GET') return ok({ parties: [{ id: 'p-host', extensionId: 'ext7' }, { id: 'p-other', extensionId: 'another' }] });
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
  assert.ok(!asked.includes('/restapi/oauth/revoke'), 'conference token remains encrypted on the server');
  assert.equal(open(db.s.taPhoneSip['7'].oauth, 's').access, 'at');
  assert.doesNotMatch(JSON.stringify(db.s), /access_token|refresh_token/);
  assert.doesNotMatch(JSON.stringify(db.s), /"password"/, 'stored encrypted');
  const mine = await call('GET /ringcentral/phone/sip', { user: geo });
  assert.equal(mine.body.sipInfo.username, 'u');
  assert.equal((await call('GET /ringcentral/phone/sip', { user: { id: 8, role: 'dispatcher' } })).body.connected, false, 'another dispatcher doesn\'t get it');
  assert.equal((await call('GET /ringcentral/phone/sip', { user: { id: 9, role: 'customer' } })).status, 403);
  const off = await call('POST /ringcentral/phone/disconnect', { user: geo });
  assert.equal(off.body.revoked, true, 'the RingCentral sign-in is cancelled at RingCentral too');
  assert.ok(asked.includes('/restapi/oauth/revoke'));
  assert.equal((await call('GET /ringcentral/phone/sip', { user: geo })).body.connected, false);
  assert.deepEqual((await call('GET /truckmate/phone/who', { user: geo, query: { n: '(305) 555-0100' } })).body, { role: 'driver', name: 'Frank U', detail: null, trips: ['626265'] });
});

test('RingCentral refusing the sign-in is explained', async () => {
  const { call } = setup({ fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'Invalid code verifier' }) }) });
  const r = await call('POST /ringcentral/phone/connect', { user: geo, body: { code: 'c', codeVerifier: 'v', redirectUri: 'r' } });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Invalid code verifier');
});

const connect = (call) => call('POST /ringcentral/phone/connect', { user: geo, body: { code: 'c1', codeVerifier: 'v1', redirectUri: 'https://mytagalong.app/rc-callback.html' } });
test('conference routes require a staff line and validate both call owners', async () => {
  const { call, asked } = setup();
  assert.equal((await call('POST /ringcentral/phone/conference', { user: { id: 3, role: 'customer' } })).status, 403);
  assert.equal((await call('POST /ringcentral/phone/conference', { user: geo })).status, 409);
  await connect(call);
  assert.equal((await call('GET /ringcentral/phone/sip', { user: geo })).body.conferenceReady, true);
  assert.equal((await call('POST /ringcentral/phone/conference', { user: geo })).body.session.voiceCallToken, 'join-token');
  const body = { conferenceId: 's-conf', conferencePartyId: 'p-host', sessionId: 's-call', partyId: 'p-host' };
  assert.equal((await call('POST /ringcentral/phone/conference/merge', { user: geo, body })).status, 200);
  const before = asked.filter((x) => x.endsWith('/bring-in')).length;
  assert.equal((await call('POST /ringcentral/phone/conference/merge', { user: geo, body: { ...body, partyId: 'p-other' } })).status, 409);
  assert.equal((await call('POST /ringcentral/phone/conference/merge', { user: geo, body: { ...body, conferencePartyId: 'p-other' } })).status, 409);
  assert.equal((await call('POST /ringcentral/phone/conference/merge', { user: geo, body: { ...body, sessionId: '../escape' } })).status, 400);
  assert.equal(asked.filter((x) => x.endsWith('/bring-in')).length, before);
  const sip = await call('GET /ringcentral/phone/sip', { user: geo });
  assert.equal(sip.body.oauth, undefined);
});

test('shadow: managers only, never your own call, needs the reconnected phone; asks RingCentral to listen in', async () => {
  const db = mem(); const routes = {}; const asked = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const live = [{ session: 's-9', extensionId: 'e103', direction: 'outbound', other: '+13055550100', since: '2026-11-04T15:00:00Z' }];
  const fetchFn = async (url, init = {}) => { asked.push([init.method || 'GET', url.replace('https://platform.ringcentral.com', ''), init.body || null]); return { ok: true, status: 200, json: async () => ({}) }; };
  initPhone(app, { requireAuth: (q, r, n) => n(), db, secret: 's', clientId: 'cid', autoRecord: { liveCalls: () => live }, activity: { lookup: async () => ({ name: 'Frank U', role: 'driver', trips: ['626265'] }) }, fetchFn, env: {}, now: () => 1e12 });
  db.s.taPhoneSip = { boss: { extensionId: 'e101', ext: '101', name: 'Nadim Tellez', deviceId: 'dev-1', oauth: seal({ access: 'at', refresh: 'rt', expires: 1e12 + 3600000 }, 's') }, jen: { extensionId: 'e103', ext: '103', name: 'Jennifer Gonzalez' } };
  const call = async (key, req) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  const boss = { id: 'boss', role: 'dispatcher', phoneManager: true };
  assert.equal((await call('GET /truckmate/phone/live', { user: { id: 'jen', role: 'dispatcher' } })).status, 403);
  const l = (await call('GET /truckmate/phone/live', { user: boss })).body.calls[0];
  assert.deepEqual([l.dispatcher, l.ext, l.name, l.trips[0]], ['Jennifer Gonzalez', '103', 'Frank U', '626265']);
  assert.equal((await call('POST /ringcentral/phone/shadow', { user: { id: 'jen', role: 'dispatcher' }, body: { session: 's-9' } })).status, 403);
  const ok = await call('POST /ringcentral/phone/shadow', { user: boss, body: { session: 's-9' } });
  assert.equal(ok.body.ok, true);
  const sup = asked.find((a) => a[1].endsWith('/telephony/sessions/s-9/supervise'));
  assert.deepEqual(JSON.parse(sup[2]), { mode: 'Listen', supervisorDeviceId: 'dev-1', agentExtensionId: 'e103' });
  assert.equal((await call('POST /ringcentral/phone/shadow', { user: boss, body: { session: 'gone' } })).status, 404);
  db.s.taPhoneSip.boss.deviceId = null;
  assert.match((await call('POST /ringcentral/phone/shadow', { user: boss, body: { session: 's-9' } })).body.error, /Reconnect your phone/);
});

test('main-line calls on/off: reads and sets RingCentral presence for your own line; direct calls keep ringing', async () => {
  const db = mem(); const routes = {}; const asked = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  let dnd = 'TakeAllCalls';
  const fetchFn = async (url, init = {}) => { asked.push([init.method || 'GET', url.replace('https://platform.ringcentral.com', ''), init.body || null]); if (init.method === 'PUT') dnd = JSON.parse(init.body).dndStatus; return { ok: true, status: 200, json: async () => ({ dndStatus: dnd }) }; };
  initPhone(app, { requireAuth: (q, r, n) => n(), db, secret: 's', clientId: 'cid', fetchFn, env: {}, now: () => 1e12 });
  db.s.taPhoneSip = { boss: { extensionId: 'e101', ext: '101', oauth: seal({ access: 'at', refresh: 'rt', expires: 1e12 + 3600000 }, 's') } };
  const call = async (key, req) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes[key][routes[key].length - 1](req, res); return out; };
  const me = { id: 'boss', role: 'dispatcher' };
  assert.equal((await call('GET /ringcentral/phone/queue', { user: me })).body.queueCalls, true);
  const off = await call('POST /ringcentral/phone/queue', { user: me, body: { on: false } });
  assert.deepEqual(off.body, { queueCalls: false, status: 'DoNotAcceptDepartmentCalls' });
  assert.deepEqual(asked[1], ['PUT', '/restapi/v1.0/account/~/extension/~/presence', JSON.stringify({ dndStatus: 'DoNotAcceptDepartmentCalls' })]);
  assert.equal((await call('POST /ringcentral/phone/queue', { user: me, body: { on: true } })).body.queueCalls, true);
  const none = await call('GET /ringcentral/phone/queue', { user: { id: 'nobody', role: 'dispatcher' } });
  assert.equal(none.status, 409); assert.match(none.body.error, /Connect your phone/);
  assert.equal((await call('GET /ringcentral/phone/queue', { user: { id: 'x', role: 'customer' } })).status, 403);
});

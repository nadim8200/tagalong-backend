import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDriverLinks, linkStatus, cleanFixes } from '../driverlink.js';

// In-memory stand-ins for the Postgres KV and Express (no network, no texts).
function fakeDb() {
  const m = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    enabled: true,
    get: async (k, fb = {}) => (m.has(k) ? clone(m.get(k)) : fb),
    set: async (k, v) => { m.set(k, clone(v)); return v; },
    update: async (k, fn, fb = {}) => { const next = fn(m.has(k) ? clone(m.get(k)) : fb); m.set(k, clone(next)); return next; },
  };
}
function fakeApp() {
  const routes = {};
  const reg = (method) => (path, ...h) => { routes[`${method} ${path}`] = h[h.length - 1]; };
  const call = async (method, path, params = {}, body = {}, user = { name: 'Ana' }) => {
    let status = 200; let out;
    const res = { status(c) { status = c; return res; }, json(j) { out = j; return res; } };
    await routes[`${method} ${path}`]({ params, body, query: {}, headers: {}, user }, res);
    return { status, body: out };
  };
  return { get: reg('GET'), post: reg('POST'), put: reg('PUT'), call };
}

test('link status reads sent → opened → sharing → quiet / stopped / ended', () => {
  const now = Date.parse('2026-10-04T15:00:00Z');
  const base = { createdAt: '2026-10-04T10:00:00Z', expiresAt: '2026-10-09T10:00:00Z' };
  assert.equal(linkStatus({ ...base }, now), 'created');
  assert.equal(linkStatus({ ...base, sentAt: '2026-10-04T10:01:00Z' }, now), 'sent');
  assert.equal(linkStatus({ ...base, sentAt: 'x', openedAt: '2026-10-04T10:05:00Z' }, now), 'opened');
  assert.equal(linkStatus({ ...base, sharing: true, lastPingAt: '2026-10-04T14:58:00Z' }, now), 'sharing');
  assert.equal(linkStatus({ ...base, sharing: true, lastPingAt: '2026-10-04T13:00:00Z' }, now), 'quiet');
  assert.equal(linkStatus({ ...base, sharing: false, lastPingAt: '2026-10-04T14:00:00Z', stoppedAt: '2026-10-04T14:01:00Z' }, now), 'stopped');
  assert.equal(linkStatus({ ...base, completedAt: 'x' }, now), 'completed');
  assert.equal(linkStatus({ ...base, revokedAt: 'x' }, now), 'revoked');
  assert.equal(linkStatus({ ...base, expiresAt: '2026-10-04T14:00:00Z' }, now), 'expired');
});

test('fixes: junk rejected, units converted, sorted', () => {
  const now = Date.parse('2026-10-04T15:00:00Z');
  const out = cleanFixes([
    { latitude: 0, longitude: 0 },
    { lat: 95, lng: 10 },
    { latitude: 27.95, longitude: -82.45, speed: 26.8, bearing: 370, time: now - 60000, accuracy: 12.4 },
    { lat: 27.9, lng: -82.4, at: '2026-10-04T14:50:00Z' },
  ], now);
  assert.equal(out.length, 2);
  assert.equal(out[0].at, '2026-10-04T14:50:00.000Z');
  assert.equal(out[1].speedMph, 60);
  assert.equal(out[1].course, 10);
  assert.equal(out[1].accuracyM, 12);
});

test('create → driver opens → pings → board shows phone GPS → check-in → delivered ends the link', async () => {
  const db = fakeDb(); const app = fakeApp();
  const checkins = [];
  const carriers = { addCheckins: async (site, trip, list) => { checkins.push({ site, trip, list }); } };
  const sent = [];
  const ringcentral = { sendSms: async (owner, msg) => { sent.push(msg); return { ok: true }; } };
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, carriers, ringcentral, env: {} });
  const item = { trip: { tripNumber: '624268', powerUnit: 'OC1016', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [{ billNumber: 'B1' }], _oc: { carrier: { name: 'Zeal Xpress Inc' }, driverPhone: '(305) 555-0117' } };
  await dl.overlay('florida-beauty', [item]);

  const made = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '624268' });
  assert.equal(made.status, 200);
  assert.match(made.body.url, /^https:\/\/mytagalong\.app\/t\/[\w-]{20,}$/);
  assert.match(made.body.code, /^\d{6}$/);
  assert.match(made.body.message, /load 624268/);
  const tok = made.body.token;

  const txt = await app.call('POST', '/truckmate/oc/:trip/link/send', { trip: '624268' }, {}, { name: 'Ana', company: 'fbf' });
  assert.equal(txt.status, 200);
  assert.equal(sent[0].to, '+13055550117');
  assert.equal(txt.body.status, 'sent');

  const byCode = await app.call('POST', '/driver/code', {}, { code: made.body.code });
  assert.equal(byCode.body.token, tok);
  const view = await app.call('GET', '/driver/link/:token', { token: tok });
  assert.equal(view.body.active, true);
  assert.equal(view.body.destination, 'ATLANTA, GA');
  assert.equal(view.body.driverPhone, undefined, 'driver page never gets contact data');

  await app.call('POST', '/driver/link/:token/open', { token: tok }, { via: 'app' });
  const now = Date.now();
  const p = await app.call('POST', '/driver/link/:token/ping', { token: tok }, { via: 'app', points: [{ latitude: 30.33, longitude: -81.65, speed: 25, time: now - 30000 }, { latitude: 30.34, longitude: -81.66, speed: 26, time: now }] });
  assert.equal(p.body.status, 'sharing');

  const fresh = { ...item, trip: { ...item.trip } };
  await dl.overlay('florida-beauty', [fresh]);
  assert.equal(fresh._driverLink.status, 'sharing');
  assert.equal(fresh._driverLink.openedVia, 'app');
  assert.equal(fresh._samsara.source, 'driver app');
  assert.equal(fresh._samsara.lat, 30.34);
  const route = await dl.routeFor('florida-beauty', 'OC1016', now - 3600000);
  assert.equal(route.length, 2);

  const ck = await app.call('POST', '/driver/link/:token/checkin', { token: tok }, { note: 'At the receiver, waiting for a door' });
  assert.equal(ck.status, 200);
  assert.equal(checkins[0].trip, '624268');
  assert.equal(checkins[0].list[0].source, 'driver app');

  const done = { ...item, freightBills: [{ billNumber: 'B1', actualDelivery: '2026-10-04T18:00:00' }] };
  await dl.overlay('florida-beauty', [done]);
  assert.equal(done._driverLink.status, 'completed');
  const late = await app.call('POST', '/driver/link/:token/ping', { token: tok }, { points: [{ latitude: 30.4, longitude: -81.7 }] });
  assert.equal(late.status, 410);
});

test('a new link replaces the old one; revoke stops pings', async () => {
  const db = fakeDb(); const app = fakeApp();
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, env: {} });
  await dl.overlay('florida-beauty', [{ trip: { tripNumber: '1', powerUnit: 'OC1' } }]);
  const a = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '1' });
  const b = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '1' });
  const old = await app.call('POST', '/driver/link/:token/ping', { token: a.body.token }, { points: [{ lat: 1, lng: 1 }] });
  assert.equal(old.status, 410);
  await app.call('POST', '/truckmate/oc/:trip/link/revoke', { trip: '1' });
  const nope = await app.call('POST', '/driver/link/:token/ping', { token: b.body.token }, { points: [{ lat: 1, lng: 1 }] });
  assert.equal(nope.status, 410);
});

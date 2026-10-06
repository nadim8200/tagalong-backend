import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDriverLinks, linkStatus, cleanFixes, appendTrack, tripHistory, infoMissing, placeLabel } from '../driverlink.js';
import { ocFor, initCarriers } from '../carriers.js';
import { evaluateBoard } from '../watchtower.js';

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
  const infoSaved = [];
  const carriers = { addCheckins: async (site, trip, list) => { checkins.push({ site, trip, list }); }, setDriverInfo: async (site, trip, info) => { infoSaved.push({ site, trip, info }); } };
  const sent = [];
  const ringcentral = { sendSms: async (owner, msg) => { sent.push(msg); return { ok: true }; } };
  const lookups = [];
  const fetchFn = async (url) => { lookups.push(url); return { json: async () => ({ address: { city: 'Jacksonville', state: 'Florida', 'ISO3166-2-lvl4': 'US-FL' } }) }; };
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, carriers, ringcentral, env: {}, fetchFn });
  const item = { trip: { tripNumber: '624268', powerUnit: 'OC1016', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [{ billNumber: 'B1' }], _oc: { carrier: { name: 'Zeal Xpress Inc' }, driverPhone: '(305) 555-0117', smsConsent: { by: 'Ana', at: '2026-10-04T10:00:00Z' } } };
  await dl.overlay('florida-beauty', [item]);

  const made = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '624268' });
  assert.equal(made.status, 200);
  assert.match(made.body.url, /^https:\/\/mytagalong\.app\/t\/[\w-]{20,}$/);
  assert.match(made.body.code, /^\d{6}$/);
  assert.match(made.body.message, /load 624268/);
  assert.match(made.body.message, /Reply STOP to opt out\.$/);
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
  // sharing is blocked until the driver sends name, phone, truck and trailer
  const blocked = await app.call('POST', '/driver/link/:token/ping', { token: tok }, { points: [{ latitude: 30.3, longitude: -81.6 }] });
  assert.equal(blocked.status, 428);
  assert.equal(view.body.needInfo, true);
  assert.equal(view.body.crew, 'solo');
  const bad = await app.call('POST', '/driver/link/:token/info', { token: tok }, { drivers: [{ name: 'Test Driver', phone: '555' }], truck: '176' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.missing, ['driver phone', 'trailer #']);
  const good = await app.call('POST', '/driver/link/:token/info', { token: tok }, { drivers: [{ name: 'Test Driver', phone: '305-555-0117' }], truck: '176', trailer: 'RR53153' });
  assert.equal(good.status, 200);
  assert.equal(good.body.needInfo, false);
  assert.equal(infoSaved[0].trip, '624268');
  const now = Date.now();
  const p = await app.call('POST', '/driver/link/:token/ping', { token: tok }, { via: 'app', points: [{ latitude: 30.33, longitude: -81.65, speed: 25, time: now - 30000 }, { latitude: 30.34, longitude: -81.66, speed: 26, time: now }] });
  assert.equal(p.body.status, 'sharing');

  const fresh = { ...item, trip: { ...item.trip } };
  await dl.overlay('florida-beauty', [fresh]);
  assert.equal(fresh._driverLink.status, 'sharing');
  assert.equal(fresh._driverLink.openedVia, 'app');
  assert.equal(fresh._samsara.source, 'driver app');
  assert.equal(fresh._samsara.lat, 30.34);
  assert.equal(fresh._samsara.location, 'Jacksonville, FL', 'city, state instead of coordinates');
  assert.equal(lookups.length, 1);
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
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, env: {}, fetchFn: null });
  await dl.overlay('florida-beauty', [{ trip: { tripNumber: '1', powerUnit: 'OC1' } }]);
  const a = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '1' });
  const b = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '1' });
  const old = await app.call('POST', '/driver/link/:token/ping', { token: a.body.token }, { points: [{ lat: 1, lng: 1 }] });
  assert.equal(old.status, 410);
  await app.call('POST', '/truckmate/oc/:trip/link/revoke', { trip: '1' });
  const nope = await app.call('POST', '/driver/link/:token/ping', { token: b.body.token }, { points: [{ lat: 1, lng: 1 }] });
  assert.equal(nope.status, 410);
});

test('track: parked time folds into one point; history lists stops and miles', () => {
  const t0 = Date.parse('2026-10-04T10:00:00Z');
  const fix = (lat, lng, min) => ({ lat, lng, at: new Date(t0 + min * 60000).toISOString(), speedMph: 0 });
  let r = appendTrack([], [fix(30.0, -81.6, 0), fix(30.1, -81.6, 10)]);
  r = appendTrack(r.pts, [fix(30.1001, -81.6, 20), fix(30.1002, -81.6001, 45), fix(30.1, -81.6, 45)]);   // parked 35 min, then a duplicate
  r = appendTrack(r.pts, [fix(30.3, -81.6, 70)]);
  assert.equal(r.pts.length, 3);
  const h = tripHistory(r.pts);
  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].minutes, 35);
  assert.equal(h.miles, 21);
  assert.equal(h.startedAt, '2026-10-04T10:00:00.000Z');
  assert.equal(h.lastAt, '2026-10-04T11:10:00.000Z');
});

test('required info: solo needs one driver, team needs two, plus truck and trailer', () => {
  const d = (name, phone) => ({ name, phone });
  assert.deepEqual(infoMissing({ drivers: [d('Ana Lopez', '3055550117')], truck: '176', trailer: 'RR1' }, 'solo'), []);
  assert.deepEqual(infoMissing({ drivers: [d('Ana Lopez', '3055550117')], truck: '176', trailer: 'RR1' }, 'team'), ['driver 2 name', 'driver 2 phone']);
  assert.deepEqual(infoMissing(null, 'solo'), ['driver name', 'driver phone', 'truck #', 'trailer #']);
});

test('Watchtower: team OC load missing driver info alerts once moving; complete info clears it', () => {
  const store = { carriers: {}, codes: {}, marks: { 9: { crew: 'team', driverName: 'Ana', driverPhone: '3055550117', truck: '176', trailer: 'RR1' } } };
  const item = { trip: { tripNumber: '9', powerUnit: 'OC9', status: 'DEPSHIP' }, freightBills: [{ endZone: '30301', endZoneDescription: 'ATLANTA, GA' }] };
  item._oc = ocFor(item, store);
  assert.deepEqual(item._oc.missing, ['driver 2 name', 'driver 2 phone']);
  const hit = evaluateBoard({ trips: [item] }, { now: Date.now(), geo: () => null }).find((a) => a.code === 'oc-info-missing');
  assert.ok(hit, 'alert expected');
  assert.match(hit.title, /Team OC load missing driver info \(2\)/);
  store.marks[9] = { ...store.marks[9], driver2Name: 'Ben', driver2Phone: '3055550118' };
  item._oc = ocFor(item, store);
  assert.equal(evaluateBoard({ trips: [item] }, { now: Date.now(), geo: () => null }).find((a) => a.code === 'oc-info-missing'), undefined);
});

test('place label: city + state code', () => {
  assert.equal(placeLabel({ town: 'Walterboro', state: 'South Carolina' }), 'Walterboro, SC');
  assert.equal(placeLabel({ city: 'Hartford', 'ISO3166-2-lvl4': 'US-CT', state: 'Connecticut' }), 'Hartford, CT');
  assert.equal(placeLabel({}), null);
});

test('OC form saves the carrier name and main phone; the trip shows it', async () => {
  const db = fakeDb(); const app = fakeApp();
  const c = initCarriers(app, { requireAuth: () => {}, db });
  await app.call('POST', '/truckmate/oc/:trip', { trip: '7' }, { carrierName: 'Zeal Xpress Inc', carrierPhone: '305-555-0147', carrierEmail: 'ops@example.com', mc: '123456', dot: '7654321', crew: 'solo', driverName: 'Ana', driverPhone: '3055550117', truck: '176', trailer: 'RR1' });
  const item = { trip: { tripNumber: '7', powerUnit: '' } };
  await c.overlay('florida-beauty', [item]);
  assert.equal(item._oc.carrier.name, 'Zeal Xpress Inc');
  assert.equal(item._oc.carrier.dispatchPhone, '305-555-0147');
  assert.equal(item._oc.carrier.email, 'ops@example.com');
  assert.equal(item._oc.carrier.mc, '123456');
  assert.equal(item._oc.truck, '176');
  assert.equal(item._oc.trailer, 'RR1');
  assert.deepEqual(item._oc.missing, []);
});

test('texting the link needs the driver\'s recorded consent', async () => {
  const db = fakeDb(); const app = fakeApp();
  const ringcentral = { sendSms: async () => ({ ok: true }) };
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, ringcentral, env: {}, fetchFn: null });
  await dl.overlay('florida-beauty', [{ trip: { tripNumber: '5', powerUnit: 'OC5' }, _oc: { driverPhone: '3055550100' } }]);
  await app.call('POST', '/truckmate/oc/:trip/link', { trip: '5' });
  const r = await app.call('POST', '/truckmate/oc/:trip/link/send', { trip: '5' }, {}, { name: 'Ana', company: 'fbf' });
  assert.equal(r.status, 409);
  assert.equal(r.body.needConsent, true);
});

test('driver uploads POD photos from the link: stored on the load, marked POD, logged', async () => {
  const db = fakeDb(); const app = fakeApp();
  const stored = []; const marked = []; const checkins = [];
  const docs = { enabled: true, storeDocs: async (a) => { stored.push(a); return a.files.map((f, i) => ({ id: String(100 + i) })); }, markDocs: async (a) => { marked.push(a); } };
  const carriers = { addCheckins: async (site, trip, list) => checkins.push({ trip, list }), setDriverInfo: async () => {} };
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, docs, carriers, env: {}, fetchFn: null });
  await dl.overlay('florida-beauty', [{ trip: { tripNumber: '9', powerUnit: 'OC9' } }]);
  const made = await app.call('POST', '/truckmate/oc/:trip/link', { trip: '9' });
  const r = await app.call('POST', '/driver/link/:token/docs', { token: made.body.token }, { kind: 'pod', files: [{ mediaType: 'image/jpeg', dataBase64: 'AAAA' }, { mediaType: 'image/jpeg', dataBase64: 'BBBB' }] });
  assert.equal(r.status, 200);
  assert.equal(stored[0].kind, 'driverdoc'); assert.equal(stored[0].trip, '9');
  assert.equal(marked[0].docType, 'proof_of_delivery');
  assert.match(checkins[0].list[0].text, /POD \(2 pages\)/);
});

test('upload-only link for a company driver: no location sharing, no info form', async () => {
  const db = fakeDb(); const app = fakeApp();
  const dl = initDriverLinks(app, { requireAuth: () => {}, db, env: {}, fetchFn: null });
  await dl.overlay('florida-beauty', [{ trip: { tripNumber: '624278', powerUnit: '937' } }]);
  const url = await dl.ensureDocsLink('florida-beauty', '624278', 'Rosa');
  assert.match(url, /\/t\/[\w-]+$/);
  assert.equal(await dl.ensureDocsLink('florida-beauty', '624278', 'Rosa'), url, 'reuses the live link');
  const tok = url.split('/t/')[1];
  const view = await app.call('GET', '/driver/link/:token', { token: tok });
  assert.equal(view.body.purpose, 'docs');
  assert.equal(view.body.needInfo, false);
});

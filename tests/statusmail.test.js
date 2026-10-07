import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifies, stopsOf, pendingEvents, renderEvent, initStatusMail } from '../statusmail.js';

const NOW = Date.parse('2026-10-05T16:00:00Z');
const geo = (zip) => ({ 30436: { lat: 32.11, lng: -82.32 }, 31601: { lat: 30.83, lng: -83.28 } }[zip] || null);
const load = (over = {}) => ({
  trip: { tripNumber: '900200', status: 'DISP', powerUnit: '2403', trailer: '5310', driver: 'JDOE', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'LYONS, GA, 30436', ...(over.trip || {}) },
  freightBills: over.bills || [
    { billNumber: 'B0180251', billToName: 'Fixture Floral Co', endZoneDescription: 'VALDOSTA, GA, 31601', actualDelivery: null },
    { billNumber: 'R0180252', billToName: 'Rose Brokers', endZoneDescription: 'LYONS, GA, 30436', actualDelivery: null },
  ],
  _samsara: { lat: 25.8, lng: -80.33, gpsAt: '2026-10-05T15:55:00Z', location: 'Miami, FL', speedMph: 0, driver1Info: { name: 'John Doe', phone: '+13055550100' } },
  _times: { statusHistory: over.hist || [] },
  ...(over.extra || {}),
});

test('only B and R loads qualify', () => {
  assert.equal(qualifies(load()), true);
  assert.equal(qualifies(load({ bills: [{ billNumber: 'H123', endZoneDescription: 'X, GA, 30436' }] })), false);
});

test('events in order: assigned → picked up → arrivals → delivered, then 3-hour updates', () => {
  assert.deepEqual(pendingEvents(load(), {}, { now: NOW }).map((e) => e.kind), ['assigned']);
  const sent = { assigned: 'x' };
  const rolling = load({ trip: { status: 'DEPSHIP' }, hist: [{ status: 'DEPSHIP', at: '2026-10-05T15:00:00Z' }] });
  assert.deepEqual(pendingEvents(rolling, sent, { now: NOW }).map((e) => e.kind), ['picked-up']);
  const s2 = { assigned: 'x', pickedUp: '2026-10-05T12:00:00Z', stops: {} };
  assert.deepEqual(pendingEvents(rolling, s2, { now: NOW }).map((e) => e.kind), ['location'], '3h since pickup → location');
  assert.deepEqual(pendingEvents(rolling, { ...s2, lastLocationAt: '2026-10-05T14:00:00Z' }, { now: NOW }), [], 'not yet 3h');
  const arrived = load({ trip: { status: 'ARRCONS' }, hist: [{ status: 'DEPSHIP' }, { status: 'ARRCONS' }] });
  const a = pendingEvents(arrived, s2, { now: NOW });
  assert.deepEqual(a.map((e) => [e.kind, e.number, e.of]), [['arrived', 1, 2]]);
  const done = load({ trip: { status: 'DEPCONS' }, bills: load().freightBills.map((b) => ({ ...b, actualDelivery: '2026-10-05T11:00:00' })) });
  const d = pendingEvents(done, { ...s2, stops: { 'VALDOSTA, GA, 31601': 'x' } }, { now: NOW });
  assert.deepEqual(d.map((e) => e.kind), ['arrived', 'delivered']);
});

test('the assigned email has truck, trailer, driver name + phone, location and pickup ETA', () => {
  const m = renderEvent({ kind: 'assigned' }, load(), { geo, now: NOW });
  assert.match(m.subject, /^Truck assigned — Trip 900200 · Bill B0180251, R0180252/);
  for (const s of ['2403', '5310', 'John Doe', '+13055550100', 'Miami, FL', 'At the pickup now']) assert.ok(m.html.includes(s), s);
  const arr = renderEvent({ kind: 'arrived', stop: 'LYONS, GA, 30436', number: 2, of: 2 }, load(), { geo, now: NOW });
  assert.match(arr.subject, /^Arrived at stop 2 of 2/);
  assert.equal(stopsOf(load())[1].number, 2);
});

function memDb() {
  const m = new Map();
  return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
}

test('first run adopts silently; later events email the customer list and log on the load', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const sent = [];
  const fetchFn = async (url, opts) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    sent.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({}) };
  };
  const db = memDb();
  await db.set('taStatusMailCfg', { customers: { 'FIXTURE FLORAL CO': ['ops@fixture.com'] } });
  const logged = [];
  const sm = initStatusMail({ get() {}, put() {}, post() {} }, { requireAuth: () => {}, db, env, fetchFn, comms: { log: async (s, t, e) => logged.push(e) } });
  await sm.process('fb', { trips: [load()] }, { geo, now: NOW });
  assert.equal(sent.length, 0, 'adopted, not sent');
  const picked = load({ trip: { status: 'DEPSHIP' } });
  await sm.process('fb', { trips: [picked] }, { geo, now: NOW + 60000 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.subject, /^Load picked up — driver departed shipper/);
  assert.deepEqual(sent[0].message.toRecipients.map((r) => r.emailAddress.address), ['ops@fixture.com']);
  assert.equal(logged[0].auto, true);
  await sm.process('fb', { trips: [picked] }, { geo, now: NOW + 120000 });
  assert.equal(sent.length, 1, 'once only');
  // a new load first seen already arrived: only the newest milestone goes out
  const other = load({ trip: { tripNumber: '900201', status: 'ARRCONS' }, hist: [{ status: 'DEPSHIP' }, { status: 'ARRCONS' }] });
  await sm.process('fb', { trips: [picked, other] }, { geo, now: NOW + 180000 });
  assert.equal(sent.length, 2);
  assert.match(sent[1].message.subject, /^Arrived at stop 1 of 2 — Trip 900201/);
});

import { contactsFor } from '../statusmail.js';
import { evaluateBoard } from '../watchtower.js';

test('contacts: trip sheet + TruckMate merged, verified when both agree, differences flagged, edits replace', () => {
  const item = load({ extra: { _manifest: { contacts: [{ role: 'broker', company: 'Rose Brokers', name: 'Ana', email: 'ana@rosebrokers.com', phone: '305-555-0101', source: 'rate con p1' }], stops: [{ customer: 'Valdosta Florist', callAhead: [{ contact: 'Joe', phone: '229 555 0102' }] }] } } });
  item.freightBills[1].caller = { name: 'Rose Brokers', email: 'ANA@rosebrokers.com', phone: '3055550101' };
  item.freightBills[0].billToCustomer = { name: 'Fixture Floral Co', emailAddress: 'ops@fixture.com' };
  const r = contactsFor(item);
  const ana = r.contacts.find((c) => c.email === 'ana@rosebrokers.com');
  assert.equal(ana.verified, true); assert.deepEqual(ana.sources, ['trip sheet', 'TruckMate']);
  assert.ok(r.contacts.find((c) => c.phone === '2295550102' && c.role === 'receiver'));
  assert.ok(r.contacts.find((c) => c.email === 'ops@fixture.com' && c.role === 'customer'));
  item.freightBills[1].caller.email = 'dispatch@rosebrokers.com';
  const r2 = contactsFor(item);
  assert.equal(r2.contacts.find((c) => c.email === 'ana@rosebrokers.com').differs, 'dispatch@rosebrokers.com');
  const r3 = contactsFor(item, { edit: { emails: ['new@rosebrokers.com'], phones: [] } });
  assert.equal(r3.edited, true); assert.deepEqual(r3.contacts.map((c) => c.email), ['new@rosebrokers.com']);
});

test('breakdown switch emails + texts everyone on the load, pauses location emails, and "back on the road" follows', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const mails = []; const texts = [];
  const fetchFn = async (url, opts) => (url.includes('oauth2') ? { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) } : (mails.push(JSON.parse(opts.body)), { ok: true, status: 202, json: async () => ({}) }));
  const rc = { configFor: async () => ({ fromNumber: '+17867233912' }), sendSms: async (o, m) => { texts.push(m); return { id: 1 }; } };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  const db = memDb();
  const sm = initStatusMail(app, { requireAuth: () => {}, db, env, fetchFn, ringcentral: rc, comms: { log: async () => {} } });
  const item = load({ trip: { status: 'DEPSHIP' }, extra: { _manifest: { contacts: [{ role: 'broker', company: 'Rose', email: 'ana@rose.com', phone: '3055550101' }], stops: [{ customer: 'Valdosta Florist', callAhead: [{ phone: '2295550102' }] }] } } });
  await sm.process('florida-beauty', { trips: [item] }, { geo, now: NOW });
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['POST /truckmate/breakdown/:trip']({ params: { trip: '900200' }, body: { on: true }, query: {}, user: { name: 'Ana D', id: 'u1' } }, res);
  assert.equal(out.emailStatus, 'sent'); assert.deepEqual(out.emailed, ['ana@rose.com']);
  assert.equal(texts.length, 2);
  assert.match(texts[0].text, /has had a breakdown\. The ETA will be impacted\. We will get back to you as soon as we have a better update\. Reply STOP to opt out\.$/);
  assert.match(mails[0].message.subject, /^Delay notice — truck breakdown — Trip 900200/);
  const trips = [{ trip: { tripNumber: '900200' } }]; await sm.overlay('florida-beauty', trips); assert.equal(trips[0]._breakdown.on, true);
  // three hours later: no routine location email while broken down
  const before = mails.length;
  await sm.process('florida-beauty', { trips: [item] }, { geo, now: NOW + 4 * 3600000 });
  assert.equal(mails.length, before);
  await routes['POST /truckmate/breakdown/:trip']({ params: { trip: '900200' }, body: { on: false, note: 'Alternator replaced' }, query: {}, user: { name: 'Ana D' } }, res);
  assert.match(mails.at(-1).message.subject, /^Back on the road/);
  assert.ok(mails.at(-1).message.body.content.includes('Alternator replaced'));
});

test('stopped alert: on duty and parked 45+ min alerts; resting (sleeper) does not', () => {
  const now = Date.parse('2026-10-05T16:00:00Z');
  const item = (status) => ({ trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '2403' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'LYONS, GA, 30436' }], _samsara: { lat: 32.84, lng: -83.63, gpsAt: '2026-10-05T15:58:00Z', speedMph: 0, location: 'Macon, GA', hos: { status, driveLeftMin: 400, shiftLeftMin: 500 } } });
  const ctx = (mins) => ({ now, geo: () => null, unitState: () => ({ stoppedSince: now - mins * 60000 }) });
  const find = (b, c) => evaluateBoard({ trips: [b] }, c).find((a) => a.code === 'stopped');
  assert.match(find(item('onDuty'), ctx(50)).title, /Stopped 50m and not resting/);
  assert.equal(find(item('onDuty'), ctx(95)).severity, 'critical');
  assert.equal(find(item('sleeperBerth'), ctx(300)), undefined);
  assert.match(find(item('sleeperBerth'), ctx(12 * 60)).title, /longer than a 10-hour break/);
});

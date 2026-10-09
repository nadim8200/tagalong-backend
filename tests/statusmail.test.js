import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifies, stopsOf, pendingEvents, renderEvent, initStatusMail, trackPickup, lateNotice, assignmentOf } from '../statusmail.js';

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
  assert.match(m.subject, /^Truck 2403, trailer 5310 and driver assigned — Trip 900200 · Bill B0180251, R0180252/);
  for (const s of ['2403', '5310', 'John Doe', '+13055550100', 'Miami, FL', 'At the pickup now']) assert.ok(m.html.includes(s), s);
  const arr = renderEvent({ kind: 'arrived', stop: 'LYONS, GA, 30436', number: 2, of: 2 }, load(), { geo, now: NOW });
  assert.match(arr.subject, /^Arrived at stop 2 of 2/);
  assert.equal(stopsOf(load())[1].number, 2);
});

// what the fake Outlook received — JSON, or MIME (text + HTML) decoded to the same shape
function readSent(opts) {
  if (!/text\/plain/.test(String((opts.headers || {})['Content-Type'] || ''))) return JSON.parse(opts.body);
  const mime = Buffer.from(opts.body, 'base64').toString('utf8');
  const subj = (mime.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m) || [])[1];
  const to = ((mime.match(/^To: (.*)$/m) || [])[1] || '').split(/,\s*/).filter(Boolean);
  return { message: { subject: subj ? Buffer.from(subj, 'base64').toString('utf8') : '', toRecipients: to.map((address) => ({ emailAddress: { address } })) }, mime };
}
function memDb() {
  const m = new Map();
  return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
}

test('first run adopts silently; later events email the customer list and log on the load', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const sent = [];
  const fetchFn = async (url, opts) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    sent.push(readSent(opts)); return { ok: true, status: 202, json: async () => ({}) };
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
  assert.match(sent[0].message.subject, /^Fixture Floral Co \| 0 delivered · 0 delayed \| .* \| Trip 900200$/);
  assert.match(Buffer.from((sent[0].mime.match(/text\/plain[\s\S]*?base64\r\n\r\n([\s\S]*?)\r\n--/) || [])[1].replace(/\r\n/g, ''), 'base64').toString(), /Loaded and ready to roll — 2 stops: 1\. VALDOSTA, GA, 2\. LYONS, GA\. We'll keep you posted\.[\s\S]*· Trip 900200 · Truck 2403/);
  assert.deepEqual(sent[0].message.toRecipients.map((r) => r.emailAddress.address), ['ops@fixture.com']);
  assert.equal(logged[0].auto, true);
  await sm.process('fb', { trips: [picked] }, { geo, now: NOW + 120000 });
  assert.equal(sent.length, 1, 'once only');
  // a new load first seen already arrived: only the newest milestone goes out
  const other = load({ trip: { tripNumber: '900201', status: 'ARRCONS' }, hist: [{ status: 'DEPSHIP' }, { status: 'ARRCONS' }] });
  await sm.process('fb', { trips: [picked, other] }, { geo, now: NOW + 180000 });
  assert.equal(sent.length, 2);
  assert.match(sent[1].message.subject, /\| Trip 900201$/);
  assert.match(Buffer.from((sent[1].mime.match(/text\/plain[\s\S]*?base64\r\n\r\n([\s\S]*?)\r\n--/) || [])[1].replace(/\r\n/g, ''), 'base64').toString(), /Driver at the receiver \(stop 1 of 2\)/);
});

test('broker updates only when asked: current location now, then at 8/12/4 AM-PM & 8/12/4 night, milestones to the broker too, ends at delivery', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const sent = [];
  const fetchFn = async (url, opts) => { if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) }; sent.push(readSent(opts)); return { ok: true, status: 202, json: async () => ({}) }; };
  const db = memDb();
  await db.set('taStatusMailCfg', { customers: { 'FIXTURE FLORAL CO': ['ops@fixture.com'] } });
  const chains = [];
  const sm = initStatusMail({ get() {}, put() {}, post() {} }, { requireAuth: () => {}, db, env, fetchFn, track: async (site, trip) => `https://mytagalong.app/s/tok${trip}`, chainReply: async (site, trip, m) => { chains.push({ trip, ...m }); return { sent: true, chain: 'msg1' }; } });
  const rc = { _ratecon: { data: { brokerEmail: 'ana@rosebrokers.com', contacts: [{ role: 'tracking', email: 'tracking@rosebrokers.com' }] } } };
  const picked = load({ trip: { status: 'DEPSHIP' }, extra: rc });
  const T = Date.parse('2026-10-09T13:30:00Z');   // Fri 9:30 AM ET
  await sm.process('fb', { trips: [load({ extra: rc })] }, { geo, now: T - 3600000 });
  await sm.process('fb', { trips: [picked] }, { geo, now: T - 1800000 });
  await sm.process('fb', { trips: [picked] }, { geo, now: T + 5 * 3600000 });
  assert.equal(chains.length, 0, 'no automatic location updates any more');
  await sm.watch('fb', '900200', { emailId: 'ask1', by: 'Rosa' });
  await sm.process('fb', { trips: [picked] }, { geo, now: T });
  assert.equal(chains.length, 1, 'current location right away');
  assert.deepEqual([chains[0].to, chains[0].cc], [['ana@rosebrokers.com'], ['tracking@rosebrokers.com']]);
  assert.match(chains[0].text, /Track this load live/);
  await sm.process('fb', { trips: [picked] }, { geo, now: T + 30 * 60000 });
  assert.equal(chains.length, 1, 'nothing until the next set time');
  await sm.process('fb', { trips: [picked] }, { geo, now: Date.parse('2026-10-09T16:05:00Z') });   // 12:05 PM ET
  assert.equal(chains.length, 2, '12 PM update');
  await sm.process('fb', { trips: [picked] }, { geo, now: Date.parse('2026-10-09T16:30:00Z') });
  assert.equal(chains.length, 2);
  // delivered → the milestone goes to the broker too, then the watch ends
  const done = load({ trip: { status: 'DELVD' }, hist: [{ status: 'DEPSHIP' }, { status: 'ARRCONS' }, { status: 'DELVD' }], bills: [{ billNumber: 'B0180251', billToName: 'Fixture Floral Co', endZoneDescription: 'VALDOSTA, GA, 31601', actualDelivery: '2026-10-09T17:00:00Z' }, { billNumber: 'R0180252', billToName: 'Rose Brokers', endZoneDescription: 'LYONS, GA, 30436', actualDelivery: '2026-10-09T19:00:00Z' }], extra: rc });
  await sm.process('fb', { trips: [done] }, { geo, now: Date.parse('2026-10-09T20:05:00Z') });
  const last = chains[chains.length - 1];
  assert.ok(last.to.includes('ana@rosebrokers.com') && last.to.includes('ops@fixture.com'), 'milestone to the broker and the customer list');
  assert.deepEqual(await db.get('taBrokerWatch:fb', {}), {}, 'watch ended at delivery');
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

test('GPS pickup: sat at the Miami yard, now 25+ mi out → picked up even with no TruckMate status', () => {
  const t0 = Date.parse('2026-10-05T01:00:00Z');
  const at = (lat, lng, ms) => load({ trip: { status: 'DISP' }, extra: { _samsara: { lat, lng, gpsAt: new Date(ms).toISOString(), speedMph: 0 } } });
  let g = trackPickup(at(25.7950, -80.3100, t0), {}, { now: t0 });
  assert.ok(g.nearAt && !g.leftAt);
  g = trackPickup(at(25.7950, -80.3100, t0 + 40 * 60000), g, { now: t0 + 40 * 60000 });
  g = trackPickup(at(26.3, -80.2, t0 + 80 * 60000), g, { now: t0 + 80 * 60000 });   // ~35 mi north
  assert.equal(g.leftAt, new Date(t0 + 40 * 60000).toISOString());
  const evs = pendingEvents(at(26.3, -80.2, t0 + 80 * 60000), { assigned: 'x' }, { now: t0 + 80 * 60000, gps: g });
  assert.deepEqual(evs.map((e) => [e.kind, e.gps]), [['picked-up', true]]);
  const m = renderEvent(evs[0], load(), { now: t0 + 80 * 60000 });
  assert.match(m.html, /our GPS shows the trailer departed/);
  assert.match(m.html, /Departed/);
  // only drove past the yard → not a pickup
  let d = trackPickup(at(25.7950, -80.3100, t0), {}, { now: t0 });
  d = trackPickup(at(26.3, -80.2, t0 + 30 * 60000), d, { now: t0 + 30 * 60000 });
  assert.equal(d.leftAt, undefined);
  assert.equal(d.nearAt, undefined);
});

test('delay notice: once per stop before a missed appointment, again only if it slips 90+ min', () => {
  const now = Date.parse('2026-10-08T17:30:00Z');
  const appt = Date.parse('2026-10-08T17:24:00Z') + 60 * 60000;     // 10:24 AM PT appt … in the future
  const e = { at: now, stops: [{ key: 'CLOVIS, CA, 93612', label: 'CLOVIS, CA, 93612', miles: 101, etaMs: appt + 111 * 60000, apptMs: appt, apptFrom: 'truckmate-appt' }] };
  const n = lateNotice(e, {}, { now });
  assert.equal(n.kind, 'late'); assert.equal(n.lateMin, 111); assert.equal(n.revised, false);
  assert.equal(lateNotice(e, { [n.stop]: { etaMs: n.etaMs } }, { now }), null, 'already told');
  const slipped = { ...e, stops: [{ ...e.stops[0], etaMs: n.etaMs + 100 * 60000 }] };
  assert.equal(lateNotice(slipped, { [n.stop]: { etaMs: n.etaMs } }, { now }).revised, true);
  assert.equal(lateNotice({ ...e, stops: [{ ...e.stops[0], apptFrom: 'truckmate-due' }] }, {}, { now }), null, 'bare due time is not an appointment');
  assert.equal(lateNotice({ ...e, stops: [{ ...e.stops[0], etaMs: appt + 20 * 60000 }] }, {}, { now }), null, '20 min is not worth a notice');
  const m = renderEvent(n, load({ bills: [{ billNumber: 'B180215', billToName: 'PAYSTAR LOGISTICS', endZoneDescription: 'CLOVIS, CA, 93612' }] }), { now });
  assert.match(m.subject, /^Delay notice — new ETA — Trip 900200 · Bill B180215/);
  assert.match(m.html, /about 1h 51m after the appointment/);
  assert.match(m.html, /Pacific/);
  assert.match(m.html, /may change/);
});

test('trailer loaded, drivers and swaps each get their own email; LOADED TO GO is not "picked up"', () => {
  const NOW2 = Date.parse('2026-10-05T16:00:00Z');
  // truck + trailer on the load, no driver yet
  const noDriver = load({ trip: { status: 'ASSGN', driver: '' }, extra: { _samsara: { lat: 25.79, lng: -80.31, gpsAt: '2026-10-05T15:55:00Z', speedMph: 0 } } });
  let evs = pendingEvents(noDriver, {}, { now: NOW2 });
  assert.deepEqual(evs.map((e) => e.parts), [['truck', 'trailer']]);
  const told = evs[0].told;
  assert.match(renderEvent(evs[0], noDriver, { now: NOW2 }).subject, /^Truck 2403 and trailer 5310 assigned/);
  // driver assigned later
  const withDriver = load({ trip: { status: 'DISP' } });
  evs = pendingEvents(withDriver, { assigned: 'x', told }, { now: NOW2 });
  assert.deepEqual(evs.map((e) => e.parts), [['drivers']]);
  assert.match(renderEvent(evs[0], withDriver, { now: NOW2 }).subject, /^Driver assigned/);
  // trailer loaded to go — loaded email, and NOT picked up
  const loaded = load({ trip: { status: 'LOADEDTOGO' }, hist: [{ status: 'LOADINGMAN' }, { status: 'LOADEDTOGO' }] });
  const t2 = { ...assignmentOf(withDriver) };
  evs = pendingEvents(loaded, { assigned: 'x', told: t2 }, { now: NOW2 });
  assert.deepEqual(evs.map((e) => [e.kind, e.parts]), [['assigned', ['loaded']]]);
  const m = renderEvent(evs[0], loaded, { now: NOW2 });
  assert.match(m.subject, /^Trailer 5310 loaded — Trip/);
  assert.match(m.html, /We will let you know as soon as it departs/);
  // trailer swap
  const swapped = load({ trip: { status: 'LOADEDTOGO', trailer: '7141' }, hist: [{ status: 'LOADEDTOGO' }] });
  evs = pendingEvents(swapped, { assigned: 'x', told: { ...t2, loaded: true } }, { now: NOW2 });
  assert.deepEqual(evs.map((e) => [e.parts, e.changed]), [[['trailer'], ['trailer']]]);
  assert.match(renderEvent(evs[0], swapped, { now: NOW2 }).subject, /^Update: new trailer 7141 assigned/);
  // loads told the old way don't get re-announced
  assert.deepEqual(pendingEvents(withDriver, { assigned: 'x' }, { now: NOW2 }), []);
  // departed → the rolling email
  const gone = load({ trip: { status: 'DEPSHIP' }, hist: [{ status: 'LOADEDTOGO' }, { status: 'DEPSHIP', at: '2026-10-05T15:00:00Z' }] });
  evs = pendingEvents(gone, { assigned: 'x', told: { ...t2, loaded: true } }, { now: NOW2 });
  assert.deepEqual(evs.map((e) => e.kind), ['picked-up']);
  assert.match(renderEvent(evs[0], gone, { now: NOW2 }).subject, /^Picked up — trailer departed and rolling/);
});

test('SOP: hourly "headed to shipper" before pickup, then "still at the shipper"; stage headlines', async () => {
  const { sopStage } = await import('../statusmail.js');
  const assigned = { assigned: new Date(NOW - 2 * 3600000).toISOString(), told: { truck: '2403', trailer: '5310', drivers: 'JDOE' } };
  const live = { _samsara: { lat: 25.9, lng: -80.3, gpsAt: new Date(NOW - 60000).toISOString(), speedMph: 55, driver1Info: { name: 'John Doe' } } };
  const before = load({ trip: { status: 'DISP' }, extra: live });
  assert.deepEqual(pendingEvents(before, { ...assigned }, { now: NOW, everyHours: 1 }).map((e) => [e.kind, e.stage]), [['location', 'to-shipper']]);
  assert.deepEqual(pendingEvents(before, { ...assigned, lastPrePickAt: new Date(NOW - 30 * 60000).toISOString() }, { now: NOW, everyHours: 1 }), [], 'not yet an hour');
  const atShip = { ...assigned, atShipper: new Date(NOW - 70 * 60000).toISOString() };
  assert.deepEqual(pendingEvents(before, atShip, { now: NOW, everyHours: 1 }).map((e) => e.stage), ['at-shipper']);
  const s1 = sopStage({ kind: 'location', stage: 'to-shipper' }, before, { geo, now: NOW });
  assert.equal(s1.stage, 'Headed to shipper'); assert.match(s1.headline, /^Empty and headed to the shipper — about \d+ mi away\. We'll keep you posted\./);
  assert.equal(sopStage({ kind: 'delivered' }, before, { now: NOW }).attach, 'pod');
  assert.equal(sopStage({ kind: 'picked-up' }, before, { now: NOW }).attach, 'bol');
});

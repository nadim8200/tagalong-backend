import test from 'node:test';
import assert from 'node:assert/strict';
import { initCommitments, lateStops, nextMorning, commitMs, stopKey, lateMessage } from '../commitments.js';
import { resolvePhones } from '../alertrecipients.js';
import { boardEtas } from '../watchtower.js';

function memDb() {
  const m = new Map();
  return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
}
function setup(nowMs) {
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, post: () => {} };
  const db = memDb(); const mails = []; const texts = []; let now = nowMs;
  const c = initCommitments(app, { requireAuth: (q, r, n) => n(), db, sendMail: async (m) => mails.push(m), emails: async () => ['dispatch@floridabeauty.us'], phones: async () => ['+13055550100'], sendSms: async (to, text) => texts.push({ to, text }), now: () => now });
  const hit = async (route, body = {}, params = {}) => {
    let code = 200; let out;
    const res = { status(x) { code = x; return this; }, json(j) { out = j; } };
    const hs = routes[route]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h({ body, params, user: { name: 'Rosa' } }, res, next); };
    await next(); return { code, out };
  };
  return { c, db, mails, texts, hit, setNow: (x) => { now = x; } };
}

test('stop keys and committed times in the stop\'s own time zone', () => {
  assert.equal(stopKey('Broussard', 'la'), 'BROUSSARD|LA');
  assert.equal(stopKey('BROUSSARD, LA, 70518'), null, 'needs a state');
  assert.equal(new Date(commitMs('2026-10-23T08:00', 'LA')).toISOString(), '2026-10-23T13:00:00.000Z');   // 8 AM Central
  assert.equal(commitMs('tomorrow', 'LA'), null);
  assert.equal(new Date(nextMorning(Date.parse('2026-10-22T02:00:00Z'))).toISOString(), '2026-10-22T10:00:00.000Z');   // left Wed 10 PM ET → Thu 6 AM ET
});

test('late check: only after the morning after the truck left (or 6 h before), and only more than an hour late', () => {
  const at = Date.parse('2026-10-23T13:00:00Z');
  const commits = { 'BROUSSARD|LA': { local: '2026-10-23T08:00', state: 'LA', atMs: at, customer: "SPEDALE'S", place: 'BROUSSARD, LA' } };
  const etas = (lateBy) => ({ stops: [{ label: 'BROUSSARD, LA, 70518', etaMs: at + lateBy * 60000, miles: 300 }] });
  const leftAt = Date.parse('2026-10-22T02:00:00Z');
  assert.deepEqual(lateStops({ commits, etas: etas(180), leftAt, now: Date.parse('2026-10-22T05:00:00Z') }), [], 'night it left: not yet');
  assert.equal(lateStops({ commits, etas: etas(180), leftAt, now: Date.parse('2026-10-22T10:30:00Z') })[0].lateMin, 180);
  assert.deepEqual(lateStops({ commits, etas: etas(45), leftAt, now: Date.parse('2026-10-22T10:30:00Z') }), [], '45 min late: no alert');
  assert.deepEqual(lateStops({ commits, etas: etas(180), leftAt: null, now: Date.parse('2026-10-22T10:30:00Z') }), [], 'truck has not left');
  // a short run: committed 6 AM the morning after → the check opens at midnight (6 h before), not at 6 AM
  const soon = { 'X|FL': { atMs: Date.parse('2026-10-22T10:00:00Z'), place: 'ORLANDO, FL' } };
  assert.equal(lateStops({ commits: soon, etas: { stops: [{ label: 'ORLANDO, FL', etaMs: Date.parse('2026-10-22T12:00:00Z') }] }, leftAt, now: Date.parse('2026-10-22T05:00:00Z') }).length, 0, 'X|FL ≠ ORLANDO|FL');
  const soon2 = { 'ORLANDO|FL': { atMs: Date.parse('2026-10-22T10:00:00Z'), place: 'ORLANDO, FL' } };
  assert.equal(lateStops({ commits: soon2, etas: { stops: [{ label: 'ORLANDO, FL', etaMs: Date.parse('2026-10-22T12:00:00Z') }] }, leftAt, now: Date.parse('2026-10-22T05:00:00Z') }).length, 1);
  const m = lateMessage({ trip: { tripNumber: '625552', powerUnit: '2604', trailer: '7309' } }, { ...commits['BROUSSARD|LA'], etaMs: at + 180 * 60000, lateMin: 180, by: 'Rosa' });
  assert.match(m.subject, /Late for a committed time — trip 625552 · SPEDALE'S, BROUSSARD, LA/);
  assert.match(m.sms, /~3h late to SPEDALE'S, BROUSSARD, LA/);
  assert.match(m.text, /Customer notification: Not sent by Jarvis/);
  assert.match(m.text, /^DELIVERY DELAY\nEstimated 3 h late/);
});

test('set a committed time on a stop → it becomes the stop\'s appointment → late email + text once', async () => {
  const v = setup(Date.parse('2026-10-21T20:00:00Z'));
  const r = await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', customer: "SPEDALE'S FLORIST", place: 'BROUSSARD, LA', local: '2026-10-23T08:00' }, { trip: '625552' });
  assert.equal(r.out['BROUSSARD|LA'].by, 'Rosa');
  assert.equal((await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', local: 'soon' }, { trip: '625552' })).code, 400);
  const it = { trip: { tripNumber: '625552', status: 'DEPSHIP', powerUnit: '2604', trailer: '7309' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'BROUSSARD, LA, 70518', pieces: 62 }], _samsara: { gpsAt: '2026-10-22T11:00:00Z', speedMph: 60, lat: 30.4, lng: -84.3, hos: { driveLeftMin: 600, shiftLeftMin: 700 } } };
  await v.c.overlay('florida-beauty', [it]);
  assert.equal(it._commit['BROUSSARD|LA'].local, '2026-10-23T08:00');
  // the watchtower now uses it as the stop's appointment
  const e = boardEtas({ trips: [it] }, { now: Date.parse('2026-10-22T11:00:00Z'), geo: () => ({ lat: 30.2, lng: -91.99 }), unitState: () => ({}) })['625552'];
  assert.equal(e.stops[0].apptFrom, 'committed');
  // the truck leaves Wed night; Thursday morning the ETA is 3 h past the commitment → one email + one text
  v.setNow(Date.parse('2026-10-22T02:00:00Z'));
  await v.c.process('florida-beauty', { trips: [it] });
  await v.db.set('taWatch:florida-beauty', { etas: { 625552: { stops: [{ label: 'BROUSSARD, LA, 70518', etaMs: Date.parse('2026-10-23T16:00:00Z'), miles: 600 }] } } });
  assert.equal((await v.c.process('florida-beauty', { trips: [it] })).sent, 0, 'not before the next morning');
  v.setNow(Date.parse('2026-10-22T10:05:00Z'));
  assert.equal((await v.c.process('florida-beauty', { trips: [it] })).sent, 1);
  assert.equal(v.mails.length, 1); assert.deepEqual(v.mails[0].to, ['dispatch@floridabeauty.us']);
  assert.equal(v.texts.length, 1); assert.equal(v.texts[0].to, '+13055550100');
  assert.equal((await v.c.process('florida-beauty', { trips: [it] })).sent, 0, 'once per stop + time');
  // clearing the time removes it
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', local: null }, { trip: '625552' });
  const after = (await v.hit('GET /truckmate/commitments/:trip', {}, { trip: '625552' })).out;
  assert.equal(after['BROUSSARD|LA'].cleared, true); assert.equal(after['BROUSSARD|LA'].atMs, undefined);
});

test('texts go to phone numbers or employees\' phones', () => {
  const r = resolvePhones(['305-555-0100', 'Frank Ducassi', 'Nobody Here'], { people: [{ name: 'Frank Ducassi', phone: '(305) 748-5611' }] });
  assert.deepEqual(r.phones, ['+13055550100', '+13057485611']);
  assert.deepEqual(r.unresolved, ['Nobody Here']);
});

import { toStanding, fromStanding, custKey } from '../commitments.js';
test('saved for next time: same weekday → same weekday + time; another day → same days after loading', () => {
  assert.deepEqual(toStanding('2026-10-23T08:00', '2026-10-21'), { day: 'Wed', offsetDays: 2, time: '08:00' });
  assert.equal(toStanding('2026-10-23T08:00', 'someday'), null);
  const mem = { byLoadDay: { Wed: { offsetDays: 2, time: '08:00' } }, last: { offsetDays: 2, time: '08:00', day: 'Wed' } };
  assert.deepEqual(fromStanding(mem, '2026-10-28'), { local: '2026-10-30T08:00', rule: 'same as the last Wednesday load: Friday 8:00 AM' });
  assert.equal(fromStanding(mem, '2026-10-26').local, '2026-10-28T08:00');         // a Monday load: 2 days after
  assert.match(fromStanding(mem, '2026-10-26').rule, /^2 days after loading/);
  // a Monday load has its own saved time → Monday loads use it
  const both = { byLoadDay: { ...mem.byLoadDay, Mon: { offsetDays: 3, time: '06:00' } }, last: mem.last };
  assert.equal(fromStanding(both, '2026-11-02').local, '2026-11-05T06:00');
  assert.equal(custKey('ZOOM BLOOM - RFW', 'Glenside', 'pa'), 'ZOOM BLOOM RFW|GLENSIDE|PA');
});

test('set once → the next outbound for that customer + location gets it automatically; clear sticks; forget stops it', async () => {
  const v = setup(Date.parse('2026-10-21T20:00:00Z'));
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', customer: "SPEDALE'S FLORIST INC.*", place: 'BROUSSARD, LA', local: '2026-10-23T08:00', loadDate: '2026-10-21' }, { trip: '625552' });
  const next = (trip, date) => ({ trip: { tripNumber: trip, status: 'LOADINGMAN' }, freightBills: [], _manifest: { dateLoaded: date, stops: [{ action: 'DELIVER', customer: "SPEDALE'S FLORIST INC.*", city: 'BROUSSARD', state: 'LA' }, { action: 'DELIVER', customer: 'OTHER', city: 'HOUSTON', state: 'TX' }] } });
  const wed = next('625700', '2026-10-28');
  await v.c.overlay('florida-beauty', [wed]);
  assert.equal(wed._commit['BROUSSARD|LA'].local, '2026-10-30T08:00');
  assert.equal(wed._commit['BROUSSARD|LA'].auto, true);
  assert.match(wed._commit['BROUSSARD|LA'].rule, /last Wednesday load/);
  assert.equal(wed._commit['HOUSTON|TX'], undefined, 'other customers: nothing saved');
  // dispatch clears it on this load → it stays cleared
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', customer: "SPEDALE'S FLORIST INC.*", local: null }, { trip: '625700' });
  const again = next('625700', '2026-10-28'); await v.c.overlay('florida-beauty', [again]);
  assert.equal(again._commit['BROUSSARD|LA'].cleared, true);
  // forget for future loads → a new load gets nothing
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'BROUSSARD', state: 'LA', customer: "SPEDALE'S FLORIST INC.*", local: null, forget: true }, { trip: '625700' });
  const later = next('625800', '2026-11-04'); await v.c.overlay('florida-beauty', [later]);
  assert.equal(later._commit, undefined);
});

test('an appointment written on the trip sheet becomes the stop\'s committed time — same late alert; kept current; never over dispatch', async () => {
  const v = setup(Date.parse('2026-10-22T12:00:00Z'));
  const sheet = (time, src = 'handwritten') => ({ trip: { tripNumber: '625207', status: 'DEPSHIP', powerUnit: '2011' }, freightBills: [],
    _manifest: { dateLoaded: '2026-10-21', stops: [{ action: 'DELIVER', customer: 'HARRIS TEETER LLC', city: 'INDIAN TRAIL', state: 'NC', apptDate: '2026-10-22', apptTime: time, apptSource: src }] } });
  const it = sheet('19:00'); await v.c.overlay('florida-beauty', [it]);
  const c = it._commit['INDIAN TRAIL|NC'];
  assert.equal(c.local, '2026-10-22T19:00'); assert.equal(c.fromSheet, true); assert.match(c.rule, /handwritten/);
  // the sheet is read again with a new time → updated
  const it2 = sheet('20:30', 'printed'); await v.c.overlay('florida-beauty', [it2]);
  assert.equal(it2._commit['INDIAN TRAIL|NC'].local, '2026-10-22T20:30'); assert.match(it2._commit['INDIAN TRAIL|NC'].by, /printed/);
  // late against it → the same email + text
  await v.db.set('taWatch:florida-beauty', { etas: { 625207: { stops: [{ label: 'INDIAN TRAIL, NC, 28079', etaMs: Date.parse('2026-10-23T02:30:00Z') }] } } });
  await v.c.process('florida-beauty', { trips: [it2] });                       // the truck left now
  v.setNow(Date.parse('2026-10-22T20:00:00Z'));                                // within 6 h of the appointment
  assert.equal((await v.c.process('florida-beauty', { trips: [it2] })).sent, 1);
  assert.match(v.mails[0].text, /Appointment source: Trip sheet \(printed\)\./);
  // a dispatcher's own time wins, and a re-read sheet doesn't overwrite it
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'INDIAN TRAIL', state: 'NC', customer: 'HARRIS TEETER LLC', local: '2026-10-22T22:00' }, { trip: '625207' });
  const it3 = sheet('19:00'); await v.c.overlay('florida-beauty', [it3]);
  assert.equal(it3._commit['INDIAN TRAIL|NC'].local, '2026-10-22T22:00');
  assert.equal(it3._commit['INDIAN TRAIL|NC'].by, 'Rosa');
});

import { tmAppointments } from '../commitments.js';
test('a broker load takes its committed time from TruckMate\'s delivery appointment (kept current, never over dispatch)', async () => {
  const now = Date.parse('2026-10-23T16:00:00Z');
  const bill = (x) => ({ billNumber: 'B180626', billToName: 'ARRIVE LOGISTICS LLC', endZoneDescription: 'MIAMI, FL, 33172', deliverBy: '2026-10-27T07:00:00', deliverByEnd: '2026-10-27T07:00:00', ...x });
  const item = (b) => ({ trip: { tripNumber: '625658', status: 'INTRAN' }, freightBills: [b] });
  assert.deepEqual(tmAppointments(item(bill()), now), [{ city: 'MIAMI', state: 'FL', customer: 'ARRIVE LOGISTICS LLC', local: '2026-10-27T07:00' }]);
  assert.deepEqual(tmAppointments(item(bill({ deliverByEnd: '2026-10-29T23:59:00' })), now), [], 'a window is not an appointment');
  assert.deepEqual(tmAppointments(item(bill({ billNumber: 'M5048614' })), now), [], 'flower / LTL bills: not here');
  const h = setup(now);
  const its = [item(bill())];
  await h.c.overlay('florida-beauty', its);
  assert.equal(its[0]._commit['MIAMI|FL'].local, '2026-10-27T07:00');
  assert.equal(its[0]._commit['MIAMI|FL'].by, 'TruckMate (delivery appointment)');
  // TruckMate moves it → follows
  const moved = [item(bill({ deliverBy: '2026-10-27T09:00:00', deliverByEnd: '2026-10-27T09:00:00' }))];
  await h.c.overlay('florida-beauty', moved);
  assert.equal(moved[0]._commit['MIAMI|FL'].local, '2026-10-27T09:00');
  // a dispatcher's time wins after that
  await h.hit('PUT /truckmate/commitments/:trip', { city: 'MIAMI', state: 'FL', local: '2026-10-27T06:00', customer: 'ARRIVE LOGISTICS LLC' }, { trip: '625658' });
  const again = [item(bill())];
  await h.c.overlay('florida-beauty', again);
  assert.equal(again[0]._commit['MIAMI|FL'].local, '2026-10-27T06:00');
});

import { rcLocal } from '../commitments.js';
test('the rate con\'s delivery appointment becomes the committed time (over TruckMate, never over dispatch)', async () => {
  const now = Date.parse('2026-10-23T16:00:00Z');
  assert.equal(rcLocal({ date: '10/27/2026', time: '0700' }, now), '2026-10-27T07:00');
  assert.equal(rcLocal({ date: 'Oct 27', appointment: '7:00 AM - 3:00 PM' }, now), '2026-10-27T07:00');
  assert.equal(rcLocal({ date: '10/27', time: 'FCFS' }, now), null, 'no clock time → not an appointment');
  const bill = { billNumber: 'B180626', billToName: 'ARRIVE LOGISTICS LLC', endZoneDescription: 'MIAMI, FL, 33172', deliverBy: '2026-10-27T07:00:00', deliverByEnd: '2026-10-27T07:00:00' };
  const item = (rc) => ({ trip: { tripNumber: '625658', status: 'INTRAN' }, freightBills: [bill], _ratecon: rc });
  const h = setup(now);
  const a = [item(null)]; await h.c.overlay('florida-beauty', a);
  assert.equal(a[0]._commit['MIAMI|FL'].fromTM, true);
  const b = [item({ deliveries: [{ name: 'Sedano\'s DC', city: 'Miami', state: 'FL', date: '10/27/2026', time: '0530', refs: 'PO 88812' }] })];
  await h.c.overlay('florida-beauty', b);
  assert.equal(b[0]._commit['MIAMI|FL'].local, '2026-10-27T05:30');
  assert.equal(b[0]._commit['MIAMI|FL'].by, 'Rate con (delivery appointment)');
  assert.match(b[0]._commit['MIAMI|FL'].rule, /PO 88812/);
  const c = [item(null)]; await h.c.overlay('florida-beauty', c);
  assert.equal(c[0]._commit['MIAMI|FL'].local, '2026-10-27T05:30', 'TruckMate never replaces the rate con');
  await h.hit('PUT /truckmate/commitments/:trip', { city: 'MIAMI', state: 'FL', local: '2026-10-27T06:00' }, { trip: '625658' });
  const d = [item({ deliveries: [{ city: 'Miami', state: 'FL', date: '10/27/2026', time: '0530' }] })]; await h.c.overlay('florida-beauty', d);
  assert.equal(d[0]._commit['MIAMI|FL'].local, '2026-10-27T06:00', 'dispatch wins');
});

import { rcFcfs } from '../commitments.js';
test('FCFS on the rate con: no appointment, said so; with receiving hours, late means after they close', async () => {
  const now = Date.parse('2026-10-23T16:00:00Z');
  assert.deepEqual(rcFcfs({ date: '10/27/2026', time: 'FCFS' }, now), { day: '2026-10-27', hours: null, closeLocal: null });
  assert.equal(rcFcfs({ date: '10/27/2026', appointment: 'FCFS 0700-1500' }, now).closeLocal, '2026-10-27T15:00');
  assert.equal(rcFcfs({ date: '10/27/2026', time: '0700' }, now), null);
  const item = (time) => ({ trip: { tripNumber: '625658', status: 'INTRAN' }, freightBills: [{ billNumber: 'B180626', endZoneDescription: 'MIAMI, FL, 33172' }], _ratecon: { deliveries: [{ city: 'Miami', state: 'FL', date: '10/27/2026', time }] } });
  const h = setup(now);
  const a = [item('FCFS')]; await h.c.overlay('florida-beauty', a);
  assert.equal(a[0]._commit['MIAMI|FL'].fcfs, true); assert.equal(a[0]._commit['MIAMI|FL'].atMs, null);
  const b = [item('FCFS 0700-1500')]; await h.c.overlay('florida-beauty', b);
  assert.equal(b[0]._commit['MIAMI|FL'].local, '2026-10-27T15:00');
  assert.match(b[0]._commit['MIAMI|FL'].rule, /before they close/);
});

test('625479: a TruckMate appointment that already passed is never committed after the fact; a truck AT the receiver is not "late"', async () => {
  const now = Date.parse('2026-10-23T15:00:00Z');
  const bill = { billNumber: 'B180593', billToName: 'TRAFFIC TECH INC', endZoneDescription: 'MIAMI, FL, 33172', deliverBy: '2026-10-22T15:00:00', deliverByEnd: '2026-10-22T15:00:00' };
  const it = { trip: { tripNumber: '625479', status: 'ARRCONS', powerUnit: '2608' }, freightBills: [bill] };
  assert.deepEqual(tmAppointments(it, now), [], 'Oct 22 3 PM already passed');
  // even with a commitment on file, ARRIVE CONSIGNEE at that stop → no late email
  const v = setup(now);
  await v.hit('PUT /truckmate/commitments/:trip', { city: 'MIAMI', state: 'FL', local: '2026-10-22T15:00' }, { trip: '625479' });
  await v.db.set('taCommitLeft:florida-beauty', { 625479: Date.parse('2026-10-21T14:53:00Z') });
  await v.db.set('taWatch:florida-beauty', { etas: { 625479: { stops: [{ label: 'MIAMI, FL, 33172', etaMs: now + 5 * 60000, miles: 4 }] } } });
  assert.equal((await v.c.process('florida-beauty', { trips: [it] })).sent, 0);
  const rolling = { ...it, trip: { ...it.trip, status: 'DEPSHIP' } };
  assert.equal((await v.c.process('florida-beauty', { trips: [rolling] })).sent, 1, 'still alerts while it is on the way');
});

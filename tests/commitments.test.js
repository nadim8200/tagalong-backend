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
  assert.match(m.text, /has not contacted them/);
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
  assert.deepEqual((await v.hit('GET /truckmate/commitments/:trip', {}, { trip: '625552' })).out, {});
});

test('texts go to phone numbers or employees\' phones', () => {
  const r = resolvePhones(['305-555-0100', 'Frank Ducassi', 'Nobody Here'], { people: [{ name: 'Frank Ducassi', phone: '(305) 748-5611' }] });
  assert.deepEqual(r.phones, ['+13055550100', '+13057485611']);
  assert.deepEqual(r.unresolved, ['Nobody Here']);
});

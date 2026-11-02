import test from 'node:test';
import assert from 'node:assert/strict';
import { clockStart, atStop, leftAt, stepOf, gpsSays, initWaitingTime } from '../waitingtime.js';
import { renderWaitingEmail } from '../handoffmail.js';

const H = 3600000; const T0 = Date.parse('2026-11-02T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };

test('the clock: 3 hours after the appointment, or after arrival if late, and early hours never count', () => {
  assert.equal(clockStart(T0 - 2 * H, T0), T0 + 3 * H, 'early by 2 hours: waits for the appointment');
  assert.equal(clockStart(T0 + H, T0), T0 + 4 * H, 'late: from arrival');
  assert.equal(clockStart(T0, null), T0 + 3 * H, 'no appointment: from arrival');
});

test('TruckMate says where the truck is, and when it left', () => {
  const item = { _times: { statusHistory: [{ status: 'DEPSHIP', at: iso(T0 - H) }, { status: 'ARRCONS', at: iso(T0) }] } };
  assert.deepEqual(atStop(item), { kind: 'receiver', arrivedMs: T0 });
  assert.equal(atStop({ _times: { statusHistory: [{ status: 'DEPCONS', at: iso(T0) }] } }), null);
  assert.equal(atStop({}), null);
  assert.equal(leftAt({ _times: { statusHistory: [{ status: 'ARRCONS', at: iso(T0) }, { status: 'DEPCONS', at: iso(T0 + H) }] } }, T0), T0 + H);
});

test('what happens next', () => {
  const r = { startMs: T0 + 3 * H, status: 'open' };
  assert.equal(stepOf(r, { here: true, now: T0 }), null, 'still free time');
  assert.equal(stepOf(r, { here: true, now: T0 + 3 * H }), 'ask');
  assert.equal(stepOf({ ...r, askedAt: 1 }, { here: true, now: T0 + 4 * H }), null, 'asked once');
  assert.equal(stepOf(r, { here: false, now: T0 + H }), 'close', 'left inside the free time: no email');
  assert.equal(stepOf({ ...r, askedAt: 1 }, { here: false, now: T0 + 4 * H }), 'total', 'unanswered still gets a total');
  assert.equal(stepOf({ ...r, askedAt: 1, status: 'approved' }, { here: false, now: T0 + 4 * H }), 'total');
  assert.equal(stepOf({ ...r, askedAt: 1, status: 'declined' }, { here: false, now: T0 + 4 * H }), 'close', 'turned down: no total');
  assert.equal(stepOf({ ...r, closedAt: 1 }, { here: false, now: T0 }), null);
});

const load = (history, mph = 0, at = null) => ({ trip: { tripNumber: '626218', powerUnit: '2205', trailer: '7262' }, freightBills: [{ billNumber: 'B180607' }], _times: { statusHistory: history }, _samsara: { speedMph: mph, gpsAt: at } });
const run = () => {
  const db = mem(); let clock = T0; const sent = [];
  const w = initWaitingTime(null, { db, secret: 's', etas: async () => ({ 626218: { stops: [{ label: 'CARSON, CA', apptMs: T0 + H }] } }), recipients: async () => ['a@floridabeauty.us'], send: async (kind, r) => sent.push([kind, r]), now: () => clock });
  return { w, db, sent, at: (ms) => { clock = ms; }, now: () => clock };
};

test('a whole visit: early arrival, one email at the clock, total when it leaves', async () => {
  const s = run();
  await s.w.process({ trips: [] });   // first run done, watching from here
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  const here = () => load(hist, 0, iso(s.now()));
  await s.w.process({ trips: [here()] });
  assert.equal(s.sent.length, 0);
  s.at(T0 + 3.9 * H); await s.w.process({ trips: [here()] });
  assert.equal(s.sent.length, 0, 'appointment + 3h is not here yet');
  s.at(T0 + 4 * H); await s.w.process({ trips: [here()] }); await s.w.process({ trips: [here()] });
  assert.equal(s.sent.length, 1, 'once'); assert.equal(s.sent[0][0], 'start');
  const key = Object.keys(s.db.s['taWaiting:florida-beauty'])[0];
  assert.equal((await s.w.decide({ k: key }, { status: 'approved', name: '' })).code, 400);
  assert.equal((await s.w.decide({ k: key }, { status: 'approved', name: 'Sara' })).ok, true);
  const gone = load([{ status: 'ARRCONS', at: iso(T0) }, { status: 'DEPCONS', at: iso(T0 + 6 * H) }]);
  s.at(T0 + 6.1 * H); await s.w.process({ trips: [gone] }); await s.w.process({ trips: [gone] });
  assert.equal(s.sent.length, 3); assert.equal(s.sent[1][0], 'decided'); assert.equal(s.sent[2][0], 'total');
  assert.equal(s.sent[2][1].waitedMs, 2 * H, 'from the clock to leaving'); assert.equal(s.sent[2][1].decidedBy, 'Sara');
  assert.equal((await s.w.decide({ k: key }, { status: 'declined', name: 'Ana' })).code, 409, 'too late to answer');
});

test('trucks already sitting there on day one and stale statuses send nothing', async () => {
  const s = run();
  await s.w.process({ trips: [load([{ status: 'ARRCONS', at: iso(T0 - 5 * H) }])] });
  assert.equal(s.sent.length, 0);
  await s.w.process({ trips: [load([{ status: 'ARRCONS', at: iso(T0 - 5 * H) }])] });
  assert.equal(s.sent.length, 0, 'adopted, not asked');
  const old = run(); await old.w.process({ trips: [] });
  await old.w.process({ trips: [load([{ status: 'ARRCONS', at: iso(T0 - 30 * H) }])] });
  assert.equal(old.sent.length, 0);
});

test('an example answer saves nothing', async () => {
  const s = run();
  assert.equal((await s.w.decide({ x: true, k: 'example' }, { status: 'approved', name: 'Sara' })).example, true);
  assert.equal(s.db.s['taWaiting:florida-beauty'], undefined);
});

test('the emails carry the buttons, the total, the signature and the load', () => {
  const r = { trip: '1', unit: '2205', trailer: '7262', kind: 'receiver', stop: 'Carson, CA', arrivedMs: T0, apptMs: T0 + H, startMs: T0 + 4 * H, status: 'open' };
  const a = renderWaitingEmail('start', r, { rows: [['Load type', 'BROKER']], reviewUrl: 'https://x/wt/t', now: T0 });
  assert.match(a.html, /WAITING TIME IS SET TO BEGIN/); assert.match(a.html, /wt\/t\?d=approved/); assert.match(a.html, /wt\/t\?d=declined/); assert.match(a.text, /Load type: BROKER/);
  const b = renderWaitingEmail('total', { ...r, leftMs: T0 + 6 * H, waitedMs: 2 * H, status: 'approved', decidedBy: 'Sara', decidedAt: T0 }, { rows: [], now: T0 });
  assert.match(b.subject, /Waiting time total 2h 0m/); assert.match(b.text, /Approved by: Sara/); assert.doesNotMatch(b.html, /d=approved/);
  assert.match(renderWaitingEmail('total', { ...r, leftMs: T0, waitedMs: H }, { rows: [], now: T0 }).html, /Nobody answered/);
  assert.match(renderWaitingEmail('start', { ...r, apptMs: null }, { rows: [], now: T0 }).text, /None on file, counted from arrival/);
});

test('LTL stops from the hubs never get a clock, only broker loads', async () => {
  const s = run();
  await s.w.process({ trips: [] });
  const ltl = { ...load([{ status: 'ARRCONS', at: iso(T0) }]), freightBills: [{ billNumber: 'M5053226' }] };
  s.at(T0 + 8 * H); await s.w.process({ trips: [ltl] });
  assert.equal(s.sent.length, 0); assert.deepEqual(Object.keys(s.db.s['taWaiting:florida-beauty'] || {}), []);
});

test('the GPS has the last word', () => {
  const fresh = iso(T0); const item = (mph, at = fresh) => ({ _samsara: { speedMph: mph, gpsAt: at } });
  assert.equal(gpsSays(item(0), { miles: 2 }, T0), 'parked');
  assert.equal(gpsSays(item(73), { miles: 2 }, T0), 'moved');
  assert.equal(gpsSays(item(0), { miles: 92 }, T0), 'moved', 'parked somewhere else is not this stop');
  assert.equal(gpsSays(item(0, iso(T0 - H)), null, T0), 'unknown', 'old GPS proves nothing');
  assert.equal(gpsSays({}, null, T0), 'unknown');
  assert.equal(gpsSays(item(6), null, T0), 'unknown', 'creeping around the yard');
});

test('truck 713: marked at the receiver but rolling on the turnpike gets no email at all', async () => {
  const s = run();
  await s.w.process({ trips: [] });
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  await s.w.process({ trips: [load(hist, 0, iso(T0))] });
  s.at(T0 + 10 * H); await s.w.process({ trips: [load(hist, 73, iso(s.now()))] });
  assert.equal(s.sent.length, 0, 'moving: no question');
  s.at(T0 + 10.1 * H); await s.w.process({ trips: [load(hist, 73, iso(s.now()))] }); await s.w.process({ trips: [load(hist, 73, iso(s.now()))] });
  assert.equal(s.sent.length, 0, 'it left inside no clock: closed quietly');
});

test('an old GPS waits instead of asking', async () => {
  const s = run();
  await s.w.process({ trips: [] });
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  await s.w.process({ trips: [load(hist, 0, iso(T0))] });
  s.at(T0 + 5 * H); await s.w.process({ trips: [load(hist, 0, iso(T0))] });
  assert.equal(s.sent.length, 0);
  await s.w.process({ trips: [load(hist, 0, iso(s.now()))] });
  assert.equal(s.sent.length, 1, 'parked and fresh: asks');
});

test('a truck that rolls off with no departure marked gets its total from when it started moving', async () => {
  const s = run();
  await s.w.process({ trips: [] });
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  await s.w.process({ trips: [load(hist, 0, iso(T0))] });
  s.at(T0 + 4 * H); await s.w.process({ trips: [load(hist, 0, iso(s.now()))] });
  assert.equal(s.sent[0][0], 'start');
  s.at(T0 + 6 * H); await s.w.process({ trips: [load(hist, 60, iso(s.now()))] });
  assert.equal(s.sent.length, 1, 'one reading could be another door');
  s.at(T0 + 6.1 * H); await s.w.process({ trips: [load(hist, 60, iso(s.now()))] });
  assert.equal(s.sent[1][0], 'total'); assert.equal(s.sent[1][1].waitedMs, 2 * H);
});

test('an appointment that shows up later moves the clock', async () => {
  const db = mem(); let clock = T0; const sent = []; let legs = {};
  const w = initWaitingTime(null, { db, secret: 's', etas: async () => legs, recipients: async () => ['a@floridabeauty.us'], send: async (k, r) => sent.push(r), now: () => clock });
  await w.process({ trips: [] });
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  await w.process({ trips: [load(hist, 0, iso(T0))] });
  legs = { 626218: { stops: [{ label: 'CARSON, CA', apptMs: T0 + 2 * H, miles: 1 }] } };
  clock = T0 + 3.5 * H; await w.process({ trips: [load(hist, 0, iso(clock))] });
  assert.equal(sent.length, 0, 'the clock moved to appointment + 3h');
  clock = T0 + 5 * H; await w.process({ trips: [load(hist, 0, iso(clock))] });
  assert.equal(sent[0].apptMs, T0 + 2 * H); assert.equal(sent[0].stop, 'CARSON, CA');
});

test('approved or not, the same people get a confirmation with who and why, once', async () => {
  const s = run();
  await s.w.process({ trips: [] });
  const hist = [{ status: 'ARRCONS', at: iso(T0) }];
  await s.w.process({ trips: [load(hist, 0, iso(T0))] });
  s.at(T0 + 4 * H); await s.w.process({ trips: [load(hist, 0, iso(s.now()))] });
  const key = Object.keys(s.db.s['taWaiting:florida-beauty'])[0];
  const r = await s.w.decide({ k: key }, { status: 'declined', name: 'Nadim', note: 'Truck is rolling' });
  assert.equal(r.emailed, true); assert.equal(s.sent[1][0], 'decided');
  assert.equal(s.sent[1][1].status, 'declined'); assert.equal(s.sent[1][1].decidedBy, 'Nadim'); assert.equal(s.sent[1][1].note, 'Truck is rolling');
  assert.equal((await s.w.decide({ k: key }, { status: 'declined', name: 'Ana' })).already, true);
  assert.equal(s.sent.length, 2, 'not twice');
  assert.equal((await s.w.decide({ k: key }, { status: 'approved', name: 'Sara' })).emailed, true, 'a change of mind tells everyone');
  assert.equal(s.sent.length, 3);
});

test('the confirmation says yes or no, by whom and why', () => {
  const r = { trip: '1', unit: '2205', kind: 'receiver', arrivedMs: T0, startMs: T0 + 3 * H, decidedBy: 'Sara', decidedAt: T0, note: 'Receiver is holding the truck' };
  const yes = renderWaitingEmail('decided', { ...r, status: 'approved' }, { rows: [], now: T0 });
  assert.match(yes.html, /WAITING TIME APPROVED/); assert.match(yes.text, /Approved by: Sara/); assert.match(yes.text, /Reason: Receiver is holding/); assert.match(yes.subject, /^Re: Waiting time set to begin/); assert.doesNotMatch(yes.html, /d=approved/);
  const no = renderWaitingEmail('decided', { ...r, status: 'declined' }, { rows: [], now: T0 });
  assert.match(no.html, /WAITING TIME NOT APPROVED/); assert.match(no.text, /Not approved by: Sara/);
});

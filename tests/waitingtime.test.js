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

const { kindFromAnswer, parkedAtPickup } = await import('../waitingtime.js');

test('where the truck is, from what someone answered', () => {
  for (const t of ['Still at the shipper Getting loaded', 'being loaded', 'at pickup', 'cargando']) assert.equal(kindFromAnswer(t), 'shipper', t);
  for (const t of ['at the receiver', 'Unloading now', 'descargando']) assert.equal(kindFromAnswer(t), 'receiver', t);
  for (const t of ['hotel approved', 'load is delayed', 'drivers resting', '']) assert.equal(kindFromAnswer(t), null, t);
});

test('a depart marked right after the arrival isn\'t the truck leaving', () => {
  const quick = { _times: { statusHistory: [{ status: 'ARRSHIP', at: iso(T0) }, { status: 'DEPSHIP', at: iso(T0 + 60000) }] } };
  assert.deepEqual(atStop(quick), { kind: 'shipper', arrivedMs: T0, quick: true });
  assert.equal(atStop({ _times: { statusHistory: [{ status: 'ARRSHIP', at: iso(T0) }, { status: 'DEPSHIP', at: iso(T0 + H) }] } }), null, 'an hour later is a real departure');
});

test('parked at the rate con\'s pickup by city or ZIP', () => {
  const it = (location, status = 'DEPSHIP') => ({ trip: { status }, _samsara: { location }, _ratecon: { data: { pickups: [{ city: 'Rochelle', state: 'IL', zip: '61068' }] } } });
  assert.equal(parkedAtPickup(it('1010 Americold Drive, Rochelle, IL, 61068'), 'parked'), 0);
  assert.equal(parkedAtPickup(it('1010 Americold Drive, Rochelle, IL'), 'parked'), 0);
  assert.equal(parkedAtPickup(it('1010 Americold Drive, Rochelle, IL'), 'moved'), null);
  assert.equal(parkedAtPickup(it('I-39, Mendota, IL'), 'parked'), null);
  assert.equal(parkedAtPickup(it('Rochelle, IL', 'ARRCONS'), 'parked'), null, 'past the pickup');
  assert.equal(parkedAtPickup({ _samsara: { location: 'Rochelle, IL' } }, 'parked'), null, 'no rate con');
});

const truck2606 = (over = {}) => ({ trip: { tripNumber: '626289', powerUnit: '2606', trailer: '7317', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B180767' }], _times: { statusHistory: [{ status: 'ARRSHIP', at: iso(T0 - 2 * H) }, { status: 'DEPSHIP', at: iso(T0 - H) }] }, _samsara: { speedMph: 0, gpsAt: iso(T0), location: 'Rochelle, IL, 61068' }, ...over });
const gio = (reason = 'Still at the shipper Getting loaded', status = 'authorized') => ({ units: { 2606: { stopEpisode: { unit: '2606', trip: '626289', stoppedSinceMs: T0 - H, review: { status, reason, by: 'Gio' } } } } });
const started = () => { const db = mem(); db.s['taWaiting:florida-beauty:began'] = 1; let clock = T0; const sent = []; const w = initWaitingTime(null, { db, secret: 's', etas: async () => ({ 626289: { stops: [{ label: 'MIAMI, FL', miles: 1440, apptMs: T0 + 40 * H }] } }), recipients: async () => ['a@floridabeauty.us'], send: async (kind, r) => sent.push([kind, r]), now: () => clock }); return { db, w, sent, at: (ms) => { clock = ms; } }; };

test('Gio says it is at the shipper: the clock runs from when it stopped, and the delivery 1,440 miles away has no say', async () => {
  const h = started();
  h.db.s['taWatch:florida-beauty'] = gio();
  await h.w.process({ trips: [truck2606()] });
  const r = Object.values(h.db.s['taWaiting:florida-beauty'])[0];
  assert.equal(r.kind, 'shipper'); assert.equal(r.startMs, T0 + 2 * H, '3 hours from the stop, not from the delivery appointment'); assert.match(r.source, /Gio/);
  assert.deepEqual([...await h.w.openTrips()], ['626289'], 'no stop emails while it is counted');
  const parked = truck2606(); parked._samsara = { ...parked._samsara, gpsAt: iso(T0 + 2 * H) };
  h.at(T0 + 2 * H); await h.w.process({ trips: [parked] });
  assert.equal(h.sent[0][0], 'start');
  const moving = truck2606(); moving._samsara = { ...moving._samsara, speedMph: 60, gpsAt: iso(T0 + 3 * H) };
  h.at(T0 + 3 * H); await h.w.process({ trips: [moving] });
  const moved2 = truck2606(); moved2._samsara = { ...moved2._samsara, speedMph: 60, gpsAt: iso(T0 + 3 * H + 240000) };
  h.at(T0 + 3 * H + 240000); await h.w.process({ trips: [moved2] });
  assert.equal(h.sent[1][0], 'total'); assert.equal(h.sent[1][1].waitedMs, H, 'until the truck really rolled, not the 1-minute depart');
  assert.equal((await h.w.openTrips()).size, 0);
});

test('other answers, or an unauthorized stop, start nothing', async () => {
  for (const ep of [gio('hotel approved'), gio('at the shipper', 'unauthorized')]) {
    const h = started(); h.db.s['taWatch:florida-beauty'] = ep; // eslint-disable-line no-await-in-loop
    await h.w.process({ trips: [truck2606()] }); // eslint-disable-line no-await-in-loop
    assert.deepEqual(h.db.s['taWaiting:florida-beauty'] || {}, {});
  }
  const lt = started(); lt.db.s['taWatch:florida-beauty'] = gio();
  await lt.w.process({ trips: [truck2606({ freightBills: Array(30).fill({ billNumber: 'T1' }) })] });
  assert.deepEqual(lt.db.s['taWaiting:florida-beauty'] || {}, {}, 'broker loads only');
});

test('the GPS parks it at the pickup: one clock for the trip, whatever else says so', async () => {
  const h = started();
  h.db.s['taWatch:florida-beauty'] = gio();
  const it = truck2606({ _ratecon: { data: { pickups: [{ city: 'Rochelle', state: 'IL', date: '2026-11-02', time: '09:00' }] } } });
  await h.w.process({ trips: [it] });
  await h.w.process({ trips: [it] });
  assert.equal(Object.keys(h.db.s['taWaiting:florida-beauty']).length, 1);
  const g = started();
  await g.w.process({ trips: [it] });
  const r = Object.values(g.db.s['taWaiting:florida-beauty'])[0];
  assert.equal(r.source, 'GPS at the pickup'); assert.equal(r.kind, 'shipper');
});

test('a one-minute depart on a parked truck keeps the clock; rolling ends it', async () => {
  const hist = [{ status: 'ARRSHIP', at: iso(T0) }, { status: 'DEPSHIP', at: iso(T0 + 60000) }];
  const h = started();
  await h.w.process({ trips: [truck2606({ _times: { statusHistory: hist } })] });
  assert.equal(Object.values(h.db.s['taWaiting:florida-beauty'])[0].quick, true);
  const it = (mph, ms) => { const x = truck2606({ _times: { statusHistory: hist } }); x._samsara = { ...x._samsara, speedMph: mph, gpsAt: iso(ms) }; return x; };
  h.at(T0 + 3 * H); await h.w.process({ trips: [it(0, T0 + 3 * H)] });
  assert.equal(h.sent[0][0], 'start');
  const q = started();
  await q.w.process({ trips: [truck2606({ _times: { statusHistory: hist } })] });
  q.at(T0 + 10 * 60000); await q.w.process({ trips: [it(60, T0 + 10 * 60000)] });
  q.at(T0 + 15 * 60000); await q.w.process({ trips: [it(60, T0 + 15 * 60000)] });
  assert.equal(q.sent.length, 0); assert.equal((await q.w.openTrips()).size, 0, 'never asked: it really left');
});

test('trip 626361: a one-minute arrive/depart while rolling opens no clock; parked at our yard closes it quietly', async () => {
  const hist = [{ status: 'ARRSHIP', at: iso(T0) }, { status: 'DEPSHIP', at: iso(T0 + 60000) }];
  const rolling = started();
  await rolling.w.process({ trips: [truck2606({ _times: { statusHistory: hist }, _samsara: { speedMph: 62, gpsAt: iso(T0) } })] });
  assert.equal(Object.keys(rolling.db.s['taWaiting:florida-beauty'] || {}).length, 0, 'rolling click-through: no clock');
  const yard = { speedMph: 0, gpsAt: iso(T0), lat: 25.8026, lng: -80.3102 };
  const home = started();
  await home.w.process({ trips: [truck2606({ _times: { statusHistory: hist }, _samsara: yard })] });
  assert.equal(Object.keys(home.db.s['taWaiting:florida-beauty'] || {}).length, 0, 'at our yard: no clock');
  const later = started();
  await later.w.process({ trips: [truck2606({ _times: { statusHistory: hist } })] });
  const key = Object.keys(later.db.s['taWaiting:florida-beauty'])[0];
  later.at(T0 + 3 * H); await later.w.process({ trips: [truck2606({ _times: { statusHistory: hist }, _samsara: { ...yard, gpsAt: iso(T0 + 3 * H) } })] });
  const r = later.db.s['taWaiting:florida-beauty'][key];
  assert.equal(r.closedWhy, 'truck at our yard');
  assert.equal(later.sent.length, 0, 'no email');
});

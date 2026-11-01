import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCommits, openStops, askEmail, requestStops, confirmPage, confirmedReply, monitorStatus, initBrokerFollow } from '../brokerfollow.js';
import { evaluateBoard } from '../watchtower.js';
import { commitMs } from '../commitments.js';

const mem = () => { const s = {}; return { enabled: true, get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, fn, d) => { s[k] = fn(k in s ? s[k] : d); return s[k]; }, s }; };
const NOW = Date.parse('2026-11-02T15:00:00Z');
const broker = { trip: { tripNumber: '626300', powerUnit: '2202', status: 'DEPSHIP' }, _ratecon: { loadNumber: 'L-1' }, freightBills: [{ billNumber: 'B180615', billToName: 'BEST BUY', endZoneDescription: 'BELLINGHAM, MA, 02019' }] };
const hub = { trip: { tripNumber: '626400', powerUnit: '733', status: 'DEPSHIP' }, _tb: { hub: 'Miami' }, freightBills: [{ billNumber: 'M5055031', endZoneDescription: 'BOSTON, MA, 02136' }] };
function rig({ trips = [broker, hub], commits = {}, etas = {} } = {}) {
  const db = mem(); const mails = []; const c = { ...commits };
  db.s['taWatch:fb'] = { etas };
  const commitments = { all: async () => c, commit: async (t, x) => { c[t] = { ...(c[t] || {}), [`${x.city}|${x.state}`]: { ...x, atMs: commitMs(x.local, x.state), place: `${x.city}, ${x.state}` } }; return { atMs: 1 }; } };
  const f = initBrokerFollow(null, { db, getBoard: async () => ({ trips }), commitments, sendMail: async (m, o = {}) => { mails.push({ ...m, direct: !!o.direct }); }, listEmails: async () => ['ronen@floridabeauty.us'], now: () => NOW });
  return { f, mails, db, c, set: (x) => Object.assign(c, x) };
}
const by = { by: 'Ana', byEmail: 'ana@floridabeauty.us', source: 'email' };

test('only a time a person confirmed counts: rate con, TruckMate and old loads do not', () => {
  const c = { A: { atMs: 1, by: 'Ana' }, B: { atMs: 1, fromRC: true, by: 'x' }, C: { atMs: 1, fromTM: true }, D: { atMs: 1, auto: true, by: 'x' }, E: { cleared: true, by: 'Ana' } };
  assert.deepEqual(Object.keys(confirmedCommits(c)), ['A']);
});

test('hub outbound never comes through here', async () => {
  const r = rig();
  const out = await r.f.start('fb', '626400', by);
  assert.equal(out.ok, false); assert.equal(out.notBroker, true);
  assert.equal(r.mails.length, 0);
});

test('no time yet: Jarvis emails the person who asked, past training mode, staff only', async () => {
  const r = rig();
  const out = await r.f.start('fb', '626300', by);
  assert.deepEqual([out.ok, out.confirmed, out.asked], [true, false, true]);
  assert.deepEqual(r.mails[0].to, ['ana@floridabeauty.us']); assert.equal(r.mails[0].direct, true);
  assert.match(r.mails[0].subject, /626300/); assert.match(r.mails[0].text, /BEST BUY, BELLINGHAM, MA/);
});

test('someone outside the company is never asked', async () => {
  const r = rig();
  const out = await r.f.start('fb', '626300', { by: 'Bob', byEmail: 'bob@broker.com' });
  assert.equal(out.asked, false); assert.equal(r.mails.length, 0);
});

test('a time given with the request is saved and no question goes out', async () => {
  const r = rig();
  const out = await r.f.start('fb', '626300', { ...by, deliverAt: '2026-11-03T08:00' });
  assert.equal(out.confirmed, true); assert.equal(r.mails.length, 0);
  assert.equal(r.c['626300']['BELLINGHAM|MA'].local, '2026-11-03T08:00');
});

test('no answer: asks once more after 2 hours, then stops', async () => {
  const r = rig(); await r.f.start('fb', '626300', by);
  const f0 = r.db.s['taBrokerFollow:fb']['626300'];
  await r.f.process('fb', { trips: [broker] }); assert.equal(r.mails.length, 1, 'too soon');
  f0.askedAt = new Date(NOW - 3 * 3600000).toISOString();
  await r.f.process('fb', { trips: [broker] }); assert.equal(r.mails.length, 2);
  r.db.s['taBrokerFollow:fb']['626300'].askedAt = new Date(NOW - 3 * 3600000).toISOString();
  await r.f.process('fb', { trips: [broker] }); assert.equal(r.mails.length, 2, 'two asks at most');
});

test('over an hour late against the confirmed time: one email to the list and the asker; on time stays quiet', async () => {
  const atMs = NOW + 3600000;
  const commit = { 'BELLINGHAM|MA': { atMs, by: 'Ana', local: '2026-11-02T11:00', customer: 'BEST BUY', place: 'BELLINGHAM, MA' } };
  const ok = rig({ commits: { 626300: commit }, etas: { 626300: { stops: [{ label: 'BELLINGHAM, MA', etaMs: atMs + 30 * 60000, miles: 40 }] } } });
  await ok.f.start('fb', '626300', by); ok.db.s['taBrokerFollow:fb']['626300'].since = '2026-11-01T12:00:00Z';
  await ok.f.process('fb', { trips: [broker] }); assert.equal(ok.mails.length, 0);
  const r = rig({ commits: { 626300: commit }, etas: { 626300: { stops: [{ label: 'BELLINGHAM, MA', etaMs: atMs + 3 * 3600000, miles: 40 }] } } });
  await r.f.start('fb', '626300', by); r.db.s['taBrokerFollow:fb']['626300'].since = '2026-11-01T12:00:00Z';
  await r.f.process('fb', { trips: [broker] });
  assert.deepEqual(r.mails.map((m) => m.to[0]).sort(), ['ana@floridabeauty.us', 'ronen@floridabeauty.us']);
  assert.match(r.mails[0].subject, /^Will miss the delivery time/);
  await r.f.process('fb', { trips: [broker] }); assert.equal(r.mails.length, 2, 'once per stop and time');
});

test('a load off the board stops being followed', async () => {
  const r = rig(); await r.f.start('fb', '626300', by);
  await r.f.process('fb', { trips: [] });
  assert.equal(r.db.s['taBrokerFollow:fb']['626300'], undefined);
});

test('the board: a broker load is quiet until followed and confirmed; a hub load keeps its alert', () => {
  const now = Date.parse('2026-10-06T18:00:00Z');
  const bill = { billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148', pieces: 1, deliverBy: '2026-10-07T04:00:00', deliverByEnd: '2026-10-07T04:00:00', deliveryApptReq: 'True' };
  const base = { trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '1' }, freightBills: [bill], _samsara: { gpsAt: '2026-10-06T17:59:00Z', lat: 26.7, lng: -80.1, speedMph: 60, hos: { status: 'driving', driveLeftMin: 600, shiftLeftMin: 600, at: '2026-10-06T17:59:00Z' } } };
  const ctx = { now, geo: () => ({ lat: 41.88, lng: -88.0 }), unitState: () => ({}), origin: { lat: 25.8, lng: -80.3 } };
  const late = (it) => evaluateBoard({ trips: [it] }, ctx).filter((a) => a.code === 'late-risk');
  assert.equal(late(base).length, 0, 'not followed');
  assert.equal(late({ ...base, _brokerFollow: { confirmed: false } }).length, 0, 'followed, no time yet');
  const commit = { 'LOMBARD|IL': { atMs: Date.parse('2026-10-07T09:00:00Z'), by: 'Ana', local: '2026-10-07T04:00', state: 'IL' } };
  assert.equal(late({ ...base, _brokerFollow: { confirmed: true } }).length, 0, 'the TruckMate time alone is not the confirmed one');
  assert.equal(late({ ...base, _brokerFollow: { confirmed: true }, _commit: commit }).length, 1);
  assert.equal(late({ ...base, freightBills: [{ ...bill, billNumber: 'M1' }] }).length, 1, 'hub loads unchanged');
});

test('helpers: open stops skip delivered bills; the question names the stop', () => {
  const it = { trip: { tripNumber: '9', powerUnit: '5' }, freightBills: [{ endZoneDescription: 'A, MA, 1', actualDelivery: 'x' }, { endZoneDescription: 'B, NY, 2', billToName: 'Z' }] };
  assert.deepEqual(openStops(it).map((s) => s.city), ['B']);
  assert.match(askEmail('9', it).text, /Z, B, NY/);
});

// ---- the redesigned request
const stop = (billNumber, endZoneDescription, billToName, extra = {}) => ({ billNumber, endZoneDescription, billToName, ...extra });
const twoStops = { trip: { tripNumber: '626045', powerUnit: '2617' }, freightBills: [stop('M1', 'SANTA ROSA, CA, 95407', 'SEQUOIA WHOLESALE FLORIST'), stop('M2', 'SANTA ROSA, CA, 95407', 'SEQUOIA WHOLESALE FLORIST'), stop('M3', 'WEST SACRAMENTO, CA, 95691', 'GOLDEN STATE FLORAL INC *')] };
const clean = (h) => h.replace(/<!--[\s\S]*?-->/g, '');

test('request: one card per stop, a reply line for each, wording matches the count, subject unchanged', () => {
  const m = askEmail('626045', twoStops);
  assert.equal(m.subject, 'Trip 626045: what time does truck 2617 need to be at delivery?');
  assert.equal((m.html.match(/&#128205;/g) || []).length, 2, 'two bills at one stop stay one card');
  assert.match(m.html, /Please confirm delivery appointments/); assert.match(m.html, /CONFIRMATION REQUESTED/); assert.match(m.html, /GOLDEN STATE FLORAL INC/); assert.doesNotMatch(m.html, /FLORAL INC \*/);
  assert.match(m.text, /SEQUOIA WHOLESALE FLORIST, SANTA ROSA, CA: \[Date\] · \[Time or window\] · \[Timezone\]/);
  assert.match(m.text, /GOLDEN STATE FLORAL INC, WEST SACRAMENTO, CA: \[Date\]/);
  assert.match(m.text, /Awaiting confirmation/); assert.match(m.text, /Please specify/);
  assert.match(m.text, /will not classify a delivery as late/); assert.doesNotMatch(m.html, /Design preview/i);
  const single = askEmail('9', { trip: { powerUnit: '5' }, freightBills: [stop('M1', 'OCALA, FL, 1', 'Z')] });
  assert.match(single.html, /Please confirm delivery appointment</); assert.match(single.text, /for the location below/);
  assert.match(askEmail('9', twoStops, { again: true }).text, /^Reminder: /m);
  assert.equal(askEmail('9', { trip: {}, freightBills: [] }).subject, 'Trip 9: what time does the truck need to be at delivery?');
});
test('request: a slash in a name stays one stop; similar names at two places stay two', () => {
  const slash = { trip: {}, freightBills: [stop('M1', 'OCALA, FL, 1', 'ACME / ZEN FLOWERS')] };
  assert.equal(requestStops(slash).length, 1); assert.equal(requestStops(slash)[0].name, 'ACME / ZEN FLOWERS');
  const similar = { trip: {}, freightBills: [stop('M1', 'TYLER, TX, 1', 'LONE STAR BLOOM *'), stop('M2', 'DALLAS, TX, 1', 'LONE STAR BLOOM *')] };
  assert.deepEqual(requestStops(similar).map((s) => s.key), ['TYLER|TX', 'DALLAS|TX'], 'in stop order');
  const sameCity = { trip: {}, freightBills: [stop('M1', 'OCALA, FL, 1', 'A'), stop('M2', 'OCALA, FL, 1', 'B')] };
  assert.equal(requestStops(sameCity).length, 1, 'stop identity is unchanged'); assert.equal(requestStops(sameCity)[0].name, 'A · B', 'neither name is dropped');
});
test('request: a time on file stays visible, unconfirmed, with its source; confirmed stops are left out', () => {
  const commits = { 'SANTA ROSA|CA': { atMs: 1, local: '2026-11-03T08:00', auto: true, fromRC: true, by: 'Rate con' }, 'WEST SACRAMENTO|CA': { atMs: 2, local: '2026-11-03T14:00', by: 'Gio', state: 'CA' } };
  const m = askEmail('626045', twoStops, { commits });
  assert.equal((m.html.match(/&#128205;/g) || []).length, 1);
  assert.match(m.text, /Tue, Nov 3, 2026 · Please confirm \(rate con\)/); assert.match(m.text, /8:00 AM · Please confirm \(rate con\)/); assert.match(m.text, /Pacific \(local at the stop\) · Please confirm/);
  assert.doesNotMatch(m.text, /WEST SACRAMENTO/); assert.match(m.html, /delivery appointment</);
  const fc = askEmail('1', { trip: {}, freightBills: [stop('M1', 'OCALA, FL, 1', 'A')] }, { commits: { 'OCALA|FL': { auto: true, fcfs: true, fromRC: true, hours: '6 AM to 2 PM' } } });
  assert.match(fc.text, /First come, first served 6 AM to 2 PM · Please confirm \(rate con\)/);
});
test('request: rate con name and reference, staff vs outside wording, escaping, nothing blank', () => {
  const it = { trip: { powerUnit: '5' }, _ratecon: { broker: 'Demo Logistics', loadNumber: 'L77', deliveries: [{ name: 'Real Receiver', city: 'Ocala', state: 'FL', refs: 'PO 5' }] }, freightBills: [stop('B1', 'OCALA, FL, 1', 'Demo Logistics')] };
  const m = askEmail('9', it);
  assert.match(m.text, /Real Receiver, OCALA, FL: \[Date\]/); assert.match(m.text, /Reference: PO 5/); assert.match(m.text, /Broker Demo Logistics · Load L77/);
  assert.match(m.text, /dispatch console/);
  assert.doesNotMatch(askEmail('9', it, { internal: false }).html + askEmail('9', it, { internal: false }).text, /console/);
  const bad = askEmail('9', { trip: {}, freightBills: [stop('M1', 'OCALA, FL, 1', '<img src=x>')] });
  assert.doesNotMatch(bad.html, /<img src/);
  assert.doesNotMatch(clean(m.html), /undefined|null|NaN/);
});

function followRig(board) {
  const db = { enabled: true, s: {}, get: async (k, d) => (k in db.s ? db.s[k] : d), update: async (k, fn, d) => { db.s[k] = fn(k in db.s ? db.s[k] : d); return db.s[k]; } };
  const saved = {}; const mail = [];
  const commitments = { all: async () => saved, commit: async (t, s) => { saved[t] = { ...(saved[t] || {}), [s.key]: { atMs: 5, local: s.local, by: s.by, state: s.state } }; return { key: s.key, atMs: 5 }; } };
  return { saved, mail, f: initBrokerFollow(null, { db, getBoard: async () => board, commitments, sendMail: async (m) => mail.push(m) }) };
}
test('replies: each stop gets its own time; an unclear stop updates nothing; twin city names are not guessed', async () => {
  const load = { ...twoStops, _ratecon: {}, freightBills: twoStops.freightBills.map((b) => ({ ...b, billNumber: b.billNumber.replace('M', 'B') })) };
  const r = followRig({ trips: [load] });
  await r.f.start('s', '626045', { by: 'Gio', byEmail: 'gio@floridabeauty.us' });
  assert.equal(r.mail.length, 1);
  assert.equal((await r.f.confirm('s', '626045', { deliverAt: '2026-11-03T08:00', by: 'Gio' })).ok, false, 'no stop named on a two-stop load');
  assert.deepEqual(r.saved, {});
  assert.equal((await r.f.confirm('s', '626045', { deliverAt: '2026-11-03T08:00', city: 'Santa Rosa', by: 'Gio' })).ok, true);
  assert.equal((await r.f.confirm('s', '626045', { deliverAt: '2026-11-03T14:00', city: 'West Sacramento, CA', by: 'Gio' })).ok, true);
  assert.equal(r.saved['626045']['SANTA ROSA|CA'].local, '2026-11-03T08:00'); assert.equal(r.saved['626045']['WEST SACRAMENTO|CA'].local, '2026-11-03T14:00');
  const twins = { trip: { tripNumber: '7', powerUnit: '5' }, _ratecon: {}, freightBills: [stop('B1', 'SPRINGFIELD, IL, 1', 'A'), stop('B2', 'SPRINGFIELD, MO, 1', 'B')] };
  const w = followRig({ trips: [twins] });
  await w.f.start('s', '7', { by: 'Gio', byEmail: 'gio@floridabeauty.us' });
  assert.equal((await w.f.confirm('s', '7', { deliverAt: '2026-11-03T08:00', city: 'Springfield', by: 'Gio' })).ok, false);
  assert.equal((await w.f.confirm('s', '7', { deliverAt: '2026-11-03T08:00', city: 'Springfield, MO', by: 'Gio' })).ok, true);
  assert.ok(w.saved['7']['SPRINGFIELD|MO']); assert.equal(w.saved['7']['SPRINGFIELD|IL'], undefined);
});

// ---- set date and time from the email
function linkRig(board, { replyOk = true } = {}) {
  const r = followRig(board); const thread = [];
  const db = { enabled: true, s: {}, get: async (k, d) => (k in db.s ? db.s[k] : d), update: async (k, fn, d) => { db.s[k] = fn(k in db.s ? db.s[k] : d); return db.s[k]; } };
  const commitments = { all: async () => r.saved, commit: async (t, s) => { r.saved[t] = { ...(r.saved[t] || {}), [s.key]: { atMs: 5, local: s.local, by: s.by, state: s.state } }; return { key: s.key }; } };
  const f = initBrokerFollow(null, { db, getBoard: async () => board, commitments, sendMail: async (m) => r.mail.push(m), secret: 's', replyInThread: async (site, id, m) => { thread.push({ id, ...m }); return { sent: replyOk }; } });
  return { ...r, f, thread };
}
const P = { t: '626045' };
const future = '2030-01-08';
const brokerLoad2 = { ...twoStops, _ratecon: {}, freightBills: twoStops.freightBills.map((b) => ({ ...b, billNumber: b.billNumber.replace('M', 'B') })) };
const follow = async (r) => r.f.start('s', '626045', { by: 'Gio', byEmail: 'gio@floridabeauty.us', emailId: 'mail1' });

test('the email carries the button; without a link it does not pretend', async () => {
  const r = linkRig({ trips: [brokerLoad2] }); await follow(r);
  assert.match(r.mail[0].html, /Set date and time/); assert.match(r.mail[0].html, /\/dc\/[\w-]+\.[\w-]+/); assert.match(r.mail[0].text, /Set date and time: https/); assert.match(r.mail[0].html, /Or reply with these details/);
  assert.doesNotMatch(askEmail('9', twoStops).html, /Set date and time|<form|<input/);
});
test('submit: saves each stop as a person confirmed it, then answers on the thread once', async () => {
  const r = linkRig({ trips: [brokerLoad2] }); await follow(r);
  const out = await r.f.submitTimes('s', P, { name: 'Gio', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }, { key: 'WEST SACRAMENTO|CA', date: future, time: '14:30' }] });
  assert.equal(out.code, 200); assert.equal(out.told, true);
  assert.equal(r.saved['626045']['SANTA ROSA|CA'].local, `${future}T08:00`); assert.equal(r.saved['626045']['WEST SACRAMENTO|CA'].by, 'Gio');
  assert.equal(r.thread.length, 1); assert.equal(r.thread[0].id, 'mail1');
  assert.match(r.thread[0].text, /DELIVERY APPOINTMENTS CONFIRMED/); assert.match(r.thread[0].text, /Trip 626045 · Truck 2617/); assert.match(r.thread[0].text, /2:30 PM Pacific time/); assert.match(r.thread[0].text, /Confirmed by: Gio/); assert.match(r.thread[0].text, /ETA MONITORING IS PENDING/, 'no ETA on this rig'); assert.doesNotMatch(r.thread[0].text, /arrives on time/);
  assert.equal((await r.f.submitTimes('s', P, { name: 'Ana', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '09:00' }] })).code, 409, 'a second submit changes nothing');
  assert.equal(r.saved['626045']['SANTA ROSA|CA'].by, 'Gio'); assert.equal(r.thread.length, 1);
});
test('submit: one stop at a time says what is still needed; a bad entry saves nothing', async () => {
  const r = linkRig({ trips: [brokerLoad2] }); await follow(r);
  assert.equal((await r.f.submitTimes('s', P, { name: '', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }] })).code, 400);
  assert.equal((await r.f.submitTimes('s', P, { name: 'Gio', stops: [] })).code, 400);
  assert.equal((await r.f.submitTimes('s', P, { name: 'Gio', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }, { key: 'WEST SACRAMENTO|CA', date: '2020-01-01', time: '08:00' }] })).code, 400);
  assert.deepEqual(r.saved, {}, 'all or nothing');
  assert.equal((await r.f.submitTimes('s', P, { name: 'Gio', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }, { key: 'NOT|ON', date: future, time: '08:00' }] })).code, 200);
  assert.equal(r.saved['626045']['NOT|ON'], undefined, 'only stops on the load');
  assert.match(r.thread[0].text, /Still needed: WEST SACRAMENTO, CA/);
  assert.equal((await r.f.submitTimes('s', { t: '111' }, { name: 'Gio', stops: [] })).code, 410);
});
test('no thread to answer on: the person who asked still hears it', async () => {
  const r = linkRig({ trips: [brokerLoad2] }, { replyOk: false }); await follow(r);
  const before = r.mail.length;
  await r.f.submitTimes('s', P, { name: 'Gio', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }] });
  assert.equal(r.mail.length, before + 1); assert.match(r.mail[before].subject, /^Re: Trip 626045/); assert.deepEqual(r.mail[before].to, ['gio@floridabeauty.us']);
});
test('the page: real calendar and clock, escaped, expired link says so', () => {
  const h = confirmPage(P, requestStops({ trip: {}, freightBills: [{ endZoneDescription: 'OCALA, FL, 1', billToName: '<b>x' }] }), 'Gio <i>');
  assert.match(h, /type="date"/); assert.match(h, /type="time"/); assert.match(h, /Eastern time, local at the stop/); assert.doesNotMatch(h, /<b>x|Gio <i>/);
  assert.match(confirmPage(null), /expired/);
  assert.match(confirmedReply('1', { trip: {} }, [{ city: 'A', state: 'FL', local: '2030-01-08T08:00', name: '<x>' }], 'G').html, /&lt;x&gt;/);
});

test('an appointment that passed only reads as late on a broker load once a person confirmed it', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const bill = { billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148', pieces: 1, deliverBy: '2026-10-07T04:00:00', deliverByEnd: '2026-10-07T04:00:00', deliveryApptReq: 'True' };
  const base = { trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '1' }, freightBills: [bill], _samsara: { gpsAt: '2026-10-07T11:59:00Z', lat: 26.7, lng: -80.1, speedMph: 60, hos: { status: 'driving', driveLeftMin: 300, shiftLeftMin: 400 } } };
  const ctx = { now, geo: () => ({ lat: 41.88, lng: -88.0 }), unitState: () => ({}), origin: { lat: 25.8, lng: -80.3 } };
  const passed = (it) => evaluateBoard({ trips: [it] }, ctx).filter((a) => a.code === 'appt-passed');
  assert.equal(passed({ ...base, freightBills: [{ ...bill, billNumber: 'M1' }] }).length, 1, 'hub loads unchanged');
  assert.equal(passed(base).length, 0, 'TruckMate time, nobody asked to follow');
  assert.equal(passed({ ...base, _brokerFollow: { confirmed: false } }).length, 0, 'followed, no confirmed time');
  assert.equal(passed({ ...base, _brokerFollow: { confirmed: true } }).length, 0, 'this stop only has the TruckMate time');
  const commit = { 'LOMBARD|IL': { atMs: Date.parse('2026-10-07T09:00:00Z'), by: 'Ana', local: '2026-10-07T04:00', state: 'IL' } };
  assert.equal(passed({ ...base, _brokerFollow: { confirmed: true }, _commit: commit }).length, 1, 'a confirmed time that passed still alerts');
});
test('the example link opens the real page and cannot save', async () => {
  const r = linkRig({ trips: [brokerLoad2] });
  assert.match(r.f.exampleLink('626045', 'Example'), /\/dc\//);
  assert.deepEqual(r.saved, {});
});

test('confirmation email: banner and wording follow the count, what saved, and real monitoring state', () => {
  const NOW = Date.parse('2026-11-01T16:00:00Z');
  const a = { name: 'CEASAR\'S FLOWERS', city: 'WATSONVILLE', state: 'CA', local: '2026-11-03T08:00' };
  const b = { name: 'SAMPLE NY', city: 'ALBANY', state: 'NY', local: '2026-11-03T14:30' };
  const it = { trip: { powerUnit: '2617' } };
  const one = confirmedReply('9', it, [a], 'Gio', [], { atMs: NOW });
  assert.match(one.text, /^DELIVERY APPOINTMENT CONFIRMED$/m); assert.match(one.text, /appointment has been recorded/); assert.match(one.text, /JARVIS IS MONITORING YOUR DELIVERY/);
  assert.match(one.text, /Tuesday, November 3, 2026, 8:00 AM Pacific time/); assert.match(one.text, /Confirmation time: Nov 1, 11:00 AM ET/); assert.match(one.text, /More than 1 hour late/);
  const two = confirmedReply('9', it, [a, b], 'Gio', []);
  assert.match(two.text, /^DELIVERY APPOINTMENTS CONFIRMED$/m); assert.match(two.text, /2:30 PM Eastern time/); assert.match(two.text, /Confirmation time: Not recorded/);
  assert.match(confirmedReply('9', it, [a], null).text, /Confirmed by: Not recorded/);
  assert.match(confirmedReply('9', it, [a], 'G', [], { thresholdMin: 90 }).text, /More than 1 hour 30 minutes late/);
  const pend = confirmedReply('9', it, [a], 'G', [], { monitoring: 'pending' });
  assert.match(pend.text, /ETA MONITORING IS PENDING/); assert.doesNotMatch(pend.text, /IS MONITORING YOUR/);
  const off = confirmedReply('9', it, [a], 'G', [], { monitoring: 'unavailable' });
  assert.match(off.text, /NOT ACTIVE/); assert.doesNotMatch(off.text, /Delay notification/);
  assert.match(confirmedReply('9', it, [a], 'G', [], { example: true }).html, /EXAMPLE PREVIEW · Not a real appointment confirmation/);
  assert.doesNotMatch(one.html, /EXAMPLE PREVIEW/);
  assert.match(confirmedReply('9', it, [a], 'G', [b]).text, /Still needed: ALBANY, NY\./);
  assert.match(confirmedReply('9', it, [{ ...a, name: '<x>' }], 'G').html, /&lt;x&gt;/);
  assert.doesNotMatch(one.text + one.html.replace(/<!--[\s\S]*?-->/g, ''), /undefined|null|NaN/); assert.match(one.text, /does not guarantee on-time arrival/);
  assert.equal(monitorStatus({ etas: { at: NOW - 60000, stops: [{ etaMs: NOW }] }, now: NOW }), 'active');
  assert.equal(monitorStatus({ etas: { at: NOW - 3600000, stops: [{ etaMs: NOW }] }, now: NOW }), 'pending', 'stale ETA');
  assert.equal(monitorStatus({ etas: null, now: NOW }), 'pending'); assert.equal(monitorStatus({ following: false }), 'unavailable');
});
test('a failed save is never reported as confirmed, and can be tried again', async () => {
  const r = linkRig({ trips: [brokerLoad2] }); await follow(r);
  const db2 = { enabled: true, s: {}, get: async (k, d) => (k in db2.s ? db2.s[k] : d), update: async (k, fn, d) => { db2.s[k] = fn(k in db2.s ? db2.s[k] : d); return db2.s[k]; } };
  let fail = 'WEST SACRAMENTO|CA'; const thread = []; const saved = {};
  const commitments = { all: async () => saved, commit: async (t, s) => { if (fail === 'ALL' || s.key === fail) return null; saved[t] = { ...(saved[t] || {}), [s.key]: { atMs: 5, local: s.local, by: s.by, state: s.state } }; return { key: s.key }; } };
  const f = initBrokerFollow(null, { db: db2, getBoard: async () => ({ trips: [brokerLoad2] }), commitments, sendMail: async () => {}, secret: 's', replyInThread: async (x, y, m) => { thread.push(m); return { sent: true }; } });
  await f.start('s', '626045', { by: 'Gio', byEmail: 'gio@floridabeauty.us', emailId: 'm' });
  const both = [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }, { key: 'WEST SACRAMENTO|CA', date: future, time: '09:00' }];
  const out = await f.submitTimes('s', P, { name: 'Gio', stops: both });
  assert.equal(out.code, 200); assert.equal(out.partial, true); assert.deepEqual(out.stops, ['SANTA ROSA|CA']);
  assert.match(thread[0].text, /^DELIVERY APPOINTMENT CONFIRMED$/m); assert.match(thread[0].text, /Still needed: WEST SACRAMENTO, CA/); assert.doesNotMatch(thread[0].text.split('Still needed')[0], /WEST SACRAMENTO/);
  fail = 'ALL';
  assert.equal((await f.submitTimes('s', P, { name: 'Gio', stops: [both[1]] })).code, 500); assert.equal(thread.length, 1, 'nothing saved, nothing sent');
  fail = null;
  assert.equal((await f.submitTimes('s', P, { name: 'Gio', stops: [both[1]] })).code, 200); assert.equal(thread.length, 2);
});

test('the delivery confirmation list gets a copy of the request and the confirmation, staff only', async () => {
  const db2 = { enabled: true, s: {}, get: async (k, d) => (k in db2.s ? db2.s[k] : d), update: async (k, fn, d) => { db2.s[k] = fn(k in db2.s ? db2.s[k] : d); return db2.s[k]; } };
  const saved = {}; const mail = []; const thread = [];
  const commitments = { all: async () => saved, commit: async (t, s) => { saved[t] = { ...(saved[t] || {}), [s.key]: { atMs: 5, local: s.local, by: s.by, state: s.state } }; return { key: s.key }; } };
  const f = initBrokerFollow(null, { db: db2, getBoard: async () => ({ trips: [brokerLoad2] }), commitments, sendMail: async (m) => mail.push(m), copyEmails: async () => ['inbound-dispatch@floridabeauty.us', 'outside@broker.com', 'gio@floridabeauty.us'], secret: 's', replyInThread: async (x, y, m) => { thread.push(m); return { sent: true }; } });
  await f.start('s', '626045', { by: 'Gio', byEmail: 'gio@floridabeauty.us', emailId: 'm' });
  assert.deepEqual(mail[0].to, ['gio@floridabeauty.us']); assert.deepEqual(mail[0].cc, ['inbound-dispatch@floridabeauty.us']);
  await f.submitTimes('s', P, { name: 'Gio', stops: [{ key: 'SANTA ROSA|CA', date: future, time: '08:00' }] });
  assert.equal(thread.length, 1); assert.deepEqual(mail[1].to, ['inbound-dispatch@floridabeauty.us']); assert.match(mail[1].subject, /^Re: Trip 626045/); assert.match(mail[1].text, /DELIVERY APPOINTMENT CONFIRMED/);
});

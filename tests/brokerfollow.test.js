import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCommits, openStops, askEmail, initBrokerFollow } from '../brokerfollow.js';
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

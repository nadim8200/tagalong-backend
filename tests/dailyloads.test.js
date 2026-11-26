import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyLoads, dailyLoadsEmail, judgeStop, initDailyLoads } from '../dailyloads.js';

const NOW = Date.parse('2026-11-25T13:00:00Z');   // 8:00 AM ET
const bill = (n, zone, deliverBy, extra = {}) => ({ billNumber: n, endZone: zone, endZoneDescription: zone, deliverBy, deliverByEnd: deliverBy, deliveryApptMade: 'True', pieces: 10, ...extra });
const ltl = { trip: { tripNumber: '627001', powerUnit: '2403', trailer: '7301', driver: 'MANCINI HALL', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [bill('M1001', 'ATLANTA, GA, 30301', '2026-11-25T09:00'), bill('M1002', 'CHARLOTTE, NC, 28201', '2026-11-25T18:00')], _tb: { hub: 'MIAMI' } };
const brokerOnTime = { trip: { tripNumber: '627002', powerUnit: '483', driver: 'JUAN AVILA', origZoneDesc: 'LAKELAND, FL', destZoneDesc: 'HYDE PARK, MA' }, freightBills: [bill('B5001', 'HYDE PARK, MA, 02136', '2026-11-25T16:00')], _ratecon: { broker: 'CH Robinson', loadNumber: 'CH-889', deliveries: [] } };
const brokerMissed = { trip: { tripNumber: '627003', powerUnit: '39', driver: 'RAFAEL RUIZ', origZoneDesc: 'VENTURA, CA', destZoneDesc: 'LOS ANGELES, CA' }, freightBills: [bill('B6001', 'LOS ANGELES, CA, 90021', '2026-11-25T04:00')], _ratecon: { broker: 'TQL', loadNumber: 'TQL-1' } };
const tomorrow = { trip: { tripNumber: '627004', powerUnit: '1', origZoneDesc: 'MIAMI TERMINAL' }, freightBills: [bill('M9', 'BOSTON, MA, 02101', '2026-11-26T10:00')] };
const etas = {
  627001: { stops: [{ key: 'ATLANTA, GA, 30301', etaMs: Date.parse('2026-11-25T15:30:00Z') }, { key: 'CHARLOTTE, NC, 28201', etaMs: Date.parse('2026-11-25T21:00:00Z') }] },
  627002: { stops: [{ key: 'HYDE PARK, MA, 02136', etaMs: Date.parse('2026-11-25T20:00:00Z') }] },
};
const alerts = [{ trip: '627002', code: 'reefer-temp', severity: 'critical', title: 'Reefer too warm — 52.6°F' }, { trip: '627003', code: 'late-risk', severity: 'critical', title: 'dup' }, { trip: '627002', code: 'x', title: 'old', resolvedAt: 1 }];

test('Luis\'s 8 AM summary: broker loads only — running late, or with an issue; flower / LTL loads left out (Nov 25)', () => {
  const quiet = { ...brokerOnTime, trip: { ...brokerOnTime.trip, tripNumber: '627005' } };
  const d = dailyLoads([ltl, brokerOnTime, brokerMissed, tomorrow, quiet], { now: NOW, etas: { ...etas, 627005: etas[627002] }, alerts });
  assert.deepEqual(d.late.map((l) => l.trip), ['627003'], 'the LTL load running late is not in it');
  assert.match(d.late[0].stops[0].text, /Missed — appointment passed/);
  assert.deepEqual(d.issues.map((l) => l.trip), ['627002']);
  assert.deepEqual(d.issues[0].issues.map((i) => i.title), ['Reefer too warm — 52.6°F']);
  assert.equal(d.issues[0].load, 'CH-889');
  assert.deepEqual(d.counts, { late: 1, issue: 1, ontime: 1, check: 0 });
});

test('broker issues from email: unanswered broker asks, problems dispatch reported, open to-dos (Nov 25)', () => {
  const hr = 3600000;
  const emails = [
    { id: 'e1', trips: ['627006'], status: 'new', at: new Date(NOW - 3 * hr).toISOString(), from: { name: 'Ana (TQL)', address: 'ana@tql.com' }, summary: 'Asks for the ETA to Boston', reply: { needed: true } },
    { id: 'e2', trips: ['627006'], status: 'new', at: new Date(NOW - 20 * 60000).toISOString(), from: { address: 'x@tql.com' }, summary: 'too new', reply: { needed: true } },
    { id: 'e3', trips: ['627006'], status: 'handled', at: new Date(NOW - 2 * hr).toISOString(), from: { name: 'Gus', address: 'gus@floridabeauty.us' }, summary: 's', loadUpdate: { kind: 'breakdown', note: 'Truck 77 air leak, waiting on road service' } },
    { id: 'e4', trips: ['627006'], status: 'replied', at: new Date(NOW - 5 * hr).toISOString(), from: { address: 'b@tql.com' }, summary: 'answered', reply: { needed: true } },
    { id: 'e5', trips: ['627006'], status: 'new', auto: 'bounce', at: new Date(NOW - 5 * hr).toISOString(), from: { address: 'mailer@x.com' }, reply: { needed: true } },
  ];
  const tasks = { 627006: [{ title: 'Send the POD to the broker', from: 'Ana (TQL)', at: new Date(NOW - hr).toISOString(), done: null }, { title: 'done one', at: new Date(NOW - hr).toISOString(), done: '2026-11-25' }] };
  const holds = { 627006: { kind: 'breakdown', emailId: 'e3', since: new Date(NOW - 2 * hr).toISOString(), note: 'dup' } };
  const inTransit = { trip: { tripNumber: '627006', powerUnit: '77', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'BOSTON, MA' }, freightBills: [bill('B7001', 'BOSTON, MA, 02101', '2026-11-27T10:00')], _ratecon: { broker: 'TQL', loadNumber: 'TQL-9' } };
  const d = dailyLoads([inTransit], { now: NOW, emails, tasks, holds });
  assert.equal(d.issues.length, 1, 'an issue counts even when the delivery is another day');
  assert.deepEqual(d.issues[0].issues.map((i) => i.kind), ['reported', 'unanswered', 'todo']);
  assert.match(d.issues[0].issues[0].title, /Reported by Gus .*air leak/);
  assert.match(d.issues[0].issues[1].title, /Not answered — Ana \(TQL\) asked 3h ago: Asks for the ETA/);
});

test('a stop judged: delivered on time / late, no ETA → check', () => {
  const st = { apptMs: NOW, delivered: false, tz: 'America/New_York' };
  assert.equal(judgeStop(st, { now: NOW - 60 * 60000 }).status, 'check');
  assert.equal(judgeStop({ ...st, delivered: true }, { now: NOW, doneMs: NOW + 10 * 60000 }).status, 'ontime');
  assert.match(judgeStop({ ...st, delivered: true }, { now: NOW, doneMs: NOW + 50 * 60000 }).text, /Delivered 50m late/);
});

test('the email: running late and issues sections, broker only, counts in the subject; test banner', () => {
  const d = dailyLoads([ltl, brokerOnTime, brokerMissed], { now: NOW, etas, alerts });
  const m = dailyLoadsEmail(d, { test: true, now: NOW });
  assert.match(m.subject, /^TEST — Broker loads · Wednesday, Nov 25 · 1 running late · 1 with issues$/);
  assert.match(m.html, /Running late · 1/); assert.match(m.html, /Issues · 1/); assert.doesNotMatch(m.html, /627001/); assert.match(m.html, /TEST · SAMPLE DATA/);
  assert.match(m.text, /LATE · Trip 627003/);
});

test('sends once at 8 AM ET to the daily list, straight through; not before 8 (Nov 25)', async () => {
  const store = { taWatch: { 'taWatch:florida-beauty': { etas, alerts: {} } } };
  const kv = new Map([['taWatch:florida-beauty', { etas, alerts: {} }]]);
  const db = { enabled: true, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); } };
  const sent = []; let t = NOW - 60 * 60000;
  const daily = initDailyLoads({ db, now: () => t, send: async (m) => { sent.push(m); } });
  await daily.tick([brokerMissed]); assert.equal(sent.length, 0, '7 AM: not yet');
  t = NOW; await daily.tick([brokerMissed]); await daily.tick([brokerMissed]);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ljimenez@floridabeauty.us']);
  assert.ok(store);
});

test('false lates from TruckMate: a stop the truck already drove past (GPS) is not late; a leftover timestamp is not an appointment (Nov 25)', () => {
  const passedLoad = { trip: { tripNumber: '627010', powerUnit: '2403', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'NEWARK, NJ' }, freightBills: [bill('B8001', 'BALTIMORE, MD, 21201', '2026-11-24T17:00'), bill('B8002', 'NEWARK, NJ, 07102', '2026-11-25T14:00')], _ratecon: { broker: 'TQL', loadNumber: 'T-1' } };
  const stamp = { trip: { tripNumber: '627011', powerUnit: '12', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA' }, freightBills: [bill('B8101', 'ATLANTA, GA, 30301', '2026-11-25T06:35:41')] };
  const e = { 627010: { passed: [{ key: 'BALTIMORE, MD, 21201' }], stops: [{ key: 'NEWARK, NJ, 07102', etaMs: Date.parse('2026-11-25T18:30:00Z') }] } };
  const d = dailyLoads([passedLoad, stamp], { now: NOW, etas: e });
  assert.deepEqual(d.late, []);
  assert.equal(d.counts.ontime, 1, 'Newark on time; Baltimore passed by GPS; the timestamp load not judged');
});

test('judged by when the truck ARRIVED (TruckMate), not when unloading ended; a POD email means delivered, not late (Nov 25)', () => {
  const hist = (...a) => ({ statusHistory: a.map(([status, at]) => ({ status, at })) });
  // arrived 7:15 for a 7:00 appointment, delivery closed 9:36 → on time
  const a = { trip: { tripNumber: '627726', powerUnit: '5', status: 'DEPCONS', currentZone: '32123', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'X' }, freightBills: [bill('B1', '32123', '2026-11-25T07:00', { actualDelivery: '2026-11-25T09:36:11' })], _times: hist(['ARRCONS', '2026-11-25T12:15:44Z'], ['DEPCONS', '2026-11-25T14:37:44Z']), _ratecon: { broker: 'X' } };
  // at the consignee since the afternoon before its 7 AM appointment, not closed
  const b = { trip: { tripNumber: '627797', powerUnit: '6', status: 'ARRCONS', currentZone: '28601', origZoneDesc: 'YARD', destZoneDesc: 'HICKORY, NC, 28601' }, freightBills: [bill('B2', '28601', '2026-11-25T07:00')], _times: hist(['ARRCONS', '2026-11-24T20:49:36Z']), _ratecon: { broker: 'X' } };
  // 6 AM appointment, no arrival, but staff emailed the POD
  const c = { trip: { tripNumber: '627798', powerUnit: '7', status: 'DEPSHIP', origZoneDesc: 'YARD', destZoneDesc: 'Y' }, freightBills: [bill('B3', '32809', '2026-11-25T06:00')], _staffPod: { by: 'Valeria' }, _ratecon: { broker: 'X' } };
  // really late: arrived 9:40 for 7:00
  const d0 = { trip: { tripNumber: '627799', powerUnit: '8', status: 'ARRCONS', currentZone: '30301', origZoneDesc: 'YARD', destZoneDesc: 'Z' }, freightBills: [bill('B4', '30301', '2026-11-25T07:00')], _times: hist(['ARRCONS', '2026-11-25T14:40:00Z']), _ratecon: { broker: 'X' } };
  const d = dailyLoads([a, b, c, d0], { now: Date.parse('2026-11-25T16:00:00Z') });
  assert.deepEqual(d.late.map((l) => l.trip), ['627799']);
  assert.match(d.late[0].stops[0].text, /Arrived 2h 40m late/);
  assert.deepEqual(d.counts, { late: 1, issue: 0, ontime: 2, check: 1 });
});

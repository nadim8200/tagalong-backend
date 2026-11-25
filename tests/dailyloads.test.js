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

test('8 AM summary: loads with an appointment today, judged against it; LTL apart from broker; issues from open alerts (Nov 25)', () => {
  const d = dailyLoads([ltl, brokerOnTime, brokerMissed, tomorrow], { now: NOW, etas, alerts });
  assert.equal(d.total, 3, 'tomorrow\'s load is left out');
  assert.deepEqual(d.ltl.map((l) => l.trip), ['627001']);
  assert.deepEqual(d.broker.map((l) => [l.trip, l.status]), [['627003', 'late'], ['627002', 'issue']]);
  const a = d.ltl[0];
  assert.equal(a.status, 'late');   // Atlanta ETA 10:30 vs 9:00 appt
  assert.match(a.stops[0].text, /Running late ~1h 30m/); assert.equal(a.stops[0].from, 'TruckMate');
  assert.equal(a.stops[1].status, 'ontime');
  assert.match(d.broker[0].stops[0].text, /Missed — appointment passed/);
  assert.deepEqual(d.broker[1].issues.map((i) => i.title), ['Reefer too warm — 52.6°F']);
  assert.equal(d.broker[1].load, 'CH-889');
  assert.deepEqual(d.counts, { late: 2, issue: 1, ontime: 0, check: 0 });
});

test('a stop judged: delivered on time / late, no ETA → check', () => {
  const st = { apptMs: NOW, delivered: false, tz: 'America/New_York' };
  assert.equal(judgeStop(st, { now: NOW - 60 * 60000 }).status, 'check');
  assert.equal(judgeStop({ ...st, delivered: true }, { now: NOW, doneMs: NOW + 10 * 60000 }).status, 'ontime');
  assert.match(judgeStop({ ...st, delivered: true }, { now: NOW, doneMs: NOW + 50 * 60000 }).text, /Delivered 50m late/);
});

test('the email: LTL and broker sections, counts in the subject; test banner', () => {
  const d = dailyLoads([ltl, brokerOnTime, brokerMissed], { now: NOW, etas, alerts });
  const m = dailyLoadsEmail(d, { test: true, now: NOW });
  assert.match(m.subject, /^TEST — Today's loads · Wednesday, Nov 25 · 2 late · 1 issues · 0 on time$/);
  assert.match(m.html, /LTL loads · 1/); assert.match(m.html, /Broker loads · 2/); assert.match(m.html, /TEST · SAMPLE DATA/);
  assert.match(m.text, /LATE · Trip 627001/);
});

test('sends once at 8 AM ET to the daily list, straight through; not before 8 (Nov 25)', async () => {
  const store = { taWatch: { 'taWatch:florida-beauty': { etas, alerts: {} } } };
  const kv = new Map([['taWatch:florida-beauty', { etas, alerts: {} }]]);
  const db = { enabled: true, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); } };
  const sent = []; let t = NOW - 60 * 60000;
  const daily = initDailyLoads({ db, now: () => t, send: async (m) => { sent.push(m); } });
  await daily.tick([ltl]); assert.equal(sent.length, 0, '7 AM: not yet');
  t = NOW; await daily.tick([ltl]); await daily.tick([ltl]);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ljimenez@floridabeauty.us']);
  assert.ok(store);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learn, usualFor, usualMs, lateCheck, shouldAlert, lateEmail, usualView, isLtl, stopKey } from '../usualarrival.js';

// Boston market (Chelsea, MA): Monday outbounds get there Wednesday about 4 AM
const ET = (iso) => Date.parse(iso);
const rows = [
  { trip: '1', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-10-21T08:05:00Z') },   // Wed 4:05 AM EDT
  { trip: '2', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-10-28T07:50:00Z') },   // Wed 3:50 AM EDT
  { trip: '3', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-11-04T09:00:00Z') },   // Wed 4:00 AM EST
  { trip: '4', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-11-04T09:10:00Z') },   // no outbound known
];
const outbound = { 1: '2026-10-19', 2: '2026-10-26', 3: '2026-11-02' };

test('learns when trucks usually get to a customer: days after the outbound day + local time', () => {
  const st = learn({}, rows, (n) => outbound[n] || null);
  const rec = st[stopKey('DIRECT FLOWERS OF BOSTON INC', 'CHELSEA, MA')];
  assert.equal(rec.arrivals.length, 3);
  assert.equal(learn(st, rows, (n) => outbound[n] || null)[stopKey('DIRECT FLOWERS OF BOSTON INC', 'CHELSEA, MA')].arrivals.length, 3, 'each trip once');
  const u = usualFor(rec, '2026-11-09');
  assert.equal(u.days, 2);
  assert.equal(u.min, 4 * 60);
  assert.match(u.text, /2 days after the outbound day at about 4:00 AM local \(Monday outbounds\)/);
  assert.equal(new Date(usualMs(u, '2026-11-09', 'CHELSEA, MA')).toISOString(), '2026-11-11T09:00:00.000Z');   // Wed 4 AM EST
  assert.equal(usualFor({ arrivals: rec.arrivals.slice(0, 2) }, '2026-11-09'), null, 'needs 3 arrivals');
});

test('an LTL ETA past the usual time → alert once, again only an hour worse; broker loads never', () => {
  const learned = learn({}, rows, (n) => outbound[n] || null);
  const item = { trip: { tripNumber: '626824', powerUnit: '2607', trailer: '7224', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-09', stops: [] },
    _manifest: { stops: [{ action: 'DELIVER', customer: 'DIRECT FLOWERS OF BOSTON INC', city: 'CHELSEA', state: 'MA' }] },
    freightBills: [{ billNumber: 'M1', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150' }] };
  assert.equal(isLtl(item), true);
  const etas = { 626824: { stops: [{ label: 'CHELSEA, MA, 02150', etaMs: ET('2026-11-11T13:57:00Z') }] } };     // 8:57 AM
  const [x] = lateCheck([item], etas, learned);
  assert.equal(x.lateMin, 297);
  assert.equal(shouldAlert(null, x.lateMin), true);
  assert.equal(shouldAlert({ lateMin: 297 }, 330), false);
  assert.equal(shouldAlert({ lateMin: 297 }, 360), true);
  assert.equal(shouldAlert(null, 60), false, 'under 1 h 30 min');
  assert.match(lateEmail(x, item).subject, /Running late: trip 626824 — DIRECT FLOWERS OF BOSTON INC \(CHELSEA, MA\) ETA 4 h 57 min past usual/);
  assert.match(usualView([x])[0].vs_usual, /4 h 57 min later than usual/);
  const broker = { ...item, trip: { ...item.trip, origZoneDesc: 'LAKELAND, FL' }, _tb: undefined, _manifest: undefined, _ratecon: { broker: 'TQL' }, freightBills: [{ billNumber: 'B180922', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150' }] };
  assert.equal(lateCheck([broker], etas, learned).length, 0);
});

test('staff set a usual time ("Pyramid Oxnard: 4 AM") — it wins over the learned one; days after outbound from what was learned', async () => {
  const { parseClock, learnedDays } = await import('../usualarrival.js');
  assert.equal(parseClock('4am'), 240); assert.equal(parseClock('4:30 PM'), 990); assert.equal(parseClock('16:30'), 990); assert.equal(parseClock('13 PM'), null);
  const { initEtaReport } = await import('../etareport.js');
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  // one Oxnard arrival learned: Monday Nov 2 outbound → Thursday Nov 5 (3 days)
  m.set('taUsualArrival:florida-beauty', { stops: { [stopKey('PYRAMID FLOWERS, INC.-OXNARD', 'OXNARD, CA')]: { customer: 'PYRAMID FLOWERS, INC.-OXNARD', place: 'OXNARD, CA', arrivals: [{ trip: '626362', days: 3, min: 1, dow: 1, outbound: '2026-11-02', ms: 1 }] } } });
  assert.equal(learnedDays(m.get('taUsualArrival:florida-beauty').stops[stopKey('PYRAMID FLOWERS, INC.-OXNARD', 'OXNARD, CA')]), 3);
  const sent = [];
  const r = initEtaReport({ db, sendMail: async (x) => sent.push(x), lateRecipients: async () => ['ntellez@floridabeauty.us'], now: () => Date.parse('2026-11-12T18:00:00Z') });
  const ok = await r.setUsual({ customer: 'Pyramid Flowers Oxnard', time: '4 AM', by: 'Nadim' });
  assert.equal(ok.ok, true);
  assert.match(ok.saved.usual, /3 days after the outbound day at 4:00 AM local \(set by Nadim\)/);
  assert.equal((await r.setUsual({ customer: 'Nobody', time: '4am' })).ok, false);
  // trip 626845 (Monday Nov 9 outbound): ETA Thu 4:04 PM PT vs the set 4 AM PT → alert
  const item = { trip: { tripNumber: '626845', powerUnit: '2611', trailer: '7136', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-09', stops: [] },
    freightBills: [{ billNumber: 'M5060046', billToName: 'PYRAMID FLOWERS, INC.-OXNARD', endZoneDescription: 'OXNARD, CA, 93030' }] };
  m.set('taWatch:florida-beauty', { etas: { 626845: { stops: [{ label: 'OXNARD, CA, 93030', etaMs: Date.parse('2026-11-13T00:04:00Z') }] } } });
  await r.process('florida-beauty', { trips: [item] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Running late: trip 626845 — PYRAMID FLOWERS, INC\.-OXNARD \(OXNARD, CA\) ETA 12 h 4 min past usual/);
  assert.match((await r.usualFor('626845'))[0].vs_usual, /12 h 4 min later than usual/);
});

test('delivery times are per hub (Miami / Ventura), and only Nadim or Ronen may set them', async () => {
  const { maySet, hubOf, hubKey, usualFor: uf } = await import('../usualarrival.js');
  assert.equal(maySet({ phone: '+1 (305) 504-0711' }), true);
  assert.equal(maySet({ phone: '3052063095' }), true);
  assert.equal(maySet({ phone: '7865551234' }), false);
  assert.equal(maySet({ name: 'Ronen Shalom' }), true);
  assert.equal(maySet({ name: 'Andres Leon' }), false);
  assert.equal(hubKey('Ventura'), 'VENTURA'); assert.equal(hubKey('miami'), 'MIAMI');
  assert.equal(hubOf({ trip: { origZoneDesc: 'MIAMI TERMINAL' } }), 'MIAMI');
  assert.equal(hubOf({ trip: {}, _tb: { hub: 'Ventura' } }), 'VENTURA');
  const rec = { customer: 'X', place: 'OXNARD, CA', arrivals: [], fixedByHub: { MIAMI: { days: 3, min: 240, hub: 'MIAMI', by: 'Nadim' }, VENTURA: { days: 0, min: 1260, hub: 'VENTURA', by: 'Ronen' } } };
  assert.match(uf(rec, '2026-11-09', 'MIAMI').text, /3 days after the outbound day at 4:00 AM local from Miami \(set by Nadim\)/);
  assert.match(uf(rec, '2026-11-09', 'VENTURA').text, /the outbound day at 9:00 PM local from Ventura \(set by Ronen\)/);
});

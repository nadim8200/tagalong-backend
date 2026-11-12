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

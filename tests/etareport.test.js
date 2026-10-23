import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldLog, foldLog, reportRows, renderReport, initEtaReport, placeKey, stopTimesFrom, hm } from '../etareport.js';

const H = 3600000; const M = 60000;
const item = { trip: { tripNumber: '625645', powerUnit: '4550', trailer: '2077', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'FALL RIVER, MA, 02720' },
  freightBills: [{ billNumber: 'M1', billToName: 'OSCAR FLOWERS *', endZoneDescription: 'MOUNT RAINIER, MD, 20712', actualDelivery: '2026-10-23T17:05:00' }, { billNumber: 'M2', billToName: 'FALL RIVER FLORIST SUPPLY', endZoneDescription: 'FALL RIVER, MA, 02720' }],
  _manifest: { stops: [{ key: 's2', city: 'MT RAINIER', state: 'MD' }, { key: 's6', city: 'FALL RIVER', state: 'MA' }] } };

test('the ETA log: first one, then only when it moves 20+ min or every 3 h', () => {
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(shouldLog([], t0 + H, t0), true);
  assert.equal(shouldLog([{ at: t0, etaMs: t0 + H }], t0 + H + 10 * M, t0 + 30 * M), false);
  assert.equal(shouldLog([{ at: t0, etaMs: t0 + H }], t0 + H + 25 * M, t0 + 30 * M), true);
  assert.equal(shouldLog([{ at: t0, etaMs: t0 + H }], t0 + H, t0 + 3 * H), true);
  assert.equal(placeKey('MT RAINIER, MD'), placeKey('MOUNT RAINIER, MD, 20712'));
});

test('report: our ETAs along the way, ARTIS\'s, and the actual arrival (geofence, else TruckMate delivered)', () => {
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  let log = foldLog({}, [item], { 625645: { stops: [{ label: 'MOUNT RAINIER, MD, 20712', etaMs: t0 + 4 * H, miles: 200 }, { label: 'FALL RIVER, MA, 02720', etaMs: t0 + 16 * H }] } }, t0);
  log = foldLog(log, [{ ...item, _artisEta: { stops: [{ name: 'OSCAR', city: 'MOUNT RAINIER', state: 'MD', etaMs: t0 + 5 * H }] } }], { 625645: { stops: [{ label: 'MOUNT RAINIER, MD, 20712', etaMs: t0 + 4.6 * H, miles: 16 }] } }, t0 + 4 * H);
  const visits = { s6: { stopKey: 's6', enteredAt: t0 + 17 * H, exitedAt: t0 + 17 * H + 85 * M, dwellMin: 85 } };
  const rows = reportRows(item, log['625645'], visits);
  const mr = rows.find((r) => /RAINIER/.test(r.label)); const fr = rows.find((r) => /FALL RIVER/.test(r.label));
  assert.equal(mr.ours.length, 2); assert.equal(mr.artis.length, 1); assert.deepEqual(mr.customers, ['OSCAR FLOWERS']);
  assert.equal(mr.actual.from, 'delivered (TruckMate)'); assert.equal(mr.actual.ms, Date.parse('2026-10-23T21:05:00Z'));
  assert.equal(fr.actual.from, 'arrived (geofence)'); assert.equal(fr.stay.minutes, 85);
  const m = renderReport(item, rows, 'delivered');
  assert.match(m.subject, /Trip report: ETAs and time at each stop — trip 625645 · truck 4550 \(delivered\)/);
  assert.match(m.html, /Our ETAs along the way/); assert.match(m.html, /ARTIS ETA/); assert.match(m.html, /1 h later/); assert.match(m.html, /Time at stop/); assert.match(m.html, /<b>1 h 25 min<\/b>/);
});

test('emailed once when the trip finishes', async () => {
  const mm = new Map(); const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const sent = [];
  const r = initEtaReport({ db, sendMail: async (x) => sent.push(x), recipients: async () => ['ntellez@floridabeauty.us'] });
  await r.onFinished('florida-beauty', { item }, 'delivered');
  await r.onFinished('florida-beauty', { item }, 'delivered');
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
});


test('stop times: every finished geofence visit — trip, truck, customer, place, how long — kept for the report', () => {
  const visits = { 625645: { s2: { stopKey: 's2', unit: '4550', geofence: { name: 'OSCAR FLOWERS', source: 'Customer geofence' }, enteredAt: 1000, exitedAt: 1000 + 40 * M, dwellMin: 40 }, s6: { stopKey: 's6', enteredAt: 5000 } } };
  const rows = stopTimesFrom(visits, [{ ...item, _manifest: { stops: [{ key: 's2', customer: 'OSCAR FLOWERS', city: 'MT RAINIER', state: 'MD' }] } }]);
  assert.deepEqual(Object.values(rows).map((r) => [r.trip, r.truck, r.customer, r.place, r.minutes]), [['625645', '4550', 'OSCAR FLOWERS', 'MT RAINIER, MD', 40]]);
  assert.equal(hm(85), '1 h 25 min'); assert.equal(hm(40), '40 min');
});

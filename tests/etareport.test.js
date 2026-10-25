import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldLog, foldLog, reportRows, renderReport, initEtaReport, placeKey, stopTimesFrom, hm, keyEtas, worthSending } from '../etareport.js';

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
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  const done = { ...item, freightBills: item.freightBills.map((b) => ({ ...b, actualDelivery: b.actualDelivery || '2026-10-24T08:00:00' })) };
  await db.set('taEtaLog:florida-beauty', foldLog({}, [done], { 625645: { stops: [{ label: 'MOUNT RAINIER, MD, 20712', etaMs: t0 + 4 * H }] } }, t0));
  await r.onFinished('florida-beauty', { item: done }, 'delivered');
  assert.equal(sent.length, 0, 'off until turned on');
  await db.set('taEtaReportMail:florida-beauty', { on: true });
  await r.onFinished('florida-beauty', { item }, 'delivered');
  assert.equal(sent.length, 0, 'a stop with no delivery time → no email');
  await r.onFinished('florida-beauty', { item: done }, 'delivered');
  await r.onFinished('florida-beauty', { item: done }, 'delivered');
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
});


test('stop times: every finished geofence visit — trip, truck, customer, place, how long — kept for the report', () => {
  const visits = { 625645: { s2: { stopKey: 's2', unit: '4550', geofence: { name: 'OSCAR FLOWERS', source: 'Customer geofence' }, enteredAt: 1000, exitedAt: 1000 + 40 * M, dwellMin: 40 }, s6: { stopKey: 's6', enteredAt: 5000 } } };
  const rows = stopTimesFrom(visits, [{ ...item, _manifest: { stops: [{ key: 's2', customer: 'OSCAR FLOWERS', city: 'MT RAINIER', state: 'MD' }] } }]);
  assert.deepEqual(Object.values(rows).map((r) => [r.trip, r.truck, r.customer, r.place, r.minutes]), [['625645', '4550', 'OSCAR FLOWERS', 'MT RAINIER, MD', 40]]);
  assert.equal(hm(85), '1 h 25 min'); assert.equal(hm(40), '40 min');
});


test('Jarvis / API query: finished stops by trip, truck or customer, and a truck at a stop right now', async () => {
  const mm = new Map(); const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const now = Date.parse('2026-10-24T15:00:00Z');
  await db.set('taStopTimes:florida-beauty', { 'a|s1': { trip: '625642', truck: '734', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: now - 5 * H, leftMs: now - 3 * H, minutes: 120 } });
  await db.set('taStopVisits:florida-beauty', { 625645: { s2: { stopKey: 's2', unit: '4550', state: 'at_stop', geofence: { name: 'OSCAR FLOWERS' }, enteredAt: now - 25 * M } } });
  const r = initEtaReport({ db, now: () => now });
  const q = await r.query({ customer: 'direct flowers' });
  assert.equal(q.count, 1); assert.equal(q.stops[0].time_there, '2 h'); assert.equal(q.average, '2 h');
  const live = await r.query({ truck: '4550' });
  assert.deepEqual(live.atStopNow.map((x) => [x.customer, x.there_so_far]), [['OSCAR FLOWERS', '25 min']]);
});

test('ETA we gave vs actual arrival, per stop (trip on the board or finished)', async () => {
  const mm = new Map(); const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  const r = initEtaReport({ db, now: () => t0 });
  await db.set('taEtaLog:florida-beauty', { 625645: { 'FALL RIVER|MA': { label: 'FALL RIVER, MA, 02720', ours: [{ at: t0, etaMs: t0 + 15 * H }, { at: t0 + 10 * H, etaMs: t0 + 16 * H }] } } });
  await db.set('taStopVisits:florida-beauty', { 625645: { s6: { stopKey: 's6', enteredAt: t0 + 16 * H + 40 * M, exitedAt: t0 + 18 * H, dwellMin: 80 } } });
  const rows = await r.etaVsActual(item);
  const fr = rows.find((x) => /FALL RIVER/.test(x.stop));
  assert.ok(fr.eta_we_gave_first && fr.eta_we_gave_last);
  assert.ok(fr.actual_arrival); assert.equal(fr.arrival_from, 'arrived (geofence)');
  assert.equal(fr.off_by_last_eta, '40 min later'); assert.equal(fr.off_by_first_eta, '1 h 40 min later'); assert.equal(fr.time_at_stop, '1 h 20 min');
});


test('report: a truck sitting still is one ETA line, not forty; empty reports are not sent', () => {
  const t0 = Date.parse('2026-10-24T23:06:00Z');
  const still = Array.from({ length: 40 }, (_, i) => ({ at: t0 + i * 20 * M, etaMs: t0 + 25 * H + i * 20 * M, miles: 45 }));
  const k = keyEtas(still);
  assert.ok(k.length <= 6); assert.equal(k[0], still[0]); assert.equal(k[k.length - 1], still[39]);
  assert.deepEqual(keyEtas(still.slice(0, 2)), still.slice(0, 2));
  assert.equal(worthSending({ trip: { powerUnit: '' } }, [{ ours: [1], actual: { ms: 1 } }]).ok, false);
  assert.equal(worthSending({ trip: { powerUnit: '602' } }, [{ ours: [1], actual: null }]).ok, false);
  assert.equal(worthSending({ trip: { powerUnit: '2612' } }, [{ ours: [], actual: { ms: 1 } }]).ok, false);
  assert.equal(worthSending({ trip: { powerUnit: '2612' } }, [{ ours: [1], actual: { ms: 1 } }]).ok, true);
});


test('the ETA log: a parked truck is one line while it sits, a new one when it moves on', () => {
  const t0 = Date.parse('2026-10-24T22:58:00Z'); const since = t0 - 40 * M;
  let log = {};
  for (let i = 0; i < 12; i++) log = foldLog(log, [item], { 625645: { stops: [{ label: 'FALL RIVER, MA, 02720', etaMs: t0 + i * 20 * M + 40 * M, miles: 38, parkedSinceMs: since }] } }, t0 + i * 20 * M);
  assert.equal(log['625645']['FALL RIVER|MA'].ours.length, 1);
  log = foldLog(log, [item], { 625645: { stops: [{ label: 'FALL RIVER, MA, 02720', etaMs: t0 + 5 * H, miles: 30 }] } }, t0 + 5 * H);
  assert.equal(log['625645']['FALL RIVER|MA'].ours.length, 2);
  const m = renderReport(item, reportRows(item, log['625645'], {}), 'delivered');
  assert.match(m.html, /parked since/);
});

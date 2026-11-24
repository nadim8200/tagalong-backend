import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempOff, shouldAlert, tempMessage, offBy, initLtlTempAlert, setPointMismatch } from '../tempalert.js';

const now = Date.parse('2026-11-12T04:00:00Z');
const ltl = (n, readingF, setF, extra = {}) => ({ trip: { tripNumber: n, powerUnit: '2611', trailer: '7136', status: 'DEPCONS', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-09', stops: [] },
  freightBills: [{ billNumber: 'M1', endZoneDescription: 'OXNARD, CA, 93030' }], _loadTemp: { current: { readingF, setF, source: 'ARTIS', at: '2026-11-12T03:40:00Z' }, target: { minF: 33, maxF: 36, text: '33–36°F' } }, ...extra });

test('LTL reefer more than 5°F off the set point → alert; at a receiver, old readings and broker loads don\'t count', () => {
  assert.deepEqual(tempOff([ltl('1', 36.45, 34.99)], { now }), [], '1.5°F off is fine');
  const [x] = tempOff([ltl('2', 41.2, 34.99)], { now });
  assert.equal(x.offF, 6.2);
  assert.equal(tempOff([ltl('3', 28.5, 34)], { now })[0].offF, -5.5, 'too cold counts too');
  assert.equal(tempOff([ltl('4', 45, 35, { trip: { tripNumber: '4', powerUnit: '1', status: 'ARRCONS', origZoneDesc: 'MIAMI TERMINAL' } })], { now }).length, 0, 'unloading');
  assert.equal(tempOff([ltl('5', 45, 35)], { now: now + 6 * 3600000 }).length, 0, 'old reading');
  const broker = { ...ltl('6', 45, 35), trip: { tripNumber: '6', powerUnit: '2', status: 'DEPSHIP', origZoneDesc: 'LAKELAND, FL' }, _tb: undefined, _ratecon: { broker: 'TQL' }, freightBills: [{ billNumber: 'B180922' }] };
  assert.equal(tempOff([broker], { now }).length, 0, 'broker loads never');
  assert.deepEqual(offBy({ current: { readingF: 43 }, target: { minF: 33, maxF: 36, text: '33–36°F' } }).offF, 7, 'no set point → the required range');
  assert.equal(shouldAlert(null, x), true);
  assert.equal(shouldAlert({ offF: 6.2 }, { offF: 7 }), false);
  assert.equal(shouldAlert({ offF: 6.2 }, { offF: 9.5 }), true);
  const m = tempMessage(x);
  assert.match(m.subject, /LTL reefer 6\.2°F above the set point: trip 2 · trailer 7136 — 41\.2°F/);
  assert.match(m.sms, /trip 2 trailer 7136 reads 41\.2F/);
});

// a reading at a time: minutes after 8:00 AM ET Nov 13
const T8 = Date.parse('2026-11-13T13:00:00Z');
const at = (min) => T8 + min * 60000;
const ltlAt = (n, readingF, setF, min, extra = {}) => { const it = ltl(n, readingF, setF, extra); it._loadTemp.current.at = new Date(at(min)).toISOString(); return it; };

test('first text waits until it has been off for 2 hours (by the readings); one text per reading; again after it comes back and goes off again', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const mails = []; const texts = [];
  let clock = at(0);
  const a = initLtlTempAlert({ db, sendMail: async (x) => mails.push(x), emails: async () => ['inbound@floridabeauty.us'], phones: async () => ['+13055040711'], sendSms: async (to, t) => texts.push([to, t]), now: () => clock });
  const run = async (f, min, set = 34.99) => { clock = at(min) + 60000; await a.process('s', { trips: [ltlAt('2', f, set, min)] }); };
  await run(35, 0);
  for (let i = 1; i <= 8; i += 1) await run(41.2, i * 15);                    // 41.2°F from 8:15 to 10:00 (1 h 45 min)
  assert.equal(texts.length, 0, 'not 2 hours yet');
  await run(41.4, 135);                                                     // 10:15 → 2 h off
  assert.equal(texts.length, 1);
  assert.equal(texts[0][1], ['REEFER TEMP ALERT', 'Trailer 7136 | Trip 2', 'Reading: 41.4°F', 'Set point: 35.0°F', 'Above set point: +6.4°F', 'Above set point for: 2 hr', 'Since: Nov 13, 8:15 AM ET', 'Reading taken: Nov 13, 10:15 AM ET', 'Load: M1', 'Jarvis · Florida Beauty Dispatch'].join('\n'));
  await a.process('s', { trips: [ltlAt('2', 41.4, 34.99, 135)] });           // the same reading again (a retry / next cycle)
  await run(41.6, 150);
  assert.equal(texts.length, 1, 'no duplicates');
  await run(44.6, 165);                                                     // 3°F worse, but 30 min after the alert → waits (no back-to-back texts)
  assert.equal(texts.length, 1, 'an update waits an hour after the last text');
  await run(44.6, 195);                                                     // an hour after the alert, still 3°F worse → TEMP UPDATE
  assert.equal(texts.length, 2); assert.match(texts[1][1], /^TEMP UPDATE\n/); assert.match(texts[1][1], /Above set point for: 3 hr/);
  assert.equal(mails.length, 2);
  await run(34.5, 210);                                                     // back at the set point → one BACK IN RANGE text, forgotten
  assert.equal(texts.length, 3);
  assert.equal(texts[2][1], ['TEMP BACK IN RANGE', 'Trailer 7136 | Trip 2', 'Reading: 34.5°F', 'Set point: 35.0°F', 'Was: 44.6°F at Nov 13, 11:15 AM ET', 'Reading taken: Nov 13, 11:30 AM ET', 'Load: M1', 'Jarvis · Florida Beauty Dispatch'].join('\n'));
  await run(34.5, 210);
  assert.equal(texts.length, 3, 'said once');
  await run(41.2, 225);
  assert.equal(texts.length, 3, 'off again: waits 2 hours again');
});

test('duration: swings above the set point keep the clock; at/below it resets; gaps and set-point changes are not assumed continuous', async () => {
  const { track, sideMin, badMin } = await import('../tempalert.js');
  let t = null;
  const step = (f, min, setF = 36, bad = false) => { t = track(t, { f, setF, at: at(min) }, { bad }); return t; };
  step(36, 0); step(41.1, 10); step(38, 40); step(43, 70); step(39, 95);   // swings, all above 36
  assert.equal(sideMin(t), 85); assert.equal(t.above.atLeast, false); assert.equal(t.above.since, at(10));
  step(36, 110);                                                            // back at the set point
  assert.equal(t.above, null);
  step(40, 120); assert.equal(sideMin(t), null, 'one reading: duration unavailable');
  step(41, 135); assert.equal(sideMin(t), 15);
  step(41, 240);                                                            // 105-min telemetry gap → starts over, "at least"
  assert.equal(t.above.since, at(240)); assert.equal(t.above.atLeast, true); assert.equal(sideMin(t), null);
  step(41, 255); assert.equal(sideMin(t), 15);
  step(41, 270, 34);                                                        // set point changed 36 → 34: timed from then
  assert.equal(t.setChangedAt, at(270)); assert.equal(t.above.since, at(270)); assert.equal(t.above.atLeast, true);
  assert.equal(track(t, { f: 41, setF: 34, at: at(270) }), t, 'same reading twice changes nothing');
  assert.equal(track(t, { f: null, setF: 34, at: at(280) }), t, 'no reading → nothing invented');
  let b = null; [[0, true], [30, true], [60, false], [75, true], [200, true]].forEach(([mn, bad]) => { b = track(b, { f: 42, setF: 36, at: at(mn) }, { bad }); });
  assert.equal(badMin(b), 0, 'a gap restarts the 2-hour wait');
  // first sight is already above: no confirmed start → "At least … or earlier"
  let c = null; c = track(c, { f: 41.1, setF: 36, at: at(0) }); c = track(c, { f: 41.1, setF: 36, at: at(85) - 40 * 60000 }); c = track(c, { f: 41.1, setF: 36, at: at(85) });
  const { tempSms } = await import('../tempalert.js');
  const x = { trip: '627081', trailer: '262041', readingF: 41.1, setF: 36, offF: 5.1, vs: 'set point', at: at(85) };
  assert.match(tempSms(x, c), /Above set point for: At least 1 hr 25 min\nSince: Nov 13, 8:00 AM ET or earlier/);
  assert.match(tempSms({ ...x, setF: null, vs: 'required', offF: 6.1, refText: 'required 33–35°F per the trip sheet' }, null), /Set point: not reported\nLoad needs: 33–35°F per the trip sheet\nAbove required: \+6\.1°F\nAbove set point for: Duration unavailable/);
  assert.match(tempSms({ ...x, readingF: 28.4, offF: -7.6 }, null), /Below set point: -7\.6°F\nBelow set point for: Duration unavailable/);
  assert.match(tempSms({ ...x, trailer: null }, null), /^REEFER TEMP ALERT\nTrailer not on file \| Trip 627081/);
});

test('the reading is checked against the required temp too; ARTIS set point not what the load needs → its own alert, once per value', () => {
  // set point 40 (wrong), reading 41: 1°F off the set point but 5°F+ over the 33–36°F the load needs
  const it = ltl('7', 41.5, 40, { _artisTemp: { setPointF: 40 } });
  const out = tempOff([it], { now });
  const r = out.find((x) => x.kind === 'reading'); const sp = out.find((x) => x.kind === 'setpoint');
  assert.equal(r.vs, 'required'); assert.equal(r.offF, 5.5);
  assert.equal(sp.setF, 40); assert.equal(sp.setFrom, 'ARTIS');
  assert.match(tempMessage(sp).subject, /LTL set point doesn't match: trip 7 · trailer 7136 — set 40°F, required 33–36°F/);
  assert.match(tempMessage(sp).sms, /is set to 40F but the load needs 33–36°F/);
  assert.equal(shouldAlert({ setF: 40 }, sp), false);
  assert.equal(shouldAlert({ setF: 38 }, sp), true);
  assert.equal(setPointMismatch(ltl('8', 35, 34.99, { _artisTemp: { setPointF: 34.99 } })), null);
  assert.equal(setPointMismatch(ltl('9', 35, 36.8)), null, 'within 1°F of the range');
  // at a receiver the set point still counts, the reading doesn't
  const at = { ...it, trip: { ...it.trip, status: 'ARRCONS' } };
  assert.deepEqual(tempOff([at], { now }).map((x) => x.kind), ['setpoint']);
});

test('is the flower load on the trailer? next load on the same trailer, delivered (TruckMate or GPS), not loaded yet, loading, rolling', async () => {
  const { loadPhase, isFlowerTemp } = await import('../tempalert.js');
  const it = (n, status, trailer = '262042', extra = {}) => ({ trip: { tripNumber: n, status, trailer }, freightBills: [{ billNumber: 'M1' }], ...extra });
  const old = it('627079', 'DEPCONS'); const nxt = it('627315', 'LOADINGMAN');
  assert.deepEqual(loadPhase(old, { trips: [old, nxt] }), { phase: 'next-load', by: '627315' }, '262042 loading for 627315 → 627079 is done');
  assert.equal(loadPhase(old, { trips: [old, it('627315', 'ASSGN')] }).phase, 'on', 'a newer trip only assigned doesn\'t count');
  assert.equal(loadPhase(old, { trips: [old, it('627001', 'DEPSHIP')] }).phase, 'on', 'an older trip doesn\'t count');
  // Nov 18: 627335 (DEPSHIP, rolling to Santa Ana) was finished because trailer 7357 showed on 627349 — a load still
  // loading or rolling is never "next load"; only at or past a receiver
  for (const st of ['LOADEDTOGO', 'DISP', 'DEPSHIP', 'INTRAN']) assert.equal(loadPhase(it('627335', st, '7357'), { trips: [it('627335', st, '7357'), it('627349', 'DEPSHIP', '7357')] }).phase, st === 'INTRAN' || st === 'DEPSHIP' ? 'on' : 'loading', `${st}: still on`);
  assert.equal(loadPhase(it('627243', 'ARRCONS'), { trips: [it('627243', 'ARRCONS'), it('627388', 'ARRSHIP')] }).phase, 'next-load', 'at the receiver + trailer at the next shipper → done');
  assert.equal(loadPhase(it('1', 'DEPSHIP', 'X', { freightBills: [{ actualDelivery: '2026-11-16T10:00:00' }, { actualDelivery: '2026-11-16T12:00:00' }] })).phase, 'delivered');
  assert.equal(loadPhase(it('1', 'DEPSHIP', 'X', { freightBills: [{ actualDelivery: '2026-11-16T10:00:00' }, {}] })).phase, 'on', 'one bill still to deliver');
  const sheet = { _manifest: { stops: [{ key: 'L', action: 'LOAD' }, { key: 'a', action: 'DELIVER' }, { key: 'b', action: 'DELIVER' }] } };
  assert.deepEqual(loadPhase(it('627178', 'DEPSHIP', 'X', sheet), { visits: { 627178: { a: { state: 'completed' }, b: { state: 'completed' } } } }), { phase: 'delivered', by: 'GPS' });
  assert.equal(loadPhase(it('627178', 'DEPSHIP', 'X', sheet), { visits: { 627178: { a: { state: 'completed' } } } }).phase, 'on', 'a stop not visited (or no geofence) keeps it on');
  assert.equal(loadPhase(it('1', 'ASSGN')).phase, 'empty');
  assert.equal(loadPhase(it('1', 'LOADEDTOGO')).phase, 'loading');
  assert.equal(loadPhase(it('1', 'INTRAN')).phase, 'on');
  assert.equal(isFlowerTemp({ target: { minF: 35, maxF: 35 } }), true);
  assert.equal(isFlowerTemp({ target: { minF: 33, maxF: 36 } }), true);
  assert.equal(isFlowerTemp({ target: { minF: 25, maxF: 25 } }), false, 'a 25°F load isn\'t flowers');
  assert.equal(isFlowerTemp({ current: { setF: 35 } }), true);
});

test('yesterday\'s texts that should not have gone out — and the ones that must: freeze, 10°F warm, a jump while loaded', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const texts = []; let clock = at(0);
  const a = initLtlTempAlert({ db, emails: async () => [], phones: async () => ['+13055040711'], sendSms: async (to, t) => texts.push(t), now: () => clock });
  const load = (n, f, setF, min, status = 'DEPSHIP', trailer = '7136', extra = {}) => { const it = ltlAt(n, f, setF, min, { trip: { tripNumber: n, powerUnit: '2611', trailer, status, origZoneDesc: 'MIAMI TERMINAL' }, ...extra }); it._loadTemp.target = { minF: 35, maxF: 35, text: '35°F', from: 'trip sheet' }; return it; };
  const run = async (min, trips) => { clock = at(min) + 60000; await a.process('s', { trips }); };
  // 627079 finished, its trailer 262042 loading for 627315 at 41–45°F: nothing for either
  for (let i = 0; i <= 12; i += 1) await run(i * 15, [load('627079', 41 + i / 4, 35, i * 15, 'DEPCONS', '262042'), load('627315', 41 + i / 4, 35, i * 15, 'LOADINGMAN', '262042')]);
  assert.equal(texts.length, 0, 'finished load and a load being loaded: no texts');
  // 627080: next load on 7282 is a broker load at -11°F → the LTL trip stops (no set point / reading texts)
  m.clear();
  const kllm = { trip: { tripNumber: '627246', trailer: '7282', status: 'DEPSHIP' }, _ratecon: { broker: 'KLLM' }, freightBills: [{ billNumber: 'B181004' }] };
  for (let i = 0; i <= 12; i += 1) await run(i * 15, [load('627080', 13.7 + i, -11, i * 15, 'DEPCONS', '7282'), kllm]);
  assert.equal(texts.length, 0, 'trailer on a newer trip: the old flower trip is over');
  // freeze: flowers at 33°F → FREEZE RISK after two readings in a row (no 2-hour wait), even at a receiver
  m.clear(); texts.length = 0;
  await run(0, [load('5', 35, 35, 0)]);
  await run(15, [load('5', 33, 35, 15)]);
  assert.equal(texts.length, 0, 'one reading: could be a blip');
  await run(30, [load('5', 32.6, 35, 30, 'ARRCONS')]);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^FREEZE RISK - FLOWERS\nTrailer 7136 \| Trip 5\nReading: 32\.6°F\nSet point: 35\.0°F/);
  assert.match(texts[0], /At or below 33°F: 2 readings in a row since Nov 13, 8:15 AM ET/);
  await run(45, [load('5', 35, 35, 45)]);
  assert.match(texts[1], /^TEMP BACK IN RANGE\n/);
  // set to 30°F with flowers on board → FREEZE RISK set point text right away
  m.clear(); texts.length = 0;
  await run(0, [load('6', 35, 30, 0)]);
  assert.match(texts[0], /^FREEZE RISK — flowers\. LTL set point alert: trip 6/);
  // 10°F+ warm while rolling → after 30 minutes, not 2 hours; while loading the doors-open allowance applies
  m.clear(); texts.length = 0;
  await run(0, [load('7', 36, 35, 0)]); await run(15, [load('7', 46, 35, 15)]); await run(30, [load('7', 46.5, 35, 30)]);
  assert.equal(texts.length, 0, '15 minutes');
  await run(45, [load('7', 47, 35, 45)]);
  assert.equal(texts.length, 1); assert.match(texts[0], /^REEFER TEMP ALERT\n[\s\S]*Above set point: \+12\.0°F/);
  m.clear(); texts.length = 0;
  for (let i = 0; i <= 12; i += 1) await run(i * 15, [load('8', 47, 35, i * 15, 'LOADEDTOGO')]);
  assert.equal(texts.length, 0, 'loading 3 hours: doors open');
  for (let i = 13; i <= 16; i += 1) await run(i * 15, [load('8', 47, 35, i * 15, 'LOADEDTOGO')]);
  assert.equal(texts.length, 1, 'still warm after 3 hours loading → counts (10°F+ → 30 min)');
});

test('627178 (Nov 17): delivered in Boston (stop left), set to -10°F for the next load, TruckMate not updated → no FREEZE text; a freeze after an older alert still needs 2 readings', async () => {
  const { loadPhase } = await import('../tempalert.js');
  const it = { trip: { tripNumber: '627178', status: 'DEPSHIP', trailer: '262045' }, freightBills: [{ billNumber: 'M5063124', endZoneDescription: 'HYDE PARK, MA, 02136' }],
    _loadTemp: { current: { readingF: -8.8, setF: -10 }, target: { minF: 35, maxF: 35 } } };
  const ms = { 627178: { waits: { 'HYDE PARK, MA, 02136': { arrivedAt: '2026-11-16T07:09:55Z', leftAt: '2026-11-16T13:54:55Z' } } } };
  assert.deepEqual(loadPhase(it, { milestones: ms }), { phase: 'delivered', by: 'stops left + set for the next load' });
  assert.equal(loadPhase({ ...it, _loadTemp: { current: { readingF: 36, setF: 35 }, target: { minF: 35, maxF: 35 } } }, { milestones: ms }).phase, 'on', 'stop left but still set for flowers → keep watching');
  assert.equal(loadPhase(it, { milestones: { 627178: { waits: {} } } }).phase, 'on', 'never left the stop → keep watching (and the set point alerts)');
  const two = { ...it, freightBills: [...it.freightBills, { billNumber: 'M2', endZoneDescription: 'BOSTON, MA, 02118' }] };
  assert.equal(loadPhase(two, { milestones: ms }).phase, 'on', 'one delivery stop not left yet → keep watching');
  // an earlier warm alert on the trip doesn't skip the 2-reading freeze check
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const texts = []; let clock = at(0);
  const a = initLtlTempAlert({ db, emails: async () => [], phones: async () => ['+1'], sendSms: async (to, t) => texts.push(t), now: () => clock });
  const load = (f, min) => { const x = ltlAt('9', f, 35, min); x._loadTemp.target = { minF: 35, maxF: 35, text: '35°F' }; return x; };
  m.set('taLtlTempAlert:s', { 9: { kind: 'reading', offF: 6, setF: 35, readingF: 41 } });
  clock = at(0) + 60000; await a.process('s', { trips: [load(32, 0)] });
  assert.equal(texts.length, 0, 'one freezing reading: wait for the next');
  clock = at(15) + 60000; await a.process('s', { trips: [load(31.5, 15)] });
  assert.equal(texts.length, 1); assert.match(texts[0], /^FREEZE RISK - FLOWERS[\s\S]*2 readings in a row/);
});

test('a set point alert is said once per trailer, trip and value — even if the trip flips to delivered and back, or the state is lost', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const texts = []; let clock = at(0);
  const a = initLtlTempAlert({ db, emails: async () => [], phones: async () => ['+1'], sendSms: async (to, t) => texts.push(t), now: () => clock });
  const load = (extra = {}) => { const x = ltlAt('627190', 36, -10, 0, { trip: { tripNumber: '627190', trailer: '7351', status: 'DEPCONS' }, ...extra }); x._loadTemp.target = { minF: 35, maxF: 35, text: '35°F' }; return x; };
  clock = at(1); await a.process('s', { trips: [load()] });
  assert.equal(texts.length, 1);
  clock = at(2); await a.process('s', { trips: [load({ freightBills: [{ billNumber: 'P1', actualDelivery: '2026-11-17' }] })] });   // delivered
  clock = at(3); await a.process('s', { trips: [load()] });                                                                      // flips back
  assert.equal(texts.length, 1, 'remembered while on the board');
  m.delete('taLtlTempAlert:s');                                                                                                  // state lost (an overlapping deploy)
  clock = at(4); await a.process('s', { trips: [load()] });
  assert.equal(texts.length, 1, 'the sent log still stops it');
});

test('the board gets each LTL load\'s flowers-on-board phase (the card stops warning once they are delivered)', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const a = initLtlTempAlert({ db, now: () => at(0) });
  m.set('taLtlTempPhase:s', { 627178: { phase: 'delivered', by: 'stops left + set for the next load', since: 1 } });
  const trips = [{ trip: { tripNumber: '627178' } }, { trip: { tripNumber: '1' } }];
  await a.overlay('s', trips);
  assert.deepEqual(trips[0]._flowerPhase, { phase: 'delivered', by: 'stops left + set for the next load', since: 1 });
  assert.equal(trips[1]._flowerPhase, undefined);
});

test('the texts carry the load number and a Google Maps link to the unit (Nov 24)', async () => {
  const { tempSms, loadNo, mapsLink } = await import('../tempalert.js');
  assert.equal(loadNo(['M1', 'B181103', 'M2']), 'B181103');
  assert.equal(loadNo(['M5067186', 'G5067296', 'M2']), 'M5067186 +2 more');
  assert.equal(loadNo(['M1']), 'M1');
  assert.equal(loadNo([]), null);
  assert.equal(mapsLink(25.81234567, -80.3), 'https://maps.google.com/?q=25.81235,-80.30000');
  assert.equal(mapsLink(null, -80), null);
  const t = tempSms({ trip: '627831', trailer: '7315', readingF: 17, setF: -10, offF: 27, vs: 'set point', at: Date.parse('2026-11-24T19:42:00Z'), load: 'M5067500 +12 more', where: '88 Hicks Ave, Medford, MA', map: 'https://maps.google.com/?q=42.40228,-71.10221' }, null);
  assert.match(t, /\nLoad: M5067500 \+12 more\nLocation: 88 Hicks Ave, Medford, MA\nMap: https:\/\/maps\.google\.com\/\?q=42\.40228,-71\.10221\nJarvis/);
  const sp = tempMessage({ kind: 'setpoint', trip: '627754', trailer: '262074', setF: 36, offF: 2, refText: 'required 34°F', load: 'B181094', map: 'https://maps.google.com/?q=1.00000,2.00000' }).sms;
  assert.equal(sp, 'LTL set point alert: trip 627754 trailer 262074 is set to 36F but the load needs 34°F.\nLoad: B181094\nMap: https://maps.google.com/?q=1.00000,2.00000');
});

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
  assert.equal(texts[0][1], ['REEFER TEMP ALERT', 'Trailer 7136 | Trip 2', 'Reading: 41.4°F', 'Set point: 35.0°F', 'Above set point: +6.4°F', 'Above set point for: 2 hr', 'Since: Nov 13, 8:15 AM ET', 'Reading taken: Nov 13, 10:15 AM ET', 'Jarvis · Florida Beauty Dispatch'].join('\n'));
  await a.process('s', { trips: [ltlAt('2', 41.4, 34.99, 135)] });           // the same reading again (a retry / next cycle)
  await run(41.6, 150);
  assert.equal(texts.length, 1, 'no duplicates');
  await run(44.6, 165);                                                     // 3°F worse → TEMP UPDATE
  assert.equal(texts.length, 2); assert.match(texts[1][1], /^TEMP UPDATE\n/); assert.match(texts[1][1], /Above set point for: 2 hr 30 min/);
  assert.equal(mails.length, 2);
  await run(34.5, 180);                                                     // back at the set point → forgotten
  await run(41.2, 195);
  assert.equal(texts.length, 2, 'off again: waits 2 hours again');
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

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

test('one email + texts to Nadim and Ronen, once; again after it comes back and goes off again', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v) };
  const mails = []; const texts = [];
  const a = initLtlTempAlert({ db, sendMail: async (x) => mails.push(x), emails: async () => ['inbound@floridabeauty.us'], phones: async () => ['+13055040711', '+13052063095'], sendSms: async (to, t) => texts.push([to, t]), now: () => now });
  await a.process('s', { trips: [ltl('2', 41.2, 34.99)] });
  await a.process('s', { trips: [ltl('2', 41.5, 34.99)] });
  assert.equal(mails.length, 1); assert.equal(texts.length, 2);
  await a.process('s', { trips: [ltl('2', 35, 34.99)] });
  await a.process('s', { trips: [ltl('2', 41.2, 34.99)] });
  assert.equal(mails.length, 2);
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

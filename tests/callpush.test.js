import test from 'node:test';
import assert from 'node:assert/strict';
import { callAskOf, callAsks, dueCallPushes, callPushFor, initCallPush } from '../callpush.js';

const mem = () => { const s = {}; return { s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };
const NOW = Date.parse('2026-11-21T18:00:00Z');

test('reading "call before" in the customer notes, Spanish or English, with how long before and the phone (Nov 21)', () => {
  assert.deepEqual(callAskOf('Puerta 4 a 9. Llamar al recibidor 30 min antes. No se aceptan entregas después de las 2 PM.'), { lead: 30, phone: null, said: 'Llamar al recibidor 30 min antes' });
  assert.equal(callAskOf('CALL 1 HOUR PRIOR TO ARRIVAL 413-555-0100 ASK FOR BRENDA').lead, 60);
  assert.equal(callAskOf('CALL 1 HOUR PRIOR TO ARRIVAL 413-555-0100 ASK FOR BRENDA').phone, '413-555-0100');
  assert.equal(callAskOf('Please call half hour before delivery').lead, 30);
  assert.equal(callAskOf('Must call ahead').lead, 60);
  assert.equal(callAskOf('Llamar con 2 horas de anticipación').lead, 120);
  assert.equal(callAskOf('Dock 3. Receiving 6 AM to 2 PM. No appointment needed.'), null);
  assert.equal(callAskOf('Call the office if there is a problem'), null, 'calling about problems is not a call-ahead');
});

const item = (notes, callAhead = []) => ({ trip: { tripNumber: '700', status: 'INTRAN', driver: 'A1', driver2: 'B2' },
  freightBills: [{ billNumber: 'B1', endZoneDescription: 'CLIFTON, NJ', billToName: 'MAIN WHOLESALE', pieces: 90 }, { billNumber: 'B2', endZoneDescription: 'LUDLOW, MA', billToName: 'COSTCO', pieces: 32 }],
  _customerNotes: notes, _callAhead: callAhead });

test('when the push goes: about 30 minutes before they need to call (our ETA), once, never after they arrive', () => {
  const stops = [{ key: 'CLIFTON, NJ', place: 'CLIFTON, NJ', name: 'MAIN WHOLESALE' }, { key: 'LUDLOW, MA', place: 'LUDLOW, MA', name: 'COSTCO' }];
  const asks = { 'LUDLOW, MA': { lead: 30, phone: null, method: 'call', source: 'customer notes' } };
  const eta = (min) => ({ 'P:LUDLOW, MA': { ours: [{ etaMs: NOW + min * 60000 }] } });
  assert.deepEqual(dueCallPushes('700', stops, asks, { etas: eta(120), now: NOW }), [], '2 h out: too early');
  assert.equal(dueCallPushes('700', stops, asks, { etas: eta(55), now: NOW }).length, 1, '55 min out, asked for 30 min: time to remind');
  assert.deepEqual(dueCallPushes('700', stops, asks, { etas: eta(55), now: NOW, sent: { '700|LUDLOW, MA': {} } }), [], 'once');
  assert.deepEqual(dueCallPushes('700', stops, asks, { etas: eta(55), now: NOW, steps: { 'arrived:LUDLOW, MA': {} } }), [], 'already there');
  const first = { 'CLIFTON, NJ': { lead: 60, method: 'call' } };
  assert.deepEqual(dueCallPushes('700', stops, first, { now: NOW }), [], 'no ETA and nothing delivered yet: not hours early');
  assert.equal(dueCallPushes('700', stops, { 'LUDLOW, MA': { lead: 60, method: 'call' } }, { steps: { 'delivered:CLIFTON, NJ': {} }, now: NOW }).length, 1, 'no ETA: once the stop before is delivered');
  const m = callPushFor({ stop: stops[1], ask: { lead: 30, phone: '413-555-0100', contact: 'BRENDA', method: 'call' }, etaMs: NOW + 55 * 60000 });
  assert.match(m.title, /^📞 Llame antes de llegar · COSTCO · LUDLOW, MA/);
  assert.match(m.body, /llame 30 min antes a BRENDA 413-555-0100/); assert.match(m.body, /Customer asks you to call 30 min before you arrive/);
});

test('the sweep: both drivers get it once, even in training mode; notes from the customer profile count', async () => {
  const db = mem();
  db.s['taEtaLog:florida-beauty'] = { 700: { 'P:LUDLOW, MA': { ours: [{ etaMs: NOW + 50 * 60000 }] } } };
  const it = item([{ name: 'COSTCO', roles: ['consignee'], notes: 'Call 30 min before arrival.' }]);
  const pushes = [];
  const w = initCallPush({ db, board: async () => [it], notify: async (c, m) => { pushes.push([c, m.title]); }, now: () => NOW, env: { NODE_ENV: 'test' } });
  assert.deepEqual(await w.sweep(), { pushed: 1 });
  assert.deepEqual(pushes.map((p) => p[0]), ['A1', 'B2']);
  assert.match(pushes[0][1], /COSTCO · LUDLOW, MA/);
  assert.deepEqual(await w.sweep(), { pushed: 0 }, 'not again');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { dueCallAheads, etaForStop, initCallAhead } from '../callahead.js';

const NOW = Date.parse('2026-11-03T20:00:00Z');
const item = { trip: { tripNumber: '625390' }, freightBills: [{ billNumber: 'M5047954' }], _manifest: { stops: [
  { stopNumber: 8, key: 's8', action: 'DELIVER', customer: 'FMC FLORAL WHOLESALE', city: 'CHICAGO', state: 'IL', pieces: 277 },
  { stopNumber: 9, key: 's9', action: 'DELIVER', customer: 'AMLINGS', city: 'ARLINGTON HEIGHTS', state: 'IL', zip: '60004', pieces: 25, callAhead: [{ contact: 'Brenda', phone: '555-010-0527', leadMinutes: 30, method: 'call' }] },
  { stopNumber: 10, key: 's10', action: 'DELIVER', customer: 'TEXT ONLY FLORIST', city: 'MUNDELEIN', state: 'IL', pieces: 70, callAhead: [{ contact: 'Ana', phone: '555-010-0100', leadMinutes: 60, method: 'text' }] },
] } };
const etas = (miles9, mins9, miles10 = 200, mins10 = 300) => ({ stops: [{ label: 'ARLINGTON HEIGHTS, IL, 60004', zip: '60004', miles: miles9, etaMs: NOW + mins9 * 60000 }, { label: 'MUNDELEIN, IL, 60060', zip: '60060', miles: miles10, etaMs: NOW + mins10 * 60000 }] });

test('the ETA for a trip sheet stop: by zip, else city and state', () => {
  assert.equal(etaForStop({ zip: '60004' }, etas(40, 50)).miles, 40);
  assert.equal(etaForStop({ city: 'Mundelein', state: 'IL' }, etas(40, 50)).miles, 200);
  assert.equal(etaForStop({ city: 'NOWHERE' }, etas(40, 50)), null);
});

test('the driver is reminded at 50 miles or once the stop before is done; Jarvis calls only under an hour (and under what they asked), never for a text instruction', () => {
  assert.deepEqual(dueCallAheads(item, { etas: etas(120, 140), now: NOW }), [], 'far away, previous stop open: nothing');
  assert.deepEqual(dueCallAheads(item, { etas: etas(48, 70), now: NOW }).map((d) => [d.kind, d.stop.key, d.why]), [['remind', 's9', '48 miles out']], '50 miles: remind; 70 min away: no call yet');
  assert.deepEqual(dueCallAheads(item, { etas: etas(120, 140), done: { s8: true }, now: NOW }).map((d) => [d.kind, d.stop.key, d.why]), [['remind', 's9', 'previous stop done']]);
  assert.deepEqual(dueCallAheads(item, { etas: etas(30, 45), sent: { '625390|s9|remind': {} }, now: NOW }), [], '45 min but she asked for 30');
  const due = dueCallAheads(item, { etas: etas(20, 28), sent: { '625390|s9|remind': {} }, now: NOW });
  assert.deepEqual(due.map((d) => [d.kind, d.stop.key, d.minsAway]), [['call', 's9', 28]]);
  // stop 10 asked for a text: the driver is reminded, Jarvis never calls
  const ten = dueCallAheads(item, { etas: etas(500, 500, 10, 15), done: { s8: true, s9: true }, now: NOW });
  assert.deepEqual(ten.map((d) => [d.kind, d.stop.key]), [['remind', 's10']]);
  assert.deepEqual(dueCallAheads(item, { etas: etas(20, 28), done: { s9: true }, now: NOW }).filter((d) => d.stop.key === 's9'), [], 'done stops are left alone');
  assert.deepEqual(dueCallAheads({ ...item, _ratecon: { data: {} }, freightBills: [{ billNumber: 'B1' }] }, { etas: etas(20, 28), now: NOW }), [], 'broker loads: not this flow');
});

test('each reminder and call happens once, and is noted on the load', async () => {
  const s = {}; const db = { enabled: true, get: async (k, d) => (k in s ? s[k] : d), update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } };
  const texts = []; const calls = []; const notes = [];
  let e = etas(45, 80);
  const ca = initCallAhead({ db, stopDone: async () => ({}), etasFor: async () => e, messageDriver: async (site, trip, text) => { texts.push(text); return { sent: true, via: 'app (push)' }; }, callCustomer: async (trip, o) => { calls.push(o); return { ok: true }; }, log: async (st, t, n) => notes.push(n.text), now: () => NOW });
  await ca.process('fb', { trips: [item] });
  assert.equal(texts.length, 1); assert.match(texts[0], /stop 9 AMLINGS \(ARLINGTON HEIGHTS\): the customer asked you to call Brenda 555-010-0527 30 minutes before you arrive/);
  await ca.process('fb', { trips: [item] });
  assert.equal(texts.length, 1, 'once');
  e = etas(15, 25);
  await ca.process('fb', { trips: [item] });
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], eta: undefined }, { phone: '555-010-0527', contact: 'Brenda', customer: 'AMLINGS', eta: undefined, boxes: 25 });
  assert.match(calls[0].eta, /Eastern$/);
  await ca.process('fb', { trips: [item] });
  assert.equal(calls.length, 1, 'once');
  assert.ok(notes.some((n) => /Jarvis called Brenda at AMLINGS/.test(n)));
});

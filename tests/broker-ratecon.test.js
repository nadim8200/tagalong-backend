import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerLoad, evaluateBoard } from '../watchtower.js';
import { brokerDue, initSynergize } from '../synergize.js';

const BROKER = { trip: { tripNumber: '625658', status: 'INTRAN', powerUnit: '2601' }, freightBills: [{ billNumber: 'B180626', billToName: 'ARRIVE LOGISTICS LLC' }] };

test('a broker load is B bills off the Truck Builder (or has a rate con); LTL runs are not', () => {
  assert.equal(brokerLoad(BROKER), true);
  assert.equal(brokerLoad({ ...BROKER, _tb: { hub: 'Miami' } }), false, 'on an ARTIS run');
  assert.equal(brokerLoad({ trip: {}, freightBills: [{ billNumber: 'G5048575' }, { billNumber: 'M5048614' }] }), false);
  assert.equal(brokerLoad({ trip: {}, freightBills: [{ billNumber: 'M1' }], _ratecon: { broker: 'X' } }), true);
});

test('no rate con on a broker load → ask dispatch; gone once it is on file or delivered', () => {
  const ctx = { now: Date.parse('2026-10-23T15:00:00Z') };
  const rc = (b) => evaluateBoard({ trips: [b] }, ctx).filter((a) => a.code === 'ratecon-missing');
  assert.equal(rc(BROKER).length, 1);
  assert.match(rc(BROKER)[0].title, /B180626/);
  assert.equal(rc({ ...BROKER, _ratecon: { broker: 'Arrive' } }).length, 0);
  assert.equal(rc({ ...BROKER, trip: { ...BROKER.trip, status: 'DELVD' } }).length, 0);
  assert.equal(rc({ ...BROKER, _tb: { hub: 'Miami' } }).length, 0, 'never on an LTL run');
});

test('broker loads are checked in Synergize right away, then every 2 h, 6 AM–10 PM', () => {
  const at = Date.parse('2026-10-23T15:00:00Z');   // 11 AM ET
  assert.equal(brokerDue([BROKER], {}, at).length, 1);
  assert.equal(brokerDue([BROKER], { 625658: at - 30 * 60000 }, at).length, 0);
  assert.equal(brokerDue([BROKER], { 625658: at - 2 * 3600000 }, at).length, 1);
  assert.equal(brokerDue([BROKER], {}, Date.parse('2026-10-24T04:00:00Z')).length, 0, 'midnight ET');
});

test('a rate con found in Synergize goes to the rate con reader', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const artisWeb = { ready: () => true, fetchText: async () => `<script>\n var documents = ${JSON.stringify([{ In_DocId: 'Syn9', In_DocName: 'RC.pdf', In_DocTypeName: 'Rate Confirmation', Bill_Number: 'B180626' }])}\n</script>`, fetchBuffer: async () => ({ buf: Buffer.from('%PDF-1.4 x'), type: 'application/pdf' }) };
  const docs = { storeDocs: async () => [{ id: 7 }] };
  const got = [];
  const s = initSynergize({ post: () => {} }, { requireAuth: (q, r, n) => n(), db, docs, artisWeb, onRateCon: async (trip, f) => { got.push([trip, f.filename]); } });
  await s.forTrip({ item: BROKER });
  assert.deepEqual(got, [['625658', 'RateCon-B180626-Syn9.pdf']]);
});

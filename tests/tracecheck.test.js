import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCheck } from '../tracecheck.js';

const bill = (trace) => ({ billNumber: 'B180921', traceNumbers: trace.map(([n, type, d]) => ({ traceNumber: n, traceType: type, description: d })) });
const B180921 = bill([['311415245', 'C', 'Pickup#'], ['998924121', 'C', 'Pickup#'], ['24552348', 'P', 'Purchase Order']]);

test('trace numbers vs the rate con: PO = load #, pickup #s on it, and rate con pickup #s missing in TruckMate', () => {
  const ok = traceCheck({ freightBills: [B180921], _ratecon: { loadNumber: '24552348', pickups: [{ refs: 'PU# 311415245, 998924121' }] } });
  assert.equal(ok.ok, true); assert.equal(ok.poMatch, true); assert.deepEqual(ok.pickups, ['311415245', '998924121']);
  const typo = traceCheck({ freightBills: [bill([['31141524', 'C', 'Pickup#'], ['24552348', 'P', 'Purchase Order']])], _ratecon: { loadNumber: '24552348', pickups: [{ refs: 'PU 311415245' }] } });
  assert.deepEqual(typo.problems, ["Pickup# 31141524 isn't on the rate con", 'Rate con pickup # 311415245 not in TruckMate']);
  const wrongPo = traceCheck({ freightBills: [B180921], _ratecon: { loadNumber: '99999999', pickups: [{ refs: '311415245 998924121' }] } });
  assert.match(wrongPo.problems[0], /PO 24552348 isn't the rate con's load # 99999999/);
  assert.deepEqual(traceCheck({ freightBills: [B180921] }), { pos: ['24552348'], pickups: ['311415245', '998924121'], rateCon: false });
  assert.equal(traceCheck({ freightBills: [{ billNumber: 'X' }] }), null);
});

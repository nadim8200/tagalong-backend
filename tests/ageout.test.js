import test from 'node:test';
import assert from 'node:assert/strict';
import { ageOutReason } from '../truckmate.js';

const H = 3600000; const NOW = Date.parse('2026-11-22T14:00:00Z');
const rec = (trip, unit, status, quietH) => ({ item: { trip: { tripNumber: trip, powerUnit: unit, status } }, updatedAt: NOW - quietH * H });

test('a quiet trip stays on the board until it is really over (trip 627656: rolling, untouched in TruckMate 39 h) (Nov 22)', () => {
  const ferney = rec('627656', '4504', 'DISP', 39);
  assert.equal(ageOutReason(ferney, { a: ferney }, NOW), null, 'still running: keep it');
  assert.equal(ageOutReason(rec('627656', '4504', 'DISP', 10), {}, NOW), null, 'recent: keep');
  const old = rec('627549', '4504', 'DEPCONS', 40);
  assert.equal(ageOutReason(old, { a: old, b: ferney }, NOW), 'truck 4504 is on trip 627656 now', 'the truck moved to a newer trip');
  assert.equal(ageOutReason(ferney, { a: old, b: ferney }, NOW), null, 'the newer one stays');
  assert.match(ageOutReason(rec('627000', '2210', 'DELVD', 37), {}, NOW), /^status DELVD/);
  assert.equal(ageOutReason(rec('627001', '', 'ASSGN', 37), {}, NOW), 'no truck and no TruckMate update for 36h', 'an old booking with no truck still goes');
  assert.equal(ageOutReason(rec('627002', '2216', 'DEPSHIP', 24 * 8), {}, NOW), 'no TruckMate update for 7 days', 'the safety net');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ageOutReason, quietTripEvidence } from '../truckmate.js';

const H = 3600000; const NOW = Date.parse('2026-11-22T14:00:00Z');
const rec = (trip, unit, status, quietH) => ({ item: { trip: { tripNumber: trip, powerUnit: unit, status } }, updatedAt: NOW - quietH * H });

test('a quiet trip stays on the board until it is really over (trip 627656: rolling, untouched in TruckMate 39 h) (Nov 22)', () => {
  const ferney = rec('627656', '4504', 'DISP', 39);
  const rolling = { known: true, movedAt: NOW, atHub: null, stoppedSinceMs: null };
  assert.equal(ageOutReason(ferney, { a: ferney }, NOW, rolling), null, 'the truck is rolling: keep it');
  assert.match(ageOutReason(ferney, { a: ferney }, NOW, { known: true, movedAt: NOW - 30 * H }), /hasn't moved in 24 h/, 'parked a day and a half: it goes like before');
  assert.equal(ageOutReason(ferney, { a: ferney }, NOW, { known: true, movedAt: NOW - 2 * H, atHub: 'Miami', stoppedSinceMs: NOW - 7 * H }), 'truck parked at the Miami yard');
  assert.equal(ageOutReason(ferney, { a: ferney }, NOW, { known: true, movedAt: NOW - H, atHub: 'Miami', stoppedSinceMs: NOW - H }), null, 'just pulled into the yard: keep for now');
  assert.match(ageOutReason(ferney, { a: ferney }, NOW, null), /no Samsara reading/);
  assert.equal(ageOutReason(rec('627656', '4504', 'DISP', 10), {}, NOW), null, 'recent: keep');
  const old = rec('627549', '4504', 'DEPCONS', 40);
  assert.equal(ageOutReason(old, { a: old, b: ferney }, NOW), 'truck 4504 is on trip 627656 now', 'the truck moved to a newer trip');
  assert.equal(ageOutReason(ferney, { a: old, b: ferney }, NOW, rolling), null, 'the newer one stays');
  assert.match(ageOutReason(rec('627000', '2210', 'DELVD', 37), {}, NOW), /^status DELVD/);
  assert.equal(ageOutReason(rec('627001', '', 'ASSGN', 37), {}, NOW), 'no truck and no TruckMate update for 36h', 'an old booking with no truck still goes');
  assert.equal(ageOutReason(rec('627002', '2216', 'DEPSHIP', 24 * 8), {}, NOW), 'no TruckMate update for 7 days', 'the safety net');
});

test('the evidence: rolling now, or when it last moved and whether it sits at a hub', () => {
  const r = rec('627656', '4504', 'DISP', 39);
  const idx = (lat, lng, mph) => ({ statsByUnit: { 4504: { gps: { latitude: lat, longitude: lng, speedMilesPerHour: mph } } } });
  assert.deepEqual(quietTripEvidence(r, idx(31.5, -81.4, 74), {}, NOW), { known: true, movedAt: NOW, atHub: null, stoppedSinceMs: null });
  assert.deepEqual(quietTripEvidence(r, idx(25.795, -80.31, 0), { 4504: { lastMovingAt: NOW - 8 * H, stoppedSince: NOW - 7 * H } }, NOW), { known: true, movedAt: NOW - 8 * H, atHub: 'Miami', stoppedSinceMs: NOW - 7 * H });
  assert.equal(quietTripEvidence(r, { statsByUnit: {} }, {}, NOW).known, false);
});

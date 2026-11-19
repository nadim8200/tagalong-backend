import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, initDriveTime } from '../drivetime.js';

const H = 3600000; const now = Date.parse('2026-11-19T05:00:00Z');
const L = (status, fromH, toH) => ({ driverId: 'd1', status, from: now - fromH * H, to: now - toH * H });
const logs = [L('offDuty', 30, 18), L('onDuty', 18, 17.5), L('driving', 17.5, 12.5), L('onDuty', 12.5, 12), L('driving', 12, 9), L('sleeperBerth', 9, 8.5), L('driving', 8.5, 5.5), L('onDuty', 5.5, 4), L('offDuty', 4, 2), L('offDuty', 2, 0)];

test('a driver\'s last 24 h from the ELD: clipped segments, totals, when they last drove, since when off duty (joined logs)', () => {
  const d = dayOf(logs, 'd1', now);
  assert.equal(d.segments[0].status, 'off'); assert.equal(d.segments[0].from, now - 24 * H);
  assert.deepEqual(d.totals, { off: 360 + 240, sleeper: 30, driving: 300 + 180 + 180, on: 30 + 30 + 90 });
  assert.equal(d.lastDroveAt, now - 5.5 * H);
  assert.equal(d.statusSince, now - 4 * H);
});

test('the endpoint reads the logs only when asked, for that truck\'s ELD drivers, cached 5 min', async () => {
  let calls = 0; const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h.at(-1); } };
  const board = { trips: [{ trip: { tripNumber: '627281' }, _samsara: { driver1: 'Angelo Sayko', hos: { driverId: 'd1' } } }] };
  initDriveTime(app, { requireAuth: () => {}, getBoard: async () => board, env: { SAMSARA_TOKEN: 'x' }, logsFn: async () => { calls += 1; return logs; }, now: () => now });
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['/truckmate/drivetime/:trip']({ params: { trip: '627281' } }, res);
  assert.equal(out.drivers[0].name, 'Angelo Sayko'); assert.equal(out.drivers[0].totals.driving, 660);
  await routes['/truckmate/drivetime/:trip']({ params: { trip: '627281' } }, res);
  assert.equal(calls, 1);
});

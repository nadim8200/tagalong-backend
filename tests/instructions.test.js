import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstructions, expandInstructions, fmtWall } from '../inbox.js';
import { plannedPickup } from '../pickupfollow.js';

test('one instruction about five loads becomes one per load', () => {
  const ins = parseInstructions([{ kind: 'task', trip: null, trips: ['624620', '624626', '624625', '624634', '624628'], message: 'Follow up on five loads' }]);
  const out = expandInstructions(ins);
  assert.deepEqual(out.map((x) => x.trip), ['624620', '624626', '624625', '624634', '624628']);
  assert.ok(out.every((x) => x.split && x.message === 'Follow up on five loads'));
});

test('single-load and eta_updates instructions are left alone', () => {
  const ins = parseInstructions([{ kind: 'note', trip: '624620', message: 'x' }, { kind: 'eta_updates', trips: ['624620', '624626'], everyHours: 2 }]);
  const out = expandInstructions(ins);
  assert.equal(out.length, 2);
  assert.equal(out[0].trip, '624620');
  assert.deepEqual(out[1].trips, ['624620', '624626']);
});

test('pickup_followup keeps its time; bad times drop', () => {
  const [a, b] = parseInstructions([{ kind: 'pickup_followup', trip: '624626', pickupAt: '2026-10-08T23:00' }, { kind: 'pickup_followup', trip: '624625', pickupAt: 'tonight' }]);
  assert.equal(a.pickupAt, '2026-10-08T23:00');
  assert.equal(b.pickupAt, null);
  assert.match(fmtWall('2026-10-08T23:00'), /Oct 8.*11:00 PM/);
});

test('a pickup time staff emailed drives the pickup follow-up', () => {
  const p = plannedPickup({ trip: { tripNumber: '624626' }, _pickupAsk: { at: '2026-10-08T23:00' } });
  assert.equal(p.source, 'dispatch email');
  assert.equal(new Date(p.ms).toISOString(), '2026-10-09T03:00:00.000Z');
});

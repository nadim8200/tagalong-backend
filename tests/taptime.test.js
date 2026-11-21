import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapTime, tapStamp } from '../taptime.js';

test('a tap sent later keeps when it was pressed: never in the future, at most 24 h back (Nov 21)', () => {
  const now = Date.parse('2026-11-21T18:00:00Z');
  assert.equal(tapTime({ tappedAt: '2026-11-21T17:20:00Z' }, now), '2026-11-21T17:20:00.000Z');
  assert.equal(tapTime({}, now), '2026-11-21T18:00:00.000Z');
  assert.equal(tapTime({ tappedAt: 'nonsense' }, now), '2026-11-21T18:00:00.000Z');
  assert.equal(tapTime({ tappedAt: '2026-11-22T18:00:00Z' }, now), '2026-11-21T18:00:00.000Z');   // phone clock ahead
  assert.equal(tapTime({ tappedAt: '2026-11-19T18:00:00Z' }, now), '2026-11-20T18:00:00.000Z');   // too old: 24 h back
  assert.deepEqual(tapStamp({ tappedAt: '2026-11-21T17:20:00Z' }, now), { at: '2026-11-21T17:20:00.000Z', sentAt: '2026-11-21T18:00:00.000Z' });
  assert.deepEqual(tapStamp({ tappedAt: '2026-11-21T17:59:00Z' }, now), { at: '2026-11-21T17:59:00.000Z' });   // seconds late: nothing to note
});

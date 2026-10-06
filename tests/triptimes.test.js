import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripTimes } from '../triptimes.js';

const T = (iso) => Date.parse(iso);

test('created from the first freight bill; added when first seen; dispatched at the status change', () => {
  const rec = {
    item: { trip: { tripNumber: '624278', status: 'DEPSHP' }, freightBills: [{ createdTime: '2026-10-03T09:40:00', createdBy: 'ANA' }, { createdTime: '2026-10-03T09:12:00', createdBy: 'ROSA' }] },
    firstSeenAt: T('2026-10-03T09:15:00Z'),
    statusHistory: [{ status: 'AVAIL', at: T('2026-10-03T09:15:00Z') }, { status: 'DISP', at: T('2026-10-03T11:02:00Z') }, { status: 'DEPSHP', at: T('2026-10-03T13:30:00Z') }],
  };
  const t = tripTimes(rec);
  assert.equal(t.createdAt, '2026-10-03T13:12:00.000Z');   // 9:12 AM Miami time (EDT) assert.equal(t.createdBy, 'ROSA'); assert.equal(t.createdFrom, 'first freight bill');
  assert.equal(t.addedAt, '2026-10-03T09:15:00.000Z');
  assert.equal(t.dispatchedAt, '2026-10-03T11:02:00.000Z');
  assert.equal(t.dispatchedBefore, null);
});

test('already past dispatch when first seen → "dispatched before"; trip-level dates win', () => {
  const before = tripTimes({ item: { trip: { status: 'ARRCONS' } }, firstSeenAt: T('2026-10-05T21:00:00Z'), addedBefore: true, statusHistory: [{ status: 'ARRCONS', at: T('2026-10-05T21:00:00Z'), first: true }] });
  assert.equal(before.dispatchedAt, null);
  assert.equal(before.dispatchedBefore, '2026-10-05T21:00:00.000Z');
  assert.equal(before.addedBefore, true);
  const direct = tripTimes({ item: { trip: { status: 'DISP', createdDate: '2026-10-01T08:00:00', dispatchDate: '2026-10-01T10:30:00' } }, firstSeenAt: T('2026-10-01T09:00:00Z') });
  assert.equal(direct.createdAt, '2026-10-01T12:00:00.000Z'); assert.equal(direct.createdFrom, 'TruckMate');
  assert.equal(direct.dispatchedAt, '2026-10-01T14:30:00.000Z'); assert.equal(direct.dispatchedFrom, 'TruckMate');
  const notYet = tripTimes({ item: { trip: { status: 'ASSGN' } }, firstSeenAt: T('2026-10-01T09:00:00Z'), statusHistory: [{ status: 'ASSGN', at: T('2026-10-01T09:00:00Z') }] });
  assert.equal(notYet.dispatchedAt, null); assert.equal(notYet.dispatchedBefore, null);
});

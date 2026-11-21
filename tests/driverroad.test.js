import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCustomer, stopNotes, tempFor, waitStart, aheadOf, roadFacts } from '../driverroad.js';

const notes = [
  { code: '100', name: 'MAIN WHOLESALE FLORIST', roles: ['consignee'], notes: 'Receiving 5AM-1PM. Dock 3.', readAt: '2026-11-18T12:00:00Z' },
  { code: '200', name: 'FLORIDA BEAUTY FLORA', roles: ['shipper'], notes: 'Check in at the guard shack.', readAt: '2026-11-18T12:00:00Z' },
  { code: '300', name: 'SOMEONE ELSE INC', roles: ['consignee'], notes: 'Call before.', readAt: null },
];

test('matches customer names loosely', () => {
  assert.ok(sameCustomer('Main Wholesale Florist Inc', 'MAIN WHOLESALE FLORIST'));
  assert.ok(!sameCustomer('Terra Flowers', 'MAIN WHOLESALE FLORIST'));
});

test('puts each customer\'s notes on its stop, pickup notes apart', () => {
  const r = stopNotes({ _customerNotes: notes }, [{ key: 'NEWARK, NJ', name: 'MAIN WHOLESALE FLORIST INC' }, { key: 'X', name: 'TERRA' }]);
  assert.equal(r.byStop['NEWARK, NJ'].notes, 'Receiving 5AM-1PM. Dock 3.');
  assert.equal(r.byStop.X, undefined);
  assert.equal(r.pickup[0].customer, 'FLORIDA BEAUTY FLORA');
  assert.deepEqual(r.other.map((o) => o.customer), ['SOMEONE ELSE INC']);
});

test('one stop and one unmatched consignee: that stop', () => {
  const r = stopNotes({ _customerNotes: [notes[2]] }, [{ key: 'K', name: 'DIFFERENT NAME' }]);
  assert.equal(r.byStop.K.notes, 'Call before.');
});

test('temperature levels: ok, off, freeze, too old', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const lt = (readingF, status, target = { minF: 34, maxF: 38 }, at = '2026-11-21T11:50:00Z') => ({ _loadTemp: { target, current: { readingF, setF: 36, at, source: 'Samsara' }, check: { status } } });
  assert.equal(tempFor(lt(36, 'ok'), now).level, 'ok');
  assert.equal(tempFor(lt(45, 'out'), now).level, 'off');
  assert.equal(tempFor(lt(32, 'out'), now).level, 'freeze');
  assert.equal(tempFor(lt(30, 'ok', { minF: -10, maxF: 0 }), now).level, 'ok');
  assert.equal(tempFor(lt(36, 'ok', undefined, '2026-11-21T06:00:00Z'), now), null);
});

test('waiting clock: 3 hours after arrival or the appointment', () => {
  assert.equal(waitStart('2026-11-21T09:00:00Z'), Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(waitStart('2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z'), Date.parse('2026-11-21T13:00:00Z'));
  assert.equal(waitStart(null), null);
});

test('truck stops ahead of a moving truck, closest first', () => {
  const pos = { lat: 28.5, lng: -81.4, course: 0, speedMph: 60 };
  const r = aheadOf(pos, [{ name: 'North', lat: 28.7, lng: -81.4 }, { name: 'South', lat: 28.3, lng: -81.4 }, { name: 'Near north', lat: 28.55, lng: -81.4 }]);
  assert.deepEqual(r.map((p) => p.name), ['Near north', 'North']);
  assert.equal(aheadOf({ ...pos, speedMph: 0 }, [{ name: 'South', lat: 28.3, lng: -81.4 }]).length, 1);
});

test('road facts: no position at 0,0', () => {
  assert.equal(roadFacts({ _samsara: { lat: 0, lng: 0 } }, {}).pos, null);
});

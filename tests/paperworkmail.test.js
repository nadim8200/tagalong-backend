import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPaperworkEmail, billOnLoad } from '../paperworkmail.js';
import { buildRundown } from '../rundown.js';

const item = { trip: { tripNumber: '626265', powerUnit: '4504', trailer: '7136' }, freightBills: [{ billNumber: 'M5055135', pieces: 12, endZoneDescription: 'EAST POINT, GA', billToName: 'ATLANTA FLOWER DELIVERY' }] };

test('the bill the driver gave, against TruckMate', () => {
  assert.deepEqual(billOnLoad(item, 'm5055135'), { onLoad: true, pieces: 12, to: 'EAST POINT, GA', billTo: 'ATLANTA FLOWER DELIVERY' });
  assert.equal(billOnLoad(item, 'X1').onLoad, false);
});

test('Accounting gets the paper, the bill, the box count against TruckMate, and the load', () => {
  const m = renderPaperworkEmail({ label: 'POD', bill: 'M5055135', boxes: 11, confirmation: 'FB-AAAA-BBBB-CCCC', by: 'Driver', files: 1, item, trip: '626265' });
  assert.equal(m.subject, 'POD // TK 4504 TL 7136 TRIP 626265 // BILL M5055135');
  for (const x of ['11, TruckMate has 12', 'does not match TruckMate', 'FB-AAAA-BBBB-CCCC', 'EAST POINT, GA', 'ATLANTA FLOWER DELIVERY']) assert.ok(m.html.includes(x), x);
  assert.match(renderPaperworkEmail({ label: 'POD', bill: 'M5055135', boxes: 12, by: 'D', item, trip: '626265' }).html, /12, matches TruckMate/);
  assert.match(renderPaperworkEmail({ label: 'BOL', bill: 'X1234567', by: 'D', item, trip: '626265' }).html, /not on this load/);
});

test('the load report carries the driver\'s paperwork for that load only, in order', () => {
  const r = buildRundown({ trip: '626265', rec: { item }, stores: { paperwork: [{ trip: '626265', at: '2026-11-03T02:00:00Z', kind: 'pod' }, { trip: '1', at: 'x', kind: 'bol' }, { trip: '626265', at: '2026-11-03T01:00:00Z', kind: 'bol' }] } });
  assert.deepEqual(r.paperwork.map((p) => p.kind), ['bol', 'pod']);
});

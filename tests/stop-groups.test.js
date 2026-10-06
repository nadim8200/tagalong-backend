import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWithTruckMate, linkSheetStops } from '../manifest.js';

const sheetStop = (n, city, state, pieces) => ({ stopNumber: n, action: 'DELIVER', city, state, pieces });
const bill = (city, st, pieces) => ({ billNumber: `B${Math.random().toString(36).slice(2, 7)}`, endZoneDescription: `${city}, ${st}, 00000`, pieces });
const item = (bills) => ({ trip: { tripNumber: '1', powerUnit: '2219', trailer: '262041' }, freightBills: bills });

test('624411: TruckMate groups Kenner + Biloxi under Pensacola — counts add up, no false notes', () => {
  const sheet = { tripNumber: '624411', truck: '2219', trailer: '262041', stops: [sheetStop(2, 'Pensacola', 'FL', 28), sheetStop(3, 'Kenner', 'LA', 35), sheetStop(4, 'Biloxi', 'MS', 15), sheetStop(5, 'Mobile', 'AL', 40)] };
  const it = item([bill('PENSACOLA', 'FL', 50), bill('PENSACOLA', 'FL', 28), bill('MOBILE', 'AL', 40)]);
  assert.deepEqual(compareWithTruckMate(sheet, it), []);
  const linked = linkSheetStops(sheet.stops, it);
  assert.equal(linked[1].tmPlace, 'PENSACOLA, FL');
  assert.equal(linked[1].tmMatchedBy, 'grouped');
});

test('624400: sheet Mundelein 122 = TruckMate Mundelein 80 + McHenry 42', () => {
  const sheet = { tripNumber: '624400', stops: [sheetStop(2, 'Mundelein', 'IL', 122)] };
  assert.deepEqual(compareWithTruckMate(sheet, item([bill('MUNDELEIN', 'IL', 80), bill('MCHENRY', 'IL', 42)])), []);
});

test('624294: Atlanta 202 in TruckMate = sheet Atlanta 124 + East Point 78', () => {
  const sheet = { tripNumber: '624294', stops: [sheetStop(4, 'East Point', 'GA', 78), sheetStop(5, 'Atlanta', 'GA', 124)] };
  assert.deepEqual(compareWithTruckMate(sheet, item([bill('ATLANTA', 'GA', 202)])), []);
});

test('real differences still show (Doraville 67 vs 145, Lombard 482 vs 483)', () => {
  const d = compareWithTruckMate({ tripNumber: '624426', stops: [sheetStop(2, 'Doraville', 'GA', 67)] }, item([bill('DORAVILLE', 'GA', 145)]));
  assert.equal(d.length, 1); assert.match(d[0].msg, /sheet 67 pcs vs TruckMate 145/);
  const l = compareWithTruckMate({ tripNumber: '624393', stops: [sheetStop(6, 'Lombard', 'IL', 482), sheetStop(5, 'Edwardsville', 'IL', 92)] }, item([bill('LOMBARD', 'IL', 483), bill('EDWARDSVILLE', 'IL', 92)]));
  assert.equal(l.length, 1); assert.match(l[0].msg, /482 pcs vs TruckMate 483/);
});

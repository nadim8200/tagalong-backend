import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocFor, isOcUnit } from '../carriers.js';
import { matchPacketPages } from '../manifest.js';
import { evaluateBoard } from '../watchtower.js';

// Synthetic data shaped like the Oct 3 packet (not real records).
const store = { carriers: { c1: { id: 'c1', name: 'Zeal Xpress Inc', dispatchPhone: '555-0147', codes: ['OC1016'], trackingMethod: 'check_call' } }, codes: { OC1016: 'c1' }, marks: {} };

test('OC detected from TruckMate unit code, trip sheet, or manual mark; company truck is not OC', () => {
  assert.equal(isOcUnit('OC1016'), true);
  assert.equal(isOcUnit('2202'), false);
  const byCode = ocFor({ trip: { tripNumber: '624268', powerUnit: 'OC1016', trailer: '2048' } }, store);
  assert.equal(byCode.carrier.name, 'Zeal Xpress Inc');
  assert.equal(byCode.source, 'TruckMate unit code');
  const bySheet = ocFor({ trip: { tripNumber: '624257', powerUnit: '176' }, _manifest: { outsideCarrier: { isOutsideCarrier: true, name: 'ZEAL XPRESS INC', truck: '176', trailer: 'RR53153', driverPhone: '555-0117' } } }, store);
  assert.equal(bySheet.carrier.id, 'c1');
  assert.equal(bySheet.truck, '176');
  assert.equal(bySheet.source, 'trip sheet');
  assert.equal(ocFor({ trip: { tripNumber: '624194', powerUnit: '2202' } }, store), null);
  const cleared = ocFor({ trip: { tripNumber: '624268', powerUnit: 'OC1016' } }, { ...store, marks: { 624268: { cleared: true } } });
  assert.equal(cleared, null);
});

test('packet pages: manifest pages, trip number, unique reference, ambiguous and unknown', () => {
  const trips = [
    { tripNumber: '624257', sourcePages: [{ file: 1, page: 1 }], stops: [{ references: ['P045280', 'SEAL# 09771655'] }] },
    { tripNumber: '624194', sourcePages: [{ file: 1, page: 8 }], stops: [{ references: ['B180215', 'PO# 425401'] }] },
  ];
  const board = new Map([['624268', { freightBills: [{ billNumber: 'B180399' }, { billNumber: 'P045280' }] }]]);
  const pages = [
    { file: 1, page: 1, type: 'manifest', references: [] },
    { file: 1, page: 3, type: 'email', tripNumbers: ['624257'], references: [] },
    { file: 1, page: 10, type: 'carrier_confirmation', tripNumbers: [], references: ['Load #425401', '5103745'] },
    { file: 1, page: 5, type: 'bill_of_lading', tripNumbers: [], references: ['P045280'] },
    { file: 1, page: 40, type: 'invoice', tripNumbers: [], references: ['W2317484'] },
  ];
  const m = matchPacketPages(pages, trips, board);
  assert.deepEqual(m.map((x) => x.trip), ['624257', '624257', '624194', null, null]);
  assert.match(m[3].matchedBy, /ambiguous/);
  assert.equal(m[4].matchedBy, 'no match');
});

test('Watchtower: OC loads skip ELD/engine rules and get a carrier-update rule', () => {
  const now = Date.parse('2026-10-03T20:00:00Z');
  const base = { trip: { tripNumber: '624257', status: 'DEPSHIP', powerUnit: '176' }, freightBills: [], _oc: { isOC: true, carrier: { name: 'Zeal Xpress Inc', dispatchPhone: '555-0147' }, truck: '176' } };
  const never = evaluateBoard({ trips: [{ ...base, _samsara: { hos: { driveLeftMin: 0 }, speedMph: 60, dtcCodes: [{ code: 'P0420' }] } }] }, { now, geo: () => null });
  assert.deepEqual(never.map((a) => a.code), ['carrier-update-overdue']);
  assert.match(never[0].title, /No check-in from Zeal Xpress Inc yet/);
  const fresh = evaluateBoard({ trips: [{ ...base, _checkins: [{ at: '2026-10-03T18:30:00Z', text: 'Driver still getting empty' }] }] }, { now, geo: () => null });
  assert.equal(fresh.length, 0);
  const stale = evaluateBoard({ trips: [{ ...base, _checkins: [{ at: '2026-10-03T10:00:00Z', text: 'Loaded' }] }] }, { now, geo: () => null });
  assert.equal(stale[0].severity, 'critical');
  assert.match(stale[0].detail, /555-0147/);
});

test('sheet vs TruckMate: Saint/St spellings and a neighbouring town with the same pieces are the same stop', async () => {
  const { compareWithTruckMate, linkSheetStops } = await import('../manifest.js');
  const sheet = { tripNumber: '624248', stops: [
    { action: 'DELIVER', city: 'SAINT LOUIS', state: 'MO', pieces: 36 },
    { action: 'DELIVER', city: 'ST LOUIS', state: 'MO', pieces: 14 },
    { action: 'DELIVER', city: 'LOMBARD', state: 'IL', pieces: 88 },
    { action: 'DELIVER', city: 'PENNSAUKEN', state: 'NJ', pieces: 19 },
  ] };
  const item = { trip: { tripNumber: '624248' }, freightBills: [
    { endZoneDescription: 'SAINT LOUIS, MO, 63103', pieces: 50 },
    { endZoneDescription: 'LOMBARD, IL, 60148', pieces: 91 },
    { endZoneDescription: 'MERCHANTVILLE, NJ, 08109', pieces: 19 },
  ] };
  const diffs = compareWithTruckMate(sheet, item);
  assert.deepEqual(diffs.map((d) => d.msg), ['LOMBARD, IL: sheet 88 pcs vs TruckMate 91 pcs.']);
  const linked = linkSheetStops(sheet.stops, item);
  assert.equal(linked[1].tmPlace, 'SAINT LOUIS, MO');
  assert.equal(linked[3].tmPlace, 'MERCHANTVILLE, NJ');
  assert.equal(linked[3].tmMatchedBy, 'same state + same pieces');
});

test('packet pages: truck, OC carrier, driver, consignee, "follows manifest" and shared load # all match', () => {
  const trips = [
    { tripNumber: '624194', truck: '2215', trailer: '2035', drivers: [{ name: 'Marcelo Castillo' }], stops: [{ action: 'DELIVER', customer: 'Dadu NY' }] },
    { tripNumber: '624257', truck: '176', outsideCarrier: { isOutsideCarrier: true, name: 'ZEAL XPRESS INC', driverName: 'Farooque Ahmed Mohsin' }, stops: [{ action: 'DELIVER', customer: 'Designers Choice' }] },
  ];
  const board = new Map([['624268', { trip: { tripNumber: '624268', powerUnit: 'OC1016', trailer: '2048' }, freightBills: [] }]]);
  const pages = [
    { file: 1, page: 2, type: 'driver_id', driverName: 'FAROOQUE AHMED MOHSIN', summary: 'Driver ID' },
    { file: 1, page: 3, type: 'email', summary: "Email 'Re: Load Rate Confirmation #12349 FL to MA' with Rizwan (Track & Trace, Zeal Xpress Inc)", references: ['Rate Confirmation #12349'] },
    { file: 1, page: 9, type: 'other', summary: 'Broker reload / fuel instructions sheet (follows manifest 624194).' },
    { file: 1, page: 19, type: 'other', summary: 'FBF warehouse load sheet for truck 2215 / trailer 2035' },
    { file: 1, page: 26, type: 'other', summary: 'FBF warehouse load sheet page 1 of 2 for truck OC1016 / trailer 2048' },
    { file: 1, page: 31, type: 'bill_of_lading', summary: 'Nazcaflor USA bill of lading for 20 boxes of oriental lilies to Designers Choice, Hyde Park MA' },
    { file: 1, page: 40, type: 'carrier_confirmation', summary: 'Pelica rate confirmation', references: ['Load #12349'] },
    { file: 1, page: 44, type: 'invoice', summary: 'Invoice for something unrelated', references: ['W2317484'] },
  ];
  const m = matchPacketPages(pages, trips, board);
  assert.deepEqual(m.map((x) => x.trip), ['624257', '624257', '624194', '624194', '624268', '624257', '624257', null]);
  assert.equal(m[4].matchedBy, 'truck OC1016');
  assert.match(m[6].matchedBy, /same load # as another page/);
});

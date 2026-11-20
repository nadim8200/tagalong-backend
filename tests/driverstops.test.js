import test from 'node:test';
import assert from 'node:assert/strict';
import { driverStops, cityStep } from '../driverstops.js';

const bill = (n, who, label, pieces, actualDelivery = null) => ({ billNumber: n, billToName: who, endZoneDescription: label, pieces, actualDelivery });
const bills = [
  bill('M1', 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', 'SOUTH WINDSOR, CT, 06074', 64),
  bill('G1', 'MAIN WHOLESALE FLORIST-CLIFTON', 'CLIFTON, NJ, 07011', 90),
  bill('M2', 'VIVEK FLOWERS.*', 'PISCATAWAY, NJ, 08854', 70),
  bill('M3', 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', 'SOUTH WINDSOR, CT, 06074', 16),
  bill('P1', 'BOKHARY FARMS LLC *', 'WALTHAM, MA, 02453', 3),
];
const geo = { '06074': { lat: 41.83, lng: -72.55 }, '07011': { lat: 40.88, lng: -74.14 }, '08854': { lat: 40.55, lng: -74.46 }, '02453': { lat: 42.37, lng: -71.24 } };

test('no trip sheet: TruckMate bills, one stop per customer, in route order from Miami (nearest first), bills and boxes under each', () => {
  const s = driverStops({ trip: { tripNumber: '1', origZoneDesc: 'MIAMI TERMINAL' }, freightBills: bills }, { geo });
  assert.deepEqual(s.map((x) => x.place), ['PISCATAWAY, NJ', 'CLIFTON, NJ', 'SOUTH WINDSOR, CT', 'WALTHAM, MA']);
  assert.deepEqual(s.map((x) => x.number), [1, 2, 3, 4]);
  assert.equal(s[2].key, 'SOUTH WINDSOR, CT, 06074', 'the step key stays the TruckMate label');
  assert.deepEqual([s[2].boxes, s[2].bills.length, s[2].name, s[2].source], [80, 2, 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', 'TruckMate']);
  assert.equal(s[0].name, 'VIVEK FLOWERS.', 'the trailing star is dropped');
  const noGeo = driverStops({ freightBills: bills }, { geo: {} });
  assert.equal(noGeo[0].place, 'SOUTH WINDSOR, CT', 'no places known: bill order');
});

test('two customers in one city are two stops; their steps also mark the city once', () => {
  const two = [...bills, bill('X1', 'CARBONE R.J. CO. CHELSEA', 'CHELSEA, MA, 02150', 5), bill('X2', 'RICCARDI WHOLESALE', 'CHELSEA, MA, 02150', 7)];
  const s = driverStops({ freightBills: two }, { geo });
  const chelsea = s.filter((x) => x.place === 'CHELSEA, MA');
  assert.deepEqual(chelsea.map((x) => x.key), ['CHELSEA, MA, 02150 · CARBONE R.J. CO. CHELSEA', 'CHELSEA, MA, 02150 · RICCARDI WHOLESALE']);
  assert.equal(cityStep('arrived:CHELSEA, MA, 02150 · RICCARDI WHOLESALE', s), 'arrived:CHELSEA, MA, 02150');
  assert.equal(cityStep('arrived:PISCATAWAY, NJ, 08854', s), null);
});

test('trip sheet: its order and details; bills by city (a misspelled sheet city matches through TruckMate\'s place); a TruckMate city the sheet lacks is still a stop', () => {
  const _manifest = { stops: [
    { action: 'LOAD', customer: 'MIAMI TERMINAL', city: 'Miami' },
    { action: 'DELIVER', key: 's2', stopNumber: 2, customer: 'VIVEK FLOWERS', city: 'PISTACAWAY', state: 'NJ', tmPlace: 'PISCATAWAY, NJ', pieces: 70, address: '1 Main St', apptDate: '11/20', apptTime: '8:00 AM', receivingHours: '6 AM–2 PM', callAhead: [{ contact: 'Raj', phone: '7325550100', leadMinutes: 60 }] },
    { action: 'DELIVER', key: 's3', stopNumber: 3, customer: 'MAIN WHOLESALE FLORIST-CLIFTON', city: 'CLIFTON', state: 'NJ', pieces: 90 },
    { action: 'DELIVER', key: 's4', stopNumber: 4, customer: 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', city: 'SOUTH WINDSOR', state: 'CT', pieces: 80 },
  ] };
  const s = driverStops({ trip: { tripNumber: '627549' }, freightBills: bills, _manifest }, { geo });
  assert.deepEqual(s.map((x) => x.name), ['VIVEK FLOWERS', 'MAIN WHOLESALE FLORIST-CLIFTON', 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', 'BOKHARY FARMS LLC']);
  assert.deepEqual(s.map((x) => x.source), ['trip sheet', 'trip sheet', 'trip sheet', 'TruckMate']);
  assert.equal(s[0].key, 'PISCATAWAY, NJ, 08854'); assert.equal(s[0].place, 'PISCATAWAY, NJ');
  assert.deepEqual([s[0].address, s[0].appt, s[0].receivingHours, s[0].callAhead[0].contact], ['1 Main St', '11/20 8:00 AM', '6 AM–2 PM', 'Raj']);
  assert.deepEqual([s[2].boxes, s[2].sheetBoxes], [80, 80]);
  assert.equal(s[3].number, 4, 'Waltham is on TruckMate only: added after the sheet\'s stops');
});

test('delivered when every bill of the stop is delivered in TruckMate', () => {
  const s = driverStops({ freightBills: [bill('A', 'X', 'CLIFTON, NJ, 07011', 1, '2026-11-20T10:00:00'), bill('B', 'X', 'CLIFTON, NJ, 07011', 1)] }, { geo });
  assert.equal(s[0].delivered, false);
});

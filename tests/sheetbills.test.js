import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetBills } from '../plansheet.js';
import { sheetTruck, sheetLanes, initNextLoads } from '../nextloads.js';

// rows as on the EMPTY LIST, Nov 18
const LIST = [{ title: 'AVAILABLE TRUCKS', rows: [
  ['', '', '', '', '', '', '', 'EMPTY LIST'],
  ['', '', '', '', '', '', '', 'ATTN: GUSTAVO DUARTE'],
  ['', 'EMPTY', '', '', '2220', '7320', '', 'ALEXEY GARCIA (4172)\nWILDEN DE ARMAS (4512)', 'FL', 'ROCHESTER HILLS MI', '', '', '', 'PTC MI TO FL'],
  ['', 'EMPTY', '', '', '2018', '7282', '', 'EDGAR MARTINEZ', 'FL', 'ROCK HILL, SC', '', '', '', 'MOUNTAIRE NC TO FL'],
  ['Mon 11/16', 'Wed 11/18', 'CW CARRIERS\n0458940\nB180940', '12:00 PM', '2216', '2024', 'DRY', 'WILSON RIOS (4801)', 'FL', 'MEMPHIS, TN', '', '', '', 'BONGARD TN TO FL'],
  ['Tue 11/17', 'Wed 11/18', 'FIRST STAR\n806370\nB181012', '7:00 PM', '4565', '7356', '-10F', 'JOSE ROSA (5682)', 'FL', 'SALEM, VA', '', '', '', 'MOUNTAIRE NC TO FL'],
  ['Mon 11/16', 'Wed 11/18', 'FLOWER', 'ETA?', '2603', '262042', '36F', 'JAVIER LEON (6327)', 'FL', 'MAPLE HEIGHTS OH', '', '', '', 'ARRIVE MI TO FL 10003349\nTHEN'],
  ['Tue 11/17', 'Thu 11/19', 'FLOWER', 'ETA?', '2614', '7371', '36F', 'MANUEL RIVERA (6291)', 'FL', 'WALTHAM MA', '', '', '', 'RXO MA TO FL\nTHEN PIERSON FL TO FL 11/20'],
  ['Tue 11/17', 'Fri 11/20', 'SUNSTATE\n0564054\nB181024', '7:30 AM', '2302', '7329', '32F', 'JOSE OCAMPO', 'FL', 'HATFIELD, MA', '', '', '', 'TO CFL'],
  ['', 'EMPTY', '', '', '2008', '7224', '', 'JOSE ROJAS (8415)', 'FL', 'LAREDO, TX', '', '', 'FBE', 'TRAFFIC TECH TX TO CA\nRELEASE IN VENTURA\nTHEN FRIDAY FLOWERS'],
] }];
const TRUCKS = ['2220', '2018', '2216', '4565', '2603', '2614', '2302', '2008', '2024', '7320'];   // 2024 / 7320 are trucks too here: only the truck column counts

test('Gus\'s EMPTY LIST: the truck column, the current load on the left (B number, load #), the plan in the comments on the right (Nov 18)', () => {
  const r = sheetBills(LIST, TRUCKS);
  assert.deepEqual(r.bills, { B180940: { truck: '2216', side: 'current' }, B181012: { truck: '4565', side: 'current' }, B181024: { truck: '2302', side: 'current' } });
  assert.equal(r.notes['2216'], 'BONGARD TN TO FL');
  assert.equal(r.notes['2614'], 'RXO MA TO FL THEN PIERSON FL TO FL 11/20');
  assert.equal(r.notes['2024'], undefined, 'a trailer number is never a truck');
  assert.deepEqual(sheetLanes(r.notes['2614']), [{ broker: ['RXO'], from: 'MA', to: 'FL' }, { broker: ['PIERSON'], from: 'FL', to: 'FL' }]);
});

test('a rate con finds its truck on the sheet: B number in the comments, load number in the comments, or broker + lane when only one truck fits', () => {
  const { bills, notes } = sheetBills(LIST, TRUCKS);
  assert.equal(sheetTruck({ bill: 'B180940' }, bills, notes), null, 'the load 2216 is on now — not its next load');
  assert.deepEqual(sheetTruck({ bill: null, loadNumber: '10003349', broker: 'Arrive Logistics' }, bills, notes), { truck: '2603', how: 'Gus\'s sheet (load 10003349 in truck 2603\'s comments)' });
  assert.deepEqual(sheetTruck({ broker: 'Bongards Creameries', pickup: { city: 'Humboldt, TN' }, delivery: { city: 'Miami, FL' } }, bills, notes), { truck: '2216', how: 'Gus\'s sheet (truck 2216: "BONGARD TN TO FL")' });
  assert.deepEqual(sheetTruck({ broker: 'Pierson Farms', pickup: { city: 'Pierson, FL' }, delivery: { city: 'Miami, FL' } }, bills, notes).truck, '2614');
  assert.equal(sheetTruck({ broker: 'Mountaire Farms', pickup: { city: 'Lumber Bridge, NC' }, delivery: { city: 'Miami, FL' } }, bills, notes), null, 'MOUNTAIRE NC TO FL is on two trucks: no guess');
  assert.equal(sheetTruck({ broker: 'Bongards Creameries', pickup: { city: 'Perham, MN' }, delivery: { city: 'Miami, FL' } }, bills, notes), null, 'another lane');
  const nb = { B181111: { truck: '2403', side: 'next' } };
  assert.deepEqual(sheetTruck({ bill: 'b181111' }, nb, {}), { truck: '2403', how: 'Gus\'s sheet (B181111 in truck 2403\'s comments)' });
});

test('a waiting rate con with its sticker B number finds its truck on Gus\'s sheet and shows as that truck\'s next load', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  m.set('taRateConPending:florida-beauty', [{ id: 'rc1', record: { broker: 'Arrive', loadNumber: '10041856', stickerBill: 'B181111', nextLoadBatch: true } }]);
  const nl = initNextLoads({ db, now: () => Date.parse('2026-11-18T21:00:00Z') });
  const cur = { trip: { tripNumber: '627400', powerUnit: '2403', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B180001' }] };
  const got = await nl.consider('florida-beauty', [{ trip: null, pendingId: 'rc1' }], { items: [cur], emailText: '', from: 'Rafael Romero' });
  assert.equal(got[0].truck, null, 'the sheet has nothing yet');
  // Gus types B181111 next to 2403 → on the next board build it shows on 2403's card
  m.set('taPlanSheet:florida-beauty', { bills: { B181111: { truck: '2403', side: 'next' } }, sheetNotes: {} });
  const trips = [JSON.parse(JSON.stringify(cur))];
  await nl.overlay('florida-beauty', trips);
  assert.equal(trips[0]._nextLoad[0].rc.loadNumber, '10041856');
  assert.equal(trips[0]._nextLoad[0].truckHow, 'Gus\'s sheet (B181111 in truck 2403\'s comments)');
});

test('the left side ties broker load numbers to B numbers: "FIRST STAR 806370 B181012", "SUNSTATE 0564054 B181024"', () => {
  const { loadBills } = sheetBills(LIST, TRUCKS);
  assert.deepEqual(loadBills, { '0458940': 'B180940', 806370: 'B181012', '0564054': 'B181024' });
});

test('a rate con for the load on the LEFT of a truck\'s row (its current load) never becomes that truck\'s next load', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  m.set('taRateConPending:florida-beauty', [{ id: 'rc1', record: { broker: 'First Star Logistics, LLC', loadNumber: '806370', truckNumber: '4565', nextLoadBatch: true } }]);
  m.set('taPlanSheet:florida-beauty', { ...sheetBills(LIST, TRUCKS), bills: sheetBills(LIST, TRUCKS).bills });
  const nl = initNextLoads({ db, now: () => Date.parse('2026-11-18T21:00:00Z') });
  const got = await nl.consider('florida-beauty', [{ trip: null, pendingId: 'rc1' }], { items: [{ trip: { tripNumber: '627300', powerUnit: '4565', status: 'DEPSHIP' } }] });
  assert.deepEqual(got, [{ trip: null, skipped: 'truck 4565\'s current load on Gus\'s sheet' }]);
});

test('TruckMate is the most up to date: a load booked there on another truck moves to that truck\'s card, whatever the sheet said', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  m.set('taNextLoads:florida-beauty', { list: [{ id: 'rc1', truck: '2403', truckHow: 'Gus\'s sheet (B181111 in truck 2403\'s comments)', rc: { broker: 'Arrive', loadNumber: '10041856', bill: 'B181111' }, at: '2026-11-18T20:00:00Z' }] });
  const nl = initNextLoads({ db, now: () => Date.parse('2026-11-18T21:00:00Z') });
  const trips = [
    { trip: { tripNumber: '627400', powerUnit: '2403', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B180001' }] },
    { trip: { tripNumber: '627410', powerUnit: '2207', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B180002' }] },
    { trip: { tripNumber: '627420', powerUnit: '2207', status: 'ASSGN' }, freightBills: [{ billNumber: 'B181111' }] },
  ];
  await nl.overlay('florida-beauty', trips);
  assert.equal(trips[0]._nextLoad, undefined, 'not on 2403 any more');
  assert.equal(trips[1]._nextLoad[0].truckHow, 'TruckMate trip 627420 (was 2403: Gus\'s sheet (B181111 in truck 2403\'s comments))');
});

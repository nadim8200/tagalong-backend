import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDispatchMessage, looksLikeDispatchMessage, initLoadSheets, cleanTime, readTemp, tripForSheet, forDriver, readRelease } from '../loadsheet.js';

const ONE = `--------------------------------------------
FB#: B180747
TRIP#: 626217
TEMP: 32F  ***CONTINUOS***
PU#: 48027
---------------------------------------------
PICK UP:

QUIRCH FOODS
7600 NW 82 PLACE
MIAMI, FL 33166

DATE: 11/01/26  TIME: 11:00 AM
---------------------------------------------

---------------------------------------------
DELIVERY:

QUIRCH FOODS
3504 OLD BATTLEGROUND RD
GREENSBORO, NC 27410

DATE: 11/03/26  TIME:  08:00 AM
---------------------------------------------
PLEASE CONFIRM WITH "OK" ONCE YOU
RECEIVE THIS MESSAGE, THANKS, HS.`;

const TWO = `$70 extra short run
--------------------------------------------
FB#: B180765
TRIP#: 626283
TEMP:   ***28F CONTINUOS***
PU#: O355139415, PO172746, PO174270
---------------------------------------------
PICK UP:
LINEAGE LOGISTICS
13700 NW 115TH AVE
MEDLEY FL 48377


DATE: 11/2/26  TIME: 3P M
---------------------------------------------
              *** NO RELEASE ***
---------------------------------------------
DELIVERY:
COLD-LINK LOGISTICS
2400 MAYFLOWER AVE
APOPKA FL 32703


DATE: 11/3/26  TIME:  8AM
---------------------------------------------
PLEASE CONFIRM WITH "OK" ONCE YOU
RECEIVE THIS MESSAGE, THANKS, PRISCYLA.`;

const THREE = `---------------------------------------------
FB#:
B180764
TRIP#: 626282
TEMP:  28F CONTINUOUS
PU#: 0122539956, 0122539874, 0122539692, 0122539937, 0122539803, 0122539571
---------------------------------------------
PICK UP:
CARL BUDDIG & CO
215 45TH ST
MUNSTER, IN 46321
DATE: 11/02/26  TIME: @ASAP
---------------------------------------------

---------------------------------------------
DELIVERY #1:
WALMART DC# 6055
6055 UNISIA DRIVE
MONROE, GA 30655
DATE: 11/03/26  TIME: 12:00PM
---------------------------------------------
***FREE RELEASE BARTOW YARD***
---------------------------------------------
DELIVERY #2:
WALMART DC# 8851
4505 FL-524
COCOA, FL 32926
DATE: 11/04/26  TIME: 1:00PM
---------------------------------------------
PLEASE CONFIRM WITH "OK" ONCE YOU
RECEIVE THIS MESSAGE, THANKS,`;

test('a plain one-stop message: bill, trip, temp, PU#, pickup and delivery with address and time, who sent it', () => {
  const s = parseDispatchMessage(ONE);
  assert.equal(s.bill, 'B180747'); assert.equal(s.trip, '626217'); assert.deepEqual(s.pickupNumbers, ['48027']);
  assert.deepEqual([s.temp.degrees, s.temp.unit, s.temp.mode], [32, 'F', 'continuous']);
  assert.equal(s.stops.length, 2);
  assert.deepEqual(s.stops[0], { kind: 'pickup', n: 1, name: 'QUIRCH FOODS', street: '7600 NW 82 PLACE', city: 'MIAMI', state: 'FL', zip: '33166', date: '11/01/26', dateIso: '2026-11-01', time: '11:00 AM', other: undefined });
  assert.equal(s.stops[1].city, 'GREENSBORO'); assert.equal(s.stops[1].time, '08:00 AM'); assert.equal(s.stops[1].dateIso, '2026-11-03');
  assert.equal(s.from, 'HS');
});

test('extra pay up top, several PU numbers, "3P M", and a note between pickup and delivery', () => {
  const s = parseDispatchMessage(TWO);
  assert.deepEqual(s.notes, ['$70 extra short run']);
  assert.deepEqual(s.pickupNumbers, ['O355139415', 'PO172746', 'PO174270']);
  assert.equal(s.temp.degrees, 28); assert.equal(s.temp.mode, 'continuous');
  assert.equal(s.stops[0].city, 'MEDLEY'); assert.equal(s.stops[0].state, 'FL'); assert.equal(s.stops[0].time, '3 PM');
  assert.deepEqual(s.stops[0].notesAfter, ['NO RELEASE']);
  assert.equal(s.stops[1].name, 'COLD-LINK LOGISTICS'); assert.equal(s.stops[1].time, '8 AM');
  assert.equal(s.from, 'PRISCYLA');
});

test('FB# on the next line, ASAP, two numbered deliveries, and a free release at Bartow yard after the first one', () => {
  const s = parseDispatchMessage(THREE);
  assert.equal(s.bill, 'B180764'); assert.equal(s.trip, '626282'); assert.equal(s.pickupNumbers.length, 6);
  assert.deepEqual(s.stops.map((x) => [x.kind, x.n, x.name]), [['pickup', 1, 'CARL BUDDIG & CO'], ['delivery', 1, 'WALMART DC# 6055'], ['delivery', 2, 'WALMART DC# 8851']]);
  assert.equal(s.stops[0].time, 'ASAP');
  assert.equal(s.stops[1].notesAfter, undefined, 'the release is not a note');
  assert.deepEqual(s.release, { type: 'free', yard: 'Bartow', stops: [2] }, 'delivery #2 goes from the yard');
  assert.equal(s.stops[2].street, '4505 FL-524'); assert.equal(s.stops[2].city, 'COCOA'); assert.equal(s.stops[2].time, '1:00 PM');
  assert.equal(s.from, null);
});

test('not a load message → null; helpers', () => {
  assert.equal(parseDispatchMessage('Driver is 10 miles away, ETA 8 AM'), null);
  assert.equal(looksLikeDispatchMessage(THREE), true); assert.equal(looksLikeDispatchMessage('pick up the delivery'), false);
  assert.equal(cleanTime('3P M'), '3 PM'); assert.equal(cleanTime('@ASAP'), 'ASAP');
  assert.equal(readTemp('-10F CYCLE').mode, 'cycle'); assert.equal(readTemp('-10F CYCLE').degrees, -10);
  assert.equal(tripForSheet({ bill: 'B1', trip: null }, [{ trip: { tripNumber: 9 }, freightBills: [{ billNumber: 'b1' }] }]), '9');
  assert.match(forDriver(parseDispatchMessage(ONE)).stops[0].map, /google\.com\/maps.*QUIRCH/);
});

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };

test('saved on the trip, sent by app and / or text, read from an email, the driver\'s OK, and on the board', async () => {
  const db = mem(); const routes = {}; const sent = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; } };
  const ls = initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, getBoard: async () => ({ trips: [{ trip: { tripNumber: '626282' }, freightBills: [{ billNumber: 'B180764' }] }] }), sendApp: async (site, trip, text) => { sent.push(['app', trip, text.slice(0, 5)]); return { sent: true }; }, sendText: async () => ({ skipped: 'texting not live yet' }) });
  const call = async (key, body) => { let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes[key][1]({ body, params: {}, user: { name: 'Haraft' } }, res); return out; };
  assert.equal((await call('POST /truckmate/loadsheet', { text: 'hello' })).status, 400);
  const pv = await call('POST /truckmate/loadsheet/preview', { text: THREE });
  assert.equal(pv.body.trip, '626282'); assert.equal(pv.body.onBoard, true); assert.equal(db.s['taLoadSheets:florida-beauty'], undefined, 'preview saves nothing');
  const r = await call('POST /truckmate/loadsheet', { text: THREE, via: ['app', 'text'] });
  assert.equal(r.body.trip, '626282'); assert.deepEqual(sent, [['app', '626282', '-----']]); assert.equal(r.body.sent.text.skipped, 'texting not live yet');
  assert.equal((await ls.get('626282')).by, 'Haraft');
  assert.equal(await ls.fromEmail('x', { text: 'no', from: {} }), null);
  assert.equal((await ls.fromEmail('x', { text: ONE, from: { name: 'Haraft J Sierra' } })).by, 'Haraft J Sierra (email)');
  await ls.confirm('626282', 'Frank U');
  const items = [{ trip: { tripNumber: '626282' } }]; await ls.overlay('x', items);
  assert.equal(items[0]._loadSheet.confirmedBy, 'Frank U');
});

test('a yard drop: the driver only sees the stops they deliver, then the release with the yard; dispatch can change it; the drop emails the team', async () => {
  assert.deepEqual(readRelease('***PAID RELEASE @ MIAMI YARD***'), { type: 'paid', yard: 'Miami' });
  assert.equal(readRelease('*** NO RELEASE ***'), null);
  assert.equal(parseDispatchMessage(TWO).release, null, 'NO RELEASE stays a note');
  const db = mem(); const routes = {}; const mails = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; } };
  const ls = initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, getBoard: async () => ({ trips: [] }), sendMail: async (m) => { mails.push(m); }, recipients: async () => ['ntellez@floridabeauty.us'] });
  const call = async (key, body, params = {}) => { let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes[key][1]({ body, params, user: { name: 'Haraft' } }, res); return out; };
  await call('POST /truckmate/loadsheet', { text: THREE });
  let d = await ls.forDriver(await ls.get('626282'));
  assert.deepEqual(d.stops.map((x) => x.name), ['CARL BUDDIG & CO', 'WALMART DC# 6055'], 'Cocoa is delivered from the yard');
  assert.equal(d.release.name, 'Bartow yard'); assert.equal(d.release.address, '5361 Rifle Range Rd, Bartow, FL 33830', 'our yards are known'); assert.deepEqual(d.release.hide, [{ zip: '32926', city: 'COCOA' }]);
  // dispatch sets the yard's address and makes it paid
  const put = await call('PUT /truckmate/loadsheet/:trip/release', { type: 'paid', yard: 'Bartow yard', address: '100 Example Rd, Bartow, FL', stops: [2, 0] }, { trip: '626282' });
  assert.equal(put.body.sheet.release.type, 'paid'); assert.deepEqual(put.body.sheet.stops.map((x) => x.toYard), [false, false, true], 'a pickup can\'t go to the yard');
  d = await ls.forDriver(await ls.get('626282'));
  assert.equal(d.release.address, '100 Example Rd, Bartow, FL'); assert.match(d.release.map, /google\.com\/maps.*Bartow/);
  assert.deepEqual((await call('GET /truckmate/yards', {})).body.yards.map((y) => `${y.name}: ${y.address}`), ['Bartow yard: 100 Example Rd, Bartow, FL', 'Memphis yard: 11153 HWY 178, Olive Branch, MS 38654', 'Miami yard: 2355 NW 70th Ave, Miami, FL 33122', 'Ventura yard: 6205 Ventura Blvd, Ventura, CA 93003'], 'a saved address wins');
  // the driver drops it
  const drop = await ls.dropped('626282', 'Frank U', { pickedUp: 'tl 7301', truck: '2401', trailer: '7136' });
  assert.equal(drop.pickedUp, 'TL 7301'); assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /TRAILER DROPPED \/\/ BARTOW YARD \/\/ TK 2401 TL 7136 TO 626282 \/\/ PICKED UP TL 7301/);
  assert.match(mails[0].text, /Still to deliver from the yard: WALMART DC# 8851 — COCOA, FL/);
  assert.equal((await ls.forDriver(await ls.get('626282'))).release.dropped.by, 'Frank U');
  // and it can be cleared
  await call('PUT /truckmate/loadsheet/:trip/release', { release: null }, { trip: '626282' });
  assert.equal((await ls.forDriver(await ls.get('626282'))).stops.length, 3);
  assert.equal(await ls.dropped('626282', 'x'), null);
});

test('the rate con fills the driver\'s load when dispatch hasn\'t sent a message: stops, handwritten pickup time, temp, notes; never the rate or the broker', async () => {
  const { sheetFromRateCon } = await import('../loadsheet.js');
  const rc = { loadNumber: '3124003', fbfBillNumber: 'b180776', rate: 3032.82, tempSetting: null, contacts: [{ phone: '555-010-0000' }], specialInstructions: ['$200 penalty'],
    pickups: [{ name: 'SILER CITY', address: '1100 EAST 3RD STREET', city: 'SILER CITY', state: 'NC', zip: '27344', date: null, time: null, refs: null }],
    deliveries: [{ name: 'US FOODS BOCA RATON', address: null, city: 'BOCA RATON', state: 'FL', zip: '33487', date: '11/06/26', time: '08:00', refs: '7598 NW 6TH AVENUE' }],
    handwrittenNotes: ['20F cont.', '2207', 'Part 2', 'P/U 11/4 ASAP', 'AM', 'No release', '$75 bonus for short trip'] };
  const s = sheetFromRateCon(rc, { trip: '900776' });
  assert.equal(s.bill, 'B180776'); assert.deepEqual([s.temp.degrees, s.temp.mode], [20, 'continuous']); assert.deepEqual(s.pickupNumbers, ['3124003']);
  assert.deepEqual([s.stops[0].street, s.stops[0].dateIso, s.stops[0].time], ['1100 EAST 3RD STREET', '2026-11-04', 'ASAP'], 'handwritten P/U fills the pickup');
  assert.equal(s.stops[1].street, '7598 NW 6TH AVENUE', 'a street in refs is the street');
  assert.deepEqual(s.notes, ['No release', '$75 bonus for short trip'], 'truck number, part, temp, pickup time and tiny marks are not notes');
  assert.ok(!/3032|555-010/.test(JSON.stringify(s)), 'never the rate or the broker\'s phone');
  assert.deepEqual(s.instructions, ['$200 penalty'], 'the rate con\'s instructions are the driver\'s to read');
  assert.equal(sheetFromRateCon({ pickups: [], deliveries: [] }), null);
  // with the load in TruckMate: TruckMate's stops and times; the rate con adds the name, street and instructions
  const tmItem = { trip: { tripNumber: '900776' }, freightBills: [{ billNumber: 'B180776', startZoneDescription: 'SILER CITY, NC, 27344', endZoneDescription: 'BOCA RATON, FL, 33487', pickUpBy: '2026-11-04T13:00:00', deliveryAppt: '2026-11-06T08:00:00' }] };
  const t = sheetFromRateCon({ ...rc, specialInstructions: ['Driver must have a pallet jack'], pickups: [{ ...rc.pickups[0], instructions: ['Check in at the guard shack'] }] }, { trip: '900776', item: tmItem });
  assert.deepEqual(t.stops.map((x) => [x.kind, x.name, x.city, x.dateIso, x.time]), [['pickup', 'SILER CITY', 'SILER CITY', '2026-11-04', '1:00 PM'], ['delivery', 'US FOODS BOCA RATON', 'BOCA RATON', '2026-11-06', '8:00 AM']], 'TruckMate\'s times');
  assert.deepEqual(t.stops[0].other, ['Check in at the guard shack']); assert.deepEqual(t.instructions, ['Driver must have a pallet jack']);
  const only = sheetFromRateCon(rc, { trip: '1', item: { trip: { tripNumber: '1' }, freightBills: [{ billNumber: 'B1', startZoneDescription: 'MIAMI, FL, 33166', endZoneDescription: 'ATLANTA, GA, 30301', pickUpBy: '2026-11-04T00:00:00' }] } });
  assert.deepEqual(only.stops.map((x) => [x.kind, x.city, x.name]), [['pickup', 'MIAMI', null], ['pickup', 'SILER CITY', 'SILER CITY'], ['delivery', 'ATLANTA', null], ['delivery', 'BOCA RATON', 'US FOODS BOCA RATON']], 'TruckMate first, then a rate con stop TruckMate doesn\'t have');
  assert.equal(only.stops[0].time, null, 'midnight in TruckMate means a date only');
  // on the board: filled once, a message from dispatch replaces it
  const db = mem(); const app = { get() {}, post() {}, put() {} };
  const ls = initLoadSheets(app, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [] }) });
  const item = { trip: { tripNumber: '900776' }, _ratecon: { data: rc } };
  assert.equal((await ls.ensureFromRateCon(item)).by, 'Jarvis (from the rate con)');
  assert.equal((await ls.ensureFromRateCon(item)).by, 'Jarvis (from the rate con)', 'once');
  await ls.confirm('900776', 'Frank U');
  const moved = await ls.ensureFromRateCon({ ...item, freightBills: [{ billNumber: 'B180776', startZoneDescription: 'SILER CITY, NC, 27344', endZoneDescription: 'BOCA RATON, FL, 33487', deliveryAppt: '2026-11-06T10:00:00' }] });
  assert.equal(moved.stops[1].time, '10:00 AM', 'kept current with TruckMate'); assert.equal(moved.confirmedBy, 'Frank U', 'the OK stays');
  assert.equal(await ls.ensureFromRateCon({ trip: { tripNumber: '1' } }), null, 'no rate con, nothing');
});

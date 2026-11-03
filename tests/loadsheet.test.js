import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDispatchMessage, looksLikeDispatchMessage, initLoadSheets, cleanTime, readTemp, tripForSheet, forDriver } from '../loadsheet.js';

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

test('FB# on the next line, ASAP, two numbered deliveries and the release note after the first one', () => {
  const s = parseDispatchMessage(THREE);
  assert.equal(s.bill, 'B180764'); assert.equal(s.trip, '626282'); assert.equal(s.pickupNumbers.length, 6);
  assert.deepEqual(s.stops.map((x) => [x.kind, x.n, x.name]), [['pickup', 1, 'CARL BUDDIG & CO'], ['delivery', 1, 'WALMART DC# 6055'], ['delivery', 2, 'WALMART DC# 8851']]);
  assert.equal(s.stops[0].time, 'ASAP');
  assert.deepEqual(s.stops[1].notesAfter, ['FREE RELEASE BARTOW YARD']);
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
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
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

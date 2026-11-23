import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDispatchMessage, looksLikeDispatchMessage, initLoadSheets, cleanTime, readTemp, tripForSheet, forDriver, readRelease, visible } from '../loadsheet.js';

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
  assert.equal(r.body.trip, '626282'); assert.deepEqual(sent, [['app', '626282', '🔁 FR']], 'the release is said first (a push shows only the start)'); assert.equal(r.body.sent.text.skipped, 'texting not live yet');
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
  assert.match(mails[0].subject, /TRAILER DROPPED \/\/ BARTOW YARD \/\/ TK 2401 TL 7136 TRIP 626282 \/\/ PICKED UP TL 7301/);
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
  // in the console: a draft for dispatch to check; the driver sees it only once dispatch sends it
  const db = mem(); const routes = {}; const told = [];
  const app = { get: (p0, ...h) => { routes[`GET ${p0}`] = h; }, post: (p0, ...h) => { routes[`POST ${p0}`] = h; }, put() {} };
  const item = { trip: { tripNumber: '900776' }, _ratecon: { data: rc }, freightBills: [{ billNumber: 'B180776', startZoneDescription: 'SILER CITY, NC, 27344', endZoneDescription: 'BOCA RATON, FL, 33487' }] };
  const ls = initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, getBoard: async () => ({ trips: [item, { trip: { tripNumber: '1' } }] }), notify: async (...a) => told.push(a) });
  const call = async (key, body, params) => { let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes[key][1]({ body, params, user: { name: 'Haraft' } }, res); return out; };
  const draft = await call('GET /truckmate/loadsheet/:trip/ratecon-draft', {}, { trip: '900776' });
  assert.equal(draft.body.sheet.stops[0].name, 'SILER CITY'); assert.equal(await ls.get('900776'), null, 'a draft is not saved');
  assert.equal((await call('GET /truckmate/loadsheet/:trip/ratecon-draft', {}, { trip: '1' })).status, 404, 'no rate con');
  const sent = await call('POST /truckmate/loadsheet/:trip/ratecon-send', { via: ['app'] }, { trip: '900776' });
  assert.equal(sent.body.ok, true);
  const saved = await ls.get('900776');
  assert.equal(saved.by, 'Haraft'); assert.ok(saved.sentAt); assert.equal(visible(saved), true);
  assert.deepEqual(told.map((t) => [t[0], t[1]]), [['900776', 'New load from dispatch']], 'no driver link: the profile\'s phones still hear it');
  assert.match(told[0][2], /^New load: trip 900776 · pick up SILER CITY/);
  assert.equal(visible({ fromRateCon: true }), false, 'Jarvis\'s own rate con draft (before this change) stays hidden');
  assert.equal(visible({ by: 'Haraft' }), true, 'a message dispatch pasted');
});

test('TruckMate first: the shipper and each consignee (several receivers) when TruckMate sends them; the rate con only fills what\'s missing', async () => {
  const { truckMateStops, sheetFromRateCon } = await import('../loadsheet.js');
  const item = { trip: { tripNumber: '626282' }, freightBills: [
    { billNumber: 'B180764', startZoneDescription: 'MUNSTER, IN, 46321', endZoneDescription: 'MONROE, GA, 30655', shipper: { name: 'CARL BUDDIG & CO', address1: '215 45TH ST' }, consignee: { name: 'WALMART DC# 6055', address1: '6055 UNISIA DRIVE' }, deliveryAppt: '2026-11-03T12:00:00' },
    { billNumber: 'B180764', startZoneDescription: 'MUNSTER, IN, 46321', endZoneDescription: 'COCOA, FL, 32926', shipper: { name: 'CARL BUDDIG & CO' }, consignee: { name: 'WALMART DC# 8851', address1: '4505 FL-524' }, deliveryAppt: '2026-11-04T13:00:00' },
  ] };
  assert.deepEqual(truckMateStops(item).map((x) => [x.kind, x.name, x.street, x.city, x.time]), [['pickup', 'CARL BUDDIG & CO', '215 45TH ST', 'MUNSTER', null], ['delivery', 'WALMART DC# 6055', '6055 UNISIA DRIVE', 'MONROE', '12:00 PM'], ['delivery', 'WALMART DC# 8851', '4505 FL-524', 'COCOA', '1:00 PM']]);
  const s = sheetFromRateCon({ loadNumber: 'L1', pickups: [{ name: 'BUDDIG (RATE CON NAME)', city: 'MUNSTER', state: 'IN', instructions: ['Check in at gate 2'] }], deliveries: [] }, { trip: '626282', item });
  assert.equal(s.stops[0].name, 'CARL BUDDIG & CO', 'TruckMate\'s name wins'); assert.deepEqual(s.stops[0].other, ['Check in at gate 2'], 'the rate con\'s instructions still come');
  assert.equal(s.stops.filter((x) => x.kind === 'delivery').length, 2, 'both receivers');
});

test('what the driver gets starts with the release and the bonus (a push shows only the start); a team gets the text on both phones (Nov 21)', async () => {
  const { sendHeadline } = await import('../loadsheet.js');
  const sh = parseDispatchMessage(`TRIP#: 626282\nBONUS: $75 SHORT RUN\n---------------------------------------------\nPICK UP:\nCARL BUDDIG & CO\nMUNSTER, IN 46321\n---------------------------------------------\nDELIVERY #1:\nWALMART DC# 6055\nMONROE, GA 30655\n***PAID RELEASE @ MIAMI YARD***\n---------------------------------------------\nDELIVERY #2:\nWALMART DC# 8851\nCOCOA, FL 32926\n---------------------------------------------`);
  assert.equal(sendHeadline(sh), '🔁 PAID RELEASE · Miami yard (after delivery #1) · 💵 BONUS $75');
  assert.equal(sendHeadline(parseDispatchMessage(ONE)), null);
  const db = mem(); const routes = {}; const texts = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; } };
  initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, getBoard: async () => ({ trips: [] }), sendText: async (site, trip, body, by, which) => { texts.push([which, body.split('\n')[0]]); return which === 1 ? { sent: true, to: '3055550101' } : { sent: true, to: '3055550102' }; } });
  const res = { status(c) { this.c = c; return this; }, json(j) { this.body = j; } };
  await routes['POST /truckmate/loadsheet'][1]({ body: { text: THREE, trip: '626282', via: ['text'] }, params: {}, user: { name: 'Ana' } }, res);
  assert.deepEqual(texts.map((x) => x[0]), [1, 2]);
  assert.match(texts[0][1], /FREE RELEASE · Bartow yard \(after delivery #1\)/);
  assert.deepEqual(res.body.sent.text.to, ['3055550101', '3055550102']);
});

test('"Send load info" writes the driver\'s text like dispatch does: bonus first, FB#/TRIP#/TEMP/PU#, stops, the release line, signed — and it reads back the same', async () => {
  const { composeDispatchMessage, initialsOf } = await import('../loadsheet.js');
  const d = { bill: 'B180938', trip: '627004', temp: { degrees: 15, unit: 'F', mode: 'continuous' }, pickupNumbers: ['360233119'],
    stops: [{ kind: 'pickup', name: 'Store #0284', street: '750 N University Dr', city: 'Coral Springs', state: 'FL', zip: '33071', dateIso: '2026-11-12', time: '9AM', other: ['P/U loaded trailer'] },
      { kind: 'delivery', name: 'Walmart DC# 6055', street: '6055 Unisia Drive', city: 'Monroe', state: 'GA', zip: '30655', date: '11/13/26', time: '12:00PM' },
      { kind: 'delivery', name: 'Walmart DC# 8851', street: '4505 FL-524', city: 'Cocoa', state: 'FL', zip: '32926', date: '11/14/26', time: '1:00PM' }] };
  const none = composeDispatchMessage(d, { bonus: '$150 flat fee', initials: 'Nadim' });
  assert.match(none, /^\$150 FLAT FEE\n-{20,}\nFB#: B180938\nTRIP#: 627004\nTEMP: 15F {2}\*\*\*CONTINUOUS\*\*\*\nPU#: 360233119\n/);
  assert.match(none, /\*\*\* NO RELEASE \*\*\*/); assert.match(none, /RECEIVE THIS MESSAGE, THANKS, NADIM\.$/);
  assert.match(none, /DATE: 11\/12\/26 {2}TIME: 9AM\nP\/U LOADED TRAILER/);
  const back = parseDispatchMessage(none);
  assert.equal(back.bill, 'B180938'); assert.equal(back.trip, '627004'); assert.deepEqual(back.pickupNumbers, ['360233119']);
  assert.deepEqual(back.stops.map((x) => [x.kind, x.city, x.zip]), [['pickup', 'CORAL SPRINGS', '33071'], ['delivery', 'MONROE', '30655'], ['delivery', 'COCOA', '32926']]);
  assert.equal(back.release, null); assert.ok(back.notes.includes('$150 FLAT FEE'));
  // a free release at Bartow after delivery #1: Cocoa goes from the yard
  const rel = parseDispatchMessage(composeDispatchMessage(d, { release: { type: 'free', yard: 'Bartow', after: 1 }, initials: 'JG' }));
  assert.deepEqual([rel.release.type, rel.release.yard, rel.release.stops], ['free', 'Bartow', [2]]);
  const paid = parseDispatchMessage(composeDispatchMessage(d, { release: { type: 'paid', yard: 'Miami yard' } }));
  assert.deepEqual([paid.release.type, paid.release.yard], ['paid', 'Miami']);
  assert.equal(initialsOf('Jeremy Lopez'), 'JEREMY'); assert.equal(initialsOf('ntellez@floridabeauty.us'), 'NTELLEZ');
});

test('the compose route: a broker load from its own TruckMate record + rate con (no board build); an LTL load gets no dispatch text', async () => {
  const db = mem(); const routes = {}; let builds = 0;
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put() {} };
  initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, getBoard: async () => { builds += 1; return { trips: [] }; } });
  db.s['taTruckMateActive:florida-beauty'] = { trips: {
    627800: { item: { trip: { tripNumber: 627800 }, freightBills: [{ billNumber: 'B181097', startZoneDescription: 'ELIOT, ME, 03903', endZoneDescription: 'ELKTON, FL, 32033' }] } },
    627555: { item: { trip: { tripNumber: 627555, origZoneDesc: 'MIAMI TERMINAL' }, freightBills: [{ billNumber: 'G5065354', startZoneDescription: 'PIERSON, FL, 32180', endZoneDescription: 'CARPINTERIA, CA, 93013' }] } } } };
  db.s['taTruckMateRateCon:florida-beauty'] = { 627800: { broker: 'TQL', loadNumber: '4016064', tempSetting: '-10', pickups: [{ name: 'Nature Rocks', address: '299 Dow Highway', city: 'Eliot', state: 'ME', zip: '03903', date: '11/21/26', appointment: 'ASAP' }], deliveries: [{ name: 'KeHE Distributors', address: '3800 Deer Park Blvd', city: 'Elkton', state: 'FL', zip: '32033', date: '11/23/26', appointment: '2:00 AM' }] } };
  const call = async (trip, body = {}) => { let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes['POST /truckmate/loadsheet/:trip/compose'][1]({ body, params: { trip }, user: { name: 'Jeremy Lopez' } }, res); return out; };
  const r = await call('627800', { bonus: '$150 flat fee' });
  assert.equal(builds, 0);
  assert.equal(r.body.source, 'rate con');
  assert.match(r.body.text, /^\$150 FLAT FEE\n/); assert.match(r.body.text, /FB#: B181097\nTRIP#: 627800/);
  assert.match(r.body.text, /PICK UP:\n\nNATURE ROCKS\n299 DOW HIGHWAY\nELIOT, ME 03903/); assert.match(r.body.text, /THANKS, JEREMY\.$/);
  const ltl = await call('627555');
  assert.equal(ltl.status, 409); assert.equal(ltl.body.ltl, true); assert.match(ltl.body.error, /LTL leaves from the hubs/);
  // the driver is on the LTL (627555); the text is for the NEXT load: a booked TruckMate trip with no rate con yet → ask for it
  db.s['taTruckMateActive:florida-beauty'].trips[627900] = { item: { trip: { tripNumber: 627900 }, freightBills: [{ billNumber: 'B181200', startZoneDescription: 'DETROIT, MI, 48201', endZoneDescription: 'FRESNO, CA, 93701' }] } };
  const need = await call('627555', { target: { trip: '627900' } });
  assert.equal(need.status, 409); assert.equal(need.body.needRateCon, true); assert.equal(need.body.error, 'Please upload the rate con so we can dispatch the driver.');
  // a rate con Jarvis queued as the truck's next load (from Gus's email), no TruckMate trip yet
  db.s['taNextLoads:florida-beauty'] = { list: [{ id: 'p1', pendingId: 'p1', truck: '1911', rc: { broker: 'CH Robinson' }, at: '2026-11-23T10:00:00Z' }] };
  db.s['taRateConPending:florida-beauty'] = [{ id: 'p1', record: { broker: 'CH Robinson', loadNumber: '55501', fbfBillNumber: 'B181300', pickups: [{ name: 'Kroger DC', city: 'Detroit', state: 'MI', zip: '48201', date: '11/25/26', appointment: '08:00' }], deliveries: [{ name: 'Fresno Cold', city: 'Fresno', state: 'CA', zip: '93701', date: '11/28/26' }] } }];
  const nx = await call('627555', { target: { nextId: 'p1' } });
  assert.equal(nx.status, undefined); assert.equal(nx.body.trip, null); assert.equal(nx.body.broker, 'CH Robinson');
  assert.match(nx.body.text, /FB#: B181300\nTRIP#: \n/); assert.match(nx.body.text, /KROGER DC\nDETROIT, MI 48201/);
});

test('the driver info email to the broker, like dispatch writes it (B181051): subject, truck / trailer / temp, drivers with IDs, phones; the dispatch box CC\'d', async () => {
  const { brokerInfoEmail, brokerInfoText, BROKER_INFO_CC } = await import('../loadsheet.js');
  const rc = { broker: 'RXO Logistics', loadNumber: '24720958', tempSetting: '36', brokerEmail: 'Brian.Karch@rxo.com', contacts: [{ role: 'tracking', email: 'hmftracking@rxo.com' }, { role: 'other', email: 'billing@rxo.com' }, { role: 'dispatch', email: 'jvargas@floridabeauty.us' }],
    pickups: [{ city: 'Chelsea', state: 'MA' }], deliveries: [{ city: 'Miami', state: 'FL' }] };
  const e = brokerInfoEmail({ rc, bill: 'B181051', truck: '2614', trailer: '7371', drivers: [{ name: 'Manuel Rivera', code: '6291', phone: '7866917947' }, { name: 'Angel Rivera', code: '06689', phone: '(786) 691-7830' }], dispatcher: { name: 'Jeinner Vargas', email: 'jvargas@floridabeauty.us' } });
  assert.equal(e.subject, 'RXO LOGISTICS LOAD 24720958 MA TO FL // TK: 2614 TL: 7371 // B181051');
  assert.equal(e.body, 'Good day,\n\nPlease see the driver info below\n\n2614\n7371\n36F\nMANUEL RIVERA (6291)\nANGEL RIVERA (6689)\n\nPH#\nMANUEL RIVERA: 786-691-7947\nANGEL RIVERA: 786-691-7830');
  assert.deepEqual(e.to, ['brian.karch@rxo.com', 'hmftracking@rxo.com']);
  assert.deepEqual(e.fields, { truck: '2614', trailer: '7371', temp: '36F', drivers: [{ name: 'MANUEL RIVERA', code: '6291', phone: '786-691-7947' }, { name: 'ANGEL RIVERA', code: '6689', phone: '786-691-7830' }] });   // the broker's own, never ours
  assert.deepEqual(e.cc, BROKER_INFO_CC); assert.deepEqual(BROKER_INFO_CC, ['Inbound-Dispatch@floridabeauty.us']);
  const full = brokerInfoText(e.body, 'Driver can pick up early.', e.signature);
  assert.match(full, /786-691-7830\n\nDriver can pick up early\.\n\nThanks,\n\nJeinner Vargas\nFlorida Beauty Express\nEmail: jvargas@floridabeauty\.us$/);
});

test('the broker email route: sent with the dispatch box CC\'d and replies to the dispatcher; needs the broker\'s email', async () => {
  const db = mem(); const routes = {}; const mails = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put() {} };
  initLoadSheets(app, { requireAuth: (req, res, next) => next(), db, sendMail: async (m) => { mails.push(m); return { ok: true, to: m.to }; } });
  const call = async (body) => { let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; await routes['POST /truckmate/loadsheet/:trip/broker-email'][1]({ body, params: { trip: '627900' }, user: { name: 'Jeremy Ospino', email: 'jospino@floridabeauty.us' } }, res); return out; };
  assert.equal((await call({ to: '', subject: 'X', body: 'Y' })).status, 400);
  const r = await call({ to: 'ops@echo.com, Team@Echo.com', subject: 'ECHO LOAD 69950678 MN TO FL // TK: 4561 TL: 2062 // B181091', body: 'Good day,\n\nPlease see the driver information below', comments: 'Driver is OTP tomorrow.' });
  assert.equal(r.body.ok, true);
  assert.deepEqual(mails[0].to, ['ops@echo.com', 'team@echo.com']); assert.deepEqual(mails[0].cc, ['inbound-dispatch@floridabeauty.us']);
  assert.deepEqual(mails[0].replyTo, ['jospino@floridabeauty.us', 'Inbound-Dispatch@floridabeauty.us']);
  assert.match(mails[0].html, /Driver is OTP tomorrow\.\n\nThanks,\n\nJeremy Ospino\nFlorida Beauty Express\nEmail: jospino@floridabeauty\.us/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrucks, compareSheet, checkEmail, dueNow, hubOfSheet, hubClock, builderBoxesFor, mergeStops, nightOf, combineStops, markSplits, splitNote, resolveFlaggedSplits, HUBS, initTruckBuilder } from '../truckbuilder.js';

// ARTIS Truck Builder, Miami 10/11/2026, trip 624773 (as read live — names / counts only)
const B = [[1, '03373', "CAGGIANO'S MEDFORD  *", 'MEDFORD', 288], [2, '06000', 'KELLEY WHOLESALE FLORIST', 'CHELSEA', 18], [3, '01732', 'RICCARDI WHOLESALE', 'CHELSEA', 38],
  [4, '01821', 'CARBONE R.J CO. CHELSEA', 'CHELSEA', 16], [5, '42996', 'DIRECT FLOWERS OF BOSTON INC', 'CHELSEA', 34], [6, '23239', "JUDY'S VILLAGE FLOWERS INC.", 'FOXBORO', 314],
  [7, '03810', 'FALL RIVER FLORIST SUPPLY', 'FALL RIVER', 167], [8, '01375', 'BIG Y  APPOINTMENT ', 'SPRINGFIELD', 83], [9, '00826', 'SPRINGFIELD FLORIST', 'SPRINGFIELD', 80],
  [10, '50396', 'FT MILL FLOWERS & GIFTS', 'ROCK HILL', 46], [11, '23137', 'EXPRESSIONS UNLIMITED INC *', 'GREENVILLE', 72], [12, '51184', 'HASON CORP ', 'ATLANTA', 128],
  [13, '50490', 'ATLANTA FLOWER DELIVERY', 'EAST POINT ', 62], [14, '03929', 'DAVIS WHOLESALE -MACON', 'MACON', 256], [15, '50463', 'MID-GA WHOLESALE FLORIST LLC', 'WARWICK', 97],
  [16, '33572', "JOHNSON'S WHOLESALE FLORIST LLC", 'LYONS', 79]];
const routes = [{ name: 'NE', routeTrucks: [
  { truckId: '4504', trailerId: '7137', closed: true, boxes: 1778, truckSeqno: 'NE-000026241', truckInfo: { tripNumber: 624773, driver1Name: 'FERNEY URREGO', closedDateStr: '10/11 13:09 EDT' },
    truckRouteStops: B.map(([o, id, n, c, b]) => ({ stopOrder: o, consigneeId: id, consigneeName: n, consigneeCity: c, consigneeState: 'XX', boxes: b, cubes: 1, boxesNotScanned: 0 })) },
  { truckId: '', trailerId: '1809', truckInfo: {}, truckRouteStops: [] },   // no trip yet → skipped
] }];
// the trip sheet as the AI read it off the scan
const S = [['JOHNSON\'S WHOLESALE FLORIST LLC', 'LYONS', 79], ['MID-GA WHOLESALE FLORIST LLC', 'WARWICK', 98], ['DAVIS WHOLESALE -MACON', 'MACON', 256], ['ATLANTA FLOWER DELIVERY', 'EAST POINT', 62],
  ['HASON CORP', 'ATLANTA', 128], ['EXPRESSIONS UNLIMITED INC *', 'GREENVILLE', 72], ['FT MILL FLOWERS & GIFTS', 'ROCK HILL', 46], ['BLOSSOMS AND BLOOMS WHOLESALE INC *', 'SOUTHAMPTON', 82],
  ['SPRINGFIELD FLORIST', 'SPRINGFIELD', 81], ['BIG Y APPOINTMENT', 'SPRINGFIELD', 83], ['FALL RIVER FLORIST SUPPLY', 'FALL RIVER', 168], ["JUDY'S VILLAGE FLOWERS INC.", 'FOXBORO', 314],
  ['CHELSEA MARKET - CARBONE R.I CO. CHELSEA', 'CHELSEA', 16], ['CHELSEA MARKET - DIRECT FLOWERS OF BOSTON INC', 'CHELSEA', 34], ['CHELSEA MARKET - KELLEY WHOLESALE FLORIST', 'CHELSEA', 18],
  ['CHELSEA MARKET - RICCARDI WHOLESALE', 'CHELSEA', 38], ["CAGGIANO'S MEDFORD *", 'MEDFORD', 288]];
const sheet = { tripNumber: '624773', truck: '734', trailer: '7137', dateLoaded: '2026-10-11', uploadedAt: '2026-10-12T00:09:52Z', unreadable: ['stop 5 faint', 'stop 10 faint'],
  stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL', city: 'MIAMI', state: 'FL', pieces: 1863 }, ...S.map(([customer, city, pieces]) => ({ action: 'DELIVER', customer, city, pieces }))] };

test('Truck Builder trucks: trip, truck, trailer, drivers and stops in order (trucks with no trip are skipped)', () => {
  const t = normalizeTrucks(routes, { hub: 'Miami', date: '2026-10-11' });
  assert.equal(t.length, 1);
  assert.equal(t[0].trip, '624773'); assert.equal(t[0].truck, '4504'); assert.equal(t[0].trailer, '7137');
  assert.equal(t[0].stops.length, 16); assert.equal(t[0].stops[13].consignee, 'DAVIS WHOLESALE -MACON'); assert.equal(t[0].stops[13].boxes, 256);
});

test('624773: the scanned sheet vs ARTIS — 3 box counts off by one, a stop ARTIS no longer has, the transfer truck', () => {
  const [truck] = normalizeTrucks(routes, { hub: 'Miami', date: '2026-10-11' });
  const c = compareSheet(sheet, truck);
  assert.equal(c.ok, false);
  assert.deepEqual(c.boxDiffs.map((d) => [d.customer, d.sheet, d.builder]).sort(), [
    ['FALL RIVER FLORIST SUPPLY', 168, 167], ['MID-GA WHOLESALE FLORIST LLC', 98, 97], ['SPRINGFIELD FLORIST', 81, 80]]);
  assert.deepEqual(c.onlyOnSheet.map((x) => x.customer), ['BLOSSOMS AND BLOOMS WHOLESALE INC *']);
  assert.deepEqual(c.onlyInBuilder, []);
  assert.equal(c.matched, 16);   // the Chelsea Market names, Carbone R.I. vs R.J. — all paired
  assert.deepEqual(c.truckDiff, { sheet: '734', builder: '4504' });   // handwritten transfer 734 → 4504
  assert.equal(c.trailerDiff, null);
  const mail = checkEmail(HUBS[0], '2026-10-11', [{ ...truck, check: c }]);
  assert.match(mail.subject, /Miami 10\/11: 1 truck, 1 with differences/);
  assert.match(mail.html, /MID-GA WHOLESALE FLORIST LLC<\/b> \(WARWICK\): trip sheet read <b>98<\/b> boxes — ARTIS has <b>97<\/b>/);
  assert.match(mail.html, /BLOSSOMS AND BLOOMS.*not on this truck in ARTIS/);
});

test('Jarvis uses the Truck Builder count over the scanned sheet', async () => {
  const [truck] = normalizeTrucks(routes, { hub: 'Miami', date: '2026-10-11' });
  const it = { trip: { tripNumber: '624773', powerUnit: '4504' }, _tb: truck, _manifest: sheet };
  assert.equal(builderBoxesFor(it, 'MID-GA WHOLESALE FLORIST LLC', 'WARWICK, GA'), 97);
  const { customerStops } = await import('../voice.js');
  const st = customerStops([it], 'Mid Georgia Wholesale', {}, { staff: true })[0];
  assert.equal(st.boxes_loaded, '97 boxes loaded for them');
  assert.equal(st.boxes_on_trip_sheet, undefined);   // the sheet's "98" was the scan — ARTIS's 97 is the count
});

test('when to read a hub: after that night\'s trip sheets go quiet for 20 min, else 11:30 PM — once a night', () => {
  const miami = HUBS[0];
  assert.equal(hubOfSheet(sheet), 3);
  assert.equal(hubOfSheet({ stops: [{ action: 'LOAD', customer: 'VENTURA TERMINAL', city: 'VENTURA', state: 'CA' }] }), 5);
  const at = (iso) => Date.parse(iso);
  const s = { ...sheet, uploadedAt: '2026-10-12T00:09:52Z' };   // 8:09 PM Miami
  assert.equal(dueNow(miami, { sheets: [s], now: at('2026-10-12T00:20:00Z') }), null);           // still coming in
  const due = dueNow(miami, { sheets: [s], now: at('2026-10-12T00:31:00Z') });
  assert.equal(due.night, '2026-10-11'); assert.deepEqual(due.dates, ['2026-10-11']);
  assert.equal(dueNow(miami, { state: { hubs: { 3: { night: '2026-10-11' } } }, sheets: [s], now: at('2026-10-12T01:00:00Z') }), null);   // done tonight
  assert.equal(dueNow(miami, { sheets: [], now: at('2026-10-11T20:00:00Z') }), null);             // 4 PM, nothing yet
  assert.equal(dueNow(miami, { sheets: [], now: at('2026-10-12T03:35:00Z') }), null);             // 11:35 PM — still waiting for sheets
  assert.equal(dueNow(miami, { sheets: [], now: at('2026-10-12T09:55:00Z') }), null);             // 5:55 AM
  const sixAm = dueNow(miami, { sheets: [], now: at('2026-10-12T10:00:00Z') });                   // 6 AM Miami, no sheets seen
  assert.equal(sixAm.reason, '6 AM — no trip sheets seen'); assert.equal(sixAm.night, '2026-10-11');
  // California: 6 AM Pacific (9 AM Miami), not 6 AM Miami
  assert.equal(dueNow(HUBS[1], { sheets: [], now: at('2026-10-12T10:00:00Z') }), null);
  assert.equal(dueNow(HUBS[1], { sheets: [], now: at('2026-10-12T13:00:00Z') }).night, '2026-10-11');
  assert.equal(nightOf('America/New_York', at('2026-10-12T04:30:00Z')), '2026-10-11');             // 12:30 AM is still that night
  assert.equal(dueNow(HUBS[1], { sheets: [s], now: at('2026-10-12T00:31:00Z') }), null);         // a Miami sheet doesn't start Ventura
  assert.equal(hubClock('America/Los_Angeles', at('2026-10-12T06:00:00Z')).date, '2026-10-11');
});

test('reads ARTIS read-only with one sign-in; a bad login is tried once a night and emailed, never retried', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  store['taTruckMateManifest:florida-beauty'] = { 624773: sheet };
  const calls = []; let password = 'right';
  const fetchFn = async (url, opt = {}) => {
    calls.push([opt.method || 'GET', url.replace('https://www.floridabeauty.com', '')]);
    if (opt.method === 'POST') {
      assert.equal(new URLSearchParams(opt.body).get('username'), 'me@floridabeauty.us');
      return { status: 302, headers: { getSetCookie: () => [`PLAY_SESSION=${password === 'right' ? 'ok' : 'anon'}; Path=/`], get: () => null } };
    }
    assert.ok(!/save|update|delete|close/i.test(url));
    if (opt.headers.Cookie !== 'PLAY_SESSION=ok') return { status: 302, text: async () => '<html>Please sign in</html>' };
    return { status: 200, text: async () => JSON.stringify(routes) };
  };
  const mails = []; const app = { get() {}, post() {} };
  const env = { NODE_ENV: 'test', ARTIS_WEB_USER: 'me@floridabeauty.us', ARTIS_WEB_PASSWORD: 'x' };
  const tb = initTruckBuilder(app, { requireAdmin: () => {}, db, env, fetchFn, sendMail: async (m) => mails.push(m), recipients: async () => ['dispatch@floridabeauty.us'], now: () => Date.parse('2026-10-12T00:31:00Z') });
  await tb.tick();
  assert.deepEqual(calls.map((c) => c[0]), ['POST', 'GET']);
  assert.match(calls[1][1], /^\/routes\/truck-builder\/truck-routes\/2026-10-11\?warehouseId=3/);
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /Miami 10\/11/);
  const board = [{ trip: { tripNumber: '624773' } }]; await tb.overlay('florida-beauty', board);
  assert.equal(board[0]._tb.stops.length, 16);
  await tb.tick(); assert.equal(calls.length, 2);   // once a night
  // a wrong password: one try, an email, no retry the same night
  password = 'wrong'; calls.length = 0; mails.length = 0;
  const tb2 = initTruckBuilder(app, { requireAdmin: () => {}, db: { ...db, get: async (k, d) => (k === 'taTruckBuilder:florida-beauty' ? d : db.get(k, d)) }, env, fetchFn, sendMail: async (m) => mails.push(m), recipients: async () => ['dispatch@floridabeauty.us'], now: () => Date.parse('2026-10-12T00:31:00Z') });
  await tb2.tick(); await tb2.tick();
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 1);
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /couldn't read ARTIS Truck Builder \(Miami\)/);
  assert.match(mails[0].html, /ARTIS_WEB_PASSWORD/);
});

test('624773 stops from ARTIS (order, boxes, cubes, totals) with the trip sheet\'s instructions kept', () => {
  const [truck] = normalizeTrucks(routes, { hub: 'Miami', date: '2026-10-11' });
  const withNotes = { ...sheet, pickupPlan: 'DRIVER WILL LEAVE AT 18:00', handwrittenNotes: ['TRANSFER PILOT FORT PIERCE'],
    stops: sheet.stops.map((x) => (x.customer === 'SPRINGFIELD FLORIST' ? { ...x, callAhead: [{ contact: 'ISRAEL', phone: '4138837695' }], instructions: ['DONT WAIT, OFFLOAD IN THE COOLER'], apptDate: '2026-10-13', apptTime: '08:00' } : x)) };
  const m = mergeStops(withNotes, truck);
  const del = m.stops.filter((x) => x.action === 'DELIVER');
  // delivery order = ARTIS loading order reversed: Lyons first … Medford last
  assert.equal(del[0].customer, "JOHNSON'S WHOLESALE FLORIST LLC"); assert.equal(del[0].stopNumber, 2);
  assert.equal(del.find((x) => x.customer === "CAGGIANO'S MEDFORD  *").stopNumber, 17);
  // ARTIS counts; the scan's misread kept for reference
  const midga = del.find((x) => /MID-GA/.test(x.customer));
  assert.equal(midga.pieces, 97); assert.equal(midga.sheetPieces, 98); assert.equal(midga.from, 'ARTIS + trip sheet');
  // the sheet's instructions stay on the stop
  const spf = del.find((x) => x.customer === 'SPRINGFIELD FLORIST');
  assert.deepEqual(spf.callAhead, [{ contact: 'ISRAEL', phone: '4138837695' }]); assert.equal(spf.apptTime, '08:00'); assert.equal(spf.pieces, 80);
  // the stop ARTIS no longer has stays, marked
  assert.equal(del.find((x) => /BLOSSOMS/.test(x.customer)).notInArtis, true);
  // truck totals from ARTIS; trip-wide notes from the sheet
  assert.equal(m.stops[0].action, 'LOAD'); assert.equal(m.stops[0].pieces, 1778); assert.equal(m.stops[0].sheetPieces, 1863);
  assert.equal(m.artis.boxes, 1778); assert.equal(m.pickupPlan, 'DRIVER WILL LEAVE AT 18:00'); assert.deepEqual(m.handwrittenNotes, ['TRANSFER PILOT FORT PIERCE']);
  // no trip sheet yet → ARTIS alone gives the trip its stops
  const only = mergeStops(null, truck);
  assert.equal(only.artisOnly, true); assert.equal(only.stops.length, 17); assert.equal(only.stops[1].customer, "JOHNSON'S WHOLESALE FLORIST LLC");
});

// real 10/09–10/10 examples: Produce Junction 811 boxes + 2 pallets on one truck; Pyramid split 486 boxes / 4 pallets
// between trips 624715 and 624720 ("PYRAMID - SPLIT"); Ventura Bay State 52 on 624743 + 140 on a truck not assigned yet
test('one stop per customer per truck (box + pallet lines); split customers carry the other trailers\' share; comments kept', () => {
  const pj = combineStops([{ stopOrder: 2, consigneeId: '00084', consigneeName: 'PRODUCE JUNCTION >>>>', consigneeCity: 'SWEDESBORO', boxes: 2, cubes: 200, packType: 'PALLET' },
    { stopOrder: 3, consigneeId: '00084', consigneeName: 'PRODUCE JUNCTION >>>>', consigneeCity: 'SWEDESBORO', boxes: 811, cubes: 1197.44, packType: 'BOX' },
    { stopOrder: 1, consigneeId: '50381', consigneeName: 'THE FLOWER BUCKET', consigneeCity: 'FAYETTEVILLE', boxes: 26, cubes: 38.94, packType: 'BOX' }]);
  assert.equal(pj.length, 2);
  assert.deepEqual([pj[1].consignee, pj[1].boxes, pj[1].pallets, pj[1].cubes, pj[1].order], ['PRODUCE JUNCTION >>>>', 811, 2, 1397.44, 2]);
  const truck = (trip, no, stops, comments = '') => ({ routeTrucks: [{ truckId: no, trailerId: 'T' + no, truckInfo: trip ? { tripNumber: trip, comments } : { comments }, truckRouteStops: stops }] });
  const routes = [truck(624715, '725', [{ stopOrder: 1, consigneeId: '03017', consigneeName: 'PYRAMID', consigneeCity: 'X', boxes: 486, packType: 'BOX' }], 'PYRAMID - SPLIT'),
    truck(624720, '2606', [{ stopOrder: 1, consigneeId: '03017', consigneeName: 'PYRAMID', consigneeCity: 'X', boxes: 4, packType: 'PALLET' }], 'PYRAMID - SPLIT'),
    truck(624743, '736', [{ stopOrder: 1, consigneeId: '02273', consigneeName: 'BAY STATE FLORAL- WILMINGTON', consigneeCity: 'WILMINGTON', boxes: 52, packType: 'BOX', splitStop: true }]),
    truck(null, '', [{ stopOrder: 1, consigneeId: '02273', consigneeName: 'BAY STATE FLORAL- WILMINGTON', consigneeCity: 'WILMINGTON', boxes: 140, packType: 'BOX', splitStop: true }])];
  const withTrip = normalizeTrucks(routes, { hub: 'Miami', date: '2026-10-09' });
  assert.equal(withTrip.length, 3);
  markSplits(withTrip, [...withTrip, ...normalizeTrucks(routes, { all: true }).filter((t) => !t.trip)]);
  const [p715, p720, bay] = withTrip;
  assert.equal(p715.comments, 'PYRAMID - SPLIT');
  assert.equal(splitNote(p715.stops[0]), 'Split between trailers: 486 boxes on this truck; 4 pallets on trip 624720 (truck 2606, trailer T2606).');
  assert.equal(splitNote(p720.stops[0]), 'Split between trailers: 4 pallets on this truck; 486 boxes on trip 624715 (truck 725, trailer T725).');
  assert.equal(splitNote(bay.stops[0]), 'Split between trailers: 52 boxes on this truck; 140 boxes on a truck not assigned yet.');
  // the trip carries the split and the comment; the nightly email shows both
  const m = mergeStops(null, p715);
  assert.equal(m.stops[1].split, true); assert.equal(m.artis.comments, 'PYRAMID - SPLIT');
  const mail = checkEmail(HUBS[0], '2026-10-09', withTrip.map((t) => ({ ...t, check: null })));
  assert.match(mail.html, /ARTIS comment: <i>PYRAMID - SPLIT<\/i>/);
  assert.match(mail.html, /BAY STATE FLORAL- WILMINGTON<\/b> \(WILMINGTON\): Split between trailers: 52 boxes on this truck; 140 boxes on a truck not assigned yet/);
});

test('ARTIS boxes for a split customer: this truck\'s share, missing flagged as either trailer', async () => {
  const { loadBoxes } = await import('../artis.js');
  const it = { trip: { tripNumber: '624743', status: 'LOADEDTOGO' }, _times: { statusHistory: [{ status: 'LOADINGMAN', at: '2026-10-09T18:00:00Z' }] },
    freightBills: [{ billToName: 'BAY STATE FLORAL- WILMINGTON', consignee: { clientId: '02273' } }],
    _tb: { stops: [{ consigneeId: '02273', consignee: 'BAY STATE FLORAL- WILMINGTON', boxes: 52, split: true, splitWith: [{ trip: null, boxes: 140 }] }] } };
  // ARTIS received 186 of the customer's 192 (both trailers) → this truck: 52 boxes, 6 not received on either trailer
  const b = loadBoxes(it, (d) => (d === '2026-10-09' ? [{ consigneeId: '02273', consignee: 'BAY STATE FLORAL- WILMINGTON', boxes: 192, scanned: 186, missing: 6, shippers: [] }] : null), Date.parse('2026-10-09T22:00:00Z'));
  assert.equal(b.stops[0].boxes, 52); assert.equal(b.stops[0].missing, 6);
  assert.match(b.stops[0].split, /52 on this truck, 140 on a truck not assigned yet — 6 not received for this customer could be on either trailer/);
  assert.match(b.alert, /\(split — could be on the other trailer\)/);
  assert.deepEqual(b.sheetDiffs, []);
});

test('same customer, different city = a different stop (not combined, not a split); same city on another truck = split', () => {
  const st = combineStops([{ stopOrder: 1, consigneeId: '01821', consigneeName: 'CARBONE R.J CO.', consigneeCity: 'CHELSEA', boxes: 190, packType: 'BOX' },
    { stopOrder: 2, consigneeId: '01821', consigneeName: 'CARBONE R.J CO.', consigneeCity: 'DERRY', boxes: 132, packType: 'BOX' },
    { stopOrder: 3, consigneeId: '01821', consigneeName: 'CARBONE R.J CO.', consigneeCity: 'CHELSEA', boxes: 1, packType: 'PALLET' }]);
  assert.deepEqual(st.map((x) => [x.city, x.boxes, x.pallets]), [['CHELSEA', 190, 1], ['DERRY', 132, 0]]);
  const t = (trip, city, boxes) => ({ trip, truck: trip, stops: [{ consigneeId: '01821', consignee: 'CARBONE R.J CO.', city, boxes, pallets: 0 }] });
  const a = t('1', 'CHELSEA', 190); const b = t('2', 'DERRY', 132); const c = t('3', 'CHELSEA', 40);
  markSplits([a, b, c]);
  assert.equal(b.stops[0].split, undefined);                         // Derry is another location
  assert.equal(a.stops[0].split, true); assert.deepEqual(a.stops[0].splitWith.map((x) => x.trip), ['3']);   // Chelsea on two trucks
});

// Bay State Wilmington: ARTIS flags split on Ventura 10/08 (150, no truck yet) and on 10/09 (52 on 624743 + 140)
test('a flagged split whose other part is on another night or hub is found; a normal daily delivery is not a split', () => {
  const stop = (o) => ({ consigneeId: '02273', consignee: 'BAY STATE FLORAL- WILMINGTON', city: 'WILMINGTON', boxes: 0, pallets: 0, ...o });
  const t624743 = { trip: '624743', truck: '736', hub: 'Ventura', date: '2026-10-09', stops: [stop({ boxes: 52, split: true, splitWith: [], hub: 'Ventura', date: '2026-10-09' })] };
  const other = [
    { trip: '624800', truck: '2219', hub: 'Ventura', date: '2026-10-10', stops: [stop({ boxes: 140, split: true })] },
    { trip: '624801', truck: '2220', hub: 'Miami', date: '2026-10-10', stops: [stop({ boxes: 300 })] },   // a normal delivery, not flagged
  ];
  resolveFlaggedSplits([t624743], other);
  assert.deepEqual(t624743.stops[0].splitWith.map((x) => x.trip), ['624800']);
  assert.equal(splitNote(t624743.stops[0]), 'Split between trailers: 52 boxes on this truck; 140 boxes on trip 624800 (truck 2219, 10/10).');
});

// backfill 10/13: Pyramid (624720) 4 pallets, Foodland (624762) 4 pallets — the sheet prints "4 PLTS"
test('a pallet-only stop compares pallets, not "0 boxes"', () => {
  const truck = { trip: '624720', truck: '2606', trailer: '7288', stops: [{ order: 1, consigneeId: '03017', consignee: 'PYRAMID FLOWERS, INC.-OXNARD', city: 'OXNARD', boxes: 0, pallets: 4, cubes: 400 }], boxes: 0, cubes: 400 };
  const sh = (n) => ({ stops: [{ action: 'DELIVER', customer: 'PYRAMID FLOWERS, INC.-OXNARD', city: 'OXNARD', pieces: n }] });
  assert.equal(compareSheet(sh(4), truck).ok, true);
  const off = compareSheet(sh(5), truck);
  assert.deepEqual(off.boxDiffs, [{ customer: 'PYRAMID FLOWERS, INC.-OXNARD', city: 'OXNARD', sheet: 5, builder: 4, unit: 'pallets' }]);
  assert.match(checkEmail(HUBS[0], '2026-10-09', [{ ...truck, check: off }]).html, /read <b>5<\/b> pallets — ARTIS has <b>4<\/b>/);
  const m = mergeStops(sh(4), truck);
  assert.equal(m.stops[1].piecesText, '4 PALLETS'); assert.equal(m.stops[1].pieces, 4); assert.equal(m.stops[1].sheetPieces, undefined);
  assert.equal(builderBoxesFor({ _tb: truck }, 'PYRAMID FLOWERS, INC.-OXNARD', 'OXNARD'), null);
});

// California's trip sheets came at 7:35 AM PT (forwarded 9:01 AM ET), after the 6 AM read with no sheets
test('sheets that come after the 6 AM read → read ARTIS once more for that night', () => {
  const ventura = HUBS[1];
  const sixAmRun = { hubs: { 5: { night: '2026-10-12', at: '2026-10-13T13:01:56Z', reason: '6 AM — no trip sheets seen' } } };
  const sheet = { uploadedAt: '2026-10-13T14:40:00Z', dateLoaded: '2026-10-12', stops: [{ action: 'LOAD', customer: 'VENTURA TERMINAL', city: 'VENTURA', state: 'CA' }] };
  assert.equal(dueNow(ventura, { state: sixAmRun, sheets: [sheet], now: Date.parse('2026-10-13T14:50:00Z') }), null);      // still coming in
  const due = dueNow(ventura, { state: sixAmRun, sheets: [sheet], now: Date.parse('2026-10-13T15:01:00Z') });
  assert.equal(due.late, true); assert.equal(due.night, '2026-10-12'); assert.match(due.reason, /came in after 6 AM/);
  assert.equal(dueNow(ventura, { state: { hubs: { 5: { ...sixAmRun.hubs[5], lateSheets: true } } }, sheets: [sheet], now: Date.parse('2026-10-13T16:00:00Z') }), null);   // only once
  assert.equal(dueNow(ventura, { state: { hubs: { 5: { night: '2026-10-12', at: '2026-10-13T05:00:00Z', reason: '3 trip sheets read' } } }, sheets: [sheet], now: Date.parse('2026-10-13T16:00:00Z') }), null);   // normal night: done
});

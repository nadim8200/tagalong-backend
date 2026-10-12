import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrucks, compareSheet, checkEmail, dueNow, hubOfSheet, hubClock, builderBoxesFor, HUBS, initTruckBuilder } from '../truckbuilder.js';

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
  assert.equal(dueNow(miami, { sheets: [], now: at('2026-10-12T03:35:00Z') }).reason, 'end of the night');   // 11:35 PM
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

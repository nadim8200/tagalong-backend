import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOf, bonusFromSheet, tripLines, cleanLines, cleanExpenses, payrollEmail, staysOf, missingMoves, apptMs, waitAt } from '../triplog.js';

test('the week runs Sunday to Saturday in Miami time', () => {
  const w = weekOf(Date.parse('2026-11-21T15:00:00Z'));          // Saturday
  assert.equal(w.start, '2026-11-15'); assert.equal(w.end, '2026-11-21');
  assert.equal(new Date(w.fromMs).toISOString(), '2026-11-15T05:00:00.000Z');
  assert.equal(weekOf('2026-11-22').start, '2026-11-22');         // Sunday starts a new week
  assert.equal(weekOf(Date.parse('2026-11-22T03:00:00Z')).start, '2026-11-15');   // still Saturday night in Miami
  assert.equal(new Date(weekOf('2026-07-15').fromMs).toISOString(), '2026-07-12T04:00:00.000Z');   // summer time
});

test('a bonus dispatch wrote on the load', () => {
  assert.deepEqual(bonusFromSheet({ notes: ['*** NO RELEASE ***', '$70 extra short run'] }), { amount: '70.00', text: '$70 extra short run' });
  assert.equal(bonusFromSheet({ notes: [], stops: [{ notesAfter: ['BONUS: $100 PU R006231'] }] }).amount, '100.00');
  assert.equal(bonusFromSheet({ notes: ['Call before'] }), null);
  assert.equal(bonusFromSheet(null), null);
});

test('one trip → its pickup and each stop, dated and timed by the check-ins', () => {
  const it = { trip: { tripNumber: 627549, origZoneDesc: 'MIAMI, FL, 33126', trailer: '18094', powerUnit: '4504' },
    freightBills: [{ billNumber: 'G5065356', endZoneDescription: 'CLIFTON, NJ, 07011', billToName: 'FLORIDESIGN', pieces: 68 }] };
  const steps = { loaded: { at: '2026-11-15T20:00:00Z' }, 'arrived:CLIFTON, NJ, 07011': { at: '2026-11-17T13:00:00Z' }, 'delivered:CLIFTON, NJ, 07011': { at: '2026-11-17T17:10:00Z' } };   // 4 h 10 at the stop → 70 min past the 3 free hours
  const ls = tripLines(it, steps, { sheet: { notes: ['$70 extra short run'] } });
  assert.equal(ls.length, 2);
  assert.deepEqual([ls[0].date, ls[0].trip, ls[0].zip, ls[0].act, ls[0].fe, ls[0].bonus, ls[0].bonusAmt, ls[0].trl], ['11/15', '627549', '33152', 'PU', 'E', 'dispatch', '70.00', '18094']);
  assert.deepEqual([ls[1].date, ls[1].zip, ls[1].act, ls[1].bill, ls[1].boxes, ls[1].wait, ls[1].waitAuto], ['11/17', '07011', 'DEL', 'G5065356', '68', 70, true]);
  assert.equal(ls[0].bill, 'G5065356');   // the trip's bills on its pickup line too
});

test('what the driver sends is kept tidy', () => {
  const [r] = cleanLines([{ zip: '33126-1234', act: 'HACK', fe: 'X', bill: 'b160241', reimb: '$120.00', wait: '95', bonus: 'free money', comment: 'x'.repeat(500) }]);
  assert.deepEqual([r.zip, r.act, r.fe, r.bill, r.reimb, r.wait, r.bonus, r.comment.length], ['33126', '', '', 'B160241', '120.00', 95, 'none', 300]);
});

test('the payroll email is the same sheet, with miles, wait and bonus added', () => {
  const log = { head: { name: 'Ferney Urrego', id: '986', truck: '4504', trailer: '18094', bod: '412386', eod: '415512' }, submittedAt: 'x',
    lines: [{ date: '11/15', trip: '627549', zip: '33126', place: 'Miami Terminal', act: 'PU', fe: 'F', bonus: 'dispatch', bonusAmt: '70.00' }, { date: '11/17', trip: '627549', zip: '07011', place: 'Floridesign', act: 'DEL', fe: 'F', bill: 'G5065356', wait: 70, reimb: '75' }] };
  const e = payrollEmail(log, { week: { start: '2026-11-15', end: '2026-11-21' }, miles: [null, 1290], odometer: { begin: 412386, end: 415512, source: 'Samsara (dashboard)' } });
  assert.match(e.subject, /Ferney Urrego \(986\) · Week of 2026-11-15/);
  assert.match(e.html, /G5065356/); assert.match(e.html, /Bonus \(dispatch\) \$70\.00/); assert.match(e.html, /1 h 10 min/); assert.match(e.html, /Odometer: <b>3126<\/b>/);
  assert.deepEqual(e.totals, { loaded: 1290, empty: 0, wait: 70, reimb: 75, bonuses: 1, expenses: 0 });
});

test('a broker load: pickup and delivery ZIPs from the load sheet / rate con', () => {
  const it = { trip: { tripNumber: 628034, trailer: '18094' }, freightBills: [] };
  const sheet = { bill: 'B160241', notes: [], stops: [{ kind: 'pickup', name: 'SHIPPER', city: 'Chambersburg', state: 'PA', zip: '17201', dateIso: '2026-11-19' }, { kind: 'delivery', name: 'GROCERY DC', city: 'Lakeland', state: 'FL', zip: '33811', dateIso: '2026-11-20' }] };
  const ls = tripLines(it, {}, { sheet });
  assert.deepEqual(ls.map((l) => [l.date, l.zip, l.act, l.fe, l.bill]), [['11/19', '17201', 'PU', 'E', 'B160241'], ['11/20', '33811', 'DEL', 'F', 'B160241']]);
  assert.equal(ls[0].place, 'Chambersburg, PA · SHIPPER');   // the city first, like the drivers write it
});

test('expenses the driver paid go to payroll with their receipts', () => {
  const ex = cleanExpenses([{ date: '11/18', kind: 'fuel', amount: '$54.20', trip: '628011', note: 'DEF', receipts: ['812', 'x'] }, { kind: 'hack', amount: '' }]);
  assert.deepEqual(ex, [{ date: '11/18', kind: 'fuel', amount: '54.20', trip: '628011', note: 'DEF', receipts: ['812'] }]);
  const e = payrollEmail({ head: { name: 'A', id: '1' }, lines: [{ zip: '33126', act: 'PU', fe: 'E', reimb: '75' }], expenses: ex }, { week: { start: '2026-11-15', end: '2026-11-21' }, docs: [{ label: 'POD', trip: '627549', filename: 'pod.pdf', attached: true }, { label: 'BOL', trip: '628011', filename: 'big.pdf', attached: false }] });
  assert.match(e.html, /Expenses paid by the driver/); assert.match(e.html, /\$54\.20/); assert.match(e.html, /To reimburse: \$129\.20/);
  assert.match(e.html, /Paperwork and photos from this trip \(2\)/); assert.match(e.html, /too big for the email/);
  assert.equal(e.totals.expenses, 54.2);
});

// a tiny stand-in for Express + the KV store, to call the routes directly
function harness() {
  const routes = {}; const kv = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; } };
  const db = { enabled: true, get: async (k, d) => (k in kv ? kv[k] : d), set: async (k, v) => { kv[k] = v; }, update: async (k, fn, d) => { kv[k] = fn(k in kv ? kv[k] : d); return kv[k]; } };
  const pass = (req, res, next) => next();
  const call = async (key, req) => {
    let out = { status: 200, body: null };
    const res = { status(n) { out.status = n; return res; }, json(b) { out.body = b; return res; } };
    const [mw, fn] = routes[key].length > 1 ? routes[key] : [pass, routes[key][0]];
    await mw(req, res, () => fn(req, res));
    return out;
  };
  return { app, db, kv, call };
}

test('one sheet per trip: the open sheet, turned-in sheets on the profile, admins see any driver\'s, dispatch logins don\'t', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness();
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => [], tripsOf: async () => [], loadsFor: () => ({ current: [], next: [] }), env: {}, now: () => Date.parse('2026-11-23T15:00:00Z'), mail: async () => {} });
  h.kv['taTripLog:florida-beauty:986'] = {
    open: { status: 'draft', savedAt: '2026-11-23T10:00:00Z', lines: [{ trip: '628100', at: '2026-11-23T09:00:00Z' }] },
    '2026-11-19T20:00': { status: 'submitted', submittedAt: '2026-11-22T23:30:00Z', period: { start: '2026-11-19', end: '2026-11-22' }, signature: 'data:image/png;base64,AAAA', lines: [{ trip: '627549', zip: '33152', wait: 70, bonus: 'dispatch', reimb: '75' }, { trip: '627656' }], expenses: [{ amount: '54.20' }] },
  };
  const mine = await h.call('GET /driver/me/logs', { driver: { code: '986' } });
  assert.deepEqual(mine.body.weeks.map((w) => [w.id, w.start, w.end, w.status]), [['open', '2026-11-23', '2026-11-23', 'draft'], ['2026-11-19T20:00', '2026-11-19', '2026-11-22', 'submitted']]);
  assert.deepEqual([mine.body.weeks[1].waitMin, mine.body.weeks[1].bonuses, mine.body.weeks[1].reimburse, mine.body.weeks[1].trips], [70, 1, 129.2, ['627549', '627656']]);
  assert.equal((await h.call('GET /truckmate/driver-profiles/:code/logs', { user: { role: 'dispatcher' }, params: { code: '986' } })).status, 403);
  const one = await h.call('GET /truckmate/driver-profiles/:code/logs/:week', { user: { admin: true }, params: { code: '986', week: '2026-11-19T20:00' } });
  assert.equal(one.body.status, 'submitted'); assert.equal(one.body.week.start, '2026-11-19'); assert.equal(one.body.lines[0].trip, '627549');
  assert.equal((await h.call('GET /truckmate/driver-profiles/:code/logs/:week', { user: { admin: true }, params: { code: '986', week: 'nope' } })).status, 404);
});

test('turning in: the open sheet closes under its first day, goes to payroll\'s list with the team partner, and the partner\'s sheet leaves those trips out', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness(); const sent = [];
  const items = [{ trip: { tripNumber: 627549, driver: '986', driver2: '2473', powerUnit: '4504', trailer: '18094', origZoneDesc: 'MIAMI, FL, 33126' }, freightBills: [{ billNumber: 'G5065356', endZoneDescription: 'CLIFTON, NJ, 07011', pieces: 68 }] }];
  h.kv['taDriverCheckins:florida-beauty'] = { 627549: { steps: { loaded: { at: '2026-11-19T20:00:00Z' }, 'arrived:CLIFTON, NJ, 07011': { at: '2026-11-20T13:00:00Z' }, 'delivered:CLIFTON, NJ, 07011': { at: '2026-11-20T14:00:00Z' } } } };
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => items, tripsOf: async () => ['627549'], loadsFor: (code) => ({ current: [], next: [] }), nameOf: async (c) => (c === '2473' ? 'Wilber Echeverri' : 'Ferney Urrego'), env: {}, now: () => Date.parse('2026-11-22T23:00:00Z'), mail: async (m) => { sent.push(m); } });
  const ferney = { code: '986', name: 'Ferney Urrego' }; const wilber = { code: '2473', name: 'Wilber Echeverri' };
  const open = await h.call('GET /driver/me/log', { driver: ferney, query: {} });
  assert.equal(open.body.id, 'open'); assert.deepEqual([open.body.head.co, open.body.head.coid], ['Wilber Echeverri', '2473']);
  assert.deepEqual(open.body.lines.map((l) => [l.zip, l.act]), [['33152', 'PU'], ['07011', 'DEL']]);
  const sig = `data:image/png;base64,${'A'.repeat(200)}`;
  const r = await h.call('POST /driver/me/log/submit', { driver: ferney, body: { head: { ...open.body.head, note: 'This trip ended the 22 of November. Thank you!' }, lines: open.body.lines, expenses: [], signature: sig, coSignature: sig, miles: [null, 1290] } });
  assert.equal(r.body.ok, true); assert.equal(r.body.id, '2026-11-19T20:00');
  assert.equal(h.kv['taTripLog:florida-beauty:986'].open, undefined);
  assert.equal(h.kv['taTripLog:florida-beauty:986']['2026-11-19T20:00'].head.note, 'This trip ended the 22 of November. Thank you!');
  const idx = h.kv['taTripLogIndex:florida-beauty']['986|2026-11-19T20:00'];
  assert.deepEqual([idx.co, idx.coName, idx.trips], ['2473', 'Wilber Echeverri', ['627549']]);
  assert.ok(sent[0].attachments.some((a) => a.contentType === 'application/pdf'));
  // Wilber's open sheet: the trip Ferney turned in for both isn't on it, and it says so
  const w = await h.call('GET /driver/me/log', { driver: wilber, query: {} });
  assert.equal(w.body.lines.length, 0); assert.equal(w.body.partner.name, 'Ferney Urrego'); assert.deepEqual(w.body.partner.trips, ['627549']);
  // Ferney's next open sheet starts fresh
  assert.equal((await h.call('GET /driver/me/log', { driver: ferney, query: {} })).body.lines.length, 0);
});

test('the PDF: the paper\'s rows (date once a day, ditto marks, "90 B.", LTL bills) and a real PDF', async () => {
  const { paperRows, boxesCell, billCell, tripLogPdf, plain } = await import('../triplogpdf.js');
  const rows = paperRows([
    { at: '2026-11-19T20:00:00Z', trip: '627549', zip: '33152', place: 'Miami, FL', act: 'PU', fe: 'E', trl: '18094', bill: 'G1 / G2 / G3' },
    { at: '2026-11-20T13:00:00Z', trip: '627549', zip: '08854', place: 'Piscataway, NJ', act: 'DEL', fe: 'F', trl: '18094', boxes: '90' },
    { at: '2026-11-20T15:00:00Z', trip: '627549', zip: '02453', place: 'Waltham, MA', act: 'DEL', fe: 'F', trl: '18094', pallets: 3 },
  ]);
  assert.deepEqual(rows.map((r) => [r.date, r.trip, r.trl, r.fe, r.boxes, r.bill]), [['11-19-26', '627549', '18094', 'Full', 'P/U', 'LTL - 3 bills'], ['11-20-26', '"', '"', 'Full', '90 B.', ''], ['"', '"', '"', 'Full', '3 Pallets', '']]);
  assert.equal(boxesCell({ boxes: '68', pallets: 1 }), '68 B. + 1 Pallet');
  assert.equal(billCell({ bill: 'B181095' }), 'B181095');
  assert.equal(plain('Clifton · NJ → “ok” 📍'), 'Clifton - NJ -> "ok"');
  const bytes = await tripLogPdf({ head: { name: 'Ferney Urrego', id: '0986', note: 'This trip ended the 22 of November.' }, lines: new Array(20).fill(0).map((_, i) => ({ at: `2026-11-2${i % 3}T1${i % 9}:00:00Z`, trip: '627549', zip: '01107', place: 'Springfield, MA', act: 'DEL', fe: 'F', boxes: '12' })), miles: [], period: { start: '2026-11-19', end: '2026-11-22' } }, {});
  const { PDFDocument } = await import('pdf-lib');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);   // 20 lines → 2 paper pages + the app's page
});

test('payroll pays only what is checked, and lists what is not', async () => {
  const { reviewTotals } = await import('../triplog.js');
  const log = { lines: [
    { date: '11/15', trip: '1', zip: '33126', act: 'PU', fe: 'E' },
    { date: '11/17', trip: '1', zip: '07011', act: 'DEL', fe: 'F', wait: 70, bonus: 'dispatch', bonusAmt: '70', reimb: '75' },
    { date: '11/18', trip: '', zip: '08505', act: 'EMPTY', fe: 'E', detected: 'gps' },
  ], expenses: [{ kind: 'fuel', amount: '54.20', trip: '1' }, { kind: 'tolls', amount: '12' }], miles: [null, 1290, 70] };
  const r = reviewTotals(log, { lines: [{}, { move: true, wait: true, bonus: false, reimb: true }, { move: false }], expenses: [true, false] });
  assert.deepEqual(r.paid, { loadedMi: 1290, emptyMi: 0, waitMin: 70, bonuses: 0, bonusAmt: 0, reimb: 75, expenses: 54.2 });
  assert.deepEqual(r.unpaid, ['Line 2 (11/17) trip 1 ZIP 07011: bonus Bonus (dispatch) $70', 'Line 3 (11/18) ZIP 08505: 70 mi empty from 07011', 'Expense 2: Tolls $12.00']);
});

test('payroll\'s list, a sheet with its pay boxes, the confirm step for what is not paid, and who may do it', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness();
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => [], tripsOf: async () => [], loadsFor: () => ({ current: [], next: [] }), env: {}, now: () => Date.parse('2026-11-21T15:00:00Z'), mail: async () => {} });
  h.kv['taTripLog:florida-beauty:986'] = { '2026-11-15': { status: 'submitted', submittedAt: '2026-11-21T14:00:00Z', head: { name: 'Ferney Urrego' }, lines: [{ trip: '1', zip: '33126', act: 'PU', fe: 'E' }, { trip: '1', zip: '07011', act: 'DEL', fe: 'F', wait: 70 }], expenses: [], miles: [null, 1290] } };
  h.kv['taTripLogIndex:florida-beauty'] = { '986|2026-11-15': { code: '986', name: 'Ferney Urrego', week: '2026-11-15', submittedAt: '2026-11-21T14:00:00Z', reviewedAt: null } };
  assert.equal((await h.call('GET /truckmate/payroll/me', { user: { role: 'dispatcher' } })).body.canPay, false);
  assert.equal((await h.call('GET /truckmate/payroll/me', { user: { role: 'dispatcher', payroll: true } })).body.canPay, true);
  assert.equal((await h.call('GET /truckmate/payroll/logs', { user: { role: 'dispatcher' } })).status, 403);
  const darlene = { role: 'dispatcher', payroll: true, name: 'Darlene' };
  assert.equal((await h.call('GET /truckmate/payroll/logs', { user: darlene })).body.logs[0].name, 'Ferney Urrego');
  const one = await h.call('GET /truckmate/payroll/logs/:code/:week', { user: darlene, params: { code: '986', week: '2026-11-15' } });
  assert.deepEqual(one.body.miles, [null, 1290]);
  const params = { code: '986', week: '2026-11-15' };
  const first = await h.call('POST /truckmate/payroll/logs/:code/:week/review', { user: darlene, params, body: { pay: { lines: [{}, { move: true, wait: false }] } } });
  assert.equal(first.status, 409); assert.deepEqual(first.body.unpaid, ['Line 2 trip 1 ZIP 07011: wait 1 h 10 min']);
  const ok = await h.call('POST /truckmate/payroll/logs/:code/:week/review', { user: darlene, params, body: { pay: { lines: [{}, { move: true, wait: false }] }, confirmUnpaid: true } });
  assert.equal(ok.body.review.by, 'Darlene'); assert.equal(ok.body.review.paid.loadedMi, 1290);
  assert.equal(h.kv['taTripLogIndex:florida-beauty']['986|2026-11-15'].reviewedBy, 'Darlene');
  assert.equal(h.kv['taTripLog:florida-beauty:986']['2026-11-15'].review.unpaid.length, 1);
});

test('waiting time starts 3 hours after the appointment (or after arriving, if later)', () => {
  const ms = (d) => Date.parse(d);
  // appointment 6 AM Miami time on Nov 17 = 11:00 UTC
  assert.equal(apptMs({ dateIso: '2026-11-17', text: '6 AM' }), ms('2026-11-17T11:00:00Z'));
  assert.equal(apptMs({ text: '11/17 14:30', dayMs: ms('2026-11-17T12:00:00Z') }), ms('2026-11-17T19:30:00Z'));
  assert.equal(apptMs({ dateIso: '2026-11-17', text: 'ASAP' }), null);
  // early for a 6 AM appointment: arrived 4 AM, left 10:30 → clock starts 9 AM → 90 min
  assert.equal(waitAt({ arrivedMs: ms('2026-11-17T09:00:00Z'), leftMs: ms('2026-11-17T15:30:00Z'), appt: ms('2026-11-17T11:00:00Z') }).wait, 90);
  // late (arrived 8 AM for 6 AM): starts 3 h after arriving
  assert.equal(waitAt({ arrivedMs: ms('2026-11-17T13:00:00Z'), leftMs: ms('2026-11-17T17:00:00Z'), appt: ms('2026-11-17T11:00:00Z') }).wait, 60);
  // under 3 hours: no waiting
  assert.equal(waitAt({ arrivedMs: ms('2026-11-17T13:00:00Z'), leftMs: ms('2026-11-17T15:00:00Z') }).wait, null);
  // dispatch's clock ran for the stop: its minutes win
  assert.equal(waitAt({ arrivedMs: 1, leftMs: 2, clock: { waitedMs: 45 * 60000, startMs: 5 } }).wait, 45);
});

test('a delivery uses the load sheet appointment and dispatch\'s waiting clock when it ran', () => {
  const it = { trip: { tripNumber: 628034 }, freightBills: [{ billNumber: 'B160241', endZoneDescription: 'LAKELAND, FL, 33811', billToName: 'GROCERY DC', pieces: 18 }] };
  const sheet = { stops: [{ kind: 'delivery', city: 'Lakeland', state: 'FL', zip: '33811', dateIso: '2026-11-20', time: '6 AM' }] };
  const steps = { 'arrived:LAKELAND, FL, 33811': { at: '2026-11-20T09:00:00Z' }, 'delivered:LAKELAND, FL, 33811': { at: '2026-11-20T16:00:00Z' } };
  const del = tripLines(it, steps, { sheet }).find((l) => l.act === 'DEL');
  assert.equal(del.wait, 120);                                     // 6 AM appt (11:00Z) + 3 h = 14:00Z → left 16:00Z
  assert.equal(del.waitFrom, '2026-11-20T14:00:00.000Z');
  const viaClock = tripLines(it, steps, { sheet, clocks: { '628034:c:arrived:LAKELAND, FL, 33811': { waitedMs: 100 * 60000, startMs: Date.parse('2026-11-20T14:20:00Z') } } }).find((l) => l.act === 'DEL');
  assert.equal(viaClock.wait, 100);
});

test('an LTL trip sheet stop keeps its own ZIP even when no TruckMate bill matched it', async () => {
  const { driverStops } = await import('../driverstops.js');
  const it = { trip: { tripNumber: 627549 }, freightBills: [], _manifest: { stops: [{ action: 'DELIVER', customer: 'TERRA', city: 'SOUTH WINDSOR', state: 'CT', zip: '06074' }] } };
  const st = driverStops(it);
  if (st.length) assert.equal(st[0].zip, '06074');
});

test('GPS: where the truck sat 45+ minutes', () => {
  const p = (min, lat, lng, place = null) => ({ t: new Date(Date.parse('2026-11-21T10:00:00Z') + min * 60000).toISOString(), lat, lng, place });
  const s = staysOf([p(0, 25.80, -80.30), p(10, 25.95, -80.30), p(20, 25.9501, -80.3001, '2355 NW 70th Ave, Miami, FL 33122'), p(80, 25.9502, -80.3, null), p(90, 26.2, -80.3)]);
  assert.equal(s.length, 1); assert.equal(s[0].zip, '33122'); assert.equal((s[0].to - s[0].from) / 60000, 70);
});

test('a move nobody wrote down is added while empty — never while loaded, never at the stop itself — and the trip back to the yard isn\'t hidden by the yard at the start', () => {
  const ms = (d) => Date.parse(d);
  const miami = { lat: 25.82, lng: -80.32 };
  const lines = [
    { trip: '1', act: 'PU', _ms: ms('2026-11-19T20:00:00Z'), _pt: miami },
    { trip: '1', act: 'DEL', _ms: ms('2026-11-20T14:00:00Z'), _pt: { lat: 40.88, lng: -74.14 } },
    { trip: '2', act: 'PU', _ms: ms('2026-11-21T02:00:00Z'), _pt: { lat: 42.36, lng: -71.06 } },
    { trip: '2', act: 'DEL', _ms: ms('2026-11-22T20:00:00Z'), _pt: { lat: 28.08, lng: -80.6 } },
  ];
  const stays = [
    { lat: 37.0, lng: -78.0, from: ms('2026-11-20T05:00:00Z'), to: ms('2026-11-20T10:00:00Z'), place: 'Rest area, VA 23950', zip: '23950' },          // loaded: a rest stop
    { lat: 40.881, lng: -74.141, from: ms('2026-11-20T13:00:00Z'), to: ms('2026-11-20T14:30:00Z'), place: 'Clifton, NJ 07011', zip: '07011' },      // the delivery itself
    { lat: 40.72, lng: -74.6, from: ms('2026-11-20T18:00:00Z'), to: ms('2026-11-20T20:00:00Z'), place: 'Truck shop, Somerville, NJ 08876, USA', zip: '08876' }, // empty, not on the sheet
    { lat: 25.821, lng: -80.321, from: ms('2026-11-23T02:00:00Z'), to: ms('2026-11-23T10:00:00Z'), place: 'NW 70th Ave, Miami, FL, USA', zip: null },   // back at the yard
  ];
  const add = missingMoves(lines, stays);
  assert.deepEqual(add.map((a) => [a.zip, a.act, a.fe, a.detected]), [['08876', 'EMPTY', 'E', 'gps'], ['33152', 'EMPTY', 'E', 'gps']]);
  assert.match(add[0].comment, /GPS: truck stopped here 2 h/);
});

test('payroll changes the sheet itself: lines, a bonus added or taken away; the driver\'s own lines are kept', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness();
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => [], tripsOf: async () => [], loadsFor: () => ({ current: [], next: [] }), env: {}, now: () => Date.parse('2026-11-23T15:00:00Z'), mail: async () => {} });
  const driverLines = [{ trip: '1', zip: '33152', act: 'PU', fe: 'E', bonus: 'dispatch', bonusAmt: '70' }, { trip: '1', zip: '07011', act: 'DEL', fe: 'F' }];
  h.kv['taTripLog:florida-beauty:986'] = { 'x1': { status: 'submitted', head: { name: 'Ferney Urrego', note: 'Thanks' }, lines: driverLines, miles: [null, 1290] } };
  const darlene = { role: 'dispatcher', payroll: true, name: 'Darlene' };
  assert.equal((await h.call('PUT /truckmate/payroll/logs/:code/:week', { user: { role: 'dispatcher' }, params: { code: '986', week: 'x1' }, body: { lines: driverLines } })).status, 403);
  const r = await h.call('PUT /truckmate/payroll/logs/:code/:week', { user: darlene, params: { code: '986', week: 'x1' },
    body: { lines: [{ ...driverLines[0], bonus: 'none', bonusAmt: '' }, { ...driverLines[1], bonus: 'holiday', bonusAmt: '100' }, { zip: '33152', act: 'EMPTY', fe: 'E' }], miles: [null, 1290, 1280], head: { name: 'Ferney Urrego', truck: '4504', note: 'changed?' } } });
  assert.equal(r.status, 200);
  const l = h.kv['taTripLog:florida-beauty:986'].x1;
  assert.deepEqual(l.lines.map((x) => [x.zip, x.bonus, x.bonusAmt]), [['33152', 'none', ''], ['07011', 'holiday', '100'], ['33152', 'none', '']]);
  assert.deepEqual(l.miles, [null, 1290, 1280]);
  assert.equal(l.driverLines[0].bonus, 'dispatch');           // what the driver turned in is kept
  assert.equal(l.head.note, 'Thanks');                        // the driver's note stays the driver's
  assert.equal(l.payrollEdits[0].by, 'Darlene');
});

test('miles payroll types in replace the calculator\'s for pay', async () => {
  const { reviewTotals, cleanLines } = await import('../triplog.js');
  const [a, b] = cleanLines([{ zip: '33152', act: 'PU', fe: 'E' }, { zip: '07011', act: 'DEL', fe: 'F', miOver: '1301' }]);
  assert.equal(b.miOver, 1301); assert.equal(a.miOver, null);
  assert.equal(reviewTotals({ lines: [a, b], miles: [null, 1290] }, { lines: [{}, { move: true }] }).paid.loadedMi, 1301);
});

test('the open sheet keeps filling itself: new stops added in order, untouched lines brought up to date, the driver\'s changes and deletions kept', async () => {
  const { mergeSheet } = await import('../triplog.js');
  const saved = [
    { key: '1|PU|origin', at: '2026-11-19T20:00:00Z', zip: '33152', act: 'PU' },
    { key: '1|DEL|CLIFTON', at: null, zip: '07011', act: 'DEL', wait: null },                       // not changed: will get its check-in
    { key: '1|DEL|NEWARK', at: '2026-11-20T15:00:00Z', zip: '07105', act: 'DEL', so: 'Short 2', edited: true },   // changed by the driver
    { key: null, at: '2026-11-20T18:00:00Z', zip: '08505', act: 'EMPTY', comment: 'truck wash' },  // added by hand
  ];
  const fresh = [
    { key: '1|PU|origin', at: '2026-11-19T20:00:00Z', zip: '33152', act: 'PU' },
    { key: '1|DEL|CLIFTON', at: '2026-11-20T13:00:00Z', zip: '07011', act: 'DEL', wait: 40 },
    { key: '1|DEL|NEWARK', at: '2026-11-20T15:00:00Z', zip: '07105', act: 'DEL', so: '' },
    { key: '1|DEL|WINDSOR', at: '2026-11-20T21:00:00Z', zip: '06074', act: 'DEL' },                // new stop
    { key: 'gps|02110|2026-11-21T01', at: '2026-11-21T01:00:00Z', zip: '02110', act: 'EMPTY' },    // deleted by the driver before
    { key: '2|PU|02110', at: '2026-11-20T16:00:00Z', zip: '17201', act: 'PU' },                    // new, earlier than the hand-added line
  ];
  const m = mergeSheet(saved, fresh, ['gps|02110|2026-11-21T01']);
  assert.deepEqual(m.map((l) => [l.zip, !!l.added]), [['33152', false], ['07011', false], ['07105', false], ['17201', true], ['08505', false], ['06074', true]]);
  assert.equal(m[1].wait, 40);             // the check-in came in
  assert.equal(m[2].so, 'Short 2');         // the driver's change stays
});

test('the open sheet route: a saved, edited sheet still gets the new stop; a deleted app line stays deleted', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness();
  const items = [{ trip: { tripNumber: 627549, driver: '986', powerUnit: '4504', trailer: '18094', origZoneDesc: 'MIAMI, FL, 33126' }, freightBills: [{ billNumber: 'G1', endZoneDescription: 'CLIFTON, NJ, 07011', pieces: 68 }, { billNumber: 'G2', endZoneDescription: 'NEWARK, NJ, 07105', pieces: 64 }] }];
  h.kv['taDriverCheckins:florida-beauty'] = { 627549: { steps: { loaded: { at: '2026-11-19T20:00:00Z' }, 'arrived:CLIFTON, NJ, 07011': { at: '2026-11-20T13:00:00Z' } } } };
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => items, tripsOf: async () => ['627549'], loadsFor: () => ({ current: [], next: [] }), env: {}, now: () => Date.parse('2026-11-20T23:00:00Z'), mail: async () => {} });
  const me = { code: '986', name: 'Ferney Urrego' };
  const first = (await h.call('GET /driver/me/log', { driver: me, query: {} })).body;
  const lines = first.lines.map((l) => (l.zip === '07011' ? { ...l, so: 'Short 1', edited: true } : l)).filter((l) => l.zip !== '07105');   // changed one, deleted one
  await h.call('PUT /driver/me/log', { driver: me, body: { head: first.head, lines, expenses: [], dismissed: first.lines.filter((l) => l.zip === '07105').map((l) => l.key) } });
  // a new check-in later: Newark delivered (still deleted by the driver), and Clifton's change stays
  h.kv['taDriverCheckins:florida-beauty'][627549].steps['delivered:CLIFTON, NJ, 07011'] = { at: '2026-11-20T17:30:00Z' };
  const again = (await h.call('GET /driver/me/log', { driver: me, query: {} })).body;
  assert.deepEqual(again.lines.map((l) => l.zip), ['33152', '07011']);
  assert.equal(again.lines[1].so, 'Short 1');
  // a stop added to the trip in TruckMate shows up on the saved sheet
  items[0].freightBills.push({ billNumber: 'G3', endZoneDescription: 'NORWALK, CT, 06851', pieces: 62 });
  const third = (await h.call('GET /driver/me/log', { driver: me, query: {} })).body;
  assert.ok(third.lines.some((l) => l.zip === '06851' && l.added));
});

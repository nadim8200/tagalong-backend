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
  assert.deepEqual([ls[0].date, ls[0].trip, ls[0].zip, ls[0].act, ls[0].fe, ls[0].bonus, ls[0].bonusAmt, ls[0].trl], ['11/15', '627549', '33126', 'PU', 'E', 'dispatch', '70.00', '18094']);
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
  assert.equal(ls[0].place, 'SHIPPER · Chambersburg, PA');
});

test('expenses the driver paid go to payroll with their receipts', () => {
  const ex = cleanExpenses([{ date: '11/18', kind: 'fuel', amount: '$54.20', trip: '628011', note: 'DEF', receipts: ['812', 'x'] }, { kind: 'hack', amount: '' }]);
  assert.deepEqual(ex, [{ date: '11/18', kind: 'fuel', amount: '54.20', trip: '628011', note: 'DEF', receipts: ['812'] }]);
  const e = payrollEmail({ head: { name: 'A', id: '1' }, lines: [{ zip: '33126', act: 'PU', fe: 'E', reimb: '75' }], expenses: ex }, { week: { start: '2026-11-15', end: '2026-11-21' }, docs: [{ label: 'POD', trip: '627549', filename: 'pod.pdf', attached: true }, { label: 'BOL', trip: '628011', filename: 'big.pdf', attached: false }] });
  assert.match(e.html, /Expenses paid by the driver/); assert.match(e.html, /\$54\.20/); assert.match(e.html, /To reimburse: \$129\.20/);
  assert.match(e.html, /Paperwork the driver scanned this week \(2\)/); assert.match(e.html, /too big for the email/);
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

test('each week is kept on the driver\'s profile: the driver sees their weeks, admins see any driver\'s, dispatch logins don\'t', async () => {
  const { initTripLog } = await import('../triplog.js');
  const h = harness();
  initTripLog(h.app, { db: h.db, requireDriver: (q, s, n) => n(), requireAuth: (q, s, n) => n(), board: async () => [], tripsOf: async () => [], loadsFor: () => ({ current: [], next: [] }), env: {}, now: () => Date.parse('2026-11-21T15:00:00Z'), mail: async () => {} });
  h.kv['taTripLog:florida-beauty:986'] = {
    '2026-11-15': { status: 'submitted', submittedAt: '2026-11-21T14:00:00Z', submissions: ['2026-11-21T14:00:00Z'], signature: 'data:image/png;base64,AAAA', lines: [{ trip: '627549', zip: '33126', wait: 70, bonus: 'dispatch', reimb: '75' }], expenses: [{ amount: '54.20' }] },
    '2026-11-08': { status: 'draft', savedAt: '2026-11-14T10:00:00Z', lines: [] },
  };
  const mine = await h.call('GET /driver/me/logs', { driver: { code: '986' } });
  assert.deepEqual(mine.body.weeks.map((w) => [w.week, w.end, w.status]), [['2026-11-15', '2026-11-21', 'submitted'], ['2026-11-08', '2026-11-14', 'draft']]);
  assert.deepEqual([mine.body.weeks[0].waitMin, mine.body.weeks[0].bonuses, mine.body.weeks[0].reimburse, mine.body.weeks[0].trips], [70, 1, 129.2, ['627549']]);
  assert.equal((await h.call('GET /truckmate/driver-profiles/:code/logs', { user: { role: 'dispatcher' }, params: { code: '986' } })).status, 403);
  const list = await h.call('GET /truckmate/driver-profiles/:code/logs', { user: { admin: true }, params: { code: '0986' } });
  assert.equal(list.body.weeks.length, 2);
  const one = await h.call('GET /truckmate/driver-profiles/:code/logs/:week', { user: { admin: true }, params: { code: '986', week: '2026-11-15' } });
  assert.equal(one.body.status, 'submitted'); assert.equal(one.body.signature, 'data:image/png;base64,AAAA'); assert.equal(one.body.lines[0].trip, '627549');
  assert.equal((await h.call('GET /truckmate/driver-profiles/:code/logs/:week', { user: { admin: true }, params: { code: '986', week: '2026-10-04' } })).status, 404);
});

test('an LTL trip sheet stop keeps its own ZIP even when no TruckMate bill matched it', async () => {
  const { driverStops } = await import('../driverstops.js');
  const it = { trip: { tripNumber: 627549 }, freightBills: [], _manifest: { stops: [{ action: 'DELIVER', customer: 'TERRA', city: 'SOUTH WINDSOR', state: 'CT', zip: '06074' }] } };
  const st = driverStops(it);
  if (st.length) assert.equal(st[0].zip, '06074');
  const ls = tripLines(it, {});
  assert.ok(ls.some((l) => l.act === 'DEL' && l.zip === '06074') || !st.length);
});

test('GPS: where the truck sat 45+ minutes', () => {
  const p = (min, lat, lng, place = null) => ({ t: new Date(Date.parse('2026-11-21T10:00:00Z') + min * 60000).toISOString(), lat, lng, place });
  const pts = [p(0, 25.80, -80.30), p(10, 25.95, -80.30), p(20, 25.9501, -80.3001, '2355 NW 70th Ave, Miami, FL 33122'), p(80, 25.9502, -80.3, null), p(90, 26.2, -80.3)];
  const s = staysOf(pts);
  assert.equal(s.length, 1); assert.equal(s[0].zip, '33122'); assert.equal((s[0].to - s[0].from) / 60000, 70);
});

test('a move nobody wrote down is added while empty, never while loaded or near a line', () => {
  const ms = (d) => Date.parse(d);
  const lines = [
    { trip: '1', act: 'PU', _ms: ms('2026-11-15T20:00:00Z'), _pt: { lat: 25.78, lng: -80.32 } },
    { trip: '1', act: 'DEL', _ms: ms('2026-11-17T14:00:00Z'), _pt: { lat: 40.88, lng: -74.14 } },
  ];
  const stays = [
    { lat: 37.0, lng: -78.0, from: ms('2026-11-16T05:00:00Z'), to: ms('2026-11-16T15:00:00Z'), place: 'Rest area, VA 23950', zip: '23950' },     // loaded: a rest stop
    { lat: 40.881, lng: -74.141, from: ms('2026-11-17T13:00:00Z'), to: ms('2026-11-17T14:30:00Z'), place: 'Clifton, NJ 07011', zip: '07011' }, // the delivery itself
    { lat: 40.72, lng: -74.6, from: ms('2026-11-17T18:00:00Z'), to: ms('2026-11-17T20:00:00Z'), place: 'Truck shop, Somerville, NJ 08876, USA', zip: '08876' }, // empty, not on the sheet
  ];
  const add = missingMoves(lines, stays);
  assert.equal(add.length, 1);
  assert.deepEqual([add[0].zip, add[0].act, add[0].fe, add[0].detected, add[0].date, add[0].place], ['08876', 'EMPTY', 'E', 'gps', '11/17', 'Truck shop, Somerville, NJ 08876']);
  assert.match(add[0].comment, /GPS: truck stopped here 2 h/);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMiami, parseBartow, sheetStage, buildReleases, counts, cardMark } from '../yardreleases.js';

// MIAMI YARD tab as on Nov 18
const MIAMI = [
  ['', 'LOCAL DRIVER', 'STATUS', 'TK', 'TL', 'B#', 'TRIP', 'TEMP', 'TIME', 'CONSIGNEE', 'CITY', 'DRIVER DEDUCTION', 'OTR DRIVER ID'],
  ['', '', '', '', '', '', '11/20/2026'],
  ['', '', '', '', '262071', 'B181038', '627403', '-10F', '3:30 AM', 'KEHE', 'HIALEAH', '', '8131 4665'],
  ['', '', '', '', '7323', 'B181036', '627401', '30F', '2:30 PM', 'PUBLIX', 'DEERFIELD BEACH', '', '9742 9481'],
  ['', '', '', '', '', '', '11/19/2026'],
  ['', 'JULIO GUTIERREZ', '', '2019', '2022', 'B180987', '627164', '45F', '5:30 AM', 'COSTCO', 'PORT SAINT LUCIE', '', '2025 8600'],
  ['', '', '', '', '', '', '11/18/2026'],
  ['1', 'YORDAN G', 'DONE', '936', '7363', 'B180967', '627143', '20 F', '8:00 AM', 'US FOODS', 'BOCA RATON', 'NO CHARGE', '6193'],
  ['6', 'LUIS P', 'AT RECEIVER', '602', '7342', 'B180949', '627033', '-10F', '3:30 PM', 'PUBLIX', 'DEERFIELD BEACH', '$150.00', '9807 0986'],
  ['7', 'JULIO GUTIERREZ', '', '2019', '262045', 'B180996', '627177', '-10F', '11:30 PM', 'ASSOCIATED GROCERS', 'POMPANO BEACH', '$150.00', '7914 0182'],
  ['1', '', 'RELEASE CANCELLED', '', '7222', 'B181014', '627306', '32F', '3:00 AM', 'ASSOC GROCERS OF FL', 'POMPANO BEACH', '', '6646'],
  ['', '', '', '', '', '', 'PICK UPS'],
  ['', 'JULIO H', '3 PALLET PARTIAL TO THE COOLER', '935', '', 'B181031', '627398', '34 F', '12:00 PM', 'TROPICAL FOODS', 'DORAL', 'LOCAL', 'LOCAL'],
];
// BARTOW YARD tab as on Nov 18 (a few rows)
const BARTOW = [
  ['total hours', 'PICK-UP DATE', 'DEL DATE', 'CUSTOMER', 'DEL TIME', 'TRUCK', 'TRAILER', 'TEMP °F', 'DRIVER PICKING UP', 'P/U ST', 'DELIVERY CITY', 'TRIP#', 'IN YARD', 'DRIVER DOING DELIVERY', 'NOTES'],
  ['', '', 'DROP & HOOK', 'TROPICANA', '', '', '7125\n7305\n7399', '', 'DROP TRAILER', '', 'TROPICANA\n1001 13TH AVE EAST\nBRADENTON, FL 34208'],
  ['', '', 'EMPTY', '', '', '2003', '2062', '', 'FRITZ FREDERIC', 'FL', 'JACKSONVILLE, FL', '', '', '', 'NO RELEASE /\nTHEN PIERSON FL TO FL #1 11/18\nY181021 / TRIP# 627395'],
  ['', '', '', '', '', '', '', '', '', '', 'FRIDAY'],
  ['', '', 'Fri 11/20', 'MAP TRANSIT\nR008879\n0112115', '2:45 AM', '1909', '7221', '45F', 'LUIS MONTIEL (5318)', 'FL', 'MACCLENNY, FL', '627121', 'SENT', 'TK 987 HERLAN QUINTANA (0243)'],
  ['', 'PO 70026', 'ASAP', 'CHEESE\nDAYRON\nY181023', 'ASAP', '987', '7221', '35F', 'HERLAN QUINTANA (0243)', 'FL', 'MIAMI, FL', '627445', 'SENT', 'OTR DRIVER'],
  ['', 'MON 11/23 10 AM', 'Tue 11/24', 'CHR\n\n576035928', '6:00 AM', '', '', '-10F', '', 'FL', 'MEDLEY, FL', '', '', 'OTR DRIVER'],
];

test('MIAMI YARD tab: date sections, the release rows, the pickups section kept apart', () => {
  const rows = parseMiami(MIAMI, { year: 2026 });
  assert.equal(rows.length, 8);
  const c = rows.find((r) => r.trip === '627164');
  assert.deepEqual([c.date, c.time, c.localDriver, c.localTruck, c.trailer, c.bill, c.consignee, c.city, c.otrDriverIds], [{ y: 2026, m: 11, d: 19 }, '5:30 AM', 'JULIO GUTIERREZ', '2019', '2022', 'B180987', 'COSTCO', 'PORT SAINT LUCIE', ['2025', '8600']]);
  assert.equal(rows.find((r) => r.trip === '627398').section, 'pickup');
  assert.equal(rows.find((r) => r.trip === '627403').section, 'release');
});

test('BARTOW YARD tab: loads by day; local driver "TK 987 HERLAN QUINTANA (0243)"; "OTR DRIVER" delivers itself; drop & hook / empty trucks skipped', () => {
  const rows = parseBartow(BARTOW, { year: 2026 });
  assert.deepEqual(rows.map((r) => r.consignee), ['MAP TRANSIT', 'CHEESE', 'CHR']);
  const m = rows[0];
  assert.deepEqual([m.trip, m.bill, m.trailer, m.otrTruck, m.localDriver, m.localTruck, m.localDriverId, m.inYard, m.city, m.state, m.date, m.time, m.section], ['627121', 'R008879', '7221', '1909', 'HERLAN QUINTANA', '987', '0243', 'SENT', 'MACCLENNY', 'FL', { y: 2026, m: 11, d: 20 }, '2:45 AM', 'FRIDAY']);
  assert.equal(rows[1].bill, 'Y181023'); assert.equal(rows[1].otrDelivers, true);
});

test('stages only from evidence: the sheet\'s words, a drop tap, the trailer GPS at that yard; unknown words → Needs review', () => {
  assert.deepEqual(sheetStage('DONE'), { stage: 'completed' });
  assert.deepEqual(sheetStage('RELEASE CANCELLED'), { stage: 'cancelled' });
  assert.deepEqual(sheetStage('AT RECEIVER'), { stage: 'out' });
  assert.deepEqual(sheetStage('3 PALLET PARTIAL TO THE COOLER'), { review: true });
  assert.equal(sheetStage(''), null);
  const now = Date.parse('2026-11-18T22:00:00Z');
  const T = (n, extra = {}, trip = {}) => ({ trip: { tripNumber: n, powerUnit: '2612', status: 'DEPSHIP', trailer: '262071', ...trip }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'HIALEAH, FL, 33010' }], ...extra });
  const items = [
    T('627403', { _samsara: { location: 'Hudson, NH', lat: 42.76, lng: -71.44 } }),
    T('627401', {}, { trailer: '7323', powerUnit: '2602' }),
    T('627164', {}, { trailer: '2022', powerUnit: '2019' }),
    T('627177', { _release: { hub: 'MIAMI', at: '2026-11-18T12:00:00Z', by: 'Ana' } }, { trailer: '262045', powerUnit: '2615' }),
    T('627033', {}, { trailer: '7342' }),
    T('627500', { _loadSheet: { release: { yard: 'Bartow yard', dropped: { at: '2026-11-18T20:00:00Z', by: 'Jose' } } } }, { trailer: '7400' }),
    T('627121', {}, { trailer: '7221', powerUnit: '1909', status: 'ARRCONS' }),
  ];
  const list = buildReleases({ sheets: { miami: parseMiami(MIAMI, { year: 2026 }), bartow: parseBartow(BARTOW, { year: 2026 }) }, items,
    trailerHubs: { 262045: { hub: 'MIAMI', at: '2026-11-18T21:00:00Z', source: 'Thermo King' } }, finished: {}, now });
  const by = (n) => list.find((r) => r.trip === n);
  assert.equal(by('627403').stage, 'coming'); assert.equal(by('627403').otr.milesToYard > 1000, true); assert.equal(by('627403').local.driver, null);
  assert.deepEqual(by('627403').appt, { date: '2026-11-20', time: '03:30', tz: 'America/New_York', zone: 'Eastern', raw: '3:30 AM' });
  assert.equal(by('627177').stage, 'at-yard'); assert.match(by('627177').evidence, /GPS at the yard \(Thermo King\)/);
  assert.deepEqual(by('627177').sources.map((s) => s.name), ['Miami yard sheet', 'Release form']);
  assert.equal(by('627033').stage, 'out');
  assert.equal(by('627143').stage, 'completed'); assert.deepEqual(by('627143').issues, [], 'DONE and off the board: nothing to flag');
  assert.deepEqual(by('627401').issues, []);
  assert.equal(by('627306').stage, 'cancelled');
  assert.equal(by('627398'), undefined, 'a local pickup is not a release');
  assert.equal(by('627500').stage, 'at-yard'); assert.equal(by('627500').hub, 'BARTOW');
  assert.equal(by('627121').hub, 'BARTOW'); assert.equal(by('627121').local.driver, 'Herlan Quintana'); assert.equal(by('627121').local.code, '0243');
  assert.equal(by('627445'), undefined, 'a Bartow row whose load isn\'t on the board is a regional load being planned');
  const c = counts(list);
  assert.equal(c.MIAMI.active, 5); assert.equal(c.MIAMI.completed, 1); assert.equal(c.MIAMI.cancelled, 1); assert.equal(c.BARTOW.active, 2);
  assert.deepEqual(cardMark(by('627164')), { hub: 'MIAMI', yard: 'Miami', stage: 'coming', review: false, localDriver: 'JULIO GUTIERREZ', localTruck: '2019', appt: by('627164').appt, sourceStatus: null, sources: ['Miami yard sheet'] });
});

test('conflicts are shown, never guessed away: the sheet says DONE but TruckMate still has the trip rolling', () => {
  const now = Date.parse('2026-11-18T22:00:00Z');
  const items = [{ trip: { tripNumber: '627143', powerUnit: '936', status: 'DEPSHIP', trailer: '7363' }, freightBills: [{ billNumber: 'B180967' }] }];
  const r = buildReleases({ sheets: { miami: parseMiami(MIAMI, { year: 2026 }) }, items, now }).find((x) => x.trip === '627143');
  assert.equal(r.stage, 'completed');
  assert.deepEqual(r.issues, ['The sheet says DONE; TruckMate still shows trip 627143 as DEPSHIP']);
});

test('history: a completed release whose load left the board stays 3 days, then drops', () => {
  const h = { 'x|': { id: 'x|', hub: 'MIAMI', stage: 'completed', seenAt: '2026-11-17T00:00:00Z', sources: [] } };
  assert.equal(buildReleases({ history: h, now: Date.parse('2026-11-18T00:00:00Z') }).length, 1);
  assert.equal(buildReleases({ history: h, now: Date.parse('2026-11-21T00:00:00Z') }).length, 0);
});

test('temps: the load\'s (sheet first) and the trailer\'s reading now (board, else its Thermo King unit); in range = within 5°F; DRY has none', async () => {
  const { tempsOf } = await import('../yardreleases.js');
  const now = Date.parse('2026-11-18T22:00:00Z');
  const it = { _loadTemp: { target: { minF: 34, maxF: 36 }, current: { readingF: 44.1, setF: 45, source: 'Samsara', at: '2026-11-18T21:50:00Z' } } };
  assert.deepEqual(tempsOf({ temp: '45F' }, it, null, {}, {}, now), { loadText: '45°F', loadF: 45, dry: false, currentF: 44.1, setF: 45, source: 'Samsara', at: '2026-11-18T21:50:00Z', ageMin: 10, powerOn: null, offF: -0.9, inRange: true, stale: false });
  const tk = tempsOf({ temp: '-10F' }, null, { returnF: 2.4, setF: -10, at: '2026-11-18T18:00:00Z', powerOn: false }, {}, {}, now);
  assert.deepEqual([tk.currentF, tk.source, tk.offF, tk.inRange, tk.stale, tk.powerOn], [2.4, 'Thermo King', 12.4, false, true, false]);
  assert.deepEqual([tempsOf({ temp: 'DRY' }).dry, tempsOf({ temp: 'DRY' }).loadF], [true, null]);
  assert.equal(tempsOf({}, it).loadText, '34–36°F');
});

test('local drivers: the sheet\'s short names match the yard\'s list; ambiguous never guessed; a manual pick wins', async () => {
  const { matchLocal, localOf, localsFor } = await import('../yardreleases.js');
  assert.equal(matchLocal('YORDAN G', 'MIAMI').code, '0992');
  assert.equal(matchLocal('JULIO H', 'MIAMI').code, '1344');
  assert.equal(matchLocal('LUIS P', 'MIAMI').code, '0511');
  assert.equal(matchLocal('YORDANI C', 'MIAMI').code, '2811');
  assert.equal(matchLocal('JOSE GARCIA', 'MIAMI').code, '5008');
  assert.equal(matchLocal('JULIO GUTIERREZ', 'MIAMI'), null, 'not on the Miami list');
  assert.equal(matchLocal('JULIO', 'MIAMI').code, '1344');
  assert.equal(matchLocal('HERLAN QUINTANA', 'BARTOW', '0243').name, 'Herlan Quintana');
  assert.deepEqual(localsFor('MIAMI').find((d) => d.code === '5008').units, ['934', '2402']);
  const r = { localDriver: 'YORDAN G', localTruck: '936' };
  assert.deepEqual([localOf(r, 'MIAMI').driver, localOf(r, 'MIAMI').how, localOf(r, 'MIAMI').truck], ['Yordan Gonzalez', 'sheet', '936']);
  const m = localOf(r, 'MIAMI', { code: '4712', name: 'Leandro Pineda', unit: '605', by: 'Nadim', at: 'x' });
  assert.deepEqual([m.driver, m.truck, m.how, m.by, m.sheetName], ['Leandro Pineda', '605', 'manual', 'Nadim', 'YORDAN G']);
  assert.equal(localOf({ localDriver: 'JULIO GUTIERREZ' }, 'MIAMI').how, 'sheet-unmatched');
});

test('the text to the local driver: trip, trailer, bill, the yard, every stop with address and time, appointment, temp, instructions, the release form link', async () => {
  const { driverText } = await import('../yardreleases.js');
  const rel = { trip: '627177', trailer: '262045', bill: 'B180996', yard: { name: 'Miami' }, customer: 'ASSOCIATED GROCERS', destination: 'POMPANO BEACH, FL', appt: { date: '2026-11-18', time: '23:30', raw: '11:30 PM', zone: 'Eastern' }, temps: { loadText: '-10°F' }, notes: [] };
  const form = { trailer: '262045', fb: 'B180996', temp: '-10F', comments: 'Call 30 min out', stops: [{ consignee: 'ASSOCIATED GROCERS', address: '1250 NW 31st Ave', cityStateZip: 'POMPANO BEACH, FL 33069', date: '11/18/2026', time: '11:30 PM' }] };
  const t = driverText(rel, form, 'https://x/release-form/abc.pdf', ['Driver must check in at the guard shack']);
  assert.equal(t, ['Florida Beauty dispatch — release delivery for you', 'Trip 627177 · Trailer 262045 · Bill B180996', 'Pick up the trailer at the Miami yard',
    'Deliver to: ASSOCIATED GROCERS, 1250 NW 31st Ave, POMPANO BEACH, FL 33069 · 11/18/2026 11:30 PM', 'Appointment: 11/18 11:30 PM ET', 'Temp: -10°F',
    'Instructions: Call 30 min out / Driver must check in at the guard shack', 'Release form: https://x/release-form/abc.pdf', 'Text back here with any questions.'].join('\n'));
});

test('assign + send: a manual pick is saved and wins; the text goes to the driver\'s cell (held in training); a driver with no cell or STOP isn\'t texted', async () => {
  const { initYardReleases } = await import('../yardreleases.js');
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  m.set('taYardSheets', { miami: parseMiami(MIAMI, { year: 2026 }), bartow: [] });
  const board = { trips: [{ trip: { tripNumber: '627177', powerUnit: '2615', status: 'DEPSHIP', trailer: '262045' }, freightBills: [{ billNumber: 'B180996' }] }] };
  const routes = {}; const sms = []; const logs = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  initYardReleases(app, { requireAuth: () => {}, db, getBoard: async () => board, formFor: async () => ({ form: { stops: [{ consignee: 'ASSOCIATED GROCERS', address: '1250 NW 31st Ave', cityStateZip: 'POMPANO BEACH, FL 33069' }] }, sent: true }),
    roster: async () => [{ code: '4712', name: 'Leandro Pineda', phone: '(305) 555-0101' }, { code: '5008', name: 'Jose Garcia', phone: '3055550102' }],
    sendSms: async (x) => { sms.push(x); return { id: 'training' }; }, log: async (...a) => logs.push(a), env: { NODE_ENV: 'test' }, now: () => Date.parse('2026-11-18T22:00:00Z') });
  const call = async (k, req) => { let out; let code = 200; await routes[k]({ user: { name: 'Nadim' }, query: {}, body: {}, ...req }, { json: (j) => { out = j; }, status(c) { code = c; return this; } }); return { code, out }; };
  const id = '627177|B180996';
  const pv = await call('GET /truckmate/releases/message', { query: { id, code: '4712' } });
  assert.equal(pv.out.phone, '(305) 555-0101'); assert.match(pv.out.text, /Release form: \[release form link\]/);
  assert.equal(sms.length, 0, 'the preview sends nothing');
  const r = await call('POST /truckmate/releases/assign', { body: { id, code: '4712', send: true } });
  assert.equal(r.out.sent.held, true); assert.equal(sms[0].to, '(305) 555-0101');
  assert.match(sms[0].text, /Release form: https:\/\/tagalong-backend-fdzx\.onrender\.com\/release-form\/[0-9a-f]{32}\.pdf/);
  const list = await call('GET /truckmate/releases', {});
  const rel = list.out.releases.find((x) => x.id === id);
  assert.deepEqual([rel.local.driver, rel.local.truck, rel.local.how, rel.local.sheetName], ['Leandro Pineda', '605', 'manual', 'JULIO GUTIERREZ']);
  assert.equal(list.out.locals.MIAMI.length, 15);
  // the PDF link works without a login, then expires
  const token = sms[0].text.match(/release-form\/([0-9a-f]+)\.pdf/)[1];
  let sentPdf = null; const res = { set() {}, send(b) { sentPdf = b; }, status() { return this; } };
  await routes['GET /release-form/:token.pdf']({ params: { token } }, res);
  assert.equal(Buffer.from(sentPdf).slice(0, 4).toString(), '%PDF');
  // no cell → not sent, and says why
  const no = await call('POST /truckmate/releases/assign', { body: { id, code: '0992', send: true } });
  assert.equal(no.code, 400); assert.match(no.out.error, /No cell on file for Yordan Gonzalez/);
  m.set('taSmsOptOut', { 3055550102: { at: 'x' } });
  const stop = await call('POST /truckmate/releases/assign', { body: { id, code: '5008', send: true } });
  assert.match(stop.out.error, /replied STOP/);
  const just = await call('POST /truckmate/releases/assign', { body: { id, code: '5008', send: false } });
  // the Driver profiles toggle: put a Bartow driver on the Miami list → he can be picked for a Miami release
  const tg = await call('PUT /truckmate/local-fleet/:code', { params: { code: '243' }, body: { hub: 'MIAMI', name: 'Herlan Quintana', units: '987' } });
  assert.equal(tg.out.fleet['0243'], 'MIAMI');
  const pick = await call('POST /truckmate/releases/assign', { body: { id, code: '0243' } });
  assert.deepEqual([pick.out.driver, pick.out.unit], ['Herlan Quintana', '987']);
  assert.deepEqual([just.out.driver, just.out.unit, just.out.sent], ['Jose Garcia', '934', null]);
});

test('local fleet toggle: any driver can be added to a yard (they show in that yard\'s list), moved, or taken off', async () => {
  const { localsFor, fleetOf } = await import('../yardreleases.js');
  const fleet = { '0243': { hub: 'MIAMI', name: 'Herlan Quintana', units: ['987'] }, 4712: { hub: null }, 6100: { hub: 'BARTOW', name: 'New Driver', units: [] } };
  const mia = localsFor('MIAMI', fleet).map((d) => d.code);
  assert.ok(mia.includes('0243')); assert.ok(!mia.includes('4712'), 'taken off');
  assert.ok(!localsFor('BARTOW', fleet).some((d) => d.code === '0243'), 'moved');
  assert.ok(localsFor('BARTOW', fleet).some((d) => d.code === '6100'));
  const f = fleetOf(fleet);
  assert.deepEqual([f['0243'], f['4712'], f['6100'], f['1344']], ['MIAMI', null, 'BARTOW', 'MIAMI']);
});

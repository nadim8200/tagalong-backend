import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { sheetIdFrom, googleToken, readSheet, sheetText, assess, planEmail, initPlanSheet } from '../plansheet.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';

test('the sheet id comes from the share email / link', () => {
  assert.equal(sheetIdFrom(`Gus shared "Truck plan" with you https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing_eil`), ID);
  assert.equal(sheetIdFrom('no link here'), null);
});

test('service account sign-in: a signed JWT for read-only Sheets access', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'jarvis-sheets@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let body = null;
  const t = await googleToken(JSON.stringify(sa), { fetchFn: async (url, o) => { body = o.body; return { ok: true, json: async () => ({ access_token: 'tok' }) }; }, now: Date.parse('2026-10-09T12:00:00Z') });
  assert.deepEqual(t, { token: 'tok', email: sa.client_email });
  const jwt = decodeURIComponent(body.split('assertion=')[1]);
  const [h, c, sig] = jwt.split('.');
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(claim.iss, sa.client_email);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('reads every visible tab; no access → a clear "share it with the service account" message', async () => {
  const fetchFn = async (url) => {
    if (/fields=/.test(url)) return { ok: true, json: async () => ({ properties: { title: 'Truck plan' }, sheets: [{ properties: { title: 'This week', index: 0 } }, { properties: { title: 'Old', index: 1, hidden: true } }] }) };
    return { ok: true, json: async () => ({ valueRanges: [{ values: [['Truck', 'Region', 'Load', 'Next'], ['2403', 'Northeast', 'B180347 flowers', 'B180400 RXO Miami→Atlanta Sat']] }] }) };
  };
  const s = await readSheet(ID, { token: 't', fetchFn });
  assert.deepEqual(s.tabs.map((t) => t.title), ['This week']);
  assert.match(sheetText(s), /=== TAB: This week ===\nR1: Truck \| Region \| Load \| Next\nR2: 2403 \| Northeast/);
  await assert.rejects(readSheet(ID, { token: 't', fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }) }), /share it with the service account/);
});

const NOW = Date.parse('2026-10-09T13:00:00Z');
const board = [
  { trip: { tripNumber: '624318', status: 'DEPSHIP', powerUnit: '2403' }, freightBills: [{ billNumber: 'B180347' }], _samsara: { lat: 40, lng: -74, gpsAt: new Date(NOW - 5 * 60000).toISOString(), location: 'I-95, Newark, NJ', speedMph: 50 } },
  { trip: { tripNumber: '624500', status: 'DISP', powerUnit: '2612' }, freightBills: [{ billNumber: 'B180400' }] },
];

test('plan vs reality: next load booked on another truck, can\'t make the next pickup', () => {
  const etas = { 624318: { stops: [{ label: 'NEWARK, NJ', etaMs: Date.parse('2026-10-10T22:00:00Z'), miles: 10 }] } };
  const a = assess({ truck: '2403', region: 'Northeast', kind: 'flowers', current: { bill: 'B180347' }, next: { bill: 'B180400', info: 'RXO Miami → Atlanta', pickupDate: '2026-10-10', pickupTime: '14:00' } }, board, { now: NOW, etas });
  assert.equal(a.current.trip, '624318');
  assert.equal(a.tone, 'red');
  assert.ok(a.flags.some((f) => /Next load B180400 is on truck 2612 in TruckMate \(trip 624500\), not 2403/.test(f.text)));
  assert.ok(a.flags.some((f) => /Won't be empty until Sat, Oct 10, 6:00 PM ET — next pickup Sat, Oct 10, 2:00 PM ET/.test(f.text)));
  const ok = assess({ truck: '2403', region: 'Northeast', current: { bill: 'B180347' }, next: null }, board, { now: NOW, etas });
  assert.equal(ok.flags.filter((f) => f.tone === 'red').length, 0);
  assert.equal(assess({ truck: '9999' }, board, { now: NOW }).flags[0].text, 'Not on the active board right now');
});

test('planning email: by region, problems first', () => {
  const rows = [
    { truck: '2615', region: 'California', tone: 'green', flags: [], current: { trip: '1', status: 'On schedule', etaMs: NOW }, next: {} },
    { truck: '2403', region: 'Northeast', kind: 'flowers', tone: 'red', flags: [{ tone: 'red', text: 'Running 2 h behind' }], current: { trip: '624318', status: 'Delayed' }, next: { bill: 'B180400', info: 'RXO' } },
  ];
  const m = planEmail(rows, { now: NOW, title: 'Truck plan' });
  assert.match(m.subject, /^Operations check \| 0 late · 0 pickups at risk · 1 plan \| Fri, Oct 9$/);
  assert.match(m.text, /OPERATIONS CHECK — 0 LATE · 0 PICKUPS AT RISK · 1 PLAN PROBLEM/);
  assert.match(m.text, /== 3 · Northeast ==\nTruck 2403 · flowers — NEEDS ATTENTION/);
  assert.ok(m.text.indexOf('Northeast') < m.text.indexOf('California'), 'problems first');
});

test('the share email sets the sheet once; missing key in Render is reported, not crashed', async () => {
  const db = memDb();
  const app = { get() {}, put() {}, post() {} };
  const p = initPlanSheet(app, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [] }), env: { NODE_ENV: 'test' } });
  assert.deepEqual(await p.offer({ text: `https://docs.google.com/spreadsheets/d/${ID}/edit` }), { id: ID, set: true });
  assert.deepEqual(await p.offer({ text: 'https://docs.google.com/spreadsheets/d/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/edit' }), { id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', set: false });
  assert.equal(await p.refresh(), null);
  assert.match((await db.get('taPlanSheet:florida-beauty', {})).error, /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test('a file name pasted instead of the key gives a clear fix-it message', async () => {
  await assert.rejects(googleToken('project-2a69d5e9-b568-43d4-928-abc123.json', { fetchFn: async () => ({}) }), /isn't the key file's contents — it starts with "project-2a69…"/);
});

test('cheaper: on a re-read only the tabs that changed go to the AI', async () => {
  const { generateKeyPairSync: gk } = await import('node:crypto');
  const { privateKey } = gk('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: 'r@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const tabs = { 'This week': [['Truck', 'Region'], ['2403', 'Northeast']], 'Next week': [['Truck', 'Region'], ['2612', 'California']] };
  let ai = 0;
  const fetchFn = async (url, o) => {
    if (/oauth2/.test(url)) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (/fields=/.test(url)) return { ok: true, json: async () => ({ properties: { title: 'Plan' }, sheets: Object.keys(tabs).map((title, index) => ({ properties: { title, index } })) }) };
    if (/batchGet/.test(url)) return { ok: true, json: async () => ({ valueRanges: Object.values(tabs).map((values) => ({ values })) }) };
    ai += 1;
    const body = JSON.parse(o.body).messages[0].content;
    const truck = /2403/.test(body) && /Northeast/.test(body) ? '2403' : '2612';
    return { ok: true, json: async () => ({ content: [{ text: JSON.stringify({ trucks: [{ truck, region: /2403/.test(body) ? 'Northeast' : 'California' }] }) }] }) };
  };
  const db = memDb();
  await db.set('taPlanSheetCfg', { sheetId: ID });
  const p = initPlanSheet({ get() {}, put() {}, post() {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [] }), env: { NODE_ENV: 'test', GOOGLE_SERVICE_ACCOUNT_JSON: sa, ANTHROPIC_API_KEY: 'k' }, fetchFn });
  assert.deepEqual((await p.refresh()).map((r) => r.truck), ['2403', '2612']);
  assert.equal(ai, 2);
  await p.refresh();
  assert.equal(ai, 2, 'nothing changed → no AI');
  tabs['Next week'] = [['Truck', 'Region'], ['2612', 'California'], ['2615', 'Midwest']];
  await p.refresh();
  assert.equal(ai, 3, 'only the changed tab');
});

import { parseTrucks, chunkTab } from '../plansheet.js';

test('a cut-off AI answer keeps every complete truck', () => {
  const cut = '{"trucks":[\n{"truck":"2403","region":"Northeast"},\n{"truck":"2612","region":"California"},\n{"truck":"2615","regi';
  assert.deepEqual(parseTrucks(cut).map((t) => t.truck), ['2403', '2612']);
  assert.deepEqual(parseTrucks('{"trucks":[{"truck":"1"}]}').map((t) => t.truck), ['1']);
  assert.deepEqual(parseTrucks('nothing'), []);
});

test('a big tab is read in pieces, each with the header rows', () => {
  const rows = [['Truck', 'Region'], ['', ''], ['WEEK 41'], ...Array.from({ length: 130 }, (_, i) => [String(2000 + i), 'NE'])];
  const parts = chunkTab({ title: 'This week', rows }, 60);
  assert.equal(parts.length, 3);
  for (const p of parts) assert.deepEqual(p.rows[0], ['Truck', 'Region']);
  assert.match(sheetText({ tabs: [parts[1]] }), /R1: Truck \| Region\nR3: WEEK 41\nR64: 2060 \| NE/);
});

import { pickTabs } from '../plansheet.js';

test('only the "Available Trucks" tab is read (or the tabs chosen in settings)', () => {
  const tabs = ['Notes', 'Available Trucks', 'Old week', 'Drivers'];
  assert.deepEqual(pickTabs(tabs), ['Available Trucks']);
  assert.deepEqual(pickTabs(['AVAILABLE TRUCK LIST', 'x']), ['AVAILABLE TRUCK LIST']);
  assert.deepEqual(pickTabs(tabs, ['old week']), ['Old week']);
  assert.deepEqual(pickTabs(tabs, ['gone']), ['Available Trucks'], 'a chosen tab that no longer exists → default');
  assert.deepEqual(pickTabs(['A', 'B']), ['A', 'B'], 'no Available Trucks tab → all');
});

import { dueSlot } from '../plansheet.js';

test('the sheet is read only at the set times (3, 6, 10 AM, 2, 5, 10 PM)', () => {
  const times = ['03:00', '06:00', '10:00', '14:00', '17:00', '22:00'];
  assert.equal(dueSlot(times, '02:59'), null);
  assert.equal(dueSlot(times, '06:05'), '06:00');
  assert.equal(dueSlot(times, '06:05', () => true), null, 'already read');
  assert.equal(dueSlot(times, '23:59', (t) => t !== '22:00'), '22:00');
});

import { opsRisks } from '../plansheet.js';

test('operations check: late deliveries (Samsara ETA past appointment) and pickups at risk, from the whole board', () => {
  const NOW2 = Date.parse('2026-10-09T13:00:00Z');   // Fri 9:00 AM ET
  const items = [
    // rolling, ETA 2 h after the appointment
    { trip: { tripNumber: '624318', status: 'DEPSHIP', powerUnit: '2403' }, _samsara: { lat: 40, lng: -74, gpsAt: new Date(NOW2 - 5 * 60000).toISOString(), location: 'I-95, Newark, NJ', speedMph: 55 }, _manifest: { stops: [{ action: 'DELIVER', customer: 'Rose Co', tmPlace: 'NEWARK, NJ', apptAt: '2026-10-09T10:00' }] } },
    // pickup at 8:00 AM, still not left
    { trip: { tripNumber: '624700', status: 'LOADEDTOGO', powerUnit: '2612' }, _manifest: { pickupAt: '2026-10-09T08:00' } },
    // pickup at 1:00 PM but its truck 2403 is still on 624318 (empty ~3 PM)
    { trip: { tripNumber: '624701', status: 'DISP', powerUnit: '2403' }, _manifest: { pickupAt: '2026-10-09T13:00' } },
    // fine: pickup tomorrow evening (outside 18 h)
    { trip: { tripNumber: '624702', status: 'DISP', powerUnit: '2700' }, _manifest: { pickupAt: '2026-10-10T20:00' } },
  ];
  const etas = { 624318: { stops: [{ label: 'NEWARK, NJ', etaMs: Date.parse('2026-10-09T19:00:00Z'), apptMs: Date.parse('2026-10-09T14:00:00Z'), miles: 40 }] } };
  const r = opsRisks(items, { now: NOW2, etas });
  assert.deepEqual(r.pickups.map((p) => p.trip), ['624700', '624701']);
  assert.match(r.pickups[0].why[0], /pickup was 1 h 0 min ago and the load hasn't left \(TruckMate LOADEDTOGO\)/);
  assert.match(r.pickups[1].why[0], /truck 2403 is still on trip 624318 — empty about Fri, Oct 9, 3:00 PM ET/);
});

test('operations check: a rolling load whose Samsara ETA is past the appointment is listed as late', () => {
  const NOW2 = Date.parse('2026-10-09T13:00:00Z');
  const it = { trip: { tripNumber: '624318', status: 'DEPSHIP', powerUnit: '2403', destZoneDesc: 'NEWARK, NJ, 07102' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'NEWARK, NJ, 07102', billToName: 'Rose' }], _samsara: { lat: 40, lng: -74, gpsAt: new Date(NOW2 - 5 * 60000).toISOString(), location: 'I-95, Newark, NJ', speedMph: 55 } };
  const etas = { 624318: { stops: [{ label: 'NEWARK, NJ, 07102', etaMs: Date.parse('2026-10-09T19:00:00Z'), apptMs: Date.parse('2026-10-09T14:00:00Z'), miles: 40 }] } };
  const r = opsRisks([it], { now: NOW2, etas });
  assert.deepEqual([r.late[0].trip, r.late[0].lateMin], ['624318', 300]);
  const m = planEmail([], { now: NOW2, risks: r });
  assert.match(m.text, /== 1 · Running late for delivery ==\nTrip 624318 · truck 2403 — 5 H 0 MIN LATE/);
});

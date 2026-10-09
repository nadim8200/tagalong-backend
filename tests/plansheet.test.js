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
  assert.match(m.subject, /^Truck plan check \| 1 need attention · 2 trucks \| Fri, Oct 9$/);
  assert.match(m.text, /TRUCK PLAN CHECK — 1 NEEDS ATTENTION/);
  assert.match(m.text, /== Northeast ==\nTruck 2403 · flowers — NEEDS ATTENTION/);
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

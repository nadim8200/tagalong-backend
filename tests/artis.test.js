import test from 'node:test';
import assert from 'node:assert/strict';
import { initArtis, summarizeCargo, artisConfig } from '../artis.js';

const ROWS = [
  { boxNo: '1', dims: '41X10X09', consigneeId: '12345', consigneeName: 'KUHN FLOWERS', farmName: 'FARM A', productDescription: 'ROSES', cargoQty: 10, cargoCubes: 12.5, scannedQty: 10, scannedCubes: 12.5 },
  { boxNo: '2', dims: '41X10X09', consigneeId: '12345', consigneeName: 'KUHN FLOWERS', farmName: 'FARM B', productDescription: 'CARNATIONS', cargoQty: 5, cargoCubes: 6, scannedQty: 2, scannedCubes: 2.4 },
  { boxNo: '3', dims: '41X10X09', consigneeId: '777', consigneeName: 'DALSIMER FLORIST', cargoQty: 3, cargoCubes: 3, scannedQty: 3, scannedCubes: 3 },
];

test('cargo received: boxes per consignee, expected vs scanned, missing first', () => {
  const s = summarizeCargo(ROWS);
  assert.deepEqual(s.map((c) => [c.consignee, c.boxes, c.scanned, c.missing]), [['KUHN FLOWERS', 15, 12, 3], ['DALSIMER FLORIST', 3, 3, 0]]);
  assert.deepEqual(s[0].farms, ['FARM A', 'FARM B']);
});

test('ARTIS calls send the FBF_AUTH headers, read-only GET, and never expose the password', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => JSON.stringify(ROWS) }; };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} };
  const env = { ARTIS_API_USER: 'edi@floridabeauty.us', ARTIS_API_PASSWORD: 'secret-pw' };
  const a = initArtis(app, { requireAuth: (q, r, n) => n(), env, fetchFn });
  const r = await a.cargo({ date: '2026-10-11', customer: 'kuhn' });
  assert.equal(r.consignees, 1); assert.equal(r.missing, 3);
  assert.equal(calls[0].opts.method, 'GET');
  assert.match(calls[0].url, /^https:\/\/www\.floridabeauty\.com\/artis\/api\/cargo\/received\?shipDate=2026-10-11$/);
  assert.equal(calls[0].opts.headers.FBF_AUTH_USERNAME, 'edi@floridabeauty.us');
  assert.equal(calls[0].opts.headers['Content-Type'], 'text/xml');
  let out; await routes['GET /truckmate/artis/status'].at(-1)({ query: { date: '2026-10-11' } }, { json: (j) => { out = j; } });
  assert.equal(out.connected, true);
  assert.ok(!JSON.stringify(out).includes('secret-pw'));
});

test('ARTIS not set up / login refused → a clear message, nothing thrown at the page', async () => {
  assert.equal(artisConfig({}).ready, false);
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} };
  initArtis(app, { requireAuth: (q, r, n) => n(), env: { ARTIS_API_USER: 'x', ARTIS_API_PASSWORD: 'y' }, fetchFn: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }) });
  let out; await routes['GET /truckmate/artis/status'].at(-1)({ query: {} }, { json: (j) => { out = j; } });
  assert.equal(out.connected, false);
  assert.match(out.error, /refused/);
});

import { loadBoxes, shipDateOf } from '../artis.js';
import { opsRisks, planEmail } from '../plansheet.js';
import { customerStops } from '../voice.js';

const caggiano = [{ consigneeId: '03373', consignee: "CAGGIANO'S MEDFORD *", boxes: 316, scanned: 288, missing: 28, cubes: 461.05 }, { consigneeId: '03810', consignee: 'FALL RIVER FLORIST SUPPLY', boxes: 111, scanned: 111, missing: 0, cubes: 160 }];
const loading = { trip: { tripNumber: '624900', status: 'LOADEDTOGO', powerUnit: '2602' }, _times: { statusHistory: [{ status: 'LOADINGMAN', at: '2026-10-11T12:00:00Z' }, { status: 'LOADEDTOGO', at: '2026-10-11T15:00:00Z' }] },
  freightBills: [{ billNumber: 'M1', billToName: "CAGGIANO'S MEDFORD *", endZoneDescription: 'MEDFORD, MA, 02155', consignee: { clientId: '3373', name: "CAGGIANO'S MEDFORD" } }] };

test('boxes on a load: its customers (client ID) on its ship date; missing boxes before it leaves → alert', () => {
  assert.equal(shipDateOf(loading), '2026-10-11');
  const b = loadBoxes(loading, (d) => (d === '2026-10-11' ? caggiano : null), Date.parse('2026-10-11T16:00:00Z'));
  assert.deepEqual([b.boxes, b.scanned, b.missing], [316, 288, 28]);
  assert.match(b.alert, /28 boxes not scanned yet — CAGGIANO'S MEDFORD \* 288\/316/);
  // once the truck has left, no "before it leaves" alert
  const gone = { ...loading, trip: { ...loading.trip, status: 'DEPSHIP' } };
  assert.equal(loadBoxes(gone, () => caggiano, Date.parse('2026-10-11T18:00:00Z')).alert, null);
  // a load for nobody in ARTIS → nothing
  assert.equal(loadBoxes({ ...loading, freightBills: [{ billToName: 'SOMEONE ELSE' }] }, () => caggiano), null);
});

test('missing boxes reach the Operations check email and the phone answer', () => {
  const it = { ...loading, _artis: loadBoxes(loading, () => caggiano, Date.parse('2026-10-11T16:00:00Z')) };
  const rk = opsRisks([it], { now: Date.parse('2026-10-11T16:00:00Z') });
  assert.equal(rk.boxes.length, 1);
  assert.match(planEmail([], { risks: rk, now: Date.parse('2026-10-11T16:00:00Z') }).html, /28 not scanned/);
  const stops = customerStops([it], "Caggiano's Medford", {});
  assert.equal(stops[0].boxes_loaded, '288 boxes loaded for them');
  assert.ok(!/missing|not scanned|316/.test(JSON.stringify(stops[0])), 'the customer never hears about missing boxes');
});

import { missingFor } from '../voice.js';
import { initMissingBoxes, missingEmail } from '../artis.js';

test('trip sheet vs ARTIS: a different box count is flagged, ARTIS is the right one', () => {
  const withSheet = { ...loading, _manifest: { stops: [{ action: 'DELIVER', customer: "CAGGIANO'S MEDFORD", pieces: 300 }] } };
  const b = loadBoxes(withSheet, () => caggiano, Date.parse('2026-10-11T16:00:00Z'));
  assert.deepEqual(b.sheetDiffs, [{ consignee: "CAGGIANO'S MEDFORD *", sheet: 300, artis: 316 }]);
  const rk = opsRisks([{ ...withSheet, _artis: b }], { now: Date.parse('2026-10-11T16:00:00Z') });
  assert.match(rk.boxes[0].text, /Trip sheet says 300 boxes .* ARTIS has 316 \(ARTIS is correct/);
});

test('missing boxes on a load a customer asked about → one email to the team, never again that day', async () => {
  const it = { ...loading, _artis: loadBoxes(loading, () => caggiano, Date.parse('2026-10-11T16:00:00Z')) };
  const list = missingFor([it], customerStops([it], "Caggiano's Medford", {}));
  assert.deepEqual(list.map((m) => [m.trip, m.missing]), [['624900', 28]]);
  const sent = []; const store = new Map();
  const db = { enabled: true, update: async (k, fn, fb) => { const v = fn(store.has(k) ? store.get(k) : fb); store.set(k, v); return v; } };
  const notify = initMissingBoxes({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['frank@x.com', 'sebastian@x.com', 'ronen@x.com', 'ntellez@floridabeauty.us'], now: () => Date.parse('2026-10-11T16:00:00Z') });
  await notify(list, { caller: '+13055550100' });
  await notify(list, { caller: '+13055550100' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.length, 4);
  assert.match(sent[0].subject, /Missing boxes — CAGGIANO'S MEDFORD \* · trip 624900 \(28 not scanned\)/);
  assert.match(missingEmail(list).html, /told the customer only how many boxes are loaded/);
});

import { leftShort } from '../artis.js';

test('a truck that LEFT with boxes not scanned (10 expected, 9 scanned) → one email to Nadim, never twice', async () => {
  const now = Date.parse('2026-10-11T22:00:00Z');
  const one = [{ consigneeId: '03373', consignee: "CAGGIANO'S MEDFORD", boxes: 10, scanned: 9, missing: 1, cubes: 10 }];
  const left = { ...loading, trip: { ...loading.trip, status: 'DEPSHIP' }, _times: { statusHistory: [...loading._times.statusHistory, { status: 'DEPSHIP', at: '2026-10-11T21:30:00Z' }] } };
  // still loading → not this email (that's the "before it leaves" alert)
  assert.equal(leftShort({ ...loading, _artis: loadBoxes(loading, () => one, now) }, now), null);
  const x = leftShort({ ...left, _artis: loadBoxes(left, () => one, now) }, now);
  assert.deepEqual([x.trip, x.truck, x.missing], ['624900', '2602', 1]);
  // left two days ago → too old to email now
  assert.equal(leftShort({ ...left, _artis: loadBoxes(left, () => one, now) }, now + 2 * 86400000), null);

  const sent = []; const store = new Map();
  const db = { enabled: true, get: async (k, fb) => (store.has(k) ? store.get(k) : fb), set: async (k, v) => store.set(k, v), update: async (k, fn, fb) => { const v = fn(store.has(k) ? store.get(k) : fb); store.set(k, v); return v; } };
  const app = { get: () => {}, post: () => {} };
  const a = initArtis(app, { requireAuth: () => {}, db, sendMail: async (m) => sent.push(m), env: { NODE_ENV: 'test', ARTIS_API_USER: 'u', ARTIS_API_PASSWORD: 'p' }, now: () => now });
  a._byDate.set('2026-10-11', one);
  await a.overlay('fb', [{ ...left }]); await new Promise((r) => setTimeout(r, 10));
  await a.overlay('fb', [{ ...left }]); await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  assert.match(sent[0].subject, /Truck 2602 left with missing boxes — trip 624900 \(1 not scanned\)/);
  assert.match(sent[0].html, /CAGGIANO'S MEDFORD \(03373\)<\/td><td>10<\/td><td>9<\/td><td><b>1<\/b>/);
});

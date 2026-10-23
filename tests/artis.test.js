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
  assert.match(b.alert, /28 boxes not received from the shipper yet — CAGGIANO'S MEDFORD \* 288\/316/);
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
  assert.match(planEmail([], { risks: rk, now: Date.parse('2026-10-11T16:00:00Z') }).html, /28 not received/);
  const stops = customerStops([it], "Caggiano's Medford", {});
  assert.equal(stops[0].boxes_loaded, undefined);   // the bill has no box count → no ARTIS number instead
  assert.ok(!/missing|not scanned|not_received/.test(JSON.stringify(stops[0])), 'nobody on the phone hears ARTIS box numbers');
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
  assert.match(sent[0].subject, /Boxes not received from the shipper — CAGGIANO'S MEDFORD \* · trip 624900 \(28\)/);
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
  const a = initArtis(app, { requireAuth: () => {}, db, sendMail: async (m) => sent.push(m), env: { NODE_ENV: 'test', ARTIS_API_USER: 'u', ARTIS_API_PASSWORD: 'p', ARTIS_LEFT_SHORT_EMAILS: 'on' }, now: () => now });
  a._byDate.set('2026-10-11', one);
  await a.overlay('fb', [{ ...left }]); await new Promise((r) => setTimeout(r, 10));
  await a.overlay('fb', [{ ...left }]); await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  assert.match(sent[0].subject, /Truck 2602 left — 1 box not received from the shipper — trip 624900/);
  assert.match(sent[0].html, /CAGGIANO'S MEDFORD \(03373\)<\/td><td>—<\/td><td>10<\/td><td>9<\/td><td><b>1<\/b>/);
});


test('624670 (Sara checked it): 27 boxes never received from the shippers — per shipper, "verify if rejected or contact the shipper"', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ consigneeId: '09273', consigneeName: 'WESTLAND FLORAL', farmName: 'AMERICAN FLORAL CARGO', cargoQty: 1, scannedQty: i < 27 ? 1 : 0 })),
    ...Array.from({ length: 54 }, (_, i) => ({ consigneeId: '09273', consigneeName: 'WESTLAND FLORAL', farmName: 'SUNBURST FARMS', cargoQty: 1, scannedQty: i < 30 ? 1 : 0 })),
  ];
  const [w] = summarizeCargo(rows);
  assert.deepEqual([w.boxes, w.scanned, w.missing], [84, 57, 27]);
  assert.deepEqual(w.shippers.map((x) => [x.shipper, x.boxes, x.scanned, x.missing]), [['SUNBURST FARMS', 54, 30, 24], ['AMERICAN FLORAL CARGO', 30, 27, 3]]);
  const trip = { trip: { tripNumber: '624670', status: 'DEPSHIP', powerUnit: '650', trailer: '7323' }, _times: { statusHistory: [{ status: 'DEPSHIP', at: '2026-10-12T16:24:00Z' }] },
    freightBills: [{ billNumber: 'M5039998', consignee: { clientId: '09273', name: 'WESTLAND FLORAL' } }] };
  const now = Date.parse('2026-10-12T16:52:00Z');
  const x = leftShort({ ...trip, _artis: loadBoxes(trip, () => [w], now) }, now);
  return import('../artis.js').then(({ leftShortEmail }) => {
    const m = leftShortEmail(x);
    assert.equal(m.subject, 'Truck 650 left — 27 boxes not received from the shipper — trip 624670');
    assert.match(m.html, /WESTLAND FLORAL \(09273\)<\/td><td>SUNBURST FARMS<\/td><td>54<\/td><td>30<\/td><td><b>24<\/b>/);
    assert.match(m.html, /AMERICAN FLORAL CARGO<\/td><td>30<\/td><td>27<\/td><td><b>3<\/b>/);
    assert.match(m.html, /Verify whether they were rejected, or contact the shipper/);
    assert.ok(!/another truck|still at the terminal/.test(m.html));
  });
});

test('admin "send me this alert again": the left-short email for one trip, to the person asking only', async () => {
  const routes = {}; const sent = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const now = Date.parse('2026-10-12T22:00:00Z');
  const a = initArtis(app, { requireAuth: (q, r, n) => n(), sendMail: async (m) => sent.push(m), env: { NODE_ENV: 'test', ARTIS_API_USER: 'u', ARTIS_API_PASSWORD: 'p' }, now: () => now });
  a._byDate.set('2026-10-12', [{ consigneeId: '09273', consignee: 'WESTLAND FLORAL', boxes: 84, scanned: 57, missing: 27, shippers: [{ shipper: 'SUNBURST FARMS', boxes: 54, scanned: 30, missing: 24 }] }]);
  const trip = { trip: { tripNumber: '624670', status: 'DEPSHIP', powerUnit: '650' }, _times: { statusHistory: [{ status: 'LOADINGMAN', at: '2026-10-12T14:00:00Z' }, { status: 'DEPSHIP', at: '2026-10-12T16:24:00Z' }] },
    freightBills: [{ consignee: { clientId: '09273', name: 'WESTLAND FLORAL' } }] };
  await a.overlay('fb', [trip]);
  let out; await routes['POST /truckmate/artis/left-short/:trip/send'].at(-1)({ params: { trip: '624670' }, user: { email: 'ntellez@floridabeauty.us' } }, { json: (j) => { out = j; }, status: () => ({ json: (j) => { out = j; } }) });
  assert.equal(out.sent, true); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  assert.match(sent[0].subject, /Truck 650 left — 27 boxes not received from the shipper — trip 624670/);
});

// 624773 (EDI report by consignee, 10/08–10/12): Davis Macon 16 shipped 10/09 + 240 shipped 10/11 = 256 = the trip sheet
test('earlier ship dates count only when they make the total EXACTLY the trip sheet count', async () => {
  const { loadBoxes } = await import('../artis.js');
  const davis = (boxes, scanned = boxes) => ({ consigneeId: '03929', consignee: 'DAVIS WHOLESALE -MACON', boxes, scanned, missing: boxes - scanned, cubes: 1, shippers: [] });
  const at = Date.parse('2026-10-12T20:00:00Z');
  const load = (sheetPieces, bills = [{ billToName: 'DAVIS WHOLESALE -MACON' }]) => ({ trip: { tripNumber: '624773', status: 'ARRCONS' },
    _times: { statusHistory: [{ status: 'LOADINGMAN', at: '2026-10-11T18:42:34Z' }] }, freightBills: bills,
    ...(sheetPieces != null ? { _manifest: { stops: [{ action: 'DELIVER', customer: 'DAVIS WHOLESALE -MACON', pieces: sheetPieces }] } } : {}) });
  // 10/10 had 30 boxes for Davis that went on another truck — 240 + 30 ≠ 256, so they stay out
  const days = { '2026-10-11': [davis(240)], '2026-10-10': [davis(30)], '2026-10-09': [davis(16)] };
  const b = loadBoxes(load(256), (d) => days[d] || null, at);
  assert.equal(b.boxes, 256); assert.equal(b.scanned, 256); assert.equal(b.missing, 0);
  assert.deepEqual(b.stops[0].shipDates, ['2026-10-11', '2026-10-09']);
  assert.deepEqual(b.sheetDiffs, []);                          // sheet and ARTIS agree — no false flag
  // the sheet says 250: no combination of earlier days makes exactly 250 → nothing added, the difference is flagged
  const off = loadBoxes(load(250), (d) => days[d] || null, at);
  assert.equal(off.boxes, 240);
  assert.deepEqual(off.sheetDiffs, [{ consignee: 'DAVIS WHOLESALE -MACON', sheet: 250, artis: 240 }]);
  // no trip sheet yet → the TruckMate bills are the count to match
  const bills = [{ billToName: 'DAVIS WHOLESALE -MACON', pieces: 16 }, { billToName: 'DAVIS WHOLESALE -MACON', pieces: 240 }];
  assert.equal(loadBoxes(load(null, bills), (d) => days[d] || null, at).boxes, 256);
  // nothing to match against → only the load's own ship date
  assert.equal(loadBoxes(load(null), (d) => days[d] || null, at).boxes, 240);
});

test('"truck left — boxes not received" emails are off unless ARTIS_LEFT_SHORT_EMAILS=on', async () => {
  const { initArtis } = await import('../artis.js');
  const sent = []; const db = { enabled: true, get: async (k, d) => d, set: async () => {}, update: async (k, fn, d) => fn(d) };
  const a = initArtis({ get() {}, post() {} }, { requireAuth: () => {}, db, sendMail: async (m) => sent.push(m), env: { NODE_ENV: 'test', ARTIS_API_USER: 'u', ARTIS_API_PASSWORD: 'p' } });
  assert.equal(await a.notifyLeftShort([{ trip: '624928', truck: '725', departedAt: new Date().toISOString(), missing: 20, boxes: 117, scanned: 97, stops: [] }]), 0);
  assert.equal(sent.length, 0);
});

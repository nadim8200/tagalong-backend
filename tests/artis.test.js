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

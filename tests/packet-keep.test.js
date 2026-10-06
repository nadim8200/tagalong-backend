import test from 'node:test';
import assert from 'node:assert/strict';
import { keepPage, initManifests } from '../manifest.js';

test('only trip-sheet pages are kept from a packet', () => {
  assert.equal(keepPage({ type: 'manifest' }), true);
  assert.equal(keepPage({ type: 'manifest_continuation' }), true);
  for (const t of ['bill_of_lading', 'proof_of_delivery', 'invoice', 'packing_slip', 'driver_id', 'rate_confirmation', 'email', 'other']) assert.equal(keepPage({ type: t, docId: '9' }), false, t);
  // a page the reader used as part of a manifest stays even if typed oddly
  assert.equal(keepPage({ type: 'other', docId: '7' }, new Set(['7'])), true);
});

test('pending list drops leftover BOL / POD / invoice pages and deletes their files', async () => {
  const m = new Map([['taTruckMatePacket:fb', { __unmatched: [
    { batchId: 'b1', file: 1, page: 31, type: 'bill_of_lading', docId: '31', summary: 'BOL' },
    { batchId: 'b1', file: 1, page: 33, type: 'proof_of_delivery', docId: '33' },
    { batchId: 'b1', file: 1, page: 37, type: 'invoice', docId: '37' },
    { batchId: 'b1', file: 1, page: 2, type: 'manifest_continuation', docId: '2', summary: 'cont.' },
  ] }]]);
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const deleted = [];
  const docs = { enabled: true, deleteDocs: async ({ ids }) => { deleted.push(...ids); return ids.length; }, linkDocs: async () => {} };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put() {}, delete() {} };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test' }, buildBoard: async () => ({ trips: [] }), docs });
  let out; await routes['GET /truckmate/packet/unmatched']({ query: { site: 'fb' } }, { json: (j) => { out = j; }, status() { return this; } });
  assert.deepEqual(out.map((p) => p.page), [2]);
  assert.deepEqual(deleted.sort(), ['31', '33', '37']);
});

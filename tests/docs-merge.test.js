import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { initDocuments } from '../documents.js';

// The manifest (page 1 + continuation) opens as ONE PDF; restricted pages never merge.
test('merged trip sheet: pages in the order asked, restricted pages skipped', async () => {
  const onePage = async (w) => { const d = await PDFDocument.create(); d.addPage([w, 100]); return Buffer.from(await d.save()); };
  const rows = [
    { id: '7', media_type: 'application/pdf', data: await onePage(300), restricted: false },
    { id: '8', media_type: 'application/pdf', data: await onePage(400), restricted: false },
    { id: '9', media_type: 'application/pdf', data: await onePage(500), restricted: true },
  ];
  const pool = { query: async (sql) => (/SELECT id, media_type/.test(sql) ? { rows } : { rows: [] }) };
  const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h[h.length - 1]; }, post: () => {}, put: () => {} };
  initDocuments(app, { requireAuth: () => {}, db: { enabled: true, pool, ensureReady: async () => {}, update: async () => {} } });
  let sent; const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; }, send: (b) => { sent = b; }, status: () => res, json: (j) => { sent = j; } };
  await routes['/truckmate/docs/merged']({ query: { ids: '8,7,9', name: 'Trip sheet 624215' }, headers: {}, body: {} }, res);
  assert.equal(headers['Content-Type'], 'application/pdf', JSON.stringify(sent));
  const merged = await PDFDocument.load(sent);
  assert.deepEqual(merged.getPages().map((p) => p.getWidth()), [400, 300]);
});

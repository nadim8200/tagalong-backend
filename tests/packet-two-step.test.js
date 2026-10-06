import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { initManifests } from '../manifest.js';

// 12-page packet: trip A = manifest + continuation (p1-2), then instructions,
// loading sheet, 3 BOLs; trip B manifest (p8), instructions, 2 BOLs, a shipment notice.
const TYPES = ['manifest', 'manifest_continuation', 'driver_instructions', 'loading_sheet', 'bill_of_lading', 'bill_of_lading', 'bill_of_lading', 'manifest', 'driver_instructions', 'bill_of_lading', 'bill_of_lading', 'shipment_notice'];

test('a big packet: quick sort of every page, full read of the trip sheets only', async () => {
  const doc = await PDFDocument.create();
  TYPES.forEach(() => doc.addPage([200, 200]));
  const packet = Buffer.from(await doc.save()).toString('base64');
  const sortCalls = []; const readCalls = [];
  const anthropic = {
    messages: { create: async ({ messages }) => {
      const labels = messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => c.text);
      sortCalls.push(labels.length);
      const pages = labels.map((l) => { const [, f, pg] = l.match(/File (\d+) · page (\d+)/); return { file: +f, page: +pg, type: TYPES[+pg - 1], tripNumber: +pg === 1 ? '624326' : +pg === 8 ? '624393' : null, summary: 'x', checkins: [] }; });
      return { content: [{ type: 'text', text: JSON.stringify({ pages }) }] };
    } },
    beta: { messages: { stream: ({ messages }) => ({ finalMessage: async () => {
      const labels = messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => c.text);
      readCalls.push(labels);
      const trips = [];
      if (labels.some((l) => l.includes('page 1 '))) trips.push({ tripNumber: '624326', stops: [], sourcePages: [{ file: 1, page: 1 }, { file: 1, page: 2 }] });
      if (labels.some((l) => l.includes('page 8 '))) trips.push({ tripNumber: '624393', stops: [], sourcePages: [{ file: 1, page: 8 }] });
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: JSON.stringify({ trips, pages: [] }) }] };
    } }) } },
  };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const deleted = [];
  const docs = { enabled: true, linkDocs: async () => {}, markDocs: async () => {}, deleteDocs: async ({ ids }) => { deleted.push(...ids); } };
  const routes = {};
  const app = { get() {}, put() {}, delete() {}, post: (p, ...h) => { routes[p] = h.at(-1); } };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, buildBoard: async () => ({ trips: [] }), docs, anthropic });
  let out; let code = 200;
  const ids = TYPES.map((_, i) => String(100 + i));
  await routes['/truckmate/manifests']({ query: {}, body: { pages: [{ filename: '10-05-2026.pdf', mediaType: 'application/pdf', dataBase64: packet }], originalIds: [ids], batchId: 'b1' }, user: { name: 'Ana' } }, { json: (j) => { out = j; }, status(c) { code = c; return this; } });
  assert.equal(code, 200, JSON.stringify(out));
  assert.deepEqual(sortCalls, [12], 'one quick sort for all 12 pages');
  assert.equal(readCalls.length, 1);
  assert.deepEqual(readCalls[0].map((l) => l.match(/page (\d+)/)[1]), ['1', '2', '8'], 'only trip-sheet pages get the full read');
  assert.deepEqual(out.trips.map((t) => t.tripNumber), ['624326', '624393']);
  assert.equal(out.skipped.length, 9);
  assert.deepEqual(deleted.sort(), ['102', '103', '104', '105', '106', '108', '109', '110', '111']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import UTIF from 'utif2';
import { toPdf, docFileName, syncSlotDue, initSynergize } from '../synergize.js';
import { nameScore } from '../voice.js';

const tiff = () => { const w = 40; const h = 20; const rgba = new Uint8Array(w * h * 4).fill(200); return Buffer.from(UTIF.encodeImage(rgba, w, h)); };
function memDb() { const m = new Map(); return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }

test('ARTIS scans: a TIFF becomes a PDF; PDFs pass through; zips are left in ARTIS', async () => {
  const pdf = await toPdf(tiff(), 'image/tif');
  assert.equal(pdf.slice(0, 4).toString(), '%PDF');
  const same = Buffer.from('%PDF-1.4 x');
  assert.equal(await toPdf(same, 'application/pdf'), same);
  assert.equal(await toPdf(Buffer.from('PK\u0003\u0004zip'), 'application/zip'), null);
  assert.equal(docFileName({ In_DocTypeName: 'POD', Bill_Number: 'B180174', In_DocId: 'Syn10584370' }), 'POD-B180174-Syn10584370.pdf');
  assert.equal(syncSlotDue({}, Date.parse('2026-10-22T15:30:00Z')), '2026-10-22|am');   // 11:30 AM ET
  assert.equal(syncSlotDue({}, Date.parse('2026-10-22T13:30:00Z')), null);
});

const DOCS = { B180174: [{ In_DocId: 'Syn1', In_DocName: 'POD_ B180174.PDF', In_DocTypeName: 'POD', Bill_Number: 'B180174', In_DocCreated: '10/6/2026 14:27 EDT' }, { In_DocId: 'Syn2', In_DocName: 'INV.pdf', In_DocTypeName: 'Invoice', Bill_Number: 'B180174 ' }, { In_DocId: 'Syn3', In_DocName: 'MP2.zip', In_DocTypeName: 'POD', Bill_Number: 'B180174' }] };
const ITEM = { trip: { tripNumber: '623522' }, freightBills: [{ billNumber: 'B180174', billToName: 'PTC LOGISTICS LLC' }, { billNumber: 'B180175', billToName: 'OTHER BROKER' }] };

test('documents by bill are stored once on the trip; small loads checked twice a day; customers get only their own POD / BOL', async () => {
  const db = memDb(); const stored = []; const fetched = [];
  const artisWeb = { ready: () => true,
    fetchText: async (p) => { fetched.push(p); const b = decodeURIComponent((p.match(/billNumber=([^&]+)/) || [])[1] || ''); return `<script>\n var documents = ${JSON.stringify(DOCS[b] || [])}\n</script>`; },
    fetchBuffer: async (p) => (/MP2/.test(decodeURIComponent(p)) ? { buf: Buffer.from('PK\u0003\u0004'), type: 'application/zip' } : { buf: tiff(), type: 'image/tif' }) };
  const docs = { storeDocs: async ({ files, trip, kind }) => { stored.push({ trip, kind, name: files[0].filename }); return [{ id: 100 + stored.length }]; } };
  const s = initSynergize({ post: () => {} }, { requireAuth: (q, r, n) => n(), db, docs, artisWeb, getBoard: async () => ({ trips: [ITEM] }), nameFits: (a, b) => nameScore(a, b) >= 0.75 || nameScore(b, a) >= 0.75 });
  const r = await s.sync();
  assert.equal(r.trips, 1); assert.equal(stored.length, 2, 'POD + invoice stored, the zip stays in ARTIS');
  assert.deepEqual(stored.map((x) => [x.kind, x.name]), [['artisdoc', 'POD-B180174-Syn1.pdf'], ['artisdoc', 'Invoice-B180174-Syn2.pdf']]);
  await s.sync(); assert.equal(stored.length, 2, 'never stored twice');
  const it = { trip: { tripNumber: '623522' } }; await s.overlay('florida-beauty', [it]);
  assert.equal(it._artisDocs.length, 3);
  // a broker asks for its POD: only PODs / BOLs, only bills billed to them
  const own = await s.forTrip({ item: ITEM, customer: 'PTC Logistics' });
  assert.equal(own.allowed, true); assert.deepEqual(own.documents.map((d) => d.type), ['POD', 'POD']);
  assert.equal(own.documents.some((d) => d.type === 'Invoice'), false);
  assert.equal((await s.forTrip({ item: ITEM, customer: 'Some Stranger Inc' })).allowed, false);
  const staff = await s.forTrip({ item: ITEM, type: 'Invoice' });
  assert.deepEqual(staff.documents.map((d) => d.type), ['Invoice']);
});

import { pagePixels } from '../synergize.js';
test('scanned pages are kept small: ~150 dpi, fax → grayscale PNG, colour → JPEG', () => {
  const w = 1700; const h = 2200; const rgba = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < rgba.length; i += 997 * 4) { rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; }
  const fax = pagePixels(rgba, w, h, 4);
  assert.equal(fax.w, 1275); assert.equal(fax.jpeg, false); assert.equal(fax.bytes.slice(1, 4).toString(), 'PNG');
  const photo = pagePixels(rgba, w, h, 7);
  assert.equal(photo.jpeg, true); assert.equal(photo.bytes[0], 0xff); assert.ok(photo.bytes.length < 600000, `jpeg ${photo.bytes.length} bytes`);
});

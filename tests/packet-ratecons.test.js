import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { initManifests } from '../manifest.js';
import { contactsFor } from '../statusmail.js';

// 3439_001.pdf layout: RXO 1-4 (RC- label on p1), HD Shipping p5, Bongards p6, Giltner p7,
// Carrier Advice p8 (no bill on board → matched by truck), CH Robinson 9-11 (no label, unknown truck → pending)
const SORT = {
  1: { type: 'rate_confirmation', pageOf: 1, pageTotal: 4, docKey: 'RXO 24261611', rcBill: null },
  2: { type: 'rate_confirmation', pageOf: 2, pageTotal: 4, docKey: 'RXO 24261611' },
  3: { type: 'rate_confirmation', pageOf: 3, pageTotal: 4, docKey: 'RXO 24261611' },
  4: { type: 'rate_confirmation', pageOf: 4, pageTotal: 4, docKey: 'RXO 24261611' },
  5: { type: 'rate_confirmation', docKey: 'HD Shipping 173965', rcBill: 'B180364' },
  6: { type: 'rate_confirmation', docKey: 'Bongards CNS398199', rcBill: 'B180284' },
  7: { type: 'rate_confirmation', docKey: 'Giltner 1526805', rcBill: 'T085286' },
  8: { type: 'rate_confirmation', docKey: 'Lumber Bridge 3113791', rcBill: null },
  9: { type: 'rate_confirmation', pageOf: 1, pageTotal: 3, docKey: 'CH Robinson 569932847' },
  10: { type: 'rate_confirmation', pageOf: 2, pageTotal: 3, docKey: 'CH Robinson 569932847' },
  11: { type: 'rate_confirmation', pageOf: 3, pageTotal: 3, docKey: 'CH Robinson 569932847' },
};
const READ = {
  1: { broker: 'RXO', loadNumber: '24261611', fbfBillNumber: 'B180342', truckNumber: '2211', contacts: [{ role: 'broker_rep', company: 'RXO', name: 'Brian Karch', phone: '847-810-5471', email: 'brian.karch@rxo.com' }, { role: 'after_hours', phone: '(877) 626-9683' }], specialInstructions: ['High Visibility Gear Required'], handwrittenNotes: ['$75 bonus for short trip', 'No Release'] },
  5: { broker: 'HD Shipping Solutions LLC', loadNumber: '173965', fbfBillNumber: 'B180364', truckNumber: '2402', contacts: [{ role: 'broker_rep', name: 'Timothy Connolly', phone: '3398321882', email: 'tconnolly@hdships.com' }], specialInstructions: ['Sealed, Padlock required', 'Tracking Required'] },
  6: { broker: 'Bongards Creameries', loadNumber: 'CNS398199', fbfBillNumber: 'B180284', specialInstructions: ['Delivery appointments need to be 72 hours in advance'] },
  7: { broker: 'Giltner Logistics', loadNumber: '1526805', fbfBillNumber: 'T085286', specialInstructions: [] },
  8: { broker: 'Lumber Bridge', loadNumber: '3113791', truckNumber: '2601', specialInstructions: [] },
  9: { broker: 'C.H. Robinson', loadNumber: '569932847', truckNumber: '987', specialInstructions: ['On time delivery must be met'] },
};

test('a stack of rate cons: grouped per document, read whole, matched by RC- bill / truck, rest pending', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 11; i++) doc.addPage([200, 200]);
  const pdf = Buffer.from(await doc.save()).toString('base64');
  const anthropic = { messages: { create: async ({ messages }) => {
    const pages = messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => { const [, f, pg] = c.text.match(/File (\d+) · page (\d+)/); return { file: +f, page: +pg, summary: 'x', checkins: [], tripNumber: null, ...SORT[+pg] }; });
    return { content: [{ type: 'text', text: JSON.stringify({ pages }) }] };
  } }, beta: { messages: { stream: () => { throw new Error('no trip sheets in this packet'); } } } };
  const reads = [];
  const saved = {};
  const ratecon = { enabled: true, read: async (pages) => { reads.push(pages.length); return READ[[1, 5, 6, 7, 8, 9][reads.length - 1]]; }, save: async (site, trip, rec) => { saved[trip] = rec; } };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const retyped = []; const deleted = [];
  const docs = { enabled: true, linkDocs: async () => {}, markDocs: async () => {}, deleteDocs: async ({ ids }) => { deleted.push(...ids); }, retypeDocs: async (a) => { retyped.push(a); return 1; } };
  const board = { trips: [
    { trip: { tripNumber: '624500', powerUnit: '2211', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B0180342' }] },
    { trip: { tripNumber: '624501', powerUnit: '2402', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B180364' }] },
    { trip: { tripNumber: '624502', powerUnit: '2001', status: 'DISP' }, freightBills: [{ billNumber: 'B180284' }] },
    { trip: { tripNumber: '624503', powerUnit: '2203', status: 'DISP' }, freightBills: [{ billNumber: 'T085286' }] },
    { trip: { tripNumber: '624504', powerUnit: '2601', status: 'ASSGN' }, freightBills: [{ billNumber: 'B180346' }] },
  ] };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put() {}, delete() {} };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, buildBoard: async () => board, docs, anthropic, ratecon });
  let out; let code = 200;
  const ids = Array.from({ length: 11 }, (_, i) => String(300 + i));
  await routes['POST /truckmate/manifests']({ query: {}, body: { pages: [{ filename: '3439_001.pdf', mediaType: 'application/pdf', dataBase64: pdf }], originalIds: [ids], batchId: 'b9' }, user: { name: 'Ana' } }, { json: (j) => { out = j; }, status(c) { code = c; return this; } });
  assert.equal(code, 200, JSON.stringify(out));
  assert.deepEqual(reads, [4, 1, 1, 1, 1, 3], 'RXO 4 pages together, CH Robinson 3 pages together');
  assert.deepEqual(out.rateCons.map((r) => [r.trip, r.matchedBy]), [
    ['624500', 'bill B0180342'], ['624501', 'bill B180364'], ['624502', 'bill B180284'], ['624503', 'bill T085286'], ['624504', 'truck 2601'], [null, null]]);
  assert.equal(saved['624500'].contacts[0].email, 'brian.karch@rxo.com');
  assert.deepEqual(saved['624500'].handwrittenNotes, ['$75 bonus for short trip', 'No Release']);
  assert.deepEqual(retyped[0], { site: 'florida-beauty', ids: ['300', '301', '302', '303'], kind: 'ratecon', trip: '624500' });
  assert.equal(deleted.length, 0, 'rate con pages are kept');
  // the unmatched one waits; assigning it saves it on the trip
  let pend; await routes['GET /truckmate/ratecons/pending']({ query: {} }, { json: (j) => { pend = j; }, status() { return this; } });
  assert.equal(pend.length, 1); assert.equal(pend[0].broker, 'C.H. Robinson');
  await routes['POST /truckmate/ratecons/assign']({ query: {}, body: { id: pend[0].id, trip: '624599' }, user: { name: 'Ana' } }, { json: () => {}, status() { return this; } });
  assert.equal(saved['624599'].broker, 'C.H. Robinson'); assert.match(saved['624599'].matchedBy, /assigned by Ana/);
});

test('rate con contacts become load contacts (and reach Jarvis)', () => {
  const r = contactsFor({ trip: {}, freightBills: [], _ratecon: { broker: 'RXO', contacts: [{ role: 'broker_rep', name: 'Brian Karch', phone: '847-810-5471', email: 'brian.karch@rxo.com' }, { role: 'after_hours', phone: '(877) 626-9683' }] } }, { prefixes: ['B'] });
  assert.ok(r.contacts.find((c) => c.email === 'brian.karch@rxo.com' && c.role === 'broker' && c.company === 'RXO'));
  assert.ok(r.contacts.find((c) => c.phone === '8776269683'));
});

test('"carrier confirmation" pages count as rate cons; terms pages inside "Page N of M" stay with it', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([200, 200]);
  const pdf = Buffer.from(await doc.save()).toString('base64');
  const S = { 1: { type: 'carrier_confirmation', pageOf: 1, pageTotal: 3, docKey: 'CW Carriers 0449890', rcBill: 'B180400' }, 2: { type: 'other', pageOf: null }, 3: { type: 'other' }, 4: { type: 'bill_of_lading' } };
  const anthropic = { messages: { create: async ({ messages }) => ({ content: [{ type: 'text', text: JSON.stringify({ pages: messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => { const [, f, pg] = c.text.match(/File (\d+) · page (\d+)/); return { file: +f, page: +pg, summary: 'x', checkins: [], ...S[+pg] }; }) }) }] }) } };
  const reads = []; const saved = {};
  const ratecon = { enabled: true, read: async (pages) => { reads.push(pages.length); return { broker: 'CW Carriers', fbfBillNumber: 'B180400', specialInstructions: [] }; }, save: async (s2, trip, rec) => { saved[trip] = rec; } };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const deleted = [];
  const docs = { enabled: true, linkDocs: async () => {}, markDocs: async () => {}, deleteDocs: async ({ ids }) => { deleted.push(...ids); }, retypeDocs: async () => 1 };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put() {}, delete() {} };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, buildBoard: async () => ({ trips: [{ trip: { tripNumber: '624417', powerUnit: '2402' }, freightBills: [{ billNumber: 'B180400' }] }] }), docs, anthropic, ratecon });
  let out;
  await routes['POST /truckmate/manifests']({ query: {}, body: { pages: [{ filename: '3440_001.pdf', mediaType: 'application/pdf', dataBase64: pdf }], originalIds: [['501', '502', '503', '504']], batchId: 'b1' }, user: { name: 'Ana' } }, { json: (j) => { out = j; }, status() { return this; } });
  assert.deepEqual(reads, [3], 'pages 1-3 read together as one rate con');
  assert.equal(out.rateCons[0].trip, '624417');
  assert.deepEqual(out.skipped.map((p) => p.type), ['bill_of_lading']);
  assert.deepEqual(deleted, ['504'], 'only the BOL page is dropped');
});

test('Legacy (2 pages) then Red Lab (RC-B180354, mis-read as "page 2"): two rate cons, each on its own trip', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([200, 200]);
  const pdf = Buffer.from(await doc.save()).toString('base64');
  const S = {
    1: { type: 'rate_confirmation', pageOf: 1, pageTotal: 2, docKey: 'Legacy 514001', rcBill: 'B180303' },
    2: { type: 'rate_confirmation', pageOf: 2, pageTotal: 2, docKey: 'Legacy 514001' },
    3: { type: 'rate_confirmation', pageOf: 2, pageTotal: 2, docKey: 'Red Lab 131963433', rcBill: 'B180354' },
    4: { type: 'rate_confirmation', pageOf: 2, pageTotal: 2, docKey: 'Red Lab 131963433' },
  };
  const anthropic = { messages: { create: async ({ messages }) => ({ content: [{ type: 'text', text: JSON.stringify({ pages: messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => { const [, f, pg] = c.text.match(/File (\d+) · page (\d+)/); return { file: +f, page: +pg, summary: 'x', checkins: [], ...S[+pg] }; }) }) }] }) } };
  const reads = []; const saved = {};
  const ratecon = { enabled: true, read: async (pages) => { reads.push(pages.length); return reads.length === 1 ? { broker: 'Legacy', fbfBillNumber: 'B180303', truckNumber: '2212' } : { broker: 'Red Lab', fbfBillNumber: 'B180354', truckNumber: '2212' }; }, save: async (s2, trip, rec) => { saved[trip] = rec; } };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const docs = { enabled: true, linkDocs: async () => {}, markDocs: async () => {}, deleteDocs: async () => {}, retypeDocs: async () => 1 };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put() {}, delete() {} };
  const board = { trips: [{ trip: { tripNumber: '624086', powerUnit: '2212', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B180303' }] }, { trip: { tripNumber: '624335', powerUnit: '2212', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B180354' }] }] };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, buildBoard: async () => board, docs, anthropic, ratecon });
  let out;
  await routes['POST /truckmate/manifests']({ query: {}, body: { pages: [{ filename: '3440_001.pdf', mediaType: 'application/pdf', dataBase64: pdf }], originalIds: [['1', '2', '3', '4']], batchId: 'b' }, user: { name: 'Ana' } }, { json: (j) => { out = j; }, status() { return this; } });
  assert.deepEqual(reads, [2, 2]);
  assert.equal(saved['624086'].broker, 'Legacy');
  assert.equal(saved['624335'].broker, 'Red Lab');
});

test('matching like a dispatcher: "RC-" prefix, bill trace numbers, truck + route; waiting rate cons attach on the next look', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([200, 200]);
  const pdf = Buffer.from(await doc.save()).toString('base64');
  const S = {
    1: { type: 'rate_confirmation', docKey: 'Giltner 1526805', rcBill: 'RC-T085286' },
    2: { type: 'rate_confirmation', docKey: 'HD Shipping 173965', rcBill: null },
    3: { type: 'rate_confirmation', docKey: 'Legacy 514001', rcBill: null },
    4: { type: 'rate_confirmation', docKey: 'Arrive 9988', rcBill: null },
  };
  const READS = [
    { broker: 'Giltner', fbfBillNumber: null },
    { broker: 'HD Shipping', truckNumber: '2402', pickups: [{ city: 'Taunton', state: 'MA' }], deliveries: [{ city: 'Belvidere', state: 'IL' }] },
    { broker: 'Legacy', loadNumber: '514001' },
    { broker: 'Arrive', deliveries: [{ city: 'Medley', state: 'FL' }], pickups: [{ city: 'Milwaukee', state: 'WI' }] },
  ];
  const anthropic = { messages: { create: async ({ messages }) => ({ content: [{ type: 'text', text: JSON.stringify({ pages: messages[0].content.filter((c) => c.type === 'text' && c.text.startsWith('---')).map((c) => { const [, f, pg] = c.text.match(/File (\d+) · page (\d+)/); return { file: +f, page: +pg, summary: 'x', checkins: [], ...S[+pg] }; }) }) }] }) } };
  let n = 0; const saved = {};
  const ratecon = { enabled: true, read: async () => READS[n++], save: async (s2, trip, rec) => { saved[trip] = rec; } };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const docs = { enabled: true, linkDocs: async () => {}, markDocs: async () => {}, deleteDocs: async () => {}, retypeDocs: async () => 1 };
  const board = { trips: [
    { trip: { tripNumber: '624342', powerUnit: '2209', status: 'DEPSHIP', origZoneDesc: 'TULARE, CA, 93274', destZoneDesc: 'HIALEAH, FL, 33018' }, freightBills: [{ billNumber: 'T085286', endZoneDescription: 'HIALEAH, FL, 33018' }] },
    { trip: { tripNumber: '624417', powerUnit: '2402', status: 'DEPSHIP', origZoneDesc: 'BEDFORD, NH, 03110', destZoneDesc: 'BELVIDERE, IL, 61008' }, freightBills: [{ billNumber: 'B180364', endZoneDescription: 'BELVIDERE, IL, 61008' }] },
    { trip: { tripNumber: '624470', powerUnit: '2402', status: 'ASSGN', origZoneDesc: 'MIAMI, FL', destZoneDesc: 'ATLANTA, GA, 30301' }, freightBills: [{ billNumber: 'B180499', endZoneDescription: 'ATLANTA, GA, 30301' }] },
    { trip: { tripNumber: '624086', powerUnit: '2212', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B180303', traceNumbers: [{ traceType: 'P', traceNumber: '514001' }] }] },
  ] };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put() {}, delete() {} };
  initManifests(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, buildBoard: async () => board, docs, anthropic, ratecon });
  let out;
  await routes['POST /truckmate/manifests']({ query: {}, body: { pages: [{ filename: 'x.pdf', mediaType: 'application/pdf', dataBase64: pdf }], originalIds: [['1', '2', '3', '4']], batchId: 'b' }, user: { name: 'Ana' } }, { json: (j) => { out = j; }, status() { return this; } });
  assert.deepEqual(out.rateCons.map((r) => [r.broker, r.trip, r.matchedBy]), [
    ['Giltner', '624342', 'bill T085286'],
    ['HD Shipping', '624417', 'truck 2402 + route'],
    ['Legacy', '624086', 'reference on the bill (514001)'],
    ['Arrive', null, null],
  ]);
  // the Medley load shows up on the board later → the waiting rate con attaches itself
  board.trips.push({ trip: { tripNumber: '624480', powerUnit: '2205', status: 'DISP', origZoneDesc: 'MILWAUKEE, WI', destZoneDesc: 'MEDLEY, FL, 33178' }, freightBills: [{ billNumber: 'B180500', endZoneDescription: 'MEDLEY, FL, 33178' }] });
  let pend; await routes['GET /truckmate/ratecons/pending']({ query: {} }, { json: (j) => { pend = j; }, status() { return this; } });
  assert.equal(pend.length, 0);
  assert.equal(saved['624480'].broker, 'Arrive'); assert.match(saved['624480'].matchedBy, /route/);
});

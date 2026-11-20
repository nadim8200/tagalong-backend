import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStopReport, stopEmail, logLine, initStopReports } from '../stopreports.js';
import { leftCooler, withDetected } from '../autodepart.js';

test('stop reports: boxes need the count; missing needs a number when reported; a problem needs what happened', () => {
  assert.match(cleanStopReport({ kind: 'boxes', stop: 'SOUTH WINDSOR, CT' }).error, /boxes you delivered/);
  assert.match(cleanStopReport({ kind: 'boxes', stop: 'X', boxes: '78', reportMissing: true }).error, /how many boxes are missing/);
  const r = cleanStopReport({ kind: 'boxes', stop: 'X', boxes: '78', pallets: '2', reportMissing: true, missing: '2', expected: 80 }).report;
  assert.deepEqual([r.boxes, r.pallets, r.missing, r.expected], [78, 2, 2, 80]);
  assert.equal(cleanStopReport({ kind: 'boxes', stop: 'X', boxes: '80', missing: '3' }).report.missing, null, 'missing only when they report it');
  assert.match(cleanStopReport({ kind: 'problem', stop: 'X' }).error, /what happened/);
  assert.deepEqual(cleanStopReport({ kind: 'scan', stop: 'X', docIds: ['12', 'x; drop', 34] }).report.docIds, ['12', '34']);
  assert.match(cleanStopReport({ kind: 'nope', stop: 'X' }).error, /Unknown/);
});

test('stop email: missing boxes with the count against TruckMate, words escaped, scans and photos listed; log lines', () => {
  const r = { ...cleanStopReport({ kind: 'boxes', stop: 'SOUTH WINDSOR, CT', stopName: 'FLOWERS & PRODUCE BY TERRA', boxes: 78, pallets: 2, reportMissing: true, missing: 2, expected: 80, note: 'Faltan <2> cajas de rosas' }).report, at: '2026-11-19T22:00:00Z' };
  const m = stopEmail(r, { trip: '627549', driver: 'Ferney Urrego', truck: '4504', trailer: '18094', links: [{ id: 'p1', label: 'Photo 1', url: 'https://x/sr/f/a' }], attached: ['p1'], scans: [{ paper: 'POD', bill: 'M5064641', confirmation: 'FB-123456', attached: true }] });
  assert.equal(m.subject, 'MISSING BOXES // 2 BOXES // TRIP 627549 // SOUTH WINDSOR, CT');
  assert.match(m.html, /78 of 80 in TruckMate/); assert.match(m.html, /Faltan &lt;2&gt; cajas/); assert.match(m.html, /POD · M5064641 · confirmation FB-123456/); assert.match(m.html, /Photo 1<\/a> <span[^>]*>· attached/);
  assert.equal(logLine(r, 'Ferney Urrego'), 'Ferney Urrego at FLOWERS & PRODUCE BY TERRA: delivered 78 boxes of 80, 2 pallets — 2 MISSING · "Faltan <2> cajas de rosas"');
  const p = { ...cleanStopReport({ kind: 'problem', stop: 'CLIFTON, NJ', why: 'refused' }).report, at: '2026-11-19T22:00:00Z' };
  assert.equal(stopEmail(p, { trip: '627549' }).subject, 'ISSUE AT A STOP // CUSTOMER REFUSED // TRIP 627549 // CLIFTON, NJ');
});

test('left the cooler: fresh GPS out of Miami with the trailer, or rolling after TruckMate says departed; old GPS or no trailer proves nothing', () => {
  const now = Date.parse('2026-11-19T22:00:00Z');
  const it = (t, s) => ({ trip: { trailer: '18094', origZoneDesc: 'MIAMI TERMINAL', status: 'DISP', ...t }, _samsara: { lat: 27.4, lng: -80.3, gpsAt: '2026-11-19T21:55:00Z', speedMph: 60, ...s } });
  assert.match(leftCooler(it(), now).why, /out of the Miami area/);
  assert.equal(leftCooler(it({}, { lat: 25.82, lng: -80.32, speedMph: 0 }), now), null, 'still at the cooler');
  assert.equal(leftCooler(it({}, { lat: 25.82, lng: -80.32, speedMph: 30 }), now), null, 'moving in Miami, TruckMate not departed');
  assert.match(leftCooler(it({ status: 'DEPSHIP' }, { lat: 25.82, lng: -80.32, speedMph: 30 }), now).why, /rolling/);
  assert.equal(leftCooler(it({}, { gpsAt: '2026-11-19T20:00:00Z' }), now), null, 'old GPS');
  assert.equal(leftCooler(it({ trailer: '' }), now), null, 'no trailer');
  assert.equal(leftCooler(it({ origZoneDesc: 'BARTOW' }, { speedMph: 0 }), now), null, 'another origin: only rolling + departed counts');
  const steps = withDetected({}, { at: '2026-11-19T21:55:00Z' });
  assert.deepEqual([steps['at-shipper'].auto, steps.loaded.by], [true, 'Jarvis (GPS)']);
  const tapped = { 'at-shipper': { at: 'x' } };
  assert.equal(withDetected(tapped, { at: 'y' })['at-shipper'].at, 'x', 'what the driver tapped wins');
  assert.equal(withDetected({ 'at-shipper': { at: 'x' }, loaded: { at: 'z' } }, { at: 'y' }).loaded.at, 'z');
});

test('stop reports from the app: only the driver\'s load, once per key, photo once per key, email with every photo and the scanned paper', async () => {
  const kv = {}; const files = []; const mails = []; const logged = [];
  const pool = { query: async (sql, args = []) => {
    if (/^INSERT INTO ta_stop_files/.test(sql)) { files.push({ id: args[0], filename: args[5], media_type: args[6], data: args[8] }); return { rows: [] }; }
    if (/WHERE id = ANY/.test(sql)) return { rows: files.filter((f) => args[0].includes(f.id)) };
    return { rows: [] };
  } };
  const db = { enabled: true, pool, get: async (k, d) => (k in kv ? JSON.parse(JSON.stringify(kv[k])) : d), set: async (k, v) => { kv[k] = v; }, update: async (k, f, d) => { kv[k] = f(k in kv ? JSON.parse(JSON.stringify(kv[k])) : d); return kv[k]; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const board = { trips: [{ trip: { tripNumber: '627549', driver: '986', status: 'DEPSHIP', powerUnit: '4504', trailer: '18094' } }] };
  const docs = { readDocs: async ({ ids }) => ids.map((id) => ({ id, mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4') })) };
  initStopReports(app, { db, secret: 's', requireDriver: (req, res, next) => { req.driver = { code: req.headers.drv || '986', name: 'Ferney Urrego' }; next(); }, requireAuth: (q, r, n) => n(), getBoard: async () => board, docs,
    sendMail: async (m) => { mails.push(m); }, recipients: { shortage: async () => ['ntellez@floridabeauty.us'], issue: async () => ['ntellez@floridabeauty.us'] }, log: async (...a) => logged.push(a), now: () => Date.parse('2026-11-19T22:00:00Z') });
  const call = async (key, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; done(); return this; }, send(t) { out.body = t; done(); return this; }, setHeader() {}, end() { done(); } };
    let done; const fin = new Promise((ok) => { done = ok; });
    const req = { body, params, query, headers, _body: true };
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
    await Promise.race([fin, new Promise((ok) => { setTimeout(ok, 200); })]); return out;
  };
  const P = { trip: '627549' };
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports', { params: { trip: '999999' }, body: { clientId: 'a', kind: 'photo', stop: 'X' } })).status, 404, 'not their load');
  const scan = await call('POST /driver/me/loads/:trip/stopreports', { params: P, body: { clientId: 's1', kind: 'scan', stop: 'SOUTH WINDSOR, CT', paper: 'pod', bill: 'M5064641', confirmation: 'FB-1', docIds: ['77'] } });
  assert.equal(scan.body.needsSend, false);
  const pic = await call('POST /driver/me/loads/:trip/stopreports', { params: P, body: { clientId: 'p1', kind: 'photo', stop: 'SOUTH WINDSOR, CT', note: 'pallet' } });
  const jpg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const up = (id, key, hd = {}) => call('POST /driver/me/loads/:trip/stopreports/:id/files', { params: { ...P, id }, query: { key, name: 'a.jpg' }, headers: { 'content-type': 'image/jpeg', ...hd }, body: jpg });
  assert.equal((await up(pic.body.id, 'k1')).status, 200);
  assert.equal((await up(pic.body.id, 'k1')).body.already, true); assert.equal(files.length, 1);
  const box = await call('POST /driver/me/loads/:trip/stopreports', { params: P, body: { clientId: 'b1', kind: 'boxes', stop: 'SOUTH WINDSOR, CT', stopName: 'TERRA', boxes: 78, pallets: 2, reportMissing: true, missing: 2, expected: 80 } });
  assert.equal(box.body.needsSend, true);
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports', { params: P, body: { clientId: 'b1', kind: 'boxes', stop: 'X', boxes: 1 } })).body.id, box.body.id, 'same key → same report');
  await up(box.body.id, 'k2');
  const sent = await call('POST /driver/me/loads/:trip/stopreports/:id/send', { params: { ...P, id: box.body.id } });
  assert.equal(sent.status, 200); assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['ntellez@floridabeauty.us']);
  assert.match(mails[0].subject, /^MISSING BOXES \/\/ 2 BOXES \/\/ TRIP 627549/);
  assert.equal(mails[0].attachments.length, 3, 'the scanned POD + both photos from that stop');
  assert.equal(mails[0].attachments[0].contentType, 'application/pdf');
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports/:id/send', { params: { ...P, id: box.body.id } })).body.already, true);
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports/:id/send', { params: { ...P, id: pic.body.id } })).body.noEmail, true);
  assert.equal(logged.length, 3); assert.match(logged[2][2].text, /2 MISSING/);
  const mine = await call('GET /driver/me/loads/:trip/stopreports', { params: P });
  assert.deepEqual(mine.body.reports.map((r) => r.kind), ['scan', 'photo', 'boxes']); assert.equal(mine.body.reports[1].photos, 1);
  const con = await call('GET /truckmate/stopreports/:trip', { params: P });
  assert.match(con.body.reports[1].links[0].url, /\/sr\/f\//);
});

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

test('stop email (Jarvis layout): shortage leads with the count and the customer, count strip, TruckMate source, driver words escaped, scans and photos with their real status; log lines', () => {
  const r = { ...cleanStopReport({ kind: 'boxes', stop: 'SOUTH WINDSOR, CT', stopName: 'FLOWERS & PRODUCE BY TERRA', boxes: 78, pallets: 2, reportMissing: true, missing: 2, expected: 80, note: 'Faltan <2> cajas' }).report, at: '2026-11-19T22:00:00Z' };
  const m = stopEmail(r, { trip: '627549', driver: 'Ferney Urrego', driverCode: '986', truck: '4504', trailer: '18094', links: [{ id: 'p1', label: 'Photo 1', url: 'https://x/sr/f/a' }, { id: 'p2', label: 'Photo 2', url: 'https://x/sr/f/b' }], attached: ['p1'], scans: [{ paper: 'POD', bill: 'M5064641', confirmation: 'FB-123456', attached: true }] });
  assert.equal(m.subject, '2 boxes missing | South Windsor, CT | Trip 627549');
  assert.match(m.html, /2 boxes missing/i); assert.match(m.html, />Delivery shortage<\/h1>/); assert.match(m.html, /FLOWERS &amp; PRODUCE BY TERRA/); assert.match(m.html, /South Windsor, CT/);
  assert.match(m.html, /78 of 80 expected boxes delivered\./); assert.match(m.html, /EXPECTED[\s\S]*80[\s\S]*DELIVERED[\s\S]*78[\s\S]*MISSING[\s\S]*2[\s\S]*PALLETS[\s\S]*2/);
  assert.match(m.html, /78 of 80 in TruckMate/); assert.match(m.html, /Faltan &lt;2&gt; cajas/); assert.match(m.html, /Original message · Spanish/);
  assert.match(m.html, /POD · M5064641[\s\S]*Confirmation FB-123456 · Attached to this email/);
  assert.match(m.html, /Photo 1<\/a><\/b><br><span[^>]*>Attached to this email · link works 30 days/); assert.match(m.html, /Photo 2<\/a><\/b><br><span[^>]*>Not attached/);
  assert.match(m.html, /Ferney Urrego \(ID 986\)/); assert.doesNotMatch(m.html, /TEST · SAMPLE DATA/);
  assert.equal(logLine(r, 'Ferney Urrego'), 'Ferney Urrego at FLOWERS & PRODUCE BY TERRA: delivered 78 boxes of 80, 2 pallets — 2 MISSING · "Faltan <2> cajas"');
  const p = { ...cleanStopReport({ kind: 'problem', stop: 'CLIFTON, NJ', stopName: 'MAIN WHOLESALE FLORIST-CLIFTON', why: 'refused', note: 'Rechazaron 1 caja, llegó aplastada.' }).report, at: '2026-11-19T22:00:00Z' };
  const pm = stopEmail(p, { trip: '627549', others: [{ label: 'Earlier count', text: 'delivered 89 boxes of 90, 3 pallets' }] });
  assert.equal(pm.subject, 'Customer refusal | Clifton, NJ | Trip 627549');
  assert.match(pm.html, /CUSTOMER REFUSAL/); assert.match(pm.html, /Earlier count<\/td><td[^>]*>delivered 89 boxes of 90, 3 pallets/); assert.match(pm.html, /The earlier delivery count is shown separately below/);
  assert.doesNotMatch(pm.html, /Scanned paperwork/i, 'no paperwork section when nothing was scanned');
  const long = stopEmail({ ...r, stopName: 'A VERY LONG CUSTOMER NAME WHOLESALE FLORIST & PRODUCE DISTRIBUTION COMPANY OF NEW ENGLAND LLC', note: '' }, { trip: '1' });
  assert.match(long.html, /DISTRIBUTION COMPANY OF NEW ENGLAND LLC/); assert.doesNotMatch(long.html, /Driver&#39;s message/i, 'no empty message panel');
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
  assert.equal(mails[0].subject, '2 boxes missing | South Windsor, CT | Trip 627549');
  assert.equal(mails[0].attachments.length, 3, 'the scanned POD + both photos from that stop');
  assert.equal(mails[0].attachments[0].contentType, 'application/pdf');
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports/:id/send', { params: { ...P, id: box.body.id } })).body.already, true);
  assert.equal((await call('POST /driver/me/loads/:trip/stopreports/:id/send', { params: { ...P, id: pic.body.id } })).body.noEmail, true);
  assert.equal(logged.length, 3); assert.match(logged[2][2].text, /2 MISSING/);
  const mine = await call('GET /driver/me/loads/:trip/stopreports', { params: P });
  assert.deepEqual(mine.body.reports.map((r) => r.kind), ['scan', 'photo', 'boxes']); assert.equal(mine.body.reports[1].photos, 1);
  const con = await call('GET /truckmate/stopreports/:trip', { params: P });
  assert.match(con.body.reports[1].links[0].url, /\/sr\/f\//);
  // paperwork from the Paperwork tab lands on its bill's stop (a scan line with its boxes); one already on the stop isn't repeated
  board.trips[0].freightBills = [{ billNumber: 'M5064641', billToName: 'EAST COAST WHOLESALE FLORIST', endZoneDescription: 'NORWALK, CT, 06851' }];
  kv['taDriverPaperwork:florida-beauty'] = [
    { at: '2026-11-21T08:01:00Z', trip: '627549', kind: 'pod', bill: 'M5064641', boxes: 62, confirmation: 'FB-482150', by: 'Wilber Echeverri' },
    { at: '2026-11-21T08:02:00Z', trip: '627549', kind: 'pod', bill: 'X0000000', boxes: 1, confirmation: 'FB-1', by: 'Wilber Echeverri' },
    { at: '2026-11-21T08:03:00Z', trip: '600000', kind: 'pod', bill: 'M5064641', boxes: 9, confirmation: 'FB-2', by: 'Someone' },
  ];
  const withPw = (await call('GET /truckmate/stopreports/:trip', { params: P })).body.reports.filter((r) => r.from === 'Paperwork tab');
  assert.deepEqual(withPw.map((r) => [r.kind, r.stop, r.bill, r.boxes, r.confirmation]), [['scan', 'NORWALK, CT', 'M5064641', 62, 'FB-482150']], 'only this trip\'s, only bills on the load');
});

test('a team: the box count Wilber sends marks the stop delivered for Ferney too (Nov 21)', async () => {
  const kv = {};
  const db = { enabled: true, pool: { query: async () => ({ rows: [] }) }, get: async (k, d) => (k in kv ? JSON.parse(JSON.stringify(kv[k])) : d), set: async (k, v) => { kv[k] = v; }, update: async (k, f, d) => { kv[k] = f(k in kv ? JSON.parse(JSON.stringify(kv[k])) : d); return kv[k]; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const board = { trips: [{ trip: { tripNumber: '627549', driver: '986', driver2: '2473', status: 'DEPSHIP', powerUnit: '4504' }, freightBills: [{ billNumber: 'M5065658', endZoneDescription: 'LUDLOW, MA, 01056', billToName: 'DENEHY', pieces: 32 }] }] };
  initStopReports(app, { db, secret: 's', requireDriver: (req, res, next) => { req.driver = { code: '2473', name: 'Wilber Echeverri' }; next(); }, getBoard: async () => board, now: () => Date.parse('2026-11-21T11:40:00Z') });
  let out = {}; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; } };
  const hs = routes['POST /driver/me/loads/:trip/stopreports']; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); };
  const req = { body: { clientId: 'b1', kind: 'boxes', stop: 'LUDLOW, MA, 01056', boxes: 32, expected: 32 }, params: { trip: '627549' }, query: {}, headers: {} };
  await next(); await new Promise((r) => { setTimeout(r, 50); });
  assert.equal(out.body.ok, true);
  const steps = kv['taDriverCheckins:florida-beauty']['627549'].steps;
  assert.equal(steps['delivered:LUDLOW, MA, 01056'].by, 'Wilber Echeverri');
  assert.ok(steps['arrived:LUDLOW, MA, 01056']);
});

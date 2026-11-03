import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { photosOf, exifOrientation, shrinkPixels, shrinkPhoto, photoAttachments } from '../breakdownphotos.js';
import { correctedLoad, renderBreakdownEmail, renderBreakdownPhotosEmail, initBreakdownReport, loadType, loadRows, breakdownSubject } from '../breakdownreport.js';
import { mmsImages } from '../ringcentral.js';

const noise = (w, h) => { const data = Buffer.alloc(w * h * 4); for (let i = 0; i < data.length; i += 1) data[i] = (i * 2654435761) >>> 24; return jpeg.encode({ data, width: w, height: h }, 95).data; };
const load = { trip: { tripNumber: '626143', powerUnit: '2008', trailer: '2029', origZoneDesc: 'VERNON, CA', destZoneDesc: 'CHARLOTTE, NC' }, _ratecon: { broker: 'Example Logistics' }, freightBills: [{ billNumber: 'B1', billToName: 'Example Co *', pieces: 10, temperature: 35 }, { billNumber: 'B2', billToName: 'Other Co', pieces: 5, temperature: 35 }] };
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };

test('only stored pictures from an email count as photos', () => {
  assert.deepEqual(photosOf({ attachments: [{ docId: 7, name: 'a.jpg', contentType: 'image/jpeg' }, { docId: 8, name: 'b.pdf', contentType: 'application/pdf' }, { docId: null, contentType: 'image/png' }] }), [{ docId: '7', name: 'a.jpg' }]);
  assert.equal(photosOf({ attachments: Array.from({ length: 9 }, (_, i) => ({ docId: i + 1, contentType: 'image/png' })) }).length, 9, 'every picture, no limit');
  assert.deepEqual(photosOf(null), []);
});

test('a big phone photo shrinks to fit an email', () => {
  const big = Buffer.from(noise(2400, 1800));
  assert.ok(big.length > 450 * 1024);
  const s = shrinkPhoto(big, 'image/jpeg');
  assert.ok(s.bytes.length < big.length / 2);
  const d = jpeg.decode(s.bytes); assert.ok(Math.max(d.width, d.height) <= 1400);
});

test('a sideways phone photo comes out the right way up', () => {
  const img = { width: 3, height: 2, data: Buffer.from([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]) };
  const o = shrinkPixels(img, 6);
  assert.deepEqual([o.width, o.height], [2, 3]);
  assert.equal(o.data[(0 * 2 + 1) * 4], 255, 'top left goes to top right');
  assert.equal(exifOrientation(Buffer.from([0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0])), 6);
  assert.equal(exifOrientation(Buffer.from('nothing')), 1);
  assert.equal(exifOrientation(null), 1);
});

test('photos that do not fit are counted, not lost', () => {
  const a = { data: Buffer.alloc(1000), mediaType: 'image/png' };
  const r = photoAttachments([a, a, a], 2500);
  assert.equal(r.attachments.length, 2); assert.equal(r.skipped, 1);
  assert.equal(r.attachments[1].cid, 'bkphoto2');
});

test('the email shows the photos and the whole load', () => {
  const report = { unit: '2008', trip: '626143', reason: 'trailer light came off', by: 'Liz', atMs: 1 };
  const m = renderBreakdownEmail({ item: load, report, photoCids: ['bkphoto1'], photosNote: '1 more photo could not go in this email.' });
  assert.match(m.html, /cid:bkphoto1/); assert.match(m.html, /1 more photo/); assert.match(m.text, /1 photo in this email/);
  for (const v of ['BROKER', 'Example Logistics', 'Example Co, Other Co', 'Boxes: 15', 'Temperature: 35°F', 'From: VERNON, CA', 'To: CHARLOTTE, NC', 'Trailer: 2029', 'Truck: 2008']) assert.match(m.text, new RegExp(v));
  assert.doesNotMatch(renderBreakdownEmail({ item: load, report }).html, />Photos</);
  assert.match(renderBreakdownPhotosEmail({ report, item: load, by: 'Driver (text)', count: 2, subject: 'Re: x', photoCids: ['bkphoto1'] }).html, /2 new photos from Driver \(text\)/);
});

test('the load type is always said when there are bills, even a mix', () => {
  const bills = (...n) => ({ trip: { tripNumber: '1', powerUnit: '2', trailer: '3' }, freightBills: n.map((billNumber) => ({ billNumber })) });
  assert.equal(loadType(bills('B1', 'M2')), 'BROKER + FLOWERS');
  assert.equal(breakdownSubject(bills('B1', 'M2'), 'flat tire'), 'BROKER + FLOWERS BREAKDOWN TRUCK 2 TRAILER 3 // TK 2 TL 3 TO 1');
  assert.equal(loadType({ trip: {} }), null);
  assert.deepEqual(loadRows({ trip: {} })[0], ['Load type', 'Not on file']);
});

test('a report takes its photos, a later report adds them, and each goes out once', async () => {
  const sent = []; const extra = [];
  const r = initBreakdownReport(null, { db: mem(), secret: 's', getBoard: async () => ({ trips: [load] }), send: async (rep) => sent.push(rep), sendPhotos: async (rep, item, fresh, by) => extra.push([fresh.map((x) => x.docId), by]), textedPhotos: async () => [{ docId: '9', name: 'text.jpg' }], now: () => 1000 });
  await r.fromEmail({ trip: '626143', reason: 'trailer light came off', by: 'Liz', emailId: 'e1', photos: [{ docId: '1', name: 'a.jpg' }] });
  assert.deepEqual(sent[0].photos.map((x) => x.docId), ['1', '9'], 'the driver text comes along');
  const again = await r.fromEmail({ trip: '626143', reason: 'still down', by: 'Ana', emailId: 'e2', photos: [{ docId: '1', name: 'a.jpg' }, { docId: '2', name: 'b.jpg' }] });
  assert.equal(again.duplicate, true);
  assert.deepEqual(extra, [[['2'], 'Ana']]);
  assert.equal((await r.addPhotos({ trip: '626143', photos: [{ docId: '2' }], by: 'x' })).added, 0);
  assert.equal((await r.addPhotos({ trip: '999', photos: [{ docId: '5' }], by: 'x' })).added, 0, 'no breakdown, nothing to add to');
});

test('pictures in a text are found, other attachments are not', () => {
  assert.deepEqual(mmsImages({ attachments: [{ id: 1, type: 'Text', uri: 'u1', contentType: 'text/plain' }, { id: 2, type: 'MmsAttachment', uri: 'https://media.ringcentral.com/x', contentType: 'image/jpeg', fileName: 'p.jpg' }, { id: 3, type: 'MmsAttachment', uri: 'u', contentType: 'video/mp4' }] }), [{ uri: 'https://media.ringcentral.com/x', contentType: 'image/jpeg', name: 'p.jpg' }]);
  assert.deepEqual(mmsImages({}), []);
});

test('reporting from the card: the choice sets the subject, the driver line and photos go in, and a repeat only adds photos', async () => {
  const routes = {}; const sent = []; const extra = [];
  const app = { get() {}, post(p, ...h) { routes[p] = h[h.length - 1]; } };
  initBreakdownReport(app, { requireAuth: (q, s, n) => n(), db: mem(), secret: 's', getBoard: async () => ({ trips: [load] }), send: async (rep) => sent.push(rep), sendPhotos: async (rep, item, fresh) => extra.push(fresh.length), storePhotos: async (trip, files) => files.map((f, i) => ({ docId: `${i + 1}`, name: f.filename })), now: () => 1000 });
  const call = (body) => new Promise((resolve) => { let code = 200; routes['/truckmate/breakdown/report']({ body, user: { name: 'Example Dispatcher' } }, { status(c) { code = c; return this; }, json: (j) => resolve({ code, ...j }) }); });
  assert.equal((await call({ trip: '626143', problem: ' ' })).code, 400);
  const photo = { dataBase64: 'eA==', mediaType: 'image/jpeg', filename: 'a.jpg' };
  const ok = await call({ trip: '626143', part: 'trailer', problem: 'light came off', driverSays: 'it fell off on the highway', photos: [photo, { dataBase64: 'eA==', mediaType: 'application/pdf', filename: 'x.pdf' }] });
  assert.equal(ok.subject, 'BROKER BREAKDOWN TRAILER 2029 // TK 2008 TL 2029 TO 626143');
  assert.equal(sent[0].by, 'Example Dispatcher'); assert.equal(sent[0].driverSays, 'it fell off on the highway'); assert.equal(sent[0].photos.length, 1, 'pictures only');
  const again = await call({ trip: '626143', problem: 'more pictures', photos: [photo, { ...photo, filename: 'b.jpg' }] });
  assert.equal(again.code, 409); assert.match(again.error, /photos went out/); assert.deepEqual(extra, [1], 'only the new one');
  const m = renderBreakdownEmail({ item: load, report: sent[0] });
  assert.match(m.html, /What the driver says/); assert.match(m.text, /What the driver says: it fell off/); assert.equal(m.subject, ok.subject);
});

test('an update on an open breakdown goes on the chain with its history, and needs an open breakdown', async () => {
  const routes = {}; const sent = [];
  const app = { get(p, ...h) { routes[`GET ${p}`] = h[h.length - 1]; }, post(p, ...h) { routes[p] = h[h.length - 1]; } };
  initBreakdownReport(app, { requireAuth: (q, s, n) => n(), db: mem(), secret: 's', getBoard: async () => ({ trips: [load] }), send: async () => {}, sendPhotos: async (rep, item, fresh, by, message) => sent.push({ rep, fresh, by, message }), storePhotos: async (trip, files) => files.map((f, i) => ({ docId: `u${i}`, name: f.filename })), now: () => 1000 });
  const call = (p, body, q = {}) => new Promise((resolve) => { let code = 200; routes[p]({ body, params: q, user: { name: 'Example Dispatcher' } }, { status(c) { code = c; return this; }, json: (j) => resolve({ code, ...j }) }); });
  assert.equal((await call('GET /truckmate/breakdown/open/:trip', null, { trip: '626143' })).open, null);
  assert.equal((await call('/truckmate/breakdown/update', { trip: '626143', message: 'tech on the way' })).code, 409, 'nothing open');
  await call('/truckmate/breakdown/report', { trip: '626143', part: 'trailer', problem: 'light came off' });
  assert.equal((await call('/truckmate/breakdown/update', { trip: '626143', message: ' ' })).code, 400);
  assert.equal((await call('/truckmate/breakdown/update', { trip: '626143', message: 'tech arrived', photos: [{ dataBase64: 'eA==', mediaType: 'image/jpeg', filename: 'p.jpg' }] })).ok, true);
  await call('/truckmate/breakdown/update', { trip: '626143', message: 'waiting on a part' });
  assert.equal(sent.length, 2); assert.equal(sent[0].message, 'tech arrived'); assert.equal(sent[0].by, 'Example Dispatcher'); assert.equal(sent[0].fresh.length, 1);
  const open = (await call('GET /truckmate/breakdown/open/:trip', null, { trip: '626143' })).open;
  assert.equal(open.reason, 'light came off'); assert.equal(open.updates.length, 2);
  const m = renderBreakdownEmail({ item: load, report: sent[1].rep, update: { message: 'waiting on a part', by: 'Example Dispatcher' }, earlier: sent[1].rep.updates.slice(0, -1) });
  assert.match(m.html, /BROKER BREAKDOWN UPDATE/); assert.match(m.html, /Update from Example Dispatcher/); assert.match(m.text, /Update: waiting on a part/); assert.match(m.text, /Earlier: tech arrived \(Example Dispatcher\)/);
  assert.match(m.text, /Reason: light came off/); assert.match(m.text, /Load type: BROKER/); assert.doesNotMatch(m.html, /Next step for dispatch/);
});

test('a corrected truck or trailer goes on the email, with the right location or none', async () => {
  const other = { trip: { tripNumber: '2', powerUnit: '4560' }, _samsara: { location: 'Other truck' } };
  const here = { ...load, _samsara: { location: 'This truck' } };
  assert.equal(correctedLoad(here, [here, other], {}), here, 'nothing changed');
  assert.equal(correctedLoad(here, [here], { truck: '2008', trailer: '2029' }), here, 'same numbers');
  assert.equal(correctedLoad(here, [here, other], { trailer: '7000' })._samsara.location, 'This truck');
  assert.equal(correctedLoad(here, [here, other], { truck: '4560' })._samsara.location, 'Other truck');
  assert.equal(correctedLoad(here, [here], { truck: '9999' })._samsara, undefined, 'never the wrong truck');
  assert.equal(here.trip.powerUnit, '2008', 'the load itself is untouched');
  const sent = [];
  const r = initBreakdownReport(null, { db: mem(), secret: 's', getBoard: async () => ({ trips: [here, other] }), send: async (rep, item) => sent.push([rep, item]), now: () => 1000 });
  assert.equal((await r.fromEmail({ trip: '999', reason: 'flat tire', by: 'A', emailId: 'x' })).ok, false, 'a trip not on the board is refused');
  const ok = await r.fromEmail({ trip: '626143', reason: 'trailer light', by: 'A', emailId: 'y', truck: '2010', trailer: '3000' });
  assert.equal(ok.subject, 'BROKER BREAKDOWN TRAILER 3000 // TK 2010 TL 3000 TO 626143');
  assert.equal(sent[0][0].unit, '2010'); assert.equal(sent[0][1].trip.trailer, '3000');
});

test('an update is a real reply on the first email, and a plain email if it cannot be', async () => {
  const { sendInThread } = await import('../mailer.js');
  const env = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const calls = []; let found = true;
  const fetchFn = async (url, o = {}) => { calls.push(`${o.method || 'GET'} ${url.split('/users/').pop().split('?')[0]}`); const ok = (j, status = 200) => ({ ok: true, status, json: async () => j }); if (/token/.test(url)) return ok({ access_token: 'x', expires_in: 3600 }); if (/sentitems/.test(url)) return ok({ value: found ? [{ id: 'm1' }] : [] }); if (/createReply/.test(url)) return ok({ id: 'd1' }); return ok({}, 202); };
  const msg = { to: ['a@floridabeauty.us'], subject: 'Re: X', html: '<b>u</b>', attachments: [{ name: 'p.jpg', contentType: 'image/jpeg', bytes: Buffer.from('x'), cid: 'bkphoto1' }] };
  const r = await sendInThread(msg, 'X', { env, fetchFn, direct: true });
  assert.equal(r.threaded, true);
  assert.ok(calls.some((c) => /d1\/send/.test(c))); assert.ok(calls.some((c) => /d1\/attachments/.test(c)));
  found = false;
  assert.equal((await sendInThread(msg, 'X', { env, fetchFn, direct: true })).threaded, undefined, 'falls back');
});

test('no photo count limit: what doesn\'t fit in one email comes back for the next one, numbered on', () => {
  const big = { data: Buffer.alloc(1000, 1), mediaType: 'image/png' };
  const r = photoAttachments(Array.from({ length: 9 }, () => big), 2500);
  assert.equal(r.attachments.length, 2); assert.equal(r.rest.length, 7);
  const r2 = photoAttachments(r.rest, 2500, 3);
  assert.deepEqual(r2.attachments.map((a) => a.cid), ['bkphoto3', 'bkphoto4']);
});

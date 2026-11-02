import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { photosOf, exifOrientation, shrinkPixels, shrinkPhoto, photoAttachments, MAX_PHOTOS } from '../breakdownphotos.js';
import { renderBreakdownEmail, renderBreakdownPhotosEmail, initBreakdownReport, loadType, loadRows, breakdownSubject } from '../breakdownreport.js';
import { mmsImages } from '../ringcentral.js';

const noise = (w, h) => { const data = Buffer.alloc(w * h * 4); for (let i = 0; i < data.length; i += 1) data[i] = (i * 2654435761) >>> 24; return jpeg.encode({ data, width: w, height: h }, 95).data; };
const load = { trip: { tripNumber: '626143', powerUnit: '2008', trailer: '2029', origZoneDesc: 'VERNON, CA', destZoneDesc: 'CHARLOTTE, NC' }, _ratecon: { broker: 'Example Logistics' }, freightBills: [{ billNumber: 'B1', billToName: 'Example Co *', pieces: 10, temperature: 35 }, { billNumber: 'B2', billToName: 'Other Co', pieces: 5, temperature: 35 }] };
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };

test('only stored pictures from an email count as photos', () => {
  assert.deepEqual(photosOf({ attachments: [{ docId: 7, name: 'a.jpg', contentType: 'image/jpeg' }, { docId: 8, name: 'b.pdf', contentType: 'application/pdf' }, { docId: null, contentType: 'image/png' }] }), [{ docId: '7', name: 'a.jpg' }]);
  assert.equal(photosOf({ attachments: Array.from({ length: 9 }, (_, i) => ({ docId: i + 1, contentType: 'image/png' })) }).length, MAX_PHOTOS);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { ltlStops, boxCheck, initStopFlow } from '../stopflow.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const LTL = { trip: { tripNumber: '900500', powerUnit: '4550', trailer: '7328' }, freightBills: [{ billNumber: 'M5055267' }, { billNumber: 'G5054888' }],
  _manifest: { stops: [{ stopNumber: 1, key: 's1', action: 'LOAD', customer: 'MIAMI TERMINAL', pieces: 61 },
    { stopNumber: 2, key: 's2', action: 'DELIVER', customer: 'SAMPLE FLORIST', city: 'JACKSONVILLE', state: 'FL', pieces: 10, apptDate: '2026-11-04', apptTime: '06:00', receivingHours: 'Mon-Fri 5 AM - 2 PM', callAhead: [{ contact: 'Brenda', phone: '555-010-0527', leadMinutes: 30, method: 'call' }], instructions: ['Use the back door'], references: ['P045339: SAMPLE MIAMI'] },
    { stopNumber: 3, key: 's3', action: 'DELIVER', customer: 'EXAMPLE FLOWERS', city: 'SAVANNAH', state: 'GA', pieces: 24 },
    { stopNumber: 4, key: 's4', action: 'DELIVER', customer: 'TEST BLOOMS', city: 'ATLANTA', state: 'GA', pieces: 20 },
    { stopNumber: null, key: 's4b', action: 'DELIVER', customer: 'TEST BLOOMS / LOCKERS', city: 'ATLANTA', state: 'GA', pieces: 7 }] } };
const BROKER = { trip: { tripNumber: '900600' }, freightBills: [{ billNumber: 'B180764' }], _ratecon: { data: {} }, _manifest: { stops: [{ n: 1, action: 'DELIVER', customer: 'X' }] } };

test('an LTL load leaves with the trip sheet deliveries; broker loads and loads without a trip sheet have none', () => {
  assert.deepEqual(ltlStops(LTL).map((s) => [s.key, s.n, s.customer, s.boxes]), [['s2', 2, 'SAMPLE FLORIST', 10], ['s3', 3, 'EXAMPLE FLOWERS', 24], ['s4', 4, 'TEST BLOOMS', 20], ['s4b', null, 'TEST BLOOMS / LOCKERS', 7]], 'two lines under one stop number stay two stops');
  const first = ltlStops(LTL)[0];
  assert.deepEqual([first.appt, first.receivingHours, first.callAhead, first.instructions, first.references], ['2026-11-04 06:00', 'Mon-Fri 5 AM - 2 PM', [{ contact: 'Brenda', phone: '555-010-0527', leadMinutes: 30, method: 'call' }], ['Use the back door'], ['P045339: SAMPLE MIAMI']]);
  assert.equal(ltlStops(BROKER), null);
  assert.equal(ltlStops({ trip: { tripNumber: '1' }, freightBills: [{ billNumber: 'M1' }] }), null);
  assert.deepEqual(boxCheck(8, 10), { delivered: 8, expected: 10, diff: -2, missing: 2, extra: 0 });
  assert.equal(boxCheck(8, null), null);
});

test('stop by stop: boxes against the trip sheet (mismatch email), signed paperwork kept for the end, an issue with photos, then the trip completed with everything', async () => {
  const db = mem(); const mails = []; const stored = []; const logged = [];
  const docs = { enabled: true, storeDocs: async ({ files }) => files.map((f) => { stored.push(f); return { id: String(stored.length) }; }), readDocs: async ({ ids }) => ids.map((id) => ({ id, mediaType: stored[Number(id) - 1].mediaType, data: Buffer.from('x') })) };
  const flow = initStopFlow({ db, docs, getBoard: async () => ({ trips: [LTL] }), sendMail: async (m) => { mails.push(m); }, recipients: async (k) => [`${k}@test`], log: async (s, t, e) => { logged.push(e); }, now: () => Date.parse('2026-11-03T20:00:00Z') });
  assert.equal((await flow.stopDone('900500', 'nope', { boxes: 1, by: 'Frank U' })).code, 404);
  assert.equal((await flow.stopDone('900500', 's2', { boxes: 'x', by: 'Frank U' })).code, 400);
  // stop 2: right count, a photo of the signed paper (not a scan)
  assert.deepEqual((await flow.stopDone('900500', 's2', { boxes: 10, files: [{ dataBase64: 'eA==', mediaType: 'image/jpeg' }], scan: false, by: 'Frank U' })).check.diff, 0);
  assert.deepEqual(mails.map((m) => m.to[0]), [], 'matches: no email per stop — the signed paperwork waits for the trip\'s final email');
  // stop 3: two short, no paperwork
  await flow.stopDone('900500', 's3', { boxes: 22, by: 'Frank U' });
  assert.equal(mails.at(-1).to[0], 'stop_box_mismatch@test');
  assert.match(mails.at(-1).subject, /BOX COUNT MISMATCH \/\/ EXAMPLE FLOWERS \/\/ DELIVERED 22 OF 24/);
  assert.match(mails.at(-1).text, /2 boxes missing/);
  // an issue at stop 4
  assert.equal((await flow.stopIssue('900500', 's4', { text: '', by: 'Frank U' })).code, 400);
  await flow.stopIssue('900500', 's4', { text: 'Receiver closed\nCalled the number on the door', files: [{ dataBase64: 'eA==', mediaType: 'image/jpeg' }], by: 'Frank U' });
  assert.equal(mails.at(-1).to[0], 'stop_issue@test'); assert.match(mails.at(-1).text, /Receiver closed\nCalled the number on the door/);
  await flow.stopDone('900500', 's4', { boxes: 20, by: 'Frank U' });
  await flow.stopDone('900500', 's4b', { boxes: 7, by: 'Frank U' });
  const view = await flow.forDriver(LTL);
  assert.deepEqual(view.stops.map((s) => [s.key, s.delivered, s.check && s.check.diff, s.paperwork, s.issues.length]), [['s2', 10, 0, 1, 0], ['s3', 22, -2, 0, 0], ['s4', 20, 0, 0, 1], ['s4b', 7, 0, 0, 0]]);
  assert.equal((await flow.complete('900500', { by: 'Frank U' })).ok, true);
  const done = mails.at(-1);
  assert.equal(done.to[0], 'trip_completed@test');
  assert.match(done.subject, /^TRIP COMPLETED \/\/ TK 4550 TL 7328 TRIP 900500 \/\/ 4 STOPS \/\/ 1 BOX MISMATCH$/);
  assert.match(done.text, /59 boxes delivered of 61 on the trip sheet/); assert.match(done.text, /stop 3 −2/);
  assert.match(done.html, /Receiver closed/);
  assert.equal(done.attachments.length, 2, 'the signed paperwork and the issue photo go with it');
  assert.match(done.html, /What the driver reported/); assert.match(done.text, /Files from the driver: 2 attached/);
  assert.equal((await flow.complete('900500', { by: 'Frank U' })).already, true, 'only once');
  const items2 = [LTL]; await flow.overlay('x', items2);
  const sf = items2[0]._stopFlow;
  assert.deepEqual([sf.total, sf.done, sf.mismatches, sf.issues, !!sf.completedAt, sf.completedBy], [4, 4, 1, 1, true, 'Frank U']);
  assert.deepEqual(sf.stops.map((x) => [x.n, x.boxes, x.expected, x.diff, x.paperwork, x.issues.length]), [[2, 10, 10, 0, 1, 0], [3, 22, 24, -2, 0, 0], [4, 20, 20, 0, 0, 1], [null, 7, 7, 0, 0, 0]]);
  assert.ok(logged.some((e) => /Stop 3 done .*22 boxes, trip sheet 24/.test(e.text)));
});

test('complete any time (stops not done are named), comments with photos on a stop, and every file the driver sent goes out, split over emails', async () => {
  const db = mem(); const mails = []; const stored = [];
  const big = 'x'.repeat(1800 * 1024);
  const docs = { enabled: true,
    storeDocs: async ({ files }) => files.map((f) => { stored.push(f); return { id: String(stored.length) }; }),
    listDocs: async () => [{ id: '99', filename: 'POD-paperwork-tab.pdf' }],
    readDocs: async ({ ids }) => ids.map((id) => (id === '99' ? { id, mediaType: 'application/pdf', data: Buffer.from(big) } : { id, mediaType: stored[Number(id) - 1].mediaType, data: Buffer.from(big) })) };
  const flow = initStopFlow({ db, docs, getBoard: async () => ({ trips: [LTL] }), sendMail: async (m) => { mails.push(m); }, recipients: async (k) => [`${k}@test`], now: () => Date.parse('2026-11-05T15:00:00Z') });
  assert.equal((await flow.stopComment('900500', 's2', { text: '', by: 'Frank U' })).code, 400);
  await flow.stopComment('900500', 's2', { text: 'Left the boxes inside the cooler, door was open', files: [{ dataBase64: 'eA==', mediaType: 'image/jpeg' }], by: 'Frank U' });
  assert.equal(mails.length, 0, 'a comment goes on the load, not its own email');
  const view = await flow.forDriver(LTL);
  assert.deepEqual(view.stops[0].comments.map((c) => [c.text, c.photos]), [['Left the boxes inside the cooler, door was open', 1]]);
  await flow.stopDone('900500', 's2', { boxes: 10, by: 'Frank U' });
  const r = await flow.complete('900500', { by: 'Frank U' });
  assert.deepEqual([r.ok, r.notDone, r.files], [true, 3, 2]);
  const first = mails.find((m) => /^TRIP COMPLETED/.test(m.subject));
  assert.match(first.subject, /4 STOPS \/\/ 3 NOT DONE$/);
  assert.match(first.html, /Not marked done/); assert.match(first.text, /Not marked done: stop 3 EXAMPLE FLOWERS, stop 4 TEST BLOOMS, TEST BLOOMS \/ LOCKERS/);
  assert.match(first.html, /Comment · stop 2/); assert.match(first.html, /Left the boxes inside the cooler/);
  assert.equal(first.attachments.length, 1, 'one big file per email');
  const more = mails.filter((m) => /^Re: TRIP COMPLETED/.test(m.subject));
  assert.equal(more.length, 1); assert.match(more[0].subject, /FILES 2 OF 2$/); assert.equal(more[0].attachments[0].name, 'POD-paperwork-tab.pdf', 'Paperwork tab files too');
});

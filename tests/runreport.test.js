import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeRun, mergeRules, otherStops, leftAfterLoaded, runStops, reportsAt, renderRunReport, initRunReport } from '../runreport.js';

const M = 60000; const H = 60 * M;
const T0 = Date.parse('2026-11-19T22:30:00Z');

test('a clean run gets a 10; each rule takes its points and says why', () => {
  const clean = { team: true, runHours: 40, leftAfterMin: 20, floridaStops: [], otherStops: [], stops: 12, checkedIn: 12, noBoxReport: 0, noPaperwork: 0, missingNoPhoto: 0 };
  assert.deepEqual(gradeRun(clean), { grade: 10, lost: [] });
  const fl = { from: T0 + 2 * H, to: T0 + 2 * H + 45 * M, place: 'Pilot, Fort Pierce, FL' };
  const rest = (h) => ({ from: T0 + h * H, to: T0 + h * H + 2 * H, place: `Rest area ${h}` });
  const g = gradeRun({ ...clean, leftAfterMin: 75, floridaStops: [fl], otherStops: [rest(10), rest(20), rest(30)], checkedIn: 7, noBoxReport: 2, noPaperwork: 5, missingNoPhoto: 1 });
  assert.deepEqual(g.lost.map((x) => [x.rule, x.points]), [['leftLate', 2], ['floridaStops', 1], ['extraStops', 2], ['checkins', 1], ['boxReports', 1], ['paperwork', 2], ['missingNoPhoto', 0.5]]);
  assert.equal(g.grade, 1);                                   // never below 1
  assert.match(g.lost[1].why, /Fort Pierce, FL \(45 min\)/);
  // a solo run may rest more: 40 h → 3 rests allowed
  assert.equal(gradeRun({ ...clean, team: false, otherStops: [rest(10), rest(20), rest(30)] }).grade, 10);
  // a rule turned off counts nothing
  assert.equal(gradeRun({ ...clean, leftAfterMin: 90 }, mergeRules({ leftLate: { on: false } })).grade, 10);
});

test('GPS stops: customers and our Miami yard aren\'t counted; Florida ones on the way out apart', () => {
  const visits = [{ enteredAt: T0 + 30 * H, exitedAt: T0 + 30.5 * H }];
  const s = (h, lat, lng, place) => ({ from: T0 + h * H, to: T0 + h * H + H, lat, lng, place });
  const out = otherStops([s(-1, 25.81, -80.31, 'Miami yard'), s(3, 27.4, -80.3, 'Fort Pierce, FL 34945'), s(18, 37, -78, 'Rest area, VA'), s(30, 40.9, -74.1, 'Clifton, NJ')], visits, { departedMs: T0, leftFloridaMs: T0 + 8 * H });
  assert.deepEqual(out.florida.map((x) => x.place), ['Fort Pierce, FL 34945']);
  assert.deepEqual(out.other.map((x) => x.place), ['Rest area, VA']);
});

test('left the yard: the first GPS point 2 miles from where it sat when loaded', () => {
  const p = (min, lat) => ({ t: new Date(T0 + min * M).toISOString(), lat, lng: -80.32 });
  assert.equal(leftAfterLoaded([p(-5, 25.8), p(0, 25.8), p(25, 25.801), p(40, 25.84)], T0), 40);
  assert.equal(leftAfterLoaded([], T0), null);
});

test('the run\'s stops, the driver\'s reports at each, and the email', () => {
  const item = { trip: { tripNumber: 627549, powerUnit: '4504', trailer: '18094', driver: '986', driver2: '2473' },
    freightBills: [{ billNumber: 'M1', endZoneDescription: 'LUDLOW, MA, 01056', billToName: 'DENEHY *', pieces: 30 }, { billNumber: 'M2', endZoneDescription: 'LUDLOW, MA, 01056', billToName: 'DENEHY *', pieces: 2 }],
    _manifest: { stops: [{ action: 'DELIVER', customer: 'DENEHY WHOLESALE', city: 'LUDLOW', state: 'MA', n: 8, sheetPieces: 32 }] } };
  const st = runStops(item);
  assert.deepEqual([st[0].customer, st[0].boxes, st[0].sheetBoxes, st[0].bills], ['DENEHY WHOLESALE', 32, 32, ['M1', 'M2']]);
  const reps = [{ kind: 'boxes', stop: 'LUDLOW, MA', boxes: 32, expected: 32 }, { kind: 'boxes', stop: 'WORCESTER, MA', boxes: 137 }];
  assert.equal(reportsAt(reps, st[0]).length, 1);
  const html = renderRunReport({ trip: { trip: '627549', truck: '4504', drivers: ['986', '2473'], team: true }, loadedMs: T0, finishedMs: T0 + 40 * H, leftAfterMin: 20, reason: 'delivered',
    stops: [{ ...st[0], boxReports: [{ boxes: 30, expected: 32, missing: 2, by: 'Wilber' }], scans: [{ paper: 'pod', bill: 'M1' }], photos: 2, files: [], problems: [], notes: ['2 boxes short'], arrivedMs: T0 + 33 * H, leftMs: T0 + 33.3 * H, minutes: 20, lastEta: T0 + 34 * H, artisEta: T0 + 35 * H, checkedIn: true }],
    floridaStops: [], otherStops: [], grade: { grade: 9.5, lost: [{ label: 'Reported missing boxes without a photo', points: 0.5, why: '1 missing-box report without a photo' }] },
    totals: { boxes: 30, expected: 32, missing: 2, pallets: 1, photos: 2, scans: 1, avgStopMin: 20 } });
  assert.match(html.subject, /Run report · trip 627549 · truck 4504 · 986 & 2473 · grade 9.5\/10/);
  assert.match(html.html, /2 MISSING/); assert.match(html.html, /📄 POD M1/); assert.match(html.html, /our ETA 1 h earlier · ARTIS 2 h earlier/);
});

test('an LTL or team run that finishes: one email to Nadim, the grade kept; a plain one-driver load gets none', async () => {
  const kv = {}; const sent = [];
  const db = { enabled: true, get: async (k, d) => (k in kv ? kv[k] : d), set: async (k, v) => { kv[k] = v; }, update: async (k, fn, d) => { kv[k] = fn(k in kv ? kv[k] : d); return kv[k]; } };
  const rr = initRunReport({ db, env: {}, sendMail: async (m) => { sent.push(m); }, now: () => T0 + 40 * H });
  const item = { trip: { tripNumber: 627549, powerUnit: '4504', driver: '986', driver2: '2473' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'LUDLOW, MA, 01056', pieces: 32 }] };
  await rr.onFinished('florida-beauty', { item }, 'delivered');
  await rr.onFinished('florida-beauty', { item }, 'delivered');                   // once only
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  assert.equal(kv['taDriverGrades:florida-beauty'][0].trip, '627549');
  await rr.onFinished('florida-beauty', { item: { trip: { tripNumber: 1, driver: '5' }, freightBills: [] } }, 'delivered');
  assert.equal(sent.length, 1);
});

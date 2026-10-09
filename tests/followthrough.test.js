import test from 'node:test';
import assert from 'node:assert/strict';
import { initFollowThrough, offersFromRateCon, extrasFor, readDecision, brokerEmails } from '../followthrough.js';

function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; }, raw: m }; }
const RC = { broker: 'RXO', loadNumber: 'RXO 24261611', rate: 2500, rateText: '$2,500', brokerEmail: 'kim@rxo.com', contacts: [{ role: 'tracking', email: 'track@rxo.com' }, { role: 'billing', email: 'pod@rxo.com' }], specialInstructions: ['Check calls every 2 hours via email', 'Driver must call receiver 1 hour before arrival', 'POD within 24 hours'], detention: '$50/hr after 2 hrs', lumper: 'Reimbursed with receipt', accessorials: [] };

test('rate con → what Jarvis can do, numbered; extras after delivery; YES / NO replies', () => {
  assert.deepEqual(brokerEmails(RC), { tracking: ['track@rxo.com', 'kim@rxo.com'], billing: ['pod@rxo.com', 'kim@rxo.com'], rep: ['kim@rxo.com'] });
  const o = offersFromRateCon('624102', RC);
  assert.deepEqual(o.map((x) => [x.n, x.kind]), [[1, 'updates'], [2, 'pod'], [3, 'driver']]);
  assert.equal(o[0].everyHours, 2);
  const ex = extrasFor({ comms: [{ type: 'note', kind: 'detention', text: 'Detention record: shipper — arrived …, 4h 10m on site (2h 10m past 2h free).' }, { type: 'reply', text: 'paid lumper $185 at the dock' }], docs: [{ docType: 'lumper_receipt', filename: 'lumper.jpg' }], rc: RC });
  assert.deepEqual(ex.map((x) => x.kind), ['detention', 'lumper']);
  assert.match(ex[0].detail, /rate con terms: \$50\/hr/);
  assert.deepEqual(readDecision('YES', 3), [1, 2, 3]);
  assert.deepEqual(readDecision('yes 1 and 3 please', 3), [1, 3]);
  assert.equal(readDecision('No thanks', 3), null);
  assert.equal(readDecision('who is the driver?', 3), undefined, 'not a decision');
  assert.deepEqual(readDecision('Si\n\nFrom: Jarvis\nReply YES to do all 1 2 3', 3), [1, 2, 3], 'the quoted email doesn\'t count');
});

test('follow-through: instructions email with offers → YES does them → delivered with extras → revised rate con received', async () => {
  const db = memDb({ taFollowCfg: { to: ['dispatch@floridabeauty.us'] } });
  const sent = []; const watches = []; const texts = [];
  const app = { get: () => {}, put: () => {}, post: () => {} };
  let t = Date.parse('2026-10-09T15:00:00Z');
  const f = initFollowThrough(app, { requireAuth: () => {}, db, sendMail: async (m) => { sent.push(m); }, etaWatch: { add: async (w) => { watches.push(w); return { ok: true }; } }, driver: { text: async (s, trip, msg) => { texts.push(msg); return { sent: true }; } }, docs: { listDocs: async () => [{ id: 9, docType: 'lumper_receipt', filename: 'lumper.jpg' }], readDocs: async () => [] }, now: () => t });
  await db.set('taTruckMateRateCon:florida-beauty', { 624102: RC });
  await f.onRateCon('florida-beauty', '624102', RC, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^Rate con — Trip 624102 · RXO RXO 24261611 · 3 special instructions \[JV-[A-F0-9]{6}\]$/);
  assert.match(sent[0].html, /Driver must call receiver 1 hour before arrival/);
  assert.match(sent[0].html, /Reply <b>YES<\/b>/);
  await f.onRateCon('florida-beauty', '624102', RC, RC);
  assert.equal(sent.length, 1, 'same rate con again → no second email');
  const token = sent[0].subject.match(/JV-([A-F0-9]+)/)[1];
  const r = await f.handleReply('florida-beauty', { subject: `RE: ${sent[0].subject}`, text: 'yes 1 3', from: { name: 'Rosa', address: 'rosa@floridabeauty.us' } });
  assert.equal(r.handled, true);
  assert.deepEqual(watches[0], { trips: ['624102'], to: ['track@rxo.com', 'kim@rxo.com'], everyHours: 2, by: 'Jarvis (approved by Rosa by email)', label: 'RXO updates' });
  assert.match(texts[0], /Driver must call receiver/);
  assert.match(sent[1].html, /Done for trip <b>624102<\/b>/);
  assert.equal((await f.handleReply('florida-beauty', { subject: `RE: [JV-${token}]`, text: 'yes', from: { address: 'rosa@floridabeauty.us' } })).summary.startsWith('Already done'), true);
  // delivered, with a lumper receipt on file → closeout email + to-do on the load
  const delivered = { trip: { tripNumber: '624102', status: 'DELVD' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'X, NJ', actualDelivery: '2026-10-09T10:00:00' }] };
  await f.run('florida-beauty', [delivered]);
  const close = sent.find((m) => /extras to bill/.test(m.subject));
  assert.ok(close); assert.match(close.html, /lumper receipt/);
  const tasks = (await db.get('taLoadTasks:florida-beauty', {}))['624102'];
  assert.match(tasks[0].title, /revised rate con with: lumper/);
  // YES → Jarvis asks the broker for the revised rate con
  const tk = close.subject.match(/JV-([A-F0-9]+)/)[1];
  await f.handleReply('florida-beauty', { subject: `RE: [JV-${tk}]`, text: 'yes', from: { name: 'Rosa', address: 'rosa@floridabeauty.us' } });
  const ask = sent.find((m) => /^Revised rate confirmation/.test(m.subject));
  assert.deepEqual(ask.to, ['pod@rxo.com', 'kim@rxo.com']);
  // the revised rate con arrives → received + dispatch told
  await f.onRateCon('florida-beauty', '624102', { ...RC, rate: 2685, rateText: '$2,685', accessorials: ['Lumper $185'] }, RC);
  assert.ok(sent.some((m) => /Revised rate con received — Trip 624102/.test(m.subject)));
  // morning email
  t = Date.parse('2026-10-10T12:05:00Z');   // 8:05 AM Eastern
  await f.run('florida-beauty', [delivered]);
  assert.ok(sent.some((m) => /^Follow-through — 2026-10-10/.test(m.subject)));
});

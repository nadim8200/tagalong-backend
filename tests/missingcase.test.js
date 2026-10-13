import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingBoxesText, caseId, systemView, caseEmail, caseTextReply, initMissingCases, byCustomer } from '../missingcase.js';

const board = [{ trip: { tripNumber: '624892', powerUnit: '2612' },
  freightBills: [{ billToName: "PAPA JOE'S GOURMET MARKET", endZoneDescription: 'ROCHESTER HILLS, MI, 48307', pieces: 25, actualDelivery: '2026-10-13T09:40:00' }],
  _manifest: { stops: [{ action: 'DELIVER', customer: "PAPA JOE'S GOURMET MARKET", city: 'ROCHESTER HILLS', state: 'MI', pieces: 25 }] },
  _artis: { shipDate: '2026-10-12', stops: [{ consigneeId: '51104', consignee: "PAPA JOE'S GOURMET MARKET", boxes: 25, scanned: 12, missing: 13, shippers: [{ shipper: 'Unknown shipper', missing: 13 }] }] } }];

test('texts about missing boxes are recognized (English / Spanish); ETA questions are not', () => {
  for (const t of ['We are missing 3 boxes from today', 'we got short 5 boxes', 'Nos faltaron 4 cajas de rosas', 'didn\'t receive 2 boxes of hydrangea', 'faltan cajas']) assert.ok(isMissingBoxesText(t), t);
  for (const t of ['What is my ETA?', 'How many boxes are on the truck?', 'Delivered thanks']) assert.ok(!isMissingBoxesText(t), t);
  assert.match(caseId(Date.parse('2026-10-13T15:00:00Z'), () => 0.5), /^MB-1013-\d{3}$/);
});

test('the office email: what the customer said + what the system shows; the customer reply has no counts', () => {
  const sys = systemView(board, { business: "Papa Joe's" });
  assert.equal(sys[0].trip, '624892');
  assert.match(sys[0].artis, /12 of 25 received — 13 not received from the shipper/);
  const c = { id: 'MB-1013-482', channel: 'call', business: "Papa Joe's Gourmet Market", contactName: 'Joe', callbackNumber: '2485551234', boxesMissing: '13', details: 'Missing 13 boxes of roses from today', system: sys };
  const m = caseEmail(c);
  assert.match(m.subject, /^Missing boxes case MB-1013-482 — Papa Joe's Gourmet Market \(trip 624892\)$/);
  assert.match(m.html, /What the customer said[\s\S]*Missing 13 boxes of roses/);
  assert.match(m.html, /What the system shows[\s\S]*12 of 25 received — 13 not received from the shipper/);
  assert.match(m.html, /\(248\) 555-1234/);
  for (const r of [caseTextReply('MB-1013-482'), caseTextReply('MB-1013-482', false)]) {
    assert.match(r, /MB-1013-482/); assert.match(r, /office will/);
    assert.ok(!/\b(received|scanned|loaded)\b/i.test(r.replace("If you haven't yet", '')), r);
    assert.ok(!/\b(12|13|25)\b/.test(r));
  }
});

test('a customer text opens a case, a follow-up text from the same phone is added to it, and the office is emailed', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  const mails = []; let t = Date.parse('2026-10-13T15:00:00Z');
  const mc = initMissingCases({ db, sendMail: async (m) => mails.push(m), recipients: async () => ['cs@floridabeauty.us'], getBoard: async () => board, now: () => t });
  assert.equal(await mc.fromText({ from: '+12485551234', text: 'What is my ETA?' }), null);
  const a = await mc.fromText({ from: '+12485551234', text: "Hi this is Papa Joe's, we are missing 13 boxes from trip 624892" });
  assert.match(a.reply, /we opened case MB-1013-\d{3} for your missing boxes/);
  assert.equal(mails.length, 1); assert.match(mails[0].html, /12 of 25 received/);
  t += 3600000;
  const b = await mc.fromText({ from: '(248) 555-1234', text: 'It was the roses from Unknown farm' });
  assert.equal(b.id, a.id); assert.match(b.reply, /added that to case/);
  assert.equal(mails.length, 2); assert.match(mails[1].subject, /^Re: Missing boxes case/); assert.match(mails[1].html, /The customer added:<\/b> It was the roses/);
  const c = await mc.open({ channel: 'call', business: 'Unknown Florist', details: 'missing 2 boxes' });
  assert.match(caseEmail(c).html, /could not match this to a load/);
});

test('Jarvis on the phone: gathers the details, gives the case number, never counts', async () => {
  const { PROMPT } = await import('../voice.js');
  assert.match(PROMPT, /reports boxes MISSING or SHORT[\s\S]*report_missing_boxes, never take_message[\s\S]*NEVER tell them how many boxes we received/);
});

test('grouped by customer: how many times each one filed, open cases, boxes reported', () => {
  const g = byCustomer([
    { id: 'MB-1', business: "Papa Joe's Gourmet Market", boxesMissing: '13', at: '2026-10-13T10:00:00Z' },
    { id: 'MB-2', business: "PAPA JOE'S GOURMET MARKET LLC", boxesMissing: '2 boxes', status: 'resolved', at: '2026-10-20T10:00:00Z' },
    { id: 'MB-3', business: 'Mobi\'s', boxesMissing: '21', at: '2026-10-14T10:00:00Z' },
  ]);
  assert.equal(g[0].cases, 2); assert.equal(g[0].open, 1); assert.equal(g[0].boxesReported, 15); assert.deepEqual(g[0].ids, ['MB-1', 'MB-2']);
  assert.equal(g[1].cases, 1);
});

test('the console lists cases and the office sets status / notes (who and when)', async () => {
  const store = { 'taMissingBoxCases:florida-beauty': [{ id: 'MB-1013-482', at: '2026-10-13T15:00:00Z', business: 'Mobi\'s' }] };
  const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  const routes = {}; const app = { get: (p, a, h) => { routes[`GET ${p}`] = h; }, post: (p, a, h) => { routes[`POST ${p}`] = h; } };
  initMissingCases({ app, requireAuth: () => {}, db, now: () => Date.parse('2026-10-14T12:00:00Z') });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const r1 = res(); await routes['GET /truckmate/missing-cases']({}, r1);
  assert.equal(r1.body.cases[0].status, 'open'); assert.equal(r1.body.byCustomer[0].cases, 1);
  const r2 = res(); await routes['POST /truckmate/missing-cases/:id']({ params: { id: 'MB-1013-482' }, body: { status: 'resolved', note: 'Found at the farm, credit issued' }, user: { name: 'Sara Trujillo' } }, r2);
  assert.equal(r2.body.status, 'resolved'); assert.deepEqual(r2.body.notes[0], { at: '2026-10-14T12:00:00.000Z', by: 'Sara Trujillo', note: 'Found at the farm, credit issued', status: 'resolved' });
  const r3 = res(); await routes['POST /truckmate/missing-cases/:id']({ params: { id: 'nope' }, body: { status: 'open' } }, r3);
  assert.equal(r3.code, 404);
});

// call 10/13 (Nadim, staff phone): "missing box report — trip 624520, 10/09 Lombard IL, 45 boxes of roses" went to take_message
test('a "take a message" about missing boxes still opens a case', async () => {
  const { isMissingBoxesText } = await import('../missingcase.js');
  assert.ok(isMissingBoxesText('Missing box report: trip 624520, delivered 10/09 in Lombard, IL — 45 boxes of roses missing'));
  assert.ok(isMissingBoxesText('Customer reports 45 boxes missing on trip 624520'));
});

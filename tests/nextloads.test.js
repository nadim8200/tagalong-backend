import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truckFor, verify, brief, initNextLoads, batchBlocks } from '../nextloads.js';
import { isRateConBatch } from '../inbox.js';
import { renderOutboundFollowUp } from '../followupmail.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const env = { INTERNAL_DOMAINS: 'floridabeauty.us', MAIL_FROM: 'jarvis@floridabeauty.us' };
const pdf = (n) => ({ name: `rc${n}.pdf`, contentType: 'application/pdf' });

test('a batch from Gus (or staff "rate cons" with several files) is read as next loads', () => {
  assert.equal(isRateConBatch('gus@floridabeauty.us', 'loads', '', [pdf(1), pdf(2)], env), true);
  assert.equal(isRateConBatch('rosar@floridabeauty.us', 'Rate cons for tomorrow', '', [pdf(1), pdf(2)], env), true);
  assert.equal(isRateConBatch('rosar@floridabeauty.us', 'hello', '', [pdf(1), pdf(2)], env), false);
  assert.equal(isRateConBatch('gus@floridabeauty.us', 'rc', '', [pdf(1)], env), false, 'one rate con goes the normal way');
  assert.equal(isRateConBatch('ana@broker.com', 'Rate cons', '', [pdf(1), pdf(2)], env), false, 'outside senders never');
});

test('which truck: on the rate con (printed / handwritten), else next to the load in the email', () => {
  const trucks = new Set(['2403', '2612']);
  assert.deepEqual(truckFor({ truckNumber: 'TRK 2403' }, { trucks }), { truck: '2403', how: 'truck number on the rate con' });
  assert.deepEqual(truckFor({ handwrittenNotes: ['Trk 2612 next'] }, { trucks }), { truck: '2612', how: 'written on the rate con' });
  assert.deepEqual(truckFor({ handwrittenNotes: ['2612 after Atlanta'] }, { trucks }), { truck: '2612', how: 'handwritten on the rate con' });
  assert.deepEqual(truckFor({ loadNumber: '8192162' }, { emailText: 'Hi team\n8192162 - 2403 after the NJ run\n7781234 - 2612', trucks }), { truck: '2403', how: 'next to this load in the email' });
  assert.equal(truckFor({ loadNumber: '8192162' }, { emailText: '8192162 pick up 1400', trucks }), null, 'a time is not a truck');
  assert.equal(truckFor({ loadNumber: '99' }, { emailText: '2403', trucks }), null);
});

test('loop: next load sits on the truck card, verified once TruckMate books it, gone when it starts', async () => {
  const db = memDb();
  await db.set('taRateConPending:florida-beauty', [{ id: 'rc_1', record: { broker: 'RXO', loadNumber: '8192162', fbfBillNumber: 'B180400', truckNumber: '2403', pickups: [{ city: 'Miami', state: 'FL', date: '10/09' }], deliveries: [{ city: 'Atlanta', state: 'GA', date: '10/10' }], rateText: '$2,400', handwrittenNotes: ['Team'], docIds: [5] } }]);
  const current = { trip: { tripNumber: '624318', status: 'DEPSHIP', powerUnit: '2403' } };
  const nl = initNextLoads({ db, now: () => Date.parse('2026-10-09T03:00:00Z') });
  const got = await nl.consider('florida-beauty', [{ trip: null, pendingId: 'rc_1' }], { items: [current], emailText: '', from: 'Gus', emailId: 'e1' });
  assert.equal(got[0].truck, '2403');
  let board = [JSON.parse(JSON.stringify(current))];
  await nl.overlay('florida-beauty', board);
  assert.equal(board[0]._nextLoad.length, 1);
  assert.equal(board[0]._nextLoad[0].rc.loadNumber, '8192162');
  assert.equal(board[0]._nextLoad[0].verified, null);
  // TruckMate books the next trip for 2403 with that bill
  board = [JSON.parse(JSON.stringify(current)), { trip: { tripNumber: '624500', status: 'DISP', powerUnit: '2403' }, freightBills: [{ billNumber: 'B180400' }] }];
  await nl.overlay('florida-beauty', board);
  assert.deepEqual(board[0]._nextLoad[0].verified, { by: 'TruckMate', trip: '624500' });
  assert.equal(board[1]._nextLoad, undefined, 'not shown on the next trip itself');
  // the next trip starts → no longer "next"
  board = [{ trip: { tripNumber: '624500', status: 'DEPSHIP', powerUnit: '2403' }, freightBills: [{ billNumber: 'B180400' }] }];
  await nl.overlay('florida-beauty', board);
  assert.equal(board[0]._nextLoad, undefined);
  assert.equal((await nl.list()).length, 0);
});

test('the reply to Gus: one block per rate con, asks only for a missing truck', () => {
  const e = (truck) => ({ id: truck || 'x', truck, truckHow: 'truck number on the rate con', rc: brief({ broker: 'RXO', loadNumber: truck ? '1' : '2', pickups: [{ city: 'Miami', state: 'FL', date: '10/09' }], deliveries: [{ city: 'Atlanta', state: 'GA' }] }) });
  const out = renderOutboundFollowUp({ heading: 'Next loads — 2 rate cons read', blocks: batchBlocks([e('2403'), e(null)]) });
  assert.match(out.text, /== Truck 2403 ==\nRXO · Load 1 — NEXT LOAD\n  Load: Miami, FL · 10\/09 → Atlanta, GA/);
  assert.match(out.text, /RXO · Load 2 — NEEDS THE TRUCK/);
  assert.deepEqual(out.needs, ['the truck for RXO load 2']);
});

test('verify by trip sheet when TruckMate does not have it yet', () => {
  const n = { truck: '2612', rc: { bill: 'B180401', loadNumber: null } };
  assert.deepEqual(verify(n, [], [{ tripNumber: '624777', truck: '2612', stops: [{ bills: ['B180401'] }] }]), { by: 'trip sheet', trip: '624777' });
});

test('Gus\'s email: one rate con + "This will be for truck # 2604" → truck 2604 (any line of the email)', () => {
  const text = '@jarvis@floridabeauty.us\nThis will be for truck # 2604\nLet me know if running late\nAnd update broker with eta\n\nRegards,\nGustavo A. Duarte\nPhone: 305-503-1200 EXT # 250\nCell: 786-402-8448';
  assert.deepEqual(truckFor({ loadNumber: '108638', broker: 'PTC LOGISTICS LLC' }, { emailText: text, trucks: new Set(['2403']), single: true }), { truck: '2604', how: 'named in the email' });
  assert.equal(truckFor({ loadNumber: '108638' }, { emailText: text, single: false }), null, 'a batch needs the truck next to its load');
  assert.equal(truckFor({ loadNumber: '1' }, { emailText: 'truck 2604 and truck 2612', single: true }), null, 'two trucks named → ask');
});

import { tmNextTrips } from '../nextloads.js';

test('TruckMate next trip: 2615 on 624497 (rolling, 35°F) with 624682 already assigned (Eliot ME → Hialeah FL, −10°F)', () => {
  const cur = { trip: { tripNumber: '624497', status: 'DEPCONS', powerUnit: '2615', origZoneDesc: 'VENTURA TERMINAL', destZoneDesc: 'BEDFORD, NH, 03110' }, freightBills: [{ billNumber: 'C978029', temperature: 35 }, { billNumber: 'C978031', temperature: 35 }] };
  const next = { trip: { tripNumber: '624682', status: 'ASSGN', powerUnit: '2615', origZoneDesc: 'ELIOT, ME, 03903', destZoneDesc: 'HIALEAH, FL, 33018' }, freightBills: [{ billNumber: 'B180414', billToName: 'BILL HOWARD CO', endZoneDescription: 'HIALEAH, FL, 33018', deliverBy: '2026-10-12T03:30:00', temperature: -10 }], _times: { createdAt: '2026-10-09T17:25:33.000Z', createdBy: 'JENNIFERG' } };
  const other = { trip: { tripNumber: '624700', status: 'ASSGN', powerUnit: '2403' }, freightBills: [] };
  const m = tmNextTrips([cur, next, other]);
  const n = m.get('624497');
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].trip, n[0].from, n[0].to, n[0].bills[0].bill, n[0].bills[0].billTo, n[0].createdBy], ['624682', 'ELIOT, ME, 03903', 'HIALEAH, FL, 33018', 'B180414', 'BILL HOWARD CO', 'JENNIFERG']);
  assert.deepEqual(n[0].tempChange, { now: [35], next: [-10] });
  assert.equal(m.has('624682'), false, 'shown on the current trip, not on itself');
  assert.equal(m.has('624700'), false, 'a truck with no trip rolling has no "next"');
});

import { nextTripTiming } from '../nextloads.js';
import { opsRisks, planEmail } from '../plansheet.js';

const GEO = { 30303: { lat: 33.75, lng: -84.39 }, 33563: { lat: 28.01, lng: -82.12 }, 33566: { lat: 27.99, lng: -82.1 }, 33166: { lat: 25.81, lng: -80.3 } };
const geo = (z) => GEO[z] || null;
const next2212 = { trip: { tripNumber: '624588', status: 'ASSGN', powerUnit: '2212', origZoneDesc: 'PLANT CITY, FL, 33563', destZoneDesc: 'MIAMI, FL, 33166' },
  freightBills: [{ billNumber: 'Y180360', billToName: 'PIERSON SUPPLY', endZoneDescription: 'MIAMI, FL, 33166', deliverBy: '2026-10-10T13:00:00', deliverByEnd: '2026-10-10T13:00:00', temperature: 35 }] };

test('next trip timing: 2212 empties near Plant City Thu evening → makes Miami by Fri 1 PM', () => {
  const eta = { stops: [{ label: 'LAKELAND, FL, 33566', zip: '33566', etaMs: Date.parse('2026-10-09T22:00:00Z') }] };   // 6 PM ET
  const t = nextTripTiming(next2212, { eta, geo, now: Date.parse('2026-10-09T16:00:00Z') });
  assert.equal(t.state, 'ok');
  assert.equal(t.deadlineMs, Date.parse('2026-10-10T17:00:00Z'));
  assert.ok(t.deliverEtaMs < t.deadlineMs);
  assert.match(t.summary, /on time/);
});

test('next trip timing: empty in Atlanta Fri 6 AM → late for the Fri 1 PM Miami delivery', () => {
  const eta = { stops: [{ label: 'ATLANTA, GA, 30303', zip: '30303', etaMs: Date.parse('2026-10-10T10:00:00Z') }] };
  const t = nextTripTiming(next2212, { eta, geo, now: Date.parse('2026-10-09T16:00:00Z') });
  assert.equal(t.state, 'late');
  assert.equal(t.lateAt, 'delivery');
  assert.ok(t.lateMin > 60);
  assert.match(t.summary, /LATE for the delivery/);
  // and it reaches the Operations check email
  const cur = { trip: { tripNumber: '624446', status: 'DEPCONS', powerUnit: '2212' }, _tmNext: [{ trip: '624588', from: 'PLANT CITY, FL, 33563', timing: t }] };
  const rk = opsRisks([cur], { now: Date.parse('2026-10-09T16:00:00Z') });
  assert.equal(rk.nextLate.length, 1);
  assert.equal(rk.nextLate[0].truck, '2212');
  const mail = planEmail([], { risks: rk, now: Date.parse('2026-10-09T16:00:00Z') });
  assert.match(mail.subject, /1 pickups at risk/);
  assert.match(mail.html, /Next trip 624588/);
});

test('next trip timing: no live ETA → unknown, never a false alarm', () => {
  const t = nextTripTiming(next2212, { eta: null, geo });
  assert.equal(t.state, 'unknown');
});

test('TruckMate next trip: 35°F vs 36°F is not a temperature change', () => {
  const cur = { trip: { tripNumber: '1', status: 'DEPCONS', powerUnit: '9' }, freightBills: [{ temperature: 36 }] };
  const nx = { trip: { tripNumber: '2', status: 'ASSGN', powerUnit: '9' }, freightBills: [{ temperature: 35 }] };
  assert.equal(tmNextTrips([cur, nx]).get('1')[0].tempChange, null);
});

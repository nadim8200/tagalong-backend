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

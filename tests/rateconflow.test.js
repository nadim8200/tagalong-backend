import test from 'node:test';
import assert from 'node:assert/strict';
import { initRateConFlow, kindOf, whatChanged, loadOnBoard, findLoad, idsFromEmail, routeMatch, renderForInbound, renderForAccounting } from '../rateconflow.js';

function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const REC = { broker: 'Trinity', loadNumber: '9953899', truckNumber: '2207', rate: 1500, accessorials: [], pickups: [{ city: 'Apopka', state: 'FL' }], deliveries: [{ city: 'Miami', state: 'FL' }], docIds: [7], filename: 'rc.pdf' };
const flow = (records = { p1: REC }) => {
  const db = memDb({ 'taRateConPending:s': Object.entries(records).map(([id, record]) => ({ id, record })) });
  const mails = []; const saved = []; let t = 1000; let fail = false;
  const f = initRateConFlow({ db, docs: { readDocs: async ({ ids }) => ids.map((id) => ({ id, data: Buffer.from('%PDF'), mediaType: 'application/pdf' })) }, sendMail: async (m) => { if (fail) throw new Error('mail down'); mails.push(m); }, recipients: async (k) => [`${k}@floridabeauty.us`], saveOnLoad: async (site, trip) => saved.push(trip), now: () => (t += 1) });
  return { f, db, mails, saved, setFail: (v) => { fail = v; }, skip: (ms) => { t += ms; } };
};
const email = { id: 'e1', from: { name: 'Gustavo Duarte', address: 'gus@floridabeauty.us' }, subject: 'Fw: Trinity load', text: 'Add the broker on tracking' };
const entry = (over = {}) => ({ rc: { broker: 'Trinity', loadNumber: '9953899', rate: 1500, ...over } });
const board = (over = {}) => ({ trips: [{ trip: { tripNumber: '626300', powerUnit: '2207', trailer: '3010', ...over }, freightBills: [{ billNumber: 'B180900', referenceNumber: '9953899' }], _samsara: { driver1: 'Jose Aguila' } }] });

test('new, revised or TONU', () => {
  assert.equal(kindOf({ subject: 'Fw: Trinity load', rc: {} }), 'new');
  assert.equal(kindOf({ subject: 'REVISED rate con 123', rc: {} }), 'revised');
  assert.equal(kindOf({ text: 'Rev 2 attached', rc: {} }), 'revised');
  assert.equal(kindOf({ subject: 'TONU 123', rc: {} }), 'tonu');
  assert.equal(kindOf({ text: 'truck ordered not used', rc: {} }), 'tonu');
  assert.equal(kindOf({ rc: { rate: 1750 } }, entry()), 'revised', 'the same load, another rate');
  assert.equal(kindOf({ rc: { rate: 1500 } }, entry()), 'new');
});

test('what changed on a revised rate con', () => {
  assert.deepEqual(whatChanged({ rate: 1750, accessorials: ['Lumper $200'] }, entry({ accessorials: [] })), ['Rate $1,500.00 → $1,750.00 (+$250.00)', 'Lumper $200']);
  assert.deepEqual(whatChanged({ rate: 1200 }, entry()), ['Rate $1,500.00 → $1,200.00 (-$300.00)']);
  assert.deepEqual(whatChanged({ rate: 250 }), ['Rate $250.00']);
});

test('a load counts once it is in TruckMate with a trip and a truck, by an exact load number', () => {
  const rc = { loadNumber: '9953899', bill: null };
  assert.ok(loadOnBoard({ rc }, board().trips));
  assert.equal(loadOnBoard({ rc }, board({ powerUnit: null }).trips), null, 'no truck yet');
  assert.equal(loadOnBoard({ rc: { loadNumber: '111111' } }, board().trips), null);
  assert.ok(loadOnBoard({ rc: { loadNumber: '777777' } }, [{ trip: { tripNumber: '1', powerUnit: '9' }, freightBills: [], _ratecon: { data: { loadNumber: '777-777' } } }]), 'or the rate con dispatch put on it');
});

test('the emails carry the load and never hide what they are', () => {
  const m = renderForInbound({ entries: [{ rc: { broker: 'Trinity', loadNumber: '9953899', truck: '2207', rate: 1500, pickup: 'Apopka, FL' } }], from: 'Gus', text: 'PU 3PM - TEMP 28 <b>' });
  assert.equal(m.subject, 'NEW RATE CON // Trinity // LOAD 9953899 // TK 2207');
  assert.match(m.html, /PU 3PM - TEMP 28 &lt;b&gt;/); assert.doesNotMatch(m.html, /1,500/, 'the rate stays out of the dispatch copy');
  const a = renderForAccounting({ kind: 'new', rc: { broker: 'Trinity', loadNumber: '9953899', rate: 1500 } }, board().trips[0]);
  assert.equal(a.subject, 'RATE CON // TK 2207 TL 3010 TO 626300 // Trinity LOAD 9953899');
  for (const x of ['626300', 'B180900', '2207', '3010', 'Jose Aguila', '$1,500.00']) assert.ok(a.html.includes(x), x);
  assert.match(renderForAccounting({ kind: 'tonu', rc: { rate: 250 } }).subject, /^TONU/);
});

test('a new rate con: to the team now, to Accounting once, when the load is in the system', async () => {
  const h = flow();
  await h.f.received('s', { email, entries: [{ pendingId: 'p1' }], fullText: 'Add the broker\nPU 3PM - TEMP 28' });
  assert.equal(h.mails.length, 1); assert.deepEqual(h.mails[0].to, ['ratecon_inbound@floridabeauty.us']);
  assert.match(h.mails[0].html, /TEMP 28/); assert.equal(h.mails[0].attachments[0].name, 'RateCon-9953899-1.pdf');
  await h.f.process('s', { trips: [] });
  await h.f.process('s', board({ powerUnit: null }));
  assert.equal(h.mails.length, 1, 'nothing until it is in the system');
  await h.f.process('s', board());
  assert.equal(h.mails.length, 2); assert.deepEqual(h.mails[1].to, ['ratecon_accounting@floridabeauty.us']);
  assert.match(h.mails[1].subject, /TO 626300/); assert.equal(h.mails[1].attachments.length, 1); assert.deepEqual(h.saved, ['626300']);
  await h.f.process('s', board());
  assert.equal(h.mails.length, 2, 'once');
});

test('sent to a team group: no second copy to the team, Accounting still gets it', async () => {
  const h = flow();
  await h.f.received('s', { email, entries: [{ pendingId: 'p1' }], alreadyWithTeam: true });
  assert.equal(h.mails.length, 0);
  await h.f.process('s', board());
  assert.deepEqual(h.mails[0].to, ['ratecon_accounting@floridabeauty.us']);
});

test('the same rate con twice is one; a batch is one forward', async () => {
  const h = flow({ p1: REC, p2: { ...REC }, p3: { ...REC, loadNumber: '555555' } });
  await h.f.received('s', { email, entries: [{ pendingId: 'p1' }, { pendingId: 'p3' }] });
  assert.equal(h.mails.length, 1); assert.match(h.mails[0].subject, /2 LOADS/);
  await h.f.received('s', { email, entries: [{ pendingId: 'p2' }] });
  assert.equal(h.mails.length, 1);
});

test('a revised rate con or TONU goes to Billing right away, with what changed', async () => {
  const h = flow({ p1: REC, p2: { ...REC, rate: 1750 }, p3: { ...REC, loadNumber: '888888', rate: 250, summary: 'TONU for load 888888' } });
  await h.f.received('s', { email, entries: [{ pendingId: 'p1' }] });
  await h.f.process('s', board());
  await h.f.received('s', { email: { ...email, id: 'e2' }, entries: [{ pendingId: 'p2' }], items: board().trips });
  const m = h.mails.at(-1);
  assert.deepEqual(m.to, ['ratecon_accounting@floridabeauty.us']); assert.match(m.subject, /^REVISED RATE CON \/\/ TK 2207 TL 3010 TO 626300/); assert.match(m.html, /\+\$250\.00/);
  await h.f.received('s', { email: { ...email, id: 'e3' }, entries: [{ pendingId: 'p3' }] });
  assert.match(h.mails.at(-1).subject, /^TONU/); assert.match(h.mails.at(-1).html, /not in TruckMate yet/);
});

test('a failed email tries again, then stops; an old one stops waiting', async () => {
  const h = flow();
  await h.f.received('s', { email, entries: [{ pendingId: 'p1' }] });
  h.setFail(true);
  for (let i = 0; i < 6; i += 1) await h.f.process('s', board()); // eslint-disable-line no-await-in-loop
  assert.equal((await h.f.list('s'))[0].status, 'failed');
  const old = flow();
  await old.f.received('s', { email, entries: [{ pendingId: 'p1' }] });
  old.skip(22 * 86400000);
  await old.f.process('s', board());
  assert.equal((await old.f.list('s'))[0].status, 'expired'); assert.equal(old.mails.length, 1);
});

const trip = (n, over = {}, bills = []) => ({ trip: { tripNumber: n, powerUnit: '2207', trailer: '3010', status: 'DISP', origZoneDesc: 'APOPKA, FL, 32703', destZoneDesc: 'MIAMI, FL, 33166', ...over }, freightBills: bills });
const fresh = (over = {}) => ({ rc: { loadNumber: '9953899', truck: '2207', trailer: '3010', pickup: 'Apopka, FL', delivery: 'Miami, FL', ...over.rc }, seenTrips: over.seenTrips || [], trip: over.trip || null });

test('the truck, trailer and trip come from the email', () => {
  assert.deepEqual(idsFromEmail({ subject: 'TRINITY LOAD 9953899 NC TO FL TR 2207 TL 3010', text: 'Empty now in miami' }), { truck: '2207', trailer: '3010', trip: null });
  assert.equal(idsFromEmail({ text: 'For truck #2604, trip 626300' }).trip, '626300');
  assert.equal(idsFromEmail({ text: 'truck 2207 or truck 2208' }).truck, null, 'two trucks: not sure');
  const batch = 'Load 111111 truck 2207\nLoad 222222 truck 2604';
  assert.equal(idsFromEmail({ text: batch, loadNumber: '222222', single: false }).truck, '2604', 'a batch: the line for this load');
});

test('a route agrees by city and state', () => {
  assert.equal(routeMatch({ pickup: 'Apopka, FL', delivery: 'Miami, FL' }, trip('1')), 'both');
  assert.equal(routeMatch({ pickup: 'Apopka, FL', delivery: 'Boston, MA' }, trip('1')), 'one');
  assert.equal(routeMatch({ pickup: 'Newark, NJ', delivery: 'Boston, MA' }, trip('1')), null);
  assert.equal(routeMatch({ pickup: 'Miami, OK', delivery: null }, trip('1', { origZoneDesc: 'MIAMI, FL' })), null, 'same city, another state');
});

test('truck, trailer and route find a new trip, never the run the truck is on now', () => {
  const running = trip('626000', { status: 'DEPSHIP', origZoneDesc: 'BOSTON, MA', destZoneDesc: 'NEWARK, NJ' });
  const seen = { seenTrips: ['626000'] };
  assert.equal(findLoad(fresh(seen), [running]), null, 'the truck\'s current run');
  assert.equal(findLoad(fresh({ seenTrips: ['626000'] }), [trip('626000', { status: 'DEPSHIP' })]), null, 'even on the same route, once it is rolling');
  const f = findLoad(fresh(seen), [running, trip('626300')]);
  assert.equal(f.it.trip.tripNumber, '626300'); assert.equal(f.by, 'truck 2207, trailer 3010, route');
  assert.equal(findLoad(fresh(seen), [trip('626300', { origZoneDesc: 'NEWARK, NJ', destZoneDesc: 'BOSTON, MA' })]), null, 'a new trip on another route');
  assert.equal(findLoad(fresh(seen), [trip('626300'), trip('626301')]), null, 'two candidates: it waits');
  assert.equal(findLoad(fresh({ seenTrips: ['626300'] }), [trip('626300')]).by, 'truck 2207, trailer 3010, route', 'entered before the rate con came, same route, not started');
  assert.equal(findLoad(fresh(seen), [trip('626300', { powerUnit: '9999' })]).by, 'trailer 3010, route', 'the trailer alone with the route');
});

test('the trip number wins, and the sure matches need no truck', () => {
  assert.equal(findLoad(fresh({ trip: '626400', seenTrips: [] }), [trip('626300'), trip('626400')]).by, 'trip 626400');
  assert.equal(findLoad({ rc: { loadNumber: '9953899' } }, [trip('626500', {}, [{ referenceNumber: '9953899' }])]).by, 'load number');
  assert.equal(findLoad({ rc: {} }, [trip('626500')]), null, 'nothing to go on');
});

test('from the email to Accounting by truck, and the email says how it matched', async () => {
  const h = flow({ p1: { ...REC, truckNumber: null, loadNumber: '111222' } });
  const running = trip('626000', { status: 'DEPSHIP', origZoneDesc: 'BOSTON, MA', destZoneDesc: 'NEWARK, NJ' });
  await h.f.received('s', { email: { ...email, subject: 'TRINITY TR 2207 TL 3010' }, entries: [{ pendingId: 'p1' }], items: [running] });
  await h.f.process('s', { trips: [running] });
  assert.equal(h.mails.length, 1, 'not its current run');
  await h.f.process('s', { trips: [running, trip('626300')] });
  assert.match(h.mails[1].html, /Matched by/); assert.match(h.mails[1].html, /truck 2207, trailer 3010, route/); assert.deepEqual(h.saved, ['626300']);
});

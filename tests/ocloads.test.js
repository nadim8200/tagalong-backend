import test from 'node:test';
import assert from 'node:assert/strict';
import { initOcLoads, ocLoadItem, foldTarget, idsOf } from '../ocloads.js';
import { finishReason } from '../finished.js';
import { parseInstructions } from '../inbox.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const RC = { broker: 'TQL', loadNumber: '88123', referenceNumbers: ['PO 4471'], trailerNumber: '53R', pickups: [{ name: 'Sunshine Farms', city: 'Homestead', state: 'FL', date: '2026-11-06', time: '08:00' }], deliveries: [{ name: 'Publix DC', city: 'Lakeland', state: 'FL', zip: '33811', date: '2026-11-06', time: '18:00' }] };

test('staff email "create this OC load" + rate con → a card labeled OC LOAD <load #>, once per load', async () => {
  const db = mem(); const saved = []; const marks = [];
  const oc = initOcLoads({ db, ratecon: { save: async (site, trip, r) => { saved.push([trip, r.loadNumber]); } }, carriers: { markOc: async (site, trip, m) => { marks.push([trip, m.by]); } } });
  const r = await oc.create('florida-beauty', { record: RC, by: 'Gio', subject: 'Track this OC' });
  assert.deepEqual([r.ok, r.id, r.label], [true, '990001', 'OC LOAD 88123']);
  assert.deepEqual(saved, [['990001', '88123']]); assert.deepEqual(marks, [['990001', 'Gio']]);
  const again = await oc.create('florida-beauty', { record: { ...RC, loadNumber: '88-123' }, by: 'Gio' });
  assert.deepEqual([again.existing, again.id], [true, '990001'], 'same load number: no second card');
  assert.equal((await oc.create('florida-beauty', { record: { summary: 'unreadable' }, by: 'Gio' })).ok, false);
  const items = await oc.extra('florida-beauty', []);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.deepEqual([it.trip.tripNumber, it.trip.powerUnit, it.trip.origZoneDesc, it.trip.destZoneDesc, it._ocEmail.label], ['990001', 'OC', 'Homestead, FL', 'Lakeland, FL', 'OC LOAD 88123']);
  assert.equal(it.freightBills[0].billNumber, 'RC 88123'); assert.equal(it.freightBills[0].billToName, 'TQL');
  assert.equal(oc.isEmailLoad('990001'), true); assert.equal(oc.isEmailLoad('626494'), false);
});

test('TruckMate shows the same load → the email card folds into it (OC info, link and rate con move over)', async () => {
  const db = mem(); const moved = [];
  const oc = initOcLoads({ db, ratecon: { save: async (site, trip) => { moved.push(['rc', trip]); } }, carriers: { markOc: async () => {}, moveMark: async (site, a, b) => { moved.push(['mark', a, b]); } }, driverLinks: { moveLink: async (site, a, b) => { moved.push(['link', a, b]); } } });
  await oc.create('florida-beauty', { record: RC, by: 'Gio' });
  moved.length = 0;
  // a TruckMate trip whose rate con has the same load number
  db.s['taTruckMateRateCon:florida-beauty'] = { 626500: { loadNumber: '88123' } };
  const tm = [{ trip: { tripNumber: '626500' }, freightBills: [{ billNumber: 'B180900' }] }];
  assert.deepEqual(await oc.extra('florida-beauty', tm), [], 'no second card');
  assert.deepEqual(moved, [['mark', '990001', '626500'], ['link', '990001', '626500']], 'its rate con is already on the TruckMate trip');
  assert.equal((await oc.list('florida-beauty'))[0].foldedInto, '626500');
  assert.equal(foldTarget({ record: { fbfBillNumber: 'B180901' } }, [{ trip: { tripNumber: '626501' }, freightBills: [{ billNumber: 'B180901' }] }]), '626501', 'or our bill number on it');
  assert.deepEqual(idsOf({ loadNumber: 'ld-88123', referenceNumbers: ['ab-12', '007'] }), ['LD88123', 'AB12'], 'any format; numbers too short to be sure are ignored');
});

test('the OC driver confirms delivery in the app → the card finishes (load report) with that reason', async () => {
  const db = mem();
  const oc = initOcLoads({ db, carriers: { markOc: async () => {} } });
  await oc.create('florida-beauty', { record: RC, by: 'Gio' });
  let [it] = await oc.extra('florida-beauty', []);
  assert.equal(finishReason(it), null);
  assert.equal(await oc.delivered('florida-beauty', '990001', 'Carlos (TagAlong app)'), true);
  [it] = await oc.extra('florida-beauty', []);
  assert.equal(finishReason(it), 'OC driver confirmed delivery (TagAlong app)');
  assert.equal(await oc.delivered('florida-beauty', '990001', 'again'), false, 'once');
});

test('Jarvis keeps "create_oc_load" from staff', () => {
  assert.deepEqual(parseInstructions([{ kind: 'create_oc_load', message: 'Jarvis please track this OC' }]).map((x) => x.kind), ['create_oc_load']);
});

test('dispatch can make an OC load by hand (or a test one): the same card', async () => {
  const db = mem(); const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h.at(-1); } };
  initOcLoads({ app, requireAuth: () => {}, db, carriers: { markOc: async () => {} } });
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['/truckmate/oc-loads']({ body: { loadNumber: 'TEST-88123', broker: 'Test Broker', billNumber: 'B999001', test: true, pickup: { name: 'Test Farm', city: 'Homestead', state: 'FL' }, delivery: { name: 'Test DC', city: 'Lakeland', state: 'FL' } }, user: { name: 'Nadim' } }, res);
  assert.deepEqual([out.ok, out.id, out.label], [true, '990001', 'OC LOAD TEST-88123']);
  await routes['/truckmate/oc-loads']({ body: {}, user: {} }, res);
  assert.match(out.error, /Load number/);
});

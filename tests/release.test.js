import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseDraft, cleanForm, releasePdf, releaseEmail, initRelease } from '../release.js';

const item = { trip: { tripNumber: '627031', powerUnit: '2003', trailer: '7141', driver: '7245' }, _samsara: { driver1: 'ROMANE WILLIAMS' }, freightBills: [{ billNumber: 'B180942', temperature: 28 }],
  _ratecon: { docIds: ['rc1'], data: { broker: 'MOUNTAIRE FARMS', commodity: 'Frozen poultry', pickups: [{ name: 'LUMBER BRIDGE' }],
    deliveries: [{ name: 'MARTINEZ DISTRIBUTORS', address: '7379 NW 31 STREET', city: 'MIAMI', state: 'FL', zip: '33122', date: '11/16/2026', time: 'ASAP' }, { name: 'PFS MIAMI', address: '3595 NW 125 ST', city: 'MIAMI', state: 'FL', zip: '33167' }, { name: 'C' }, { name: 'D' }, { name: 'E (5th)' }] } } };

test('the Driver Release Form filled from the load: FB#, truck, trailer, driver + ID, broker, shipper, temp, commodity, up to 4 deliveries', () => {
  const d = releaseDraft(item, { by: 'Nadim Tellez', now: Date.parse('2026-11-16T16:30:00Z') });
  assert.deepEqual([d.fb, d.truck, d.trailer, d.trip, d.driver1, d.driver1Id, d.broker, d.shipper, d.temp, d.commodity, d.date, d.time, d.approvedBy],
    ['B180942', '2003', '7141', '627031', 'ROMANE WILLIAMS', '7245', 'MOUNTAIRE FARMS', 'LUMBER BRIDGE', '28F', 'Frozen poultry', '11/16/2026', '11:30AM', 'Nadim Tellez']);
  assert.equal(d.stops.length, 4, 'the form has room for 4');
  assert.deepEqual(d.stops[0], { date: '11/16/2026', time: 'ASAP', consignee: 'MARTINEZ DISTRIBUTORS', address: '7379 NW 31 STREET', city: 'MIAMI', state: 'FL', zip: '33122', cityStateZip: 'MIAMI, FL 33122', lumper: '', signSlc: true });
  assert.equal(releaseDraft({ trip: { tripNumber: '1' } }).stops.length, 1, 'no rate con: one empty delivery to fill');
  assert.equal(cleanForm({ stops: Array(6).fill({ consignee: 'x' }) }).stops.length, 4);
  const m = releaseEmail(cleanForm(d));
  assert.match(m.subject, /^DRIVER RELEASE — FB B180942 · Trip 627031 · Truck 2003 · Trailer 7141$/);
  assert.match(m.html, /Sign bills S\.L\.C/);
});

test('submit: emails the PDF + the rate con to the recipients on the form (the two dispatch inboxes are offered every time), remembers the extras, keeps a record; needs truck, trailer and an email', async () => {
  const pdf = await releasePdf(cleanForm(releaseDraft(item)));
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
  const routes = {}; const app = { get: (p, g, h) => { routes[`GET ${p}`] = h; }, post: (p, g, h) => { routes[`POST ${p}`] = h; } };
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const sent = []; const logs = [];
  const api = initRelease(app, { requireAuth: () => {}, db, hubOf: async () => 'MIAMI', docs: { readDocs: async () => [{ id: 'rc1', mediaType: 'application/pdf', data: Buffer.from('%PDF rc') }] }, getBoard: async () => ({ trips: [item] }), sendMail: async (x) => sent.push(x), log: async (s, t, e) => logs.push(e) });
  const call = async (k, req) => { let out; let code = 200; await routes[k]({ user: { name: 'Nadim' }, params: { trip: '627031' }, body: {}, ...req }, { status: (c) => { code = c; return { json: (j) => { out = j; } }; }, json: (j) => { out = j; }, set: () => {}, end: () => {} }); return { code, out }; };
  const g = await call('GET /truckmate/release/:trip', {});
  assert.equal(g.out.form.fb, 'B180942'); assert.equal(g.out.hasRateCon, true);
  assert.equal(g.out.form.hub, 'MIAMI', 'suggested from where the load is headed');
  assert.deepEqual(g.out.hubs.map((h) => h.key), ['MIAMI', 'VENTURA', 'MEMPHIS', 'BARTOW']);
  assert.equal((await call('POST /truckmate/release/:trip', { body: { form: { ...g.out.form, hub: '' }, to: 'yard@example.com' } })).code, 400, 'the hub is required');
  assert.deepEqual(g.out.always, ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us']);
  assert.equal((await call('POST /truckmate/release/:trip', { body: { form: { ...g.out.form, trailer: '' }, to: 'yard@example.com' } })).code, 400);
  const r = await call('POST /truckmate/release/:trip', { body: { form: { ...g.out.form, comments: 'Drop at Bartow' }, to: 'Yard_Dispatch@floridabeauty.us, Inbound-Dispatch@floridabeauty.us, Yard@Example.com, dispatch@floridabeauty.us, yard_dispatch@floridabeauty.us' } });
  assert.equal(r.out.ok, true); assert.equal(r.out.rateCon, true);
  assert.deepEqual(sent[0].to, ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us', 'yard@example.com', 'dispatch@floridabeauty.us'], 'the two inboxes first, never twice');
  assert.deepEqual(sent[0].attachments.map((a) => a.name), ['Driver-Release-627031.pdf', 'Rate-Con-627031.pdf']);
  assert.deepEqual(m.get('taReleaseTo'), ['yard@example.com', 'dispatch@floridabeauty.us']);
  assert.equal(m.get('taReleases:florida-beauty')['627031'][0].fields.comments, 'Drop at Bartow');
  assert.match(sent[0].html, /Release at<\/b><\/td><td[^>]*>Miami hub/);
  const board = [{ trip: { tripNumber: '627031' } }, { trip: { tripNumber: '1' } }]; await api.overlay('florida-beauty', board);
  assert.deepEqual({ ...board[0]._release, at: undefined }, { at: undefined, by: 'Nadim', hub: 'MIAMI', hubName: 'Miami', count: 1 });
  assert.equal(board[1]._release, undefined);
  assert.match(logs[0].text, /Driver release at Miami sent to yard_dispatch@floridabeauty\.us, inbound-dispatch@floridabeauty\.us, yard@example\.com/);
  assert.deepEqual((await call('GET /truckmate/release/:trip', {})).out.to, ['yard@example.com', 'dispatch@floridabeauty.us'], 'remembered for next time');
  assert.equal((await call('POST /truckmate/release/:trip', { body: { form: g.out.form, to: '' } })).code, 400, 'no one on it');
  await call('POST /truckmate/release/:trip', { body: { form: g.out.form, to: 'yard_dispatch@floridabeauty.us' } });
  assert.deepEqual(sent[1].to, ['yard_dispatch@floridabeauty.us'], 'Inbound Dispatch taken off for this release');
  const again = (await call('GET /truckmate/release/:trip', {})).out;
  assert.deepEqual(again.always, ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us'], 'both back the next time the form opens');
  assert.deepEqual(again.to, [], 'no extras that time');
});

test('city, state and ZIP edit separately and round-trip to the PDF line; an older one-line value still works', () => {
  const d = releaseDraft(item);
  assert.deepEqual([d.stops[0].city, d.stops[0].state, d.stops[0].zip], ['MIAMI', 'FL', '33122']);
  assert.equal(cleanForm({ stops: [{ city: 'Doral', state: 'fl', zip: '33178' }] }).stops[0].cityStateZip, 'Doral, FL 33178');
  assert.equal(cleanForm({ stops: [{ cityStateZip: 'MIAMI, FL 33122' }] }).stops[0].cityStateZip, 'MIAMI, FL 33122');
});

test('the release hub comes from where the load is headed: South Florida → Miami, the rest of Florida → Bartow, TN/MS/AR → Memphis, CA → Ventura', async () => {
  const { hubForDest } = await import('../yardreport.js');
  const at = (d) => hubForDest({ trip: { destZoneDesc: d } });
  assert.equal(at('MIAMI, FL, 33122'), 'MIAMI'); assert.equal(at('ORLANDO, FL, 32824'), 'BARTOW'); assert.equal(at('MEMPHIS, TN, 38141'), 'MEMPHIS');
  assert.equal(at('OXNARD, CA, 93030'), 'VENTURA'); assert.equal(at('ROCK HILL, SC, 29730'), null);
  assert.equal(hubForDest({ trip: { destZoneDesc: 'ORLANDO, FL' }, freightBills: [{ endZoneDescription: 'BOCA RATON, FL, 33431' }] }), 'MIAMI', 'the last delivery wins');
});

test('the release is filled for THIS load: a next load already assigned never fills it — only once this load is done', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  m.set('taRateConPending:florida-beauty', [
    { id: 'p1', record: { broker: 'DM Trans, LLC dba Arrive Logistics', loadNumber: '9981663', fbfBillNumber: 'B181050', tempSetting: '-10°F', pickups: [{ name: 'NOVOLEX' }], deliveries: [{ name: 'LINEAGE', city: 'FONTANA', state: 'CA', zip: '92335' }], docIds: ['rc9'] } },
    { id: 'p2', record: { broker: 'KLLM', loadNumber: '0382143', fbfBillNumber: 'B181004', tempSetting: '-10°F', pickups: [{ name: 'DEERFIELD COLD' }], deliveries: [{ name: 'ROCK HILL DC', city: 'ROCK HILL', state: 'SC', zip: '29730' }], docIds: ['rc4'] } },
  ]);
  const next = [{ pendingId: 'p1', rc: { broker: 'DM Trans, LLC dba Arrive Logistics', loadNumber: '9981663', docIds: ['rc9'] }, verified: { trip: '627311' } }];
  const items = {
    running: { trip: { tripNumber: '627178', powerUnit: '733', trailer: '262045', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M5063124' }], _nextLoad: next },
    done: { trip: { tripNumber: '627179', powerUnit: '734', trailer: '262046', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M5063125' }], _nextLoad: next, _flowerPhase: { phase: 'delivered' } },
    broker: { trip: { tripNumber: '627246', powerUnit: '2018', trailer: '7282', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B181004' }], _nextLoad: next },
  };
  const routes = {}; const app = { get: (p, g, h) => { routes[`GET ${p}`] = h; }, post: (p, g, h) => { routes[`POST ${p}`] = h; } };
  initRelease(app, { requireAuth: () => {}, db, docs: { readDocs: async () => [] }, getBoard: async () => ({ trips: Object.values(items) }), sendMail: async () => {} });
  const get = async (trip) => { let out; await routes['GET /truckmate/release/:trip']({ user: { name: 'Nadim' }, params: { trip } }, { status: () => ({ json: () => {} }), json: (j) => { out = j; } }); return out; };
  const a = await get('627178');   // still delivering its flowers, next load already assigned
  assert.equal(a.filledFrom, null, 'an LTL (M bills) never has a rate con: no note');
  assert.equal(a.form.broker, ''); assert.equal(a.form.trip, '627178');
  const b = await get('627246');   // a broker load whose batch rate con was never filed to it: matched by its FB #
  assert.match(b.filledFrom, /this load's rate con \(FB B181004, from a batch\)/);
  m.set('taRateConPending:florida-beauty', m.get('taRateConPending:florida-beauty').filter((p) => p.id !== 'p2'));
  assert.match((await get('627246')).filledFrom, /TruckMate only — no rate con on file for this broker load yet/, 'a broker load without its rate con: said');
  assert.equal(b.form.broker, 'KLLM'); assert.equal(b.form.stops[0].consignee, 'ROCK HILL DC');
  const c = await get('627179');   // flowers delivered: the release is for the next load
  assert.match(c.filledFrom, /next load's rate con — DM Trans, LLC dba Arrive Logistics 9981663 — this load's flowers are delivered/);
  assert.equal(c.form.trip, '627311'); assert.equal(c.form.fb, 'B181050'); assert.equal(c.form.stops[0].consignee, 'LINEAGE');
});

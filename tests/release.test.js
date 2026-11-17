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
  initRelease(app, { requireAuth: () => {}, db, docs: { readDocs: async () => [{ id: 'rc1', mediaType: 'application/pdf', data: Buffer.from('%PDF rc') }] }, getBoard: async () => ({ trips: [item] }), sendMail: async (x) => sent.push(x), log: async (s, t, e) => logs.push(e) });
  const call = async (k, req) => { let out; let code = 200; await routes[k]({ user: { name: 'Nadim' }, params: { trip: '627031' }, body: {}, ...req }, { status: (c) => { code = c; return { json: (j) => { out = j; } }; }, json: (j) => { out = j; }, set: () => {}, end: () => {} }); return { code, out }; };
  const g = await call('GET /truckmate/release/:trip', {});
  assert.equal(g.out.form.fb, 'B180942'); assert.equal(g.out.hasRateCon, true);
  assert.deepEqual(g.out.always, ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us']);
  assert.equal((await call('POST /truckmate/release/:trip', { body: { form: { ...g.out.form, trailer: '' }, to: 'yard@example.com' } })).code, 400);
  const r = await call('POST /truckmate/release/:trip', { body: { form: { ...g.out.form, comments: 'Drop at Bartow' }, to: 'Yard_Dispatch@floridabeauty.us, Inbound-Dispatch@floridabeauty.us, Yard@Example.com, dispatch@floridabeauty.us, yard_dispatch@floridabeauty.us' } });
  assert.equal(r.out.ok, true); assert.equal(r.out.rateCon, true);
  assert.deepEqual(sent[0].to, ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us', 'yard@example.com', 'dispatch@floridabeauty.us'], 'the two inboxes first, never twice');
  assert.deepEqual(sent[0].attachments.map((a) => a.name), ['Driver-Release-627031.pdf', 'Rate-Con-627031.pdf']);
  assert.deepEqual(m.get('taReleaseTo'), ['yard@example.com', 'dispatch@floridabeauty.us']);
  assert.equal(m.get('taReleases:florida-beauty')['627031'][0].fields.comments, 'Drop at Bartow');
  assert.match(logs[0].text, /Driver release sent to yard_dispatch@floridabeauty\.us, inbound-dispatch@floridabeauty\.us, yard@example\.com/);
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

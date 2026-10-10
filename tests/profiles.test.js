import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLoad, mergeInto, phoneAllowed, toCsv, parseCsv, applyCsv, profileKey } from '../profiles.js';
import { contactsFor } from '../statusmail.js';

const flowerLoad = { trip: { tripNumber: '624481' }, freightBills: [{ billNumber: 'M2', billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453', billToCustomer: { name: 'BOKHARY FARMS LLC', email: 'orders@bokhary.com' } }],
  _manifest: { stops: [{ action: 'DELIVER', customer: 'BOKHARY FARMS LLC *', city: 'WALTHAM', state: 'MA', callAhead: [{ contact: 'Sam', phone: '781-555-0123' }] }] } };
const rxo = (city, state, trip) => ({ trip: { tripNumber: trip }, freightBills: [{ billNumber: 'B1' }], _ratecon: { data: { broker: 'RXO Capacity Solutions, LLC', brokerOffice: { city, state }, brokerEmail: `ops-${state.toLowerCase()}@rxo.com`, contacts: [{ role: 'tracking', name: 'Kim', phone: '312-555-0101' }, { role: 'receiver', name: 'Dock', phone: '555-111-2222' }] } } });

test('profiles build themselves from loads; one broker, two offices = two profiles', () => {
  const f = fromLoad(flowerLoad);
  assert.equal(f.length, 1, 'trip sheet + TruckMate name the same customer once');
  assert.equal(f[0].type, 'customer'); assert.equal(f[0].name, 'BOKHARY FARMS LLC');
  assert.deepEqual(f[0].contacts.map((c) => c.phone || c.email).sort(), ['7815550123', 'orders@bokhary.com']);
  let all = mergeInto({}, fromLoad(rxo('Charlotte', 'NC', '1')), '1');
  all = mergeInto(all, fromLoad(rxo('Ontario', 'CA', '2')), '2');
  all = mergeInto(all, fromLoad(rxo('Charlotte', 'NC', '3')), '3');
  const brokers = Object.values(all).filter((p) => p.type === 'broker');
  assert.equal(brokers.length, 2);
  const nc = brokers.find((p) => p.office.state === 'NC');
  assert.deepEqual(nc.loads.map((l) => l.trip), ['3', '1']);
  assert.ok(nc.contacts.every((c) => c.phone !== '5551112222'), 'the receiver dock is not a broker contact');
  assert.equal(nc.contacts.find((c) => c.email === 'ops-nc@rxo.com').statusEmails, true);
});

test('dispatcher edits are never overwritten by the automatic sync', () => {
  let all = mergeInto({}, fromLoad(flowerLoad), '624481');
  const p = Object.values(all)[0];
  const sam = p.contacts.find((c) => c.phone === '7815550123');
  Object.assign(sam, { name: 'Sam Bokhary (owner)', authorized: true, edited: true });
  all = mergeInto(all, fromLoad(flowerLoad), '624490');
  const again = Object.values(all)[0].contacts.find((c) => c.phone === '7815550123');
  assert.equal(again.name, 'Sam Bokhary (owner)'); assert.equal(again.authorized, true);
  assert.equal(Object.values(all)[0].contacts.length, 2, 'no duplicates');
});

test('authorized numbers: strict rule, numbers that get any load, customers with none on file', () => {
  const profiles = { a: { type: 'customer', name: 'BOKHARY FARMS', aliases: ['BOKHARY FARMS LLC *'], contacts: [{ phone: '7815550123', authorized: true }] }, b: { type: 'customer', name: 'RICCARDI WHOLESALE', contacts: [] } };
  const strict = { strict: true, anyLoad: [{ name: 'Ronen', phone: '3055553000' }] };
  assert.equal(phoneAllowed({ profiles, settings: strict, customerName: 'BOKHARY FARMS LLC *', phone: '+1 781 555 0123' }).ok, true);
  assert.equal(phoneAllowed({ profiles, settings: strict, customerName: 'Bokhary Farms', phone: '7865550000' }).ok, false);
  assert.equal(phoneAllowed({ profiles, settings: strict, customerName: 'Bokhary Farms', phone: '305-555-3000' }).why, 'authorized for every load');
  assert.equal(phoneAllowed({ profiles, settings: strict, customerName: 'Riccardi Wholesale', phone: '6175550000' }).why, 'no authorized numbers on file for this customer');
  assert.equal(phoneAllowed({ profiles, settings: { strict: false }, customerName: 'Bokhary Farms', phone: '7865550000' }).ok, true, 'rule off → as before');
});

test('download all customer profiles as a spreadsheet, add phones / emails, upload it back', () => {
  const all = mergeInto({}, fromLoad(flowerLoad), '624481');
  const csv = toCsv(all, 'customer');
  assert.match(csv.split('\n')[0], /^profile_id,type,name,office_city,office_state,contact_name,role,email,phone,status_emails,authorized_caller$/);
  const id = Object.keys(all)[0];
  const edited = `${csv}\n${id},customer,BOKHARY FARMS LLC,,,Maria Lopez,customer,maria@bokhary.com,(781) 555-0199,yes,yes\n,customer,"NEW FLOWERS, INC",,,Ana,customer,ana@newflowers.com,,yes,`;
  const rows = parseCsv(edited);
  const r = applyCsv(all, rows, 'Rosa');
  assert.equal(r.created, 1);
  const bk = r.profiles[id];
  const maria = bk.contacts.find((c) => c.email === 'maria@bokhary.com');
  assert.deepEqual({ phone: maria.phone, statusEmails: maria.statusEmails, authorized: maria.authorized }, { phone: '7815550199', statusEmails: true, authorized: true });
  assert.ok(Object.values(r.profiles).some((p) => p.name === 'NEW FLOWERS, INC' && p.key === profileKey('customer', 'NEW FLOWERS, INC')));
});

test('customer status emails go to profile contacts marked "Status emails"', () => {
  const item = { ...flowerLoad, _profiles: [{ type: 'customer', name: 'BOKHARY FARMS', contacts: [{ name: 'Maria', email: 'maria@bokhary.com', statusEmails: true }, { name: 'Night dock', phone: '7815550000', authorized: true, statusEmails: false }] }] };
  const c = contactsFor(item).contacts;
  assert.ok(c.some((x) => x.email === 'maria@bokhary.com' && x.sources.includes('customer profile')));
  assert.ok(!c.some((x) => x.phone === '7815550000' && x.sources.includes('customer profile')));
});

import { fromClientList, mergeClientList } from '../profiles.js';

test('client list → customer profiles: phones + emails as contacts, merged into the profile built from loads', () => {
  const list = [{ id: '00412', name: 'CHELSEA MARKET - DIRECT FLOWERS OF BOSTON INC', city: 'CHELSEA', state: 'MA', phone: '6175551212', fax: '6175550000', phones: ['617-555-3434'], emails: ['Orders@DirectFlowers.com'], contacts: ['MIKE'] },
    { id: '01967', name: "HILL'S WHOLESALE -LITTLE FLOYD", city: 'LONGVIEW', state: 'TX', phone: '9037588300', phones: [], emails: [], contacts: [] }];
  const f = fromClientList(list);
  assert.deepEqual(f[0].contacts.map((c) => [c.name, c.phone, c.email]), [['MIKE', '6175551212', null], [null, '6175553434', null], [null, null, 'orders@directflowers.com']]);
  // the profile TruckMate already made for this customer gets the contacts (no duplicate profile)
  const store = mergeInto({}, [{ key: profileKey('customer', 'CHELSEA MARKET - DIRECT FLOWERS OF BOSTON INC'), type: 'customer', name: 'CHELSEA MARKET - DIRECT FLOWERS OF BOSTON INC', office: null, locations: ['CHELSEA, MA'], contacts: [] }], '624709');
  const all = Object.values(mergeClientList(store, list));
  assert.equal(all.length, 2);
  const p = all.find((x) => x.clientId === '00412');
  assert.equal(p.contacts.length, 3);
  assert.ok(p.contacts.every((c) => !c.authorized && !c.statusEmails), 'dispatch ticks status emails / authorized callers');
  assert.deepEqual(p.loads.map((l) => l.trip), ['624709']);
  // running it again adds nothing
  assert.equal(Object.values(mergeClientList(Object.fromEntries(all.map((x) => [x.id, x])), list)).find((x) => x.clientId === '00412').contacts.length, 3);
});

import { initProfiles } from '../profiles.js';
function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }

test('profiles sync only merges loads that changed since the last run ("Update from loads" re-merges all)', async () => {
  let writes = 0;
  const db = memDb(); const upd = db.update; db.update = async (...a) => { writes++; return upd(...a); };
  const it = { trip: { tripNumber: '700001', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'C1', billToName: 'KUHN FLOWERS', endZoneDescription: 'JACKSONVILLE, FL, 32205', consignee: { name: 'KUHN FLOWERS', phone: '9045551212' } }] };
  const board = { trips: [it] };
  const noop = () => {};
  const p = initProfiles({ get: noop, post: noop, put: noop, delete: noop }, { requireAuth: noop, db, getBoard: async () => board, env: { NODE_ENV: 'test' } });
  await p.sync();
  assert.ok(Object.values(await db.get('taProfiles:florida-beauty', {})).some((x) => x.name === 'KUHN FLOWERS'));
  const w1 = writes;
  await p.sync();
  assert.equal(writes, w1, 'nothing changed → no rewrite of the profile set');
  board.trips = [{ ...it, freightBills: [...it.freightBills, { billNumber: 'C2', billToName: 'DALSIMER FLORIST', endZoneDescription: 'DEERFIELD BEACH, FL, 33441' }] }];
  await p.sync();
  assert.ok(writes > w1, 'a changed load is merged');
  const w2 = writes;
  await p.sync({ force: true });
  assert.ok(writes > w2, 'Update from loads always re-merges');
});

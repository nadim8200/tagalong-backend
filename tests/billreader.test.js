import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billsToRead, loadParties, cleanRecipe } from '../reeferagent.js';
import { staffFacts } from '../stafffacts.js';

const trips = [
  { trip: { tripNumber: '1', status: 'DISP' }, freightBills: [{ billNumber: 'B1', updatedTimestamp: 't1' }, { billNumber: 'B2', updatedTimestamp: 't1' }, { billNumber: 'B3', actualDelivery: '2026-11-01T10:00' }] },
  { trip: { tripNumber: '2', status: 'DISP' }, _oc: {}, freightBills: [{ billNumber: 'B9' }] },
];

test('bills to read: new ones first, changed ones again, delivered and outside carriers skipped', () => {
  assert.deepEqual(billsToRead(trips, {}).map((x) => x.bill), ['B1', 'B2']);
  assert.deepEqual(billsToRead(trips, { B1: { updated: 't1' }, B2: { updated: 't0' } }).map((x) => x.bill), ['B2']);
});

test('the bill recipe may type the bill number, nothing else', () => {
  assert.equal(cleanRecipe({ steps: [{ do: 'type', text: '{bill}' }, { do: 'shot' }] }).ok, true);
  assert.equal(cleanRecipe({ steps: [{ do: 'type', text: 'hello' }, { do: 'shot' }] }).ok, false);
});

test('a load with two shippers and two consignees says so', () => {
  const sh = (name, a, c) => ({ name, address1: a, city: c, province: 'FL', postalCode: '33563' });
  const read = {
    B1: { screen: { shipper: sh('AMERICOLD', '302 NORTH FRONTAGE ROAD', 'PLANT CITY'), consignee: sh('PFG VIRGINIA', '7422 RANCO ROAD', 'RICHMOND'), pickup: { from: '11/11/2026 3:00', apptMade: true } } },
    B2: { screen: { shipper: sh('LINEAGE', '1 MAIN ST', 'LAKELAND'), consignee: sh('PFG VIRGINIA', '7422 RANCO ROAD', 'RICHMOND') } },
    B4: { screen: { shipper: sh('AMERICOLD', '302 NORTH FRONTAGE ROAD', 'PLANT CITY'), consignee: sh('SYSCO', '9 OAK AVE', 'ATLANTA') } },
  };
  const item = { freightBills: [{ billNumber: 'B1' }, { billNumber: 'B2' }, { billNumber: 'B4' }] };
  const p = loadParties(item, read);
  assert.equal(p.shippers.length, 2);
  assert.equal(p.consignees.length, 2);
  assert.equal(p.multipleShippers, true);
  assert.deepEqual(p.shippers[0].bills, ['B1', 'B4']);
  item._parties = p;
  const f = staffFacts(item);
  assert.equal(f.shippers[0].address, '302 NORTH FRONTAGE ROAD, PLANT CITY, FL 33563');
  assert.match(f.partiesNote, /2 different shippers.*2 different consignees.*3 of 3 bills/);
  assert.equal(loadParties({ freightBills: [{ billNumber: 'X' }] }, read), null);
});

test('customer notes: the trip sheet\'s delivery stops, by their ARTIS customer number, read every 10 days', async () => {
  const { customersToRead, loadCustomerNotes, stopKey, nameMatch, artisIdFor, customerId } = await import('../reeferagent.js');
  // two MOBI'S locations: the trip's own ARTIS stop list says which one this stop is
  const trips = [
    { trip: { tripNumber: '7' }, _tb: { stops: [{ consigneeId: '11857', consignee: "MOBI'S", city: 'ATLANTA' }] },
      _manifest: { stops: [{ action: 'LOAD', customer: 'Miami hub' }, { action: 'DELIVER', customer: "Mobi's", city: 'Atlanta' }, { action: 'DELIVER', customer: 'Native Lombard', city: 'Lombard' }, { action: 'DELIVER', customer: 'Nobody Known', city: 'Ocala' }] } },
    { trip: { tripNumber: '8' }, freightBills: [{ billNumber: 'B9' }] },          // no trip sheet: not an LTL load
  ];
  const artis = [{ id: '11834', name: "MOBI'S", city: 'DORAL' }, { id: '11857', name: "MOBI'S", city: 'ATLANTA' }, { id: '3516', name: 'NATIVE CHICAGO - LOMBARD', city: 'LOMBARD' }];
  const now = Date.parse('2026-11-11T00:00:00Z');
  // searched by ID; the stop with no known number is left out
  assert.deepEqual(customersToRead(trips, {}, { now, artis }).map((x) => `${x.value}|${x.name}|${x.city}`), ["11857|MOBI'S|ATLANTA", '03516|NATIVE LOMBARD|LOMBARD']);
  const read = { 11857: { code: '11857', at: '2026-11-05T00:00:00Z' }, '03516': { code: '03516', at: '2026-10-30T00:00:00Z' } };
  assert.deepEqual(customersToRead(trips, read, { now, artis }).map((x) => x.value), ['03516']);   // Mobi's is 6 days old
  // by name alone, several locations → no guess; the city picks one
  assert.equal(artisIdFor(artis, "Mobi's"), null);
  assert.equal(artisIdFor(artis, "Mobi's", 'Doral'), '11834');
  assert.equal(customerId('3516'), '03516');
  const customers = { 11857: { code: '11857', name: "MOBI'S", at: '2026-11-05T00:00:00Z', notes: 'Saturday dock 8am-2pm. Get the receiver signature.' }, 11834: { code: '11834', name: "MOBI'S", at: '2026-11-05T00:00:00Z', notes: 'Doral: back door only.' } };
  const n = loadCustomerNotes(trips[0], {}, customers, {}, artis);
  assert.equal(n.length, 1);
  assert.equal(n[0].code, '11857');
  // a stop read earlier by name still works
  assert.equal(loadCustomerNotes({ _manifest: { stops: [{ customer: 'Zed', city: 'X' }] } }, {}, { 99999: { code: '99999', notes: 'x', at: '2026-11-05T00:00:00Z' } }, { [stopKey('Zed', 'X')]: { code: '99999' } })[0].code, '99999');
  assert.match(staffFacts({ _customerNotes: n }).customerInstructions[0].instructions, /dock 8am/);
  assert.equal(nameMatch('NATIVE CHICAGO - LOMBARD', 'Native Lombard'), true);
  assert.equal(nameMatch('WINN DIXIE JACKSONVILLE', 'Native Lombard'), false);
  assert.equal(nameMatch("MOBI'S", "Mobi's"), true);
});

test('TruckMate customer info lands on our customer profile: instructions, phones, emails; edited contacts kept', async () => {
  const { applyTruckMateCustomer } = await import('../profiles.js');
  const store = { a: { id: 'a', key: 'customer|PFG THE VIRGINIA FOOD SERVICE GROUP|', type: 'customer', name: 'PFG THE VIRGINIA FOOD SERVICE GROUP', contacts: [{ id: 'c1', phone: '8045551234', name: 'Receiving', edited: true }], aliases: [] } };
  const tm = { code: '31797', name: 'PFG THE VIRGINIA FOOD SERVICE GROUP', notes: 'Receiving 6AM-2PM. Check in at gate 2.', phones: [{ label: 'Main', number: '(804) 555-1234' }, { label: 'Fax', number: '804-555-9999' }, { label: 'Dock', number: '804-555-0000' }], emails: [{ label: 'Receiving', email: 'dock@pfg.com' }], people: [] };
  const { profiles, id } = applyTruckMateCustomer(store, tm, '2026-11-11T00:00:00Z');
  assert.equal(id, 'a');
  const p = profiles.a;
  assert.equal(p.truckmate.notes, 'Receiving 6AM-2PM. Check in at gate 2.');
  assert.equal(p.truckmate.code, '31797');
  assert.equal(p.contacts.length, 3);                       // existing 804-555-1234 kept as is, dock phone + email added, no fax
  assert.equal(p.contacts[0].name, 'Receiving');
  assert.ok(p.contacts.some((c) => c.email === 'dock@pfg.com' && c.source === 'TruckMate'));
  // next time it matches by TruckMate code even if the name differs
  assert.equal(applyTruckMateCustomer(profiles, { ...tm, name: 'PFG VIRGINIA' }).id, 'a');
  assert.ok(applyTruckMateCustomer({}, { code: '1', name: 'NEW CUSTOMER', notes: null, phones: [], emails: [], people: [] }).id);
});

test('find steps: the agent asks where a button is instead of fixed click spots', async () => {
  const { cleanRecipe, boxCenter, pngSize } = await import('../reeferagent.js');
  const r = cleanRecipe({ steps: [{ do: 'find', target: 'the Consignee tab at the bottom of the Notes for Client window' }, { do: 'shot' }] });
  assert.equal(r.ok, true);
  assert.equal(r.recipe.steps[0].do, 'find');
  assert.equal(cleanRecipe({ steps: [{ do: 'find', target: 'x' }, { do: 'shot' }] }).ok, false);
  assert.deepEqual(boxCenter([100, 200, 140, 220], { w: 800, h: 600 }), { x: 0.15, y: 0.35 });
  assert.equal(boxCenter([0, 0, 700, 20], { w: 800, h: 600 }), null);       // far too wide for a button
  assert.equal(boxCenter([790, 0, 820, 20], { w: 800, h: 600 }), null);     // outside the picture
  assert.ok(boxCenter([458, 46, 796, 66], { w: 816, h: 430 }));             // Select Client's Search/Sort By dropdown (~41% wide)
  const png = Buffer.alloc(24); png.write('\x89PNG', 0, 'latin1'); png.writeUInt32BE(856, 16); png.writeUInt32BE(843, 20);
  assert.deepEqual(pngSize(png.toString('base64')), { w: 856, h: 843 });
});

test('bill on screen: the cursor on the first letter does not make it a different bill', async () => {
  const { sameBill } = await import('../reeferagent.js');
  assert.equal(sameBill('G5058914', 'G5058914'), true);
  assert.equal(sameBill('5505891.4', 'G5058914'), true);
  assert.equal(sameBill('5058914', 'G5058914'), true);
  assert.equal(sameBill('G5058915', 'G5058914'), false);
  assert.equal(sameBill('B180922-AA', 'B180922'), true);    // same bill, stop AA
  assert.equal(sameBill('B180922', 'B180922-AB'), true);
  assert.equal(sameBill('B180923-AA', 'B180922-AA'), false);
  assert.equal(sameBill(null, 'G5058914'), false);
});

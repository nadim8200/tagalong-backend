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

test('customer notes: codes from the bills read once a week, and each load gets its customers\' notes', async () => {
  const { customersToRead, loadCustomerNotes } = await import('../reeferagent.js');
  const bills = {
    B1: { trip: '7', screen: { shipper: { code: '29860', name: 'AMERICOLD' }, consignee: { code: '31797', name: 'PFG VIRGINIA' } } },
    B2: { trip: '7', screen: { shipper: { code: '29860', name: 'AMERICOLD' }, consignee: { code: '35951', name: 'EASTERN FOOD' } } },
  };
  const now = Date.parse('2026-11-11T00:00:00Z');
  // consignees only (the stops drivers deliver), only on trip-sheet loads
  assert.deepEqual(customersToRead(bills, {}, { now }).map((x) => x.value), ['31797', '35951']);
  assert.deepEqual(customersToRead(bills, {}, { now, ltlTrips: new Set(['8']) }), []);
  const read = { 31797: { at: '2026-11-05T00:00:00Z', name: 'PFG VIRGINIA', notes: 'Check in at gate 2. Lumper paid by receiver.' }, 35951: { at: '2026-10-30T00:00:00Z', notes: null } };
  assert.deepEqual(customersToRead(bills, read, { now }).map((x) => x.value), ['35951']);   // 31797 is 6 days old, 35951 12
  const n = loadCustomerNotes({ freightBills: [{ billNumber: 'B1' }, { billNumber: 'B2' }] }, bills, read);
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].roles, ['consignee']);
  const item = { _customerNotes: n };
  assert.match(staffFacts(item).customerInstructions[0].instructions, /gate 2/);
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
  const png = Buffer.alloc(24); png.write('\x89PNG', 0, 'latin1'); png.writeUInt32BE(856, 16); png.writeUInt32BE(843, 20);
  assert.deepEqual(pngSize(png.toString('base64')), { w: 856, h: 843 });
});

test('bill on screen: the cursor on the first letter does not make it a different bill', async () => {
  const { sameBill } = await import('../reeferagent.js');
  assert.equal(sameBill('G5058914', 'G5058914'), true);
  assert.equal(sameBill('5505891.4', 'G5058914'), true);
  assert.equal(sameBill('5058914', 'G5058914'), true);
  assert.equal(sameBill('G5058915', 'G5058914'), false);
  assert.equal(sameBill('B180922-AA', 'B180922'), false);
  assert.equal(sameBill(null, 'G5058914'), false);
});

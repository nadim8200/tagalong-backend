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

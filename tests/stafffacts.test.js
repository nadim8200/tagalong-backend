import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffFacts, staffFactsSpoken, tmTime } from '../stafffacts.js';

test('TruckMate wall times read as local, date-only as a date', () => {
  assert.equal(tmTime('2026-11-11T15:00:00'), 'Wed, Nov 11 3:00 PM');
  assert.equal(tmTime('2026-11-13T00:00'), 'Fri, Nov 13');
  assert.equal(tmTime(''), null);
});

test('what a broker load pays: Billing total vs the rate con, Acc Chgs flagged', () => {
  const item = {
    trip: { tripNumber: '624900' },
    freightBills: [
      { billNumber: 'B180921', totalCharges: 2850, charges: 2500, startZoneDescription: 'SALINAS, CA', pickUpBy: '2026-11-11T15:00', pickUpApptReq: 'True', pickUpApptMade: 'True', endZoneDescription: 'ATLANTA, GA', deliverBy: '2026-11-13T09:00' },
    ],
    _ratecon: { data: { rate: 2500, broker: 'X Logistics' } },
    _loadTemp: { target: { text: '34°F', from: 'rate con' }, current: { source: 'TruckMate (Thermo King)', currentF: 35, returnF: 35, supplyF: 33, setF: 34, at: '2026-11-10T12:00:00Z' }, check: { status: 'ok' } },
    _trace: { pos: ['L123'], pickups: [], loadNumber: 'L123', ok: true, problems: [] },
  };
  const f = staffFacts(item);
  assert.equal(f.billing.loadPays, '$2,850.00');
  assert.equal(f.billing.rateConRate, '$2,500.00');
  assert.equal(f.billing.accChgsOverRateCon, '$350.00');
  assert.equal(f.reefer.dischargeAir, '33°F');
  assert.equal(f.reefer.loadNeeds, '34°F (rate con)');
  assert.equal(f.shipperConsignee[0].pickup, 'Wed, Nov 11 3:00 PM');
  assert.equal(f.shipperConsignee[0].pickupApptMade, true);
  assert.equal(f.shipperConsignee[0].shipper, 'SALINAS, CA');
  assert.equal(f.traceNumbers.ok, true);
  assert.match(staffFactsSpoken(item).load_pays, /\$2,850\.00 .*rate con \$2,500\.00.*\$350\.00 extra/);
});

test('nothing known → empty sections, no crash', () => {
  const f = staffFacts({ trip: { tripNumber: '1' } });
  assert.equal(f.billing, null);
  assert.equal(f.reefer, null);
  assert.equal(f.shipperConsignee, null);
  assert.equal(staffFacts(null), null);
});

test('the rest of the TruckMate bill: weight, miles, who entered it, billing approved', () => {
  const f = staffFacts({ freightBills: [{ billNumber: 'B1', commodity: 'TEMP32', temperature: 34, temperatureUnits: 'F', weight: 38000, distance: 1210, createdBy: 'HSIERRA', isApproved: 'False', pickupPowerUnit1: '2403', pickUpDriver: 'DOEJ', serviceLevel: 'TRUCKLOAD' }] });
  const b = f.truckmateBills[0];
  assert.equal(b.weight, '38,000 lb');
  assert.equal(b.miles, 1210);
  assert.equal(b.requiredTemp, '34°F');
  assert.equal(b.enteredBy, 'HSIERRA');
  assert.equal(b.billingApproved, false);
  assert.equal(b.pickupBy, 'truck 2403 / DOEJ');
});

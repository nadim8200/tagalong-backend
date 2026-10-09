import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBillingMailbox, dropGarbled, sopStage } from '../statusmail.js';

test('billing / invoice mailboxes do not get hourly location updates', () => {
  for (const e of ['ftminvoicesmc@fedex.com', 'ap@x.com', 'accounts.payable@x.com', 'billing@x.com', 'invoices@x.com']) assert.equal(isBillingMailbox(e), true, e);
  for (const e of ['greg.stroka@fedexfreight.com', 'tl@specialty-freight.com', 'apple@x.com', 'dispatch@x.com', 'carla.arce@x.com']) assert.equal(isBillingMailbox(e), false, e);
});

test('a garbled copy of an address ("l-greg…") is dropped when the clean one is there', () => {
  assert.deepEqual(dropGarbled(['greg.stroka@fedexfreight.com', 'l-greg.stroka@fedexfreight.com', 'tl@specialty-freight.com']), ['greg.stroka@fedexfreight.com', 'tl@specialty-freight.com']);
  assert.deepEqual(dropGarbled(['l-greg.stroka@fedexfreight.com']), ['l-greg.stroka@fedexfreight.com'], 'alone it stays');
});

test('the hourly update headline says stopped when the truck is stopped', () => {
  const it = (mph, loc) => ({ trip: {}, _samsara: { lat: 25.8, lng: -80.3, speedMph: mph, gpsAt: new Date().toISOString(), location: loc } });
  assert.equal(sopStage({ kind: 'location', stage: 'rolling' }, it(0, 'NW 74th St, Miami, FL')).headline, "In transit — the truck is stopped at Miami, FL right now. We'll keep you posted.");
  assert.equal(sopStage({ kind: 'location', stage: 'rolling' }, it(60, 'I-95, Boynton Beach, FL')).headline, "Rolling — near Boynton Beach, FL. We'll keep you posted.");
});

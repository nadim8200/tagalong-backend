import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTempRange, requiredRange, brokerMayShare, VERIFYING } from '../temppolicy.js';
import { loadSnapshot, renderUpdateEmail } from '../updateemail.js';

test('rate con temperature ranges: 2-8C, 35-38°F, -10F, a TruckMate bill temperature', () => {
  assert.deepEqual(parseTempRange('2-8C'), { minF: 36, maxF: 46, text: '2–8°C' });
  assert.deepEqual([parseTempRange('35-38°F').minF, parseTempRange('35-38°F').maxF], [35, 38]);
  assert.deepEqual([parseTempRange('-10F').minF, parseTempRange('-10F').maxF], [-10, -10]);
  assert.equal(requiredRange({ _ratecon: { data: { specialInstructions: ['2-8C DISPATCH MUST PROVIDE 2 LIVE TEMP/LOCATION UPDATES DAILY'] } } }).text, '2–8°C');
  assert.deepEqual([requiredRange({ freightBills: [{ temperature: 35 }] }).minF, requiredRange({ freightBills: [{ temperature: 35 }] }).from], [35, 'TruckMate']);
});

test('the broker sees a reading only within 3°F of the rate con range', () => {
  const r = { minF: 36, maxF: 46, text: '2–8°C' };
  assert.equal(brokerMayShare(41, r).share, true);
  assert.equal(brokerMayShare(48, r).share, true, '2°F over — within the 3°F allowance');
  assert.equal(brokerMayShare(50, r).share, false, '4°F over');
  assert.equal(brokerMayShare(31, r).share, false, '5°F under');
  assert.equal(brokerMayShare(null, r).share, false);
  assert.equal(brokerMayShare(41, null).share, false, 'nothing to check it against → dispatch decides');
});

test('broker update email: in range → the reading; out of range → "verifying"; internal copy shows both', () => {
  const base = { trip: { tripNumber: '624338', status: 'DEPSHIP', powerUnit: '2405', trailer: '175349', destZoneDesc: 'DEVENS, MA' }, freightBills: [{ billNumber: 'B180347', billToName: 'FEDEX', endZoneDescription: 'DEVENS, MA', temperature: 40 }],
    _ratecon: { data: { tempSetting: '2-8C' } } };
  const at = (f) => ({ ...base, _samsara: { tempF: f, setpointF: 41, gpsAt: new Date().toISOString(), location: 'I-90, MA', speedMph: 60 } });
  const html = (item, audience) => renderUpdateEmail({ audience, customer: 'FEDEX', snaps: [loadSnapshot(item, {})] }).html;
  assert.match(html(at(41), 'customer'), /41°F · set 41°F/);
  assert.ok(!/53°F/.test(html(at(53), 'customer')));
  assert.match(html(at(53), 'customer'), new RegExp(VERIFYING));
  assert.match(html(at(53), 'internal'), /53°F.*required 2–8°C.*NOT shared with the broker/);
  assert.match(html({ ...base, _samsara: { gpsAt: new Date().toISOString() } }, 'customer'), new RegExp(VERIFYING), 'no reading → verifying, never a photo or number');
});

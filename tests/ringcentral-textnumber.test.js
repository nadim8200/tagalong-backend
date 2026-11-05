import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTextNumber } from '../ringcentral.js';

test('the texting number picks itself: the campaign number when it can text, else the only one that can', () => {
  const recs = [{ phoneNumber: '+13053955415', features: ['CallerId'] }, { phoneNumber: '+17867233912', features: ['CallerId', 'SmsSender'] }, { phoneNumber: '+15619223730', features: ['SmsSender'] }];
  assert.equal(pickTextNumber(recs, '+17867233912'), '+17867233912');
  assert.equal(pickTextNumber(recs, '(786) 723-3912'), '+17867233912', 'any format');
  assert.equal(pickTextNumber(recs, '+19999999999'), null, 'two can text, none preferred: someone picks');
  assert.equal(pickTextNumber([recs[0], recs[1]], null), '+17867233912', 'the only one that can');
  assert.equal(pickTextNumber([{ phoneNumber: '+17867233912', features: ['CallerId'] }], '+17867233912'), null, 'not enabled for texts yet');
  assert.equal(pickTextNumber([], '+17867233912'), null);
});

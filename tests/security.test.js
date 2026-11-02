import test from 'node:test';
import assert from 'node:assert/strict';
import { senderCheck, isInternal } from '../inbox.js';
import { tempPassword, dispatcherMayUse } from '../dispatchers.js';
import { makeToken, readToken } from '../breakdownreport.js';

const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test('a staff From address has to be backed by Microsoft', () => {
  assert.equal(senderCheck(h({ 'X-MS-Exchange-Organization-AuthAs': 'Internal' })), 'ok');
  assert.equal(senderCheck(h({ 'Authentication-Results': 'spf=pass; dkim=pass; dmarc=pass action=none' })), 'ok', 'our scanner or a passing relay');
  assert.equal(senderCheck(h({ 'X-MS-Exchange-Organization-AuthAs': 'Anonymous', 'Authentication-Results': 'spf=fail; dmarc=fail action=none' })), 'failed');
  assert.equal(senderCheck(h({ 'X-MS-Exchange-Organization-AuthAs': 'Anonymous' })), 'failed');
  assert.equal(senderCheck(h({ 'Authentication-Results': 'spf=none; dmarc=none; compauth=fail' })), 'failed');
  assert.equal(senderCheck([]), 'unknown'); assert.equal(senderCheck(null), 'unknown');
});

test('only floridabeauty.us is staff by default', () => {
  assert.equal(isInternal('a@floridabeauty.us', {}), true);
  assert.equal(isInternal('a@floridabeauty.com', {}), false);
});

test('temporary passwords are long and readable', () => {
  const a = tempPassword();
  assert.match(a, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}-[A-Z2-9]{4}$/);
  assert.notEqual(a, tempPassword());
});

test('a stop link lasts a day, others a week', () => {
  const now = 1000; const DAY = 86400000;
  const t = makeToken({ a: 1 }, 's', now, 'stop-review', 1);
  assert.ok(readToken(t, 's', now + DAY - 1, 'stop-review'));
  assert.equal(readToken(t, 's', now + DAY + 1, 'stop-review'), null);
  assert.ok(readToken(makeToken({ a: 1 }, 's', now), 's', now + 6 * DAY));
});

test('a plain dispatcher cannot change Jarvis\' voice', () => {
  assert.equal(dispatcherMayUse('PUT', '/voice/voice', { companyAdmin: false }), 'settings');
  assert.equal(dispatcherMayUse('PUT', '/voice/voice', { companyAdmin: true }), null);
});

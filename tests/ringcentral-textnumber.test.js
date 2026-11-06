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

import { initRingCentral } from '../ringcentral.js';
test('a company\'s own setup with no texting number sends as the company line ((786) 723-3912, shared login)', async () => {
  const store = { taRingCentral: { fbf: { clientId: 'c1', clientSecret: 's1', jwt: 'j1' }, __shared: { clientId: 'c2', clientSecret: 's2', jwt: 'j2', fromNumber: '+17867233912' } } };
  const db = { enabled: true, get: async (k, d) => (k in store ? store[k] : d), set: async (k, v) => { store[k] = v; }, update: async (k, f, d) => { store[k] = f(k in store ? store[k] : d); return store[k]; } };
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), auth: (opts.headers || {}).Authorization, body: opts.body }); return { ok: true, status: 200, json: async () => (/oauth\/token/.test(url) ? { access_token: /assertion=j2/.test(String(opts.body)) ? 'shared-token' : 'own-token', expires_in: 3600 } : { id: 'sms1', messageStatus: 'Queued' }) }; };
  try {
    const rc = initRingCentral(app, { requireAuth: () => {}, db });
    const r = await rc.sendSms('fbf', { to: '+13058421587', text: 'Test', sign: false });
    assert.equal(r.from, '+17867233912');
    const sms = calls.find((c) => /\/sms$/.test(c.url));
    assert.equal(sms.auth, 'Bearer shared-token', 'sent with the shared login');
    assert.deepEqual(JSON.parse(sms.body).from, { phoneNumber: '+17867233912' });
  } finally { globalThis.fetch = realFetch; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, initAssistant } from '../assistant.js';

test('phones and emails are masked everywhere', () => {
  const out = mask({ driverPhone: '786-326-1126', note: 'call Israel 413-883-7695 or ana@rosebrokers.com', to: '+13055550101', pieces: 482, trip: '624393' });
  assert.equal(out.driverPhone, '***-***-1126');
  assert.equal(out.note, 'call Israel ***-***-7695 or a***@rosebrokers.com');
  assert.equal(out.to, '***-***-0101');
  assert.equal(out.pieces, 482); assert.equal(out.trip, '624393');
});

test('needs the read-only key; GET only; masked answers', async () => {
  const routes = {}; const methods = [];
  const app = { get: (p, ...h) => { methods.push('GET'); routes[p] = h; }, post: () => methods.push('POST'), put: () => methods.push('PUT'), delete: () => methods.push('DELETE') };
  const env = { ASSISTANT_READ_KEY: 'k'.repeat(40) };
  const board = { trips: [{ trip: { tripNumber: '624393', powerUnit: '2607', status: 'DISP' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148', pieces: 483 }], _oc: { driverPhone: '7864394668', truck: '77' } }] };
  initAssistant(app, { db: { enabled: false }, env, buildBoard: async () => board });
  assert.ok(methods.every((m) => m === 'GET'));
  const call = async (path, key, params = {}) => {
    let code = 200; let body;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
    const req = { path, params, query: {}, get: (h) => (h === 'x-assistant-key' ? key : undefined) };
    const [guard, handler] = routes[path];
    await new Promise((resolve) => { guard(req, res, async () => { await handler(req, res); resolve(); }); if (code !== 200) resolve(); });
    return { code, body };
  };
  assert.equal((await call('/assistant/board', 'wrong')).code, 401);
  const ok = await call('/assistant/trip/:trip', 'k'.repeat(40), { trip: '624393' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.truck, '2607');
  assert.ok(!JSON.stringify(ok.body).includes('7864394668'));
  env.ASSISTANT_READ_KEY = '';
  assert.equal((await call('/assistant/board', 'x')).code, 503);
});

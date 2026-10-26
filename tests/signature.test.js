import test from 'node:test';
import assert from 'node:assert/strict';
import { signText, sender } from '../ringcentral.js';
import { initDirectory } from '../directory.js';

test('every text is signed: the sender\'s name before "Reply STOP to opt out.", Jarvis when nobody sent it', () => {
  assert.equal(signText('Florida Beauty Flora: please send the POD for load 625717. Reply STOP to opt out.', 'Ronen Koubi'),
    'Florida Beauty Flora: please send the POD for load 625717. — Ronen Koubi, Florida Beauty Dispatch. Reply STOP to opt out.');
  assert.equal(signText('Running late?', null), 'Running late? — Jarvis (AI), Florida Beauty Dispatch');
  const once = signText('Hi', 'Sara'); assert.equal(signText(once, 'Sara'), once, 'never signed twice');
});

test('the sender comes from the signed-in request', async () => {
  const seen = await new Promise((resolve) => sender.run({ user: { name: 'Valeria' } }, () => setTimeout(() => resolve(sender.getStore().user.name), 1)));
  assert.equal(seen, 'Valeria');
  assert.equal(sender.getStore(), undefined, 'outside a request: nobody (Jarvis signs)');
});

test('employee contact history: every text / email / call to a person, newest first', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const routes = {};
  const dir = initDirectory({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, put: () => {}, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } }, { requireAuth: () => {}, requireAdmin: () => {}, db, contact: { textingLive: async () => true, text: async () => ({}), email: async () => {}, call: async () => ({ called: true }) } });
  let out; const res = { json: (j) => { out = j; }, status() { return res; } };
  await routes['GET /truckmate/directory']({ user: { admin: true } }, res);
  const frank = out.people.find((p) => p.name === 'Frank Ducassi');
  await routes['POST /truckmate/directory/:id/contact']({ user: { admin: true, name: 'Nadim Tellez' }, params: { id: frank.id }, body: { message: 'Mayesh called', via: ['text'] } }, res);
  await dir.logContact({ phone: frank.phone, by: 'Jarvis (callback request)', message: 'call back Ronen', result: { call: 'calling' }, source: 'Jarvis' });
  await routes['GET /truckmate/directory/:id/contacts']({ user: { admin: true }, params: { id: frank.id } }, res);
  assert.deepEqual(out.history.map((h) => [h.by, Object.keys(h.result)[0]]), [['Jarvis (callback request)', 'call'], ['Nadim Tellez', 'text']]);
  await routes['GET /truckmate/directory/:id/contacts']({ user: { role: 'dispatcher' }, params: { id: frank.id } }, res);
  assert.equal(out.history.length, 2, 'every dispatcher sees the whole thread');
  await routes['GET /truckmate/directory/:id/contacts']({ user: { role: 'owner' }, params: { id: frank.id } }, res);
  assert.ok(out.error, 'never a customer');
});

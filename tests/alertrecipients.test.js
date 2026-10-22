import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntries, cleanRecipients, initAlertRecipients } from '../alertrecipients.js';

const people = [{ name: 'Frank Ducassi', email: 'fducassi@floridabeauty.us' }, { name: 'Sebastian Manotas', email: 'smanotas@floridabeauty.us' }, { name: 'Ronen Koul', email: '' }];
const groupEmail = (n) => (/^dispatch$/i.test(n) ? 'dispatches@floridabeauty.us' : null);

test('alert lists: emails, employees by name and email groups → addresses; unknown names are reported', () => {
  const r = resolveEntries(['Frank Ducassi', 'Dispatch', 'jane@broker.com', 'Ronen', 'Nadim', 'Nobody Here'], { people, groupEmail });
  assert.deepEqual(r.emails, ['fducassi@floridabeauty.us', 'dispatches@floridabeauty.us', 'jane@broker.com', 'ntellez@floridabeauty.us']);
  assert.deepEqual(r.unresolved, ['Ronen', 'Nobody Here'], 'Ronen has no email on Employees yet');
  assert.deepEqual(cleanRecipients({ artis_left_short: [' A@X.com ', 'a@x.com', '', 'Dispatch'], bogus: ['x'] }), { artis_left_short: ['a@x.com', 'Dispatch'] });
});

test('admins change the lists in the console; the alert uses the saved list', async () => {
  const routes = {}; const store = new Map();
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; } };
  const db = { enabled: true, get: async (k, fb) => (store.has(k) ? store.get(k) : fb), update: async (k, fn, fb) => { const v = fn(store.has(k) ? store.get(k) : fb); store.set(k, v); return v; } };
  const directory = { load: async () => ({ people, groups: [{ name: 'Dispatch', email: 'dispatches@floridabeauty.us' }] }) };
  const ar = initAlertRecipients(app, { requireAuth: (q, r, n) => n(), db, directory });
  assert.deepEqual(await ar.resolve('artis_left_short'), ['ntellez@floridabeauty.us'], 'default before anyone edits it');
  await routes['PUT /truckmate/alert-recipients'].at(-1)({ body: { alerts: { artis_left_short: ['Dispatch', 'Frank Ducassi'] } } }, { json: () => {}, status: () => ({ json: () => {} }) });
  assert.deepEqual(await ar.resolve('artis_left_short'), ['dispatches@floridabeauty.us', 'fducassi@floridabeauty.us']);
  let out; await routes['GET /truckmate/alert-recipients'].at(-1)({}, { json: (j) => { out = j; } });
  assert.equal(out.alerts.length, 8); assert.deepEqual(out.groups, ['Dispatch']);
});

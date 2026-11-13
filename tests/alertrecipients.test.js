import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERTS, resolveEntries, cleanRecipients, initAlertRecipients, dropSaray, sarayGetsIt } from '../alertrecipients.js';

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
  assert.equal(out.alerts.length, 28); assert.deepEqual(out.groups, ['Dispatch']);
});

test('loading-temperature emails have their own list: warehouse + outbound, separate from the reefer list', () => {
  const door = ALERTS.find((a) => a.key === 'door_temp');
  assert.deepEqual(door.defaults, ['warehouse@floridabeauty.us', 'outbound@floridabeauty.us']);
  assert.ok(ALERTS.find((a) => a.key === 'reefer_temp').defaults.includes('Dispatch'));
});

test('Saray: only the cc on the running-late emails, Friday to Monday (Eastern); off every other alert, the extended stop email too', () => {
  const ppl = [{ name: 'Saray Fabregas', email: 'sfabregas@floridabeauty.us' }];
  const list = ['dispatches@floridabeauty.us', 'sfabregas@floridabeauty.us', 'inbound-dispatch@floridabeauty.us'];
  const fri = Date.parse('2026-11-06T15:00:00Z'); const mon = Date.parse('2026-11-09T15:00:00Z'); const wed = Date.parse('2026-11-04T15:00:00Z');
  const tueLateNightEt = Date.parse('2026-11-10T03:30:00Z'); // still Monday 10:30 PM in Miami
  assert.deepEqual(dropSaray(['strujillo@floridabeauty.us'], { key: 'running_late_cc', now: fri }), ['strujillo@floridabeauty.us']);
  assert.deepEqual(dropSaray(['strujillo@floridabeauty.us'], { key: 'running_late_cc', now: mon }), ['strujillo@floridabeauty.us']);
  assert.equal(sarayGetsIt('running_late_cc', tueLateNightEt), true);
  assert.deepEqual(dropSaray(['strujillo@floridabeauty.us'], { key: 'running_late_cc', now: wed }), [], 'not Tuesday–Thursday');
  assert.equal(sarayGetsIt('team_stopped', fri), false);
  assert.deepEqual(dropSaray(list, { key: 'team_stopped', people: ppl, now: fri }), ['dispatches@floridabeauty.us', 'inbound-dispatch@floridabeauty.us'], 'not on the extended stop email any more');
  assert.deepEqual(dropSaray(['saray.f@floridabeauty.us', 'a@x.com'], { key: 'transfer', now: fri }), ['a@x.com'], 'her address even when not on Employees');
  assert.deepEqual(ALERTS.find((a) => a.key === 'running_late_cc').defaults, ['strujillo@floridabeauty.us']);
});

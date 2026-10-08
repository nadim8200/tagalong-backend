import test from 'node:test';
import assert from 'node:assert/strict';
import { initPushRules, emailsFor, cleanPeople } from '../pushrules.js';

function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; }, raw: m }; }

test('who gets which push: picked per person and type; off people get nothing', () => {
  const rules = { people: cleanPeople([
    { email: 'Rosa@FloridaBeauty.us', types: { callback: true, 'call-in': true } },
    { email: 'boss@floridabeauty.us', types: { 'callback-urgent': true, priority: true } },
    { email: 'off@floridabeauty.us', active: false, types: { callback: true } },
    { email: 'not-an-email', types: { callback: true } },
  ]) };
  assert.deepEqual(emailsFor(rules, 'callback'), ['rosa@floridabeauty.us']);
  assert.deepEqual(emailsFor(rules, ['callback', 'callback-urgent']), ['rosa@floridabeauty.us', 'boss@floridabeauty.us']);
  assert.deepEqual(emailsFor(rules, 'priority'), ['boss@floridabeauty.us']);
});

test('first time: built from the older settings; saving keeps Priority 1 in step with Alert settings', async () => {
  const db = memDb({
    'taActivityPush:florida-beauty': { emails: ['rosa@floridabeauty.us'], callsIn: true, textsIn: true },
    taMilestonesCfg: { notify: ['dispatch@floridabeauty.us'] },
    taWatchCfg: { recipients: ['boss@floridabeauty.us'] },
    taHelpCfg: { teams: [{ name: 'Dispatch', members: [{ name: 'Rosa', email: 'rosa@floridabeauty.us' }] }] },
    taDispatchers: { list: [] },
  });
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  const pr = initPushRules(app, { requireAdmin: (q, r, n) => n(), db, listDispatchers: async () => [{ email: 'leo@floridabeauty.us', name: 'Leo' }] });
  assert.deepEqual(await pr.emailsFor('callback'), ['rosa@floridabeauty.us']);
  assert.deepEqual(await pr.emailsFor('call-in'), ['rosa@floridabeauty.us']);
  assert.deepEqual(await pr.emailsFor('driver'), ['dispatch@floridabeauty.us']);
  assert.deepEqual(await pr.emailsFor('priority'), ['boss@floridabeauty.us']);
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['GET /admin/push-rules']({}, res);
  assert.equal(out.types.length, 8);
  assert.deepEqual(out.suggestions.map((s) => s.email), ['leo@floridabeauty.us'], 'dispatchers not on the list yet are suggested');
  await routes['PUT /admin/push-rules']({ body: { people: [...out.people, { email: 'leo@floridabeauty.us', types: { callback: true, priority: true } }] }, user: { name: 'Nadim' } }, res);
  assert.deepEqual(await pr.emailsFor('callback'), ['rosa@floridabeauty.us', 'leo@floridabeauty.us']);
  assert.deepEqual(db.raw.get('taWatchCfg').recipients, ['boss@floridabeauty.us', 'leo@floridabeauty.us']);
  await pr.setPriority(['leo@floridabeauty.us']);    // edited from Alert settings
  assert.deepEqual(await pr.emailsFor('priority'), ['leo@floridabeauty.us']);
});

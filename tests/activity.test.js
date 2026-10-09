import test from 'node:test';
import assert from 'node:assert/strict';
import { initActivity, whoIs, dayOf } from '../activity.js';

function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const PROFILES = { p1: { type: 'customer', name: 'BOKHARY FARMS', contacts: [{ name: 'Sam', phone: '7815550123' }] }, p2: { type: 'broker', name: 'RXO Capacity Solutions', office: { city: 'Charlotte', state: 'NC' }, contacts: [{ name: 'Kim', phone: '3125550101' }] } };

test('who a number belongs to: customer / broker (by office) / driver / our team / unknown', () => {
  const drivers = new Map([['3055550117', { name: 'Luis Perez', trips: ['624268'] }]]);
  const team = [{ name: 'Rosa', phone: '305-555-4000', team: 'Dispatch' }];
  assert.deepEqual(whoIs('+1 (781) 555-0123', { profiles: PROFILES }), { role: 'customer', name: 'Sam', detail: 'BOKHARY FARMS' });
  assert.deepEqual(whoIs('312-555-0101', { profiles: PROFILES }), { role: 'broker', name: 'Kim', detail: 'RXO Capacity Solutions — Charlotte, NC' });
  assert.equal(whoIs('3055550117', { drivers }).role, 'driver');
  assert.equal(whoIs('3055554000', { team }).role, 'team');
  assert.equal(whoIs('9995550000', {}).role, 'unknown');
});

test('saved by day; filter by customers / brokers / drivers; a call updates in place (no duplicates)', async () => {
  const db = memDb({ 'taProfiles:florida-beauty': PROFILES });
  const routes = {};
  const a = initActivity({ get: (p, ...h) => { routes[p] = h.at(-1); }, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [{ trip: { tripNumber: '624268' }, _oc: { driverPhone: '3055550117', driverName: 'Luis' } }] }) });
  const at = '2026-10-08T14:05:00Z';
  await a.record({ id: 'call:c1', kind: 'call', direction: 'inbound', from: '+17815550123', to: '+17862040122', at, transcript: 'Agent: hi' });
  await a.record({ id: 'call:c1', kind: 'call', direction: 'inbound', from: '+17815550123', to: '+17862040122', at, summary: 'ETA question', transcript: 'Agent: hi\nUser: where is my truck' });
  await a.record({ kind: 'text', dir: 'in', from: '+13125550101', to: '+13055551200', at: '2026-10-08T15:00:00Z', text: 'Load RXO 24261611 status?' });
  await a.record({ kind: 'app', dir: 'out', from: 'TagAlong app', to: 'driver app', at: '2026-10-08T16:00:00Z', text: 'Call the receiver', trip: '624268', role: 'driver', name: 'Luis' });
  await a.record({ kind: 'text', dir: 'out', from: '+13055551200', to: '+19995550000', at: '2026-10-09T15:00:00Z', text: 'next day' });
  const get = async (query) => { let out; await routes['/truckmate/activity']({ query }, { json: (j) => { out = j; } }); return out; };
  const day = await get({ date: dayOf(at) });
  assert.equal(day.entries.length, 3, 'one call entry, not two');
  const call = day.entries.find((e) => e.kind === 'call');
  assert.deepEqual({ role: call.role, name: call.name, other: call.otherPhone, summary: call.summary }, { role: 'customer', name: 'Sam', other: '+17815550123', summary: 'ETA question' });
  assert.deepEqual((await get({ date: dayOf(at), type: 'broker' })).entries.map((e) => e.text), ['Load RXO 24261611 status?']);
  assert.deepEqual((await get({ date: dayOf(at), type: 'driver' })).entries.map((e) => e.text), ['Call the receiver']);
  let days; await routes['/truckmate/activity/days']({ query: {} }, { json: (j) => { days = j; } });
  assert.deepEqual(days, [{ day: '2026-10-09', count: 1 }, { day: '2026-10-08', count: 3 }]);
});

test('pushFor: calls ping once ended, texts as they come in — each with its push type', async () => {
  const { pushFor } = await import('../activity.js');
  assert.equal(pushFor({ kind: 'call', direction: 'inbound', from: '+17815550123' }), null); // still ringing
  const n = pushFor({ kind: 'call', direction: 'inbound', from: '+17815550123', ended: true, trip: '624268', summary: 'Asked for ETA' });
  assert.equal(n.type, 'call-in');
  assert.match(n.title, /\(781\) 555-0123 called Jarvis/);
  assert.match(n.body, /Load 624268 · Asked for ETA/);
  assert.equal(pushFor({ kind: 'call', direction: 'outbound', to: '3055550117', ended: true }).type, 'call-out');
  const t = pushFor({ kind: 'text', dir: 'in', from: '3055550117', name: 'Luis', text: 'At the dock' });
  assert.equal(t.type, 'text-in'); assert.match(t.title, /Text from Luis/);
  assert.equal(pushFor({ kind: 'app', dir: 'out', to: 'driver app', text: 'hi' }).type, 'text-out');
});

test('record pushes once per call even when the webhook repeats — to whoever the admin picked for that type', async () => {
  const db = memDb();
  const sent = [];
  const pushRules = { emailsFor: async (type) => (type === 'call-in' ? ['d@floridabeauty.us'] : []) };
  const a = initActivity({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, push: { sendToEmails: async (to, m) => { sent.push({ to, ...m }); } }, pushRules });
  const base = { id: 'call:abc', kind: 'call', direction: 'inbound', from: '+17815550123', to: '+17862040122', at: '2026-10-08T15:00:00Z' };
  await a.record(base);
  assert.equal(sent.length, 0);
  await a.record({ ...base, ended: '2026-10-08T15:04:00Z', minutes: 4 });
  await a.record({ ...base, summary: 'Asked for ETA' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['d@floridabeauty.us']);
  assert.equal(sent[0].data.path, '/truckmate?tab=calls');
  await a.record({ id: 't1', kind: 'text', dir: 'out', to: '3055550117', text: 'hi', at: '2026-10-08T15:10:00Z' });
  assert.equal(sent.length, 1, 'nobody picked for texts sent');
});

test('calls show their callback request: open → "call back needed", then who handled it', async () => {
  const { callbackOf } = await import('../activity.js');
  const reqs = [{ id: 'h1', source: 'call', ref: 'abc:Please call me about 624268', status: 'open', need: 'ETA for 624268', urgent: false }, { id: 'h2', source: 'email', ref: 'abc', status: 'open' }];
  assert.deepEqual(callbackOf('abc', reqs), { id: 'h1', status: 'open', need: 'ETA for 624268', urgent: false, handledBy: null, handledAt: null, owner: null, dueAt: null, teams: [] });
  assert.equal(callbackOf('zzz', reqs), null);
  const db = memDb({ 'taHelpRequests:florida-beauty': reqs });
  const routes = {};
  const a = initActivity({ get: (p, ...h) => { routes[p] = h.at(-1); }, put: () => {} }, { requireAuth: () => {}, db });
  await a.record({ id: 'call:abc', kind: 'call', direction: 'inbound', from: '+17815550123', at: '2026-10-08T15:00:00Z', ended: true });
  await a.record({ id: 'call:def', kind: 'call', direction: 'inbound', from: '+17815550999', at: '2026-10-08T16:00:00Z', ended: true });
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['/truckmate/activity']({ query: { date: '2026-10-08', type: 'callback' } }, res);
  assert.deepEqual(out.entries.map((e) => e.id), ['call:abc']);
  await routes['/truckmate/activity/call/:callId']({ params: { callId: 'abc' }, query: { at: '2026-10-08T15:01:00Z' } }, res);
  assert.equal(out.id, 'call:abc');
});

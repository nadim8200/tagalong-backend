import test from 'node:test';
import assert from 'node:assert/strict';
import { initMessages, loadsOf, samePeople, unreadOf } from '../messages.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const fakeApp = () => { const r = {}; const reg = (m) => (p, ...h) => { r[`${m} ${p}`] = h[h.length - 1]; }; return { r, get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') }; };
const call = async (app, key, user, { params = {}, query = {}, body = {} } = {}) => { let out = null; let code = 200; await app.r[key]({ user, params, query, body }, { status(c) { code = c; return this; }, json(b) { out = b; } }); return { code, body: out }; };
const GEO = { id: 'u1', name: 'Geo', role: 'dispatcher' };
const VAL = { id: 'u2', name: 'Valeria', role: 'dispatcher' };
const OUT = { id: 'x9', name: 'Broker Bob', role: 'customer' };
const BOARD = [{ trip: { tripNumber: '626130', powerUnit: '4566', trailer: '7300' }, _samsara: { driver1: 'Carlos Rojas', driver1Info: { phone: '+1 (305) 555-0101' }, driver2: 'Miguel Lopez', driver2Info: { phone: '305-555-0102' } } },
  { trip: { tripNumber: '626200', powerUnit: '2403' }, _samsara: { driver1: 'Ana Diaz', driver1Info: { phone: '7865550199' } } }];

const setup = ({ live = false, appResult = { sent: true, via: 'app (push)' } } = {}) => {
  const db = mem(); const app = fakeApp(); const sent = []; let t = Date.parse('2026-11-04T15:00:00Z');
  const comms = { log: async () => {} };
  const driverLinks = { messageDriver: async (site, trip, text, by) => { sent.push(['app', trip, text, by]); return appResult; } };
  const ringcentral = { configFor: async () => (live ? { fromNumber: '+17867233912' } : {}), sendSms: async (o, m) => { sent.push(['sms', m.to, m.text, m.by]); return { id: 'm1', status: 'Queued' }; } };
  const inbox = initMessages(app, { requireAuth: () => {}, db, getBoard: async () => ({ trips: BOARD }), activity: { lookup: async (p) => (String(p).endsWith('0199') ? { role: 'driver', name: 'Ana Diaz' } : { role: 'unknown' }) }, ringcentral, driverLinks, comms, now: () => t });
  return { db, app, sent, inbox, at: (ms) => { t = ms; } };
};

test('the drivers on each load, with clean phones; same people regardless of order', () => {
  const l = loadsOf(BOARD);
  assert.deepEqual(l[0], { trip: '626130', truck: '4566', trailer: '7300', drivers: [{ name: 'Carlos Rojas', phone: '3055550101' }, { name: 'Miguel Lopez', phone: '3055550102' }] });
  assert.equal(samePeople([{ phone: '3055550102' }, { phone: '3055550101' }], l[0].drivers), true);
  assert.equal(samePeople([{ phone: '3055550101' }], l[0].drivers), false);
  assert.equal(unreadOf({ inbound: ['a', 'c', 'd'] }, 'b'), 2);
});

test('two dispatchers see the same conversation; each send keeps who sent it; unread is per dispatcher', async () => {
  const h = setup();
  await h.inbox.fromApp('626200', { type: 'reply', from: 'driver app', by: 'Ana Diaz (app)', text: 'At the receiver.', at: '2026-11-04T14:00:00Z', extId: 'a1' });
  let g = await call(h.app, 'GET /truckmate/messages', GEO); let v = await call(h.app, 'GET /truckmate/messages', VAL);
  assert.equal(g.body.threads.length, 1); assert.equal(g.body.threads[0].id, 'p:7865550199');
  assert.equal(g.body.threads[0].unread, 1); assert.equal(v.body.threads[0].unread, 1);
  await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: 'p:7865550199' } });
  g = await call(h.app, 'GET /truckmate/messages', GEO); v = await call(h.app, 'GET /truckmate/messages', VAL);
  assert.equal(g.body.threads[0].unread, 0, 'Geo read it'); assert.equal(v.body.threads[0].unread, 1, 'still unread for Valeria');
  const s = await call(h.app, 'POST /truckmate/messages/send', VAL, { body: { thread: 'p:7865550199', text: 'Thanks Ana', via: 'app', clientId: 'c-1' } });
  assert.equal(s.code, 200); assert.deepEqual(h.sent[0], ['app', '626200', 'Thanks Ana', 'Valeria']);
  // the load-log echo of our own app send isn't stored twice
  await h.inbox.fromApp('626200', { type: 'text', kind: 'app-message', to: 'driver app', text: 'Thanks Ana', by: 'Valeria' });
  const th = await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: 'p:7865550199' } });
  assert.deepEqual(th.body.messages.map((m) => [m.dir, m.by, m.text]), [['in', 'Ana Diaz (app)', 'At the receiver.'], ['out', 'Valeria', 'Thanks Ana']]);
  // retried send with the same clientId: sent once
  const again = await call(h.app, 'POST /truckmate/messages/send', VAL, { body: { thread: 'p:7865550199', text: 'Thanks Ana', via: 'app', clientId: 'c-1' } });
  assert.equal(again.body.duplicate, true); assert.equal(h.sent.length, 1);
  // a repeated provider event is stored once
  await h.inbox.fromApp('626200', { type: 'reply', from: 'driver app', by: 'Ana Diaz (app)', text: 'At the receiver.', at: '2026-11-04T14:00:00Z', extId: 'a1' });
  assert.equal((await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: 'p:7865550199' } })).body.messages.length, 2);
});

test('team drivers: the load app chat is one group, replies labeled by sender, separate from a driver\'s own thread', async () => {
  const h = setup();
  await h.inbox.fromApp('626130', { type: 'reply', from: 'driver app', by: 'Carlos Rojas (app)', text: 'Received.', extId: 'x1' });
  await h.inbox.fromApp('626130', { type: 'reply', from: 'driver app', by: 'Miguel Lopez (app)', text: 'Confirmed.', extId: 'x2' });
  await h.inbox.fromSms('3055550101', { type: 'reply', from: '3055550101', text: 'Carlos here by text', extId: 's1' });
  const list = (await call(h.app, 'GET /truckmate/messages', GEO)).body.threads;
  const g = list.find((t) => t.kind === 'group');
  assert.equal(list.length, 2); assert.equal(g.name, 'Carlos Rojas + Miguel Lopez'); assert.equal(g.trip, '626130'); assert.equal(g.truck, '4566');
  const th = (await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: g.id } })).body;
  assert.deepEqual(th.messages.map((m) => m.by), ['Carlos Rojas (app)', 'Miguel Lopez (app)']);
  assert.equal(th.can.app.ok, true); assert.equal(th.can.sms.ok, false, 'no group texting until verified');
  const s = await call(h.app, 'POST /truckmate/messages/send', GEO, { body: { thread: g.id, text: 'Appointment 8 AM', via: 'app', clientId: 'c-2' } });
  assert.equal(s.code, 200); assert.deepEqual(h.sent[0], ['app', '626130', 'Appointment 8 AM', 'Geo']);
  const sms = await call(h.app, 'POST /truckmate/messages/send', GEO, { body: { thread: g.id, text: 'x', via: 'sms', clientId: 'c-3' } });
  assert.equal(sms.code, 409); assert.equal(h.sent.length, 1, 'never faked as separate texts');
});

test('a group is made only after confirming members; truck/trip only when verified; members never change', async () => {
  const h = setup();
  const one = await call(h.app, 'POST /truckmate/messages/groups', GEO, { body: { members: [{ phone: '3055550101', name: 'Carlos Rojas' }] } });
  assert.equal(one.code, 400);
  const r = await call(h.app, 'POST /truckmate/messages/groups', GEO, { body: { members: [{ phone: '3055550101', name: 'Carlos Rojas', role: 'driver' }, { phone: '3055550102', name: 'Miguel Lopez', role: 'driver' }] } });
  assert.equal(r.body.thread.trip, '626130'); assert.equal(r.body.thread.truck, '4566');
  const mixed = await call(h.app, 'POST /truckmate/messages/groups', GEO, { body: { members: [{ phone: '3055550101', name: 'Carlos' }, { phone: '7865550199', name: 'Ana' }] } });
  assert.equal(mixed.body.thread.trip, null, 'not the drivers of one load: no truck/trip');
  // the load's drivers change: the group keeps its members and can't use that load's app chat any more
  BOARD[0]._samsara.driver2Info = { phone: '3055550999' };
  h.at(Date.parse('2026-11-04T15:01:00Z'));   // past the 30-second load cache: one read starts the refresh
  await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: r.body.thread.id } }); await new Promise((ok) => setImmediate(ok));
  const th = (await call(h.app, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: r.body.thread.id } })).body;
  assert.equal(th.thread.members.length, 2); assert.equal(th.can.app.ok, false);
  BOARD[0]._samsara.driver2Info = { phone: '305-555-0102' };
});

test('texting waits for RingCentral; when live, a text goes on the company line with the dispatcher; failures show as failed', async () => {
  const off = setup();
  const r = await call(off.app, 'POST /truckmate/messages/send', GEO, { body: { phone: '(786) 555-1234', text: 'hi', via: 'sms', clientId: 'c-9' } });
  assert.equal(r.code, 409); assert.match(r.body.error, /RingCentral approves/);
  const on = setup({ live: true });
  const ok = await call(on.app, 'POST /truckmate/messages/send', VAL, { body: { phone: '(786) 555-1234', text: 'hi', via: 'sms', clientId: 'c-10' } });
  assert.equal(ok.code, 200); assert.deepEqual(on.sent[0], ['sms', '7865551234', 'hi', 'Valeria']);
  const consent = await call(on.app, 'POST /truckmate/messages/send', VAL, { body: { phone: '7865550199', text: 'hi', via: 'sms', clientId: 'c-11' } });
  assert.equal(consent.code, 409, 'drivers need recorded consent'); assert.match(consent.body.error, /agreed to texts/);
  // the provider refuses: shown as failed, once; sending again is a new send
  const fail = setup({ live: true });
  const rc = { configFor: async () => ({ fromNumber: '+17867233912' }), sendSms: async () => { throw new Error('Carrier rejected'); } };
  const f2 = fakeApp(); initMessages(f2, { requireAuth: () => {}, db: fail.db, getBoard: async () => ({ trips: [] }), ringcentral: rc, driverLinks: {}, now: () => Date.now() });
  const x = await call(f2, 'POST /truckmate/messages/send', GEO, { body: { phone: '7865551234', text: 'hi', via: 'sms', clientId: 'c-12' } });
  assert.equal(x.code, 502);
  const again = await call(f2, 'POST /truckmate/messages/send', GEO, { body: { phone: '7865551234', text: 'hi', via: 'sms', clientId: 'c-12' } });
  assert.equal(again.body.duplicate, true, 'a repeated request is not sent twice');
  const msgs = (await call(f2, 'GET /truckmate/messages/thread/:id', GEO, { params: { id: 'p:7865551234' } })).body.messages;
  assert.deepEqual(msgs.map((m) => [m.status, m.note]), [['failed', 'Carrier rejected']]);
});

test('only dispatch logins; outsiders get nothing', async () => {
  const h = setup();
  const r = await call(h.app, 'GET /truckmate/messages', OUT);
  assert.equal(r.code, 403);
  assert.equal((await call(h.app, 'GET /truckmate/messages/contacts', OUT)).code, 403);
});

test('contacts: every driver profile (on a load or not), with extra cells', async () => {
  const db = mem(); const app = fakeApp();
  initMessages(app, { requireAuth: () => {}, db, getBoard: async () => ({ trips: BOARD }), drivers: async () => [{ code: 'D9', name: 'Ferney Urrego', phone: '+1 786 555 0300', phones: [{ number: '7865550300', label: 'Samsara' }, { number: '305-555-0301', label: 'Wife' }], truck: '2619' }] });
  const r = (await call(app, 'GET /truckmate/messages/contacts', GEO, { query: { q: 'ferne' } })).body;
  assert.deepEqual(r.contacts.map((c) => [c.name, c.phone, c.truck]), [['Ferney Urrego', '7865550300', '2619'], ['Ferney Urrego', '3055550301', '2619']]);
});

test('contacts: drivers with truck and trip; a new 10-digit number can be texted', async () => {
  const h = setup();
  const r = (await call(h.app, 'GET /truckmate/messages/contacts', GEO, { query: { q: '4566' } })).body;
  assert.deepEqual(r.contacts.map((c) => c.name), ['Carlos Rojas', 'Miguel Lopez']);
  assert.equal((await call(h.app, 'GET /truckmate/messages/contacts', GEO, { query: { q: '(954) 555-0000' } })).body.newNumber, '9545550000');
  const pins = await call(h.app, 'PUT /truckmate/messages/pins', GEO, { body: { pins: ['p:3055550101', 'junk', 'g:abcdef0123'] } });
  assert.deepEqual(pins.body.pins, ['p:3055550101', 'g:abcdef0123']);
});

test('a truck search offers its team drivers as one group; the same group is reused', async () => {
  const h = setup();
  const r = (await call(h.app, 'GET /truckmate/messages/contacts', GEO, { query: { q: '4566' } })).body;
  assert.deepEqual(r.teams.map((t) => [t.truck, t.trip, t.drivers.map((d) => d.name)]), [['4566', '626130', ['Carlos Rojas', 'Miguel Lopez']]]);
  assert.deepEqual((await call(h.app, 'GET /truckmate/messages/contacts', GEO, { query: { q: '2403' } })).body.teams, [], 'one driver: no team');
  const a = await call(h.app, 'POST /truckmate/messages/groups', GEO, { body: { members: r.teams[0].drivers.map((d) => ({ ...d, role: 'driver' })), trip: '626130' } });
  const b = await call(h.app, 'POST /truckmate/messages/groups', VAL, { body: { members: r.teams[0].drivers.map((d) => ({ ...d, role: 'driver' })), trip: '626130' } });
  assert.equal(b.body.existing, true); assert.equal(a.body.thread.id, b.body.thread.id);
});

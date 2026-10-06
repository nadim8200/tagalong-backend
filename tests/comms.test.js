import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, routeReply } from '../comms.js';

test('registered texts: company name, load, STOP line', () => {
  const a = messageFor('confirm-stop', { trip: '624268', stopLabel: 'stop 3 (Example Produce, Lawrence MA)', phone: '+17867233912' });
  assert.match(a, /^Florida Beauty Flora dispatch: please confirm stop 3 .* on load 624268 was delivered\. Reply YES/);
  assert.match(a, /Reply STOP to opt out\.$/);
  const b = messageFor('pod-request', { trip: '624268', link: 'https://mytagalong.app/t/abc' });
  assert.match(b, /signed POD and BOL for load 624268\. Upload photos here: https:\/\/mytagalong\.app\/t\/abc/);
  assert.equal(messageFor('marketing', {}), null);
});

test('driver replies: YES confirms the stop asked about; any reply is logged on the driver\'s load', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const asks = [
    { trip: '624268', kind: 'confirm-stop', stopKey: '3.0|EXAMPLE|LAWRENCE|MA', stopLabel: 'stop 3', phone: '3055550117', at: '2026-10-06T14:00:00Z' },
    { trip: '624100', kind: 'confirm-stop', stopKey: 'x', phone: '3055550117', at: '2026-10-01T14:00:00Z' },   // too old
  ];
  const driverPhones = new Map([['3055550199', ['624300']]]);
  const yes = routeReply({ from: '+1 (305) 555-0117', text: 'Yes delivered' }, { asks, driverPhones, now });
  assert.deepEqual(yes.trips, ['624268']);
  assert.equal(yes.confirm.stopKey, '3.0|EXAMPLE|LAWRENCE|MA');
  const other = routeReply({ from: '+13055550117', text: 'running 30 min late' }, { asks, driverPhones, now });
  assert.equal(other.confirm, null);
  const known = routeReply({ from: '+13055550199', text: 'at the receiver' }, { asks, driverPhones, now });
  assert.deepEqual(known.trips, ['624300']);
  assert.deepEqual(routeReply({ from: '+19995550000', text: 'hi' }, { asks, driverPhones, now }).trips, []);
});

test('who gets the text: OC driver, else the company driver from Samsara; consent by load or by phone', async () => {
  const { recipientFor } = await import('../comms.js');
  const oc = { _oc: { driverPhone: '305-555-0117', driverName: 'Test Driver', smsConsent: { by: 'Ana' } } };
  assert.deepEqual(recipientFor(oc), { phone: '305-555-0117', name: 'Test Driver', consent: { by: 'Ana' }, kind: 'oc' });
  const co = { _samsara: { driver1Info: { name: 'Mark Bodien', phone: '+1 954 555 0100' }, driver2Info: { name: 'Second', phone: null } } };
  assert.equal(recipientFor(co).consent, null);
  assert.deepEqual(recipientFor(co, 1, { 9545550100: { by: 'Rosa' } }).consent, { by: 'Rosa' });
  assert.equal(recipientFor(co, 2), null);   // no phone in Samsara
  assert.equal(recipientFor({ _samsara: {} }), null);
});

test('Samsara driver profile: only name, phone and IDs leave the server', async () => {
  const { driverProfile } = await import('../samsara.js');
  const p = driverProfile({ id: 7, name: 'Mark Bodien', username: 'MBODIEN', phone: '+19545550100', licenseNumber: 'B123456789', licenseState: 'FL', notes: 'x' });
  assert.deepEqual(p, { id: '7', name: 'Mark Bodien', username: 'MBODIEN', phone: '+19545550100' });
});

test('custom text: company name first, STOP line added, length capped', () => {
  assert.equal(messageFor('custom', { text: '  Call me when you\'re empty  ' }), "Florida Beauty Flora dispatch: Call me when you're empty Reply STOP to opt out.");
  assert.equal(messageFor('custom', { text: 'Ok thanks. Reply STOP to opt out.' }), 'Florida Beauty Flora dispatch: Ok thanks. Reply STOP to opt out.');
  assert.equal(messageFor('custom', { text: '   ' }), null);
  assert.ok(messageFor('custom', { text: 'x'.repeat(500) }).length < 360);
});

test('driver conversation: every call, text and reply on the driver\'s thread, tagged with the load', async () => {
  const { initComms } = await import('../comms.js');
  const m = new Map(); const clone = (v) => JSON.parse(JSON.stringify(v));
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? clone(m.get(k)) : fb), set: async (k, v) => m.set(k, clone(v)), update: async (k, fn, fb) => { const n = fn(m.has(k) ? clone(m.get(k)) : fb); m.set(k, clone(n)); return n; } };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; } };
  const c = initComms(app, { requireAuth: () => {}, db, env: { NODE_ENV: 'test' } });
  await c.log('florida-beauty', '624278', { type: 'call', to: '+19545550100', label: 'Mark Bodien', by: 'Rosa' });
  await c.log('florida-beauty', '624278', { type: 'text', kind: 'custom', to: '+19545550100', text: 'Florida Beauty Flora dispatch: call me. Reply STOP to opt out.', by: 'Rosa' });
  await c.log('florida-beauty', '624301', { type: 'reply', from: '(954) 555-0100', text: 'on my way' });
  let out; const res = { json: (j) => { out = j; }, status: () => res };
  await routes['GET /truckmate/drivers/:phone/thread']({ params: { phone: '9545550100' }, query: {}, body: {} }, res);
  assert.deepEqual(out.map((e) => [e.type, e.trip]), [['reply', '624301'], ['text', '624278'], ['call', '624278']]);
  assert.equal(out[1].by, 'Rosa');
});

import { keyword, OPTIN_MSG, HELP_MSG, initComms } from '../comms.js';

test('STOP / START / HELP keywords', () => {
  for (const t of ['STOP', 'stop', ' Unsubscribe ', 'cancel', 'END', 'quit.']) assert.equal(keyword(t), 'stop', t);
  for (const t of ['START', 'unstop']) assert.equal(keyword(t), 'start', t);
  for (const t of ['HELP', 'help?', 'info']) assert.equal(keyword(t), 'help', t);
  for (const t of ['yes', 'stop 3 delivered', 'please help me unload', 'ok']) assert.equal(keyword(t), null, t);
  assert.match(OPTIN_MSG, /Msg frequency varies\. Msg & data rates may apply\. Reply HELP for help, STOP to opt out\.$/);
  assert.match(HELP_MSG, /\(305\) 503-1200/);
});

test('opt-in text waits until texting is live, goes once; STOP blocks and removes consent; START re-subscribes; HELP answers', async () => {
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  let live = false; const sent = [];
  const ringcentral = { configFor: async () => (live ? { fromNumber: '+17867233912' } : {}), sendSms: async (o, msg) => { sent.push(msg); return { id: 1 }; }, inboundSince: async () => [] };
  const app = { get() {}, post() {}, put() {} };
  const comms = initComms(app, { requireAuth: () => {}, db, ringcentral, env: { NODE_ENV: 'test' }, getBoard: async () => ({ trips: [{ trip: { tripNumber: '624257' }, _oc: { driverPhone: '(786) 555-0144', driverName: 'Oc Driver', smsConsent: { by: 'Ana', at: '2026-10-06T12:00:00Z' } } }] }) });
  m.set('taSmsConsent:florida-beauty', { 3055550100: { by: 'Ana', at: '2026-10-06T12:00:00Z' } });
  assert.equal(await comms.sendConfirmations(), 0, 'texting not live yet → nothing sent');
  live = true;
  assert.equal(await comms.sendConfirmations(), 2, 'company driver + OC driver');
  assert.ok(sent.every((x) => x.text === OPTIN_MSG));
  assert.equal(await comms.sendConfirmations(), 0, 'only once');
  await comms.handleKeyword('florida-beauty', { from: '+13055550100', text: 'STOP', at: '2026-10-06T13:00:00Z' }, 'stop');
  assert.ok((await db.get('taSmsOptOut', {}))['3055550100']);
  assert.equal((await db.get('taSmsConsent:florida-beauty', {}))['3055550100'], undefined);
  await comms.handleKeyword('florida-beauty', { from: '+13055550100', text: 'START', at: '2026-10-06T14:00:00Z' }, 'start');
  assert.equal((await db.get('taSmsOptOut', {}))['3055550100'], undefined);
  assert.equal(sent.at(-1).text, OPTIN_MSG, 'START gets the opt-in text again');
  await comms.handleKeyword('florida-beauty', { from: '+13055550100', text: 'HELP' }, 'help');
  assert.equal(sent.at(-1).text, HELP_MSG);
});

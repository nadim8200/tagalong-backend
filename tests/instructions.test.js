import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstructions, expandInstructions, fmtWall } from '../inbox.js';
import { plannedPickup } from '../pickupfollow.js';

test('one instruction about five loads becomes one per load', () => {
  const ins = parseInstructions([{ kind: 'task', trip: null, trips: ['624620', '624626', '624625', '624634', '624628'], message: 'Follow up on five loads' }]);
  const out = expandInstructions(ins);
  assert.deepEqual(out.map((x) => x.trip), ['624620', '624626', '624625', '624634', '624628']);
  assert.ok(out.every((x) => x.split && x.message === 'Follow up on five loads'));
});

test('single-load and eta_updates instructions are left alone', () => {
  const ins = parseInstructions([{ kind: 'note', trip: '624620', message: 'x' }, { kind: 'eta_updates', trips: ['624620', '624626'], everyHours: 2 }]);
  const out = expandInstructions(ins);
  assert.equal(out.length, 2);
  assert.equal(out[0].trip, '624620');
  assert.deepEqual(out[1].trips, ['624620', '624626']);
});

test('pickup_followup keeps each trip own date / time / place; bad values drop', () => {
  const [a, b, c] = parseInstructions([
    { kind: 'pickup_followup', trip: '624626', event: 'pickup', date: '2026-10-08', time: '23:00', region: 'Florida', temp: '35 degrees' },
    { kind: 'pickup_followup', trip: '624620', event: 'meetup', date: '2026-10-08', time: null, place: 'Fort Pierce', region: 'Florida' },
    { kind: 'pickup_followup', trip: '624628', event: 'departure', date: '2026-10-09', time: 'afternoon', timeText: 'afternoon', region: 'California' },
  ]);
  assert.deepEqual([a.trip, a.date, a.time, a.event, a.temp], ['624626', '2026-10-08', '23:00', 'pickup', '35 degrees']);
  assert.deepEqual([b.event, b.time, b.place], ['meetup', null, 'Fort Pierce']);
  assert.deepEqual([c.time, c.timeText], [null, 'afternoon']);
  assert.match(fmtWall('2026-10-08T23:00'), /Oct 8.*11:00 PM/);
});

test('a pickup time staff emailed drives the pickup follow-up', () => {
  const p = plannedPickup({ trip: { tripNumber: '624626' }, _pickupAsk: { at: '2026-10-08T23:00' } });
  assert.equal(p.source, 'dispatch email');
  assert.equal(new Date(p.ms).toISOString(), '2026-10-09T03:00:00.000Z');
});

import { departedNow, chainNote, initPickupFollow } from '../pickupfollow.js';
import { sheetChains } from '../inbox.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }

test('each load replies in the chain its trip sheet came in (newest staff email wins)', () => {
  const list = [
    { id: 'new', from: { address: 'rosar@floridabeauty.us' }, tripSheets: [{ trip: '624626' }] },
    { id: 'old', from: { address: 'rosar@floridabeauty.us' }, tripSheets: [{ trip: '624626' }, { trip: '624625' }] },
    { id: 'ext', from: { address: 'x@broker.com' }, tripSheets: [{ trip: '624620' }] },
  ];
  const c = sheetChains(list, (a) => a.endsWith('@floridabeauty.us'));
  assert.equal(c['624626'].id, 'new');
  assert.equal(c['624625'].id, 'old');
  assert.equal(c['624620'], undefined);
});

test('departed = TruckMate departed, or moving on GPS from 15 min before pickup', () => {
  const plan = { ms: Date.parse('2026-10-09T03:00:00Z') };
  assert.ok(departedNow({ trip: { status: 'DEPSHIP' } }, plan, 0));
  assert.equal(departedNow({ trip: { status: 'DISP' }, _samsara: { speedMph: 50 } }, plan, plan.ms - 60 * 60000), null);
  assert.ok(departedNow({ trip: { status: 'DISP' }, _samsara: { speedMph: 50 } }, plan, plan.ms - 10 * 60000));
});

test('the not-departed note says what has not happened and asks for a new time', () => {
  const plan = { ms: Date.parse('2026-10-09T03:00:00Z'), place: 'Miami cooler', source: 'trip sheet' };
  const n = chainNote([{ trip: '624626', kind: 'late', plan, item: { trip: { status: 'DISP', powerUnit: '2403' } }, checkins: 'no answer yet — Jarvis called at 10:00 PM' }], plan.ms + 32 * 60000);
  assert.match(n.text, /Trip 624626 — NOT DEPARTED/);
  assert.match(n.text, /32 min past pickup/);
  assert.match(n.text, /TruckMate still shows DISP/);
  assert.match(n.text, /a new time for 624626, if it changed/i);
  assert.match(n.text, /Reply on this email/);
  assert.ok(n.asks);
});

test('follow-up loop: 30 min late → one reply in the chain; then departed → another', async () => {
  const db = memDb();
  const at = '2026-10-08T23:00';
  const plan = Date.parse('2026-10-09T03:00:00Z');
  const item = { trip: { tripNumber: '624626', status: 'DISP', powerUnit: '2403' }, _samsara: { speedMph: 0 }, _pickupAsk: { at, emailId: 'rosa1' } };
  const sent = [];
  let clock = plan - 2 * 60 * 60000;
  const f = initPickupFollow({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [item] }), replyInThread: async (site, id, b) => { sent.push({ id, ...b }); return { sent: true }; }, env: { NODE_ENV: 'test' }, now: () => clock });
  await f.run();
  assert.equal(sent.length, 0);
  clock = plan + 31 * 60000; await f.run();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'rosa1');
  assert.match(sent[0].text, /NOT DEPARTED/);
  clock = plan + 40 * 60000; await f.run();
  assert.equal(sent.length, 1, 'only one late note');
  item.trip.status = 'DEPSHIP';
  clock = plan + 50 * 60000; await f.run();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Trip 624626 — DEPARTED/);
  clock = plan + 60 * 60000; await f.run();
  assert.equal(sent.length, 2, 'departure told once');
});

import { tripsInAnswer, isStatusAsk, cleanAnswer } from '../inbox.js';

test('a free-text answer about board loads still gets the standard update', () => {
  const a = 'Nadim, 4 Ever Roses has two loads. Trip 624480, truck 2011: delivered. Trip 624559 is behind. Bill 123456 is not a trip.';
  assert.deepEqual(tripsInAnswer(a, new Set(['624480', '624559'])), ['624480', '624559']);
});

test('"locate and provide status" is answered by the reply, not a to-do', () => {
  assert.ok(isStatusAsk({ kind: 'task', message: 'Locate and provide status update on 4 Ever Roses load to Nadim Tellez.' }));
  assert.ok(!isStatusAsk({ kind: 'task', message: 'Send the rate con to RXO' }));
  assert.ok(!isStatusAsk({ kind: 'text_driver', message: 'where are you?' }));
});

test('model-written "Done from your email" lists and offer endings are removed', () => {
  const t = 'Two loads on the board.\n\nIf you want, I can text the driver on 624559.\n\n**Done from your email:**\n- To-do: x — which load?';
  assert.equal(cleanAnswer(t), 'Two loads on the board.');
});

test('once departed (GPS 47 mph), slowing to 6 mph in traffic later never sends "not departed"', async () => {
  const db = memDb();
  const plan = Date.parse('2026-10-09T03:30:00Z');   // Thu Oct 8, 11:30 PM ET
  const item = { trip: { tripNumber: '624625', status: 'LOADEDTOGO', powerUnit: '2220' }, _samsara: { speedMph: 0 }, _sheetEmail: { id: 'rosa1' }, _manifest: { pickupAt: '2026-10-08T23:30' } };
  const sent = [];
  let clock = plan - 20 * 60000;
  const f = initPickupFollow({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [item] }), replyInThread: async (site, id, b) => { sent.push(b.text); return { sent: true }; }, env: { NODE_ENV: 'test' }, now: () => clock });
  await f.run();                                                     // waiting at the cooler
  item._samsara = { speedMph: 47, location: 'State Road 7, Palm Beach County, FL' };
  clock = plan - 2 * 60000; await f.run();
  assert.equal(sent.length, 1); assert.match(sent[0], /DEPARTED/);
  item._samsara = { speedMph: 6, location: 'I 95, Oakland Park, FL' };   // traffic
  clock = plan + 31 * 60000; await f.run();
  clock = plan + 90 * 60000; await f.run();
  assert.equal(sent.length, 1, 'no "not departed" after it departed');
});

import { tmFixNote } from '../pickupfollow.js';

test('GPS departed but TruckMate still LOADEDTOGO → one email to dispatches@ + customer service to fix TruckMate', async () => {
  const db = memDb();
  await db.set('taHelpCfg', { teams: [{ id: 'customer-service', name: 'Customer service', email: '', members: [{ name: 'Saray', email: 'saray@floridabeauty.us' }, { name: 'Outside', email: 'x@gmail.com' }] }] });
  const plan = Date.parse('2026-10-09T03:30:00Z');
  const item = { trip: { tripNumber: '624625', status: 'LOADEDTOGO', powerUnit: '2220', trailer: '2048' }, _samsara: { speedMph: 0 }, _manifest: { pickupAt: '2026-10-08T23:30' } };
  const mails = [];
  let clock = plan - 20 * 60000;
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  const fetchFn = async (url, o) => { if (/token/.test(url)) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) }; mails.push(o.body); return { ok: true, status: 202, json: async () => ({}) }; };
  const f = initPickupFollow({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [item] }), env, fetchFn, now: () => clock });
  await f.run();
  assert.equal(mails.length, 0);
  item._samsara = { speedMph: 47, location: 'State Road 7, Palm Beach County, FL', gpsAt: new Date(plan - 2 * 60000).toISOString() };
  clock = plan - 2 * 60000; await f.run();
  assert.equal(mails.length, 1);
  const mime = Buffer.from(mails[0], 'base64').toString('utf8');
  assert.match(mime, /^To: dispatches@floridabeauty\.us, saray@floridabeauty\.us$/m);
  clock = plan + 10 * 60000; await f.run();
  assert.equal(mails.length, 1, 'once per pickup');
  item.trip.status = 'DEPSHIP';
});

test('the fix-TruckMate email says what TruckMate shows and what GPS shows', () => {
  const m = tmFixNote({ item: { trip: { tripNumber: '624625', status: 'LOADEDTOGO', powerUnit: '2220', trailer: '2048' }, _samsara: { location: 'State Road 7, Palm Beach County, FL', driver1: 'Alexey Garcia' } }, plan: { ms: Date.parse('2026-10-09T03:30:00Z'), place: 'MIAMI TERMINAL', source: 'trip sheet' }, dep: { source: 'GPS: truck moving 47 mph' }, now: Date.parse('2026-10-09T03:28:00Z') });
  assert.equal(m.subject, 'Update TruckMate: trip 624625 departed — status still LOADEDTOGO');
  assert.match(m.text, /TruckMate shows LOADEDTOGO, but the truck has left — GPS: truck moving 47 mph near State Road 7, Palm Beach County, FL/);
  assert.match(m.text, /update the status in TruckMate to departed \(DEPSHIP\)/);
});

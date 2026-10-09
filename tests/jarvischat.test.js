import test from 'node:test';
import assert from 'node:assert/strict';
import { initJarvisChat, TOOLS } from '../jarvischat.js';

const LOAD = { trip: { tripNumber: '624399', status: 'DEPSHIP', powerUnit: '724', trailer: '7343', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'BEDFORD, NH, 03110' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'CLIFTON, NJ, 07011' }], _samsara: { location: 'New Jersey Turnpike, Cranbury, NJ', gpsAt: '2026-10-08T12:00:00Z', speedMph: 64 } };
function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
// a scripted Claude: each call returns the next step
function fakeClaude(steps) {
  const sent = [];
  const fetchFn = async (url, opts) => { const body = JSON.parse(opts.body); sent.push(body); const s = steps.shift(); return { ok: true, status: 200, json: async () => s(body) }; };
  return { fetchFn, sent };
}
const useTool = (name, input) => () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}`, name, input }] });
const say = (text) => () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
function setup(steps, extra = {}) {
  const db = memDb(); const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  const claude = fakeClaude(steps);
  const chat = initJarvisChat(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [JSON.parse(JSON.stringify(LOAD))], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: claude.fetchFn, ...extra });
  const call = async (key, body = {}, params = {}) => { let out; let status = 200; const res = { status(c) { status = c; return this; }, json(j) { out = j; } }; await routes[key]({ body, params, user: { id: 7, name: 'Rosa', role: 'dispatcher' } }, res); return { status, body: out }; };
  return { db, chat, call, claude };
}

test('a dispatcher asks about a load: Jarvis looks it up with a tool and answers; the thread is saved', async () => {
  const h = setup([useTool('load_details', { trip: '624399' }), say('624399 (truck 724) is on the NJ Turnpike near Cranbury, 64 mph.')]);
  const r = await h.call('POST /jarvis/chat', { message: 'Where is 624399?' });
  assert.equal(r.status, 200); assert.match(r.body.answer, /Cranbury/);
  const toolResult = h.claude.sent[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result'); assert.match(toolResult.content, /New Jersey Turnpike/);
  assert.match(h.claude.sent[0].system, /Rosa, a dispatcher/);
  assert.ok(TOOLS.some((t) => t.name === 'propose_action'));
  const th = await h.call('GET /jarvis/threads/:id', {}, { id: r.body.threadId });
  assert.deepEqual(th.body.messages.map((m) => m.role), ['user', 'assistant']);
});

test('a transfer between two teams is recorded on the load (card + Jarvis see it)', async () => {
  const transfer = { fromTruck: '724', fromDrivers: 'Giovanni Damelio & Rodolfo Medina', toTruck: '2205', toDrivers: 'Team Lopez', place: 'Savannah, GA (Pilot exit 94)', at: 'Oct 9 6:00 PM' };
  const h = setup([useTool('add_note', { trip: '624399', kind: 'transfer', text: 'Hand-off to truck 2205 in Savannah', transfer }), say('Saved: 624399 transfers from truck 724 to 2205 in Savannah, Oct 9 6:00 PM.')]);
  const r = await h.call('POST /jarvis/chat', { message: 'Giovanni\'s team hands 624399 to truck 2205 (Team Lopez) at the Pilot exit 94 in Savannah tomorrow 6 PM' });
  assert.deepEqual(r.body.did, [{ tool: 'add_note', trip: '624399', ok: true }]);
  const items = [JSON.parse(JSON.stringify(LOAD))];
  await h.chat.overlay('florida-beauty', items);
  assert.equal(items[0]._notes[0].kind, 'transfer'); assert.equal(items[0]._notes[0].transfer.toTruck, '2205'); assert.equal(items[0]._notes[0].by, 'Rosa');
});

test('texting a driver is only proposed — it goes out when the dispatcher clicks Confirm', async () => {
  const sent = [];
  const driver = { text: async (site, trip, message, by) => { sent.push({ trip, message, by }); return { sent: true, via: 'app (push)' }; } };
  const h = setup([useTool('propose_action', { type: 'text_driver', trip: '624399', message: 'Please call Main Wholesale Clifton 1 hour before arrival.' }), say('I drafted the message — click Confirm to send it.')], { driver });
  const r = await h.call('POST /jarvis/chat', { message: 'Tell the 624399 driver to call Clifton an hour before' });
  assert.equal(sent.length, 0, 'nothing sent before Confirm');
  assert.equal(r.body.actions[0].status, 'waiting');
  const ok = await h.call('POST /jarvis/actions/:id/:decision', {}, { id: r.body.actions[0].id, decision: 'confirm' });
  assert.equal(ok.body.status, 'done'); assert.deepEqual(sent[0], { trip: '624399', message: 'Please call Main Wholesale Clifton 1 hour before arrival.', by: 'Rosa via Jarvis' });
  assert.equal((await h.call('POST /jarvis/actions/:id/:decision', {}, { id: r.body.actions[0].id, decision: 'confirm' })).status, 409, 'never twice');
});

test('uploads: a trip sheet is read and filed; another document is stored and can be attached to a load', async () => {
  const packets = async (site, files) => { if (/sheet/.test(files[0].filename)) return { trips: [{ trip: '624520' }], rateCons: [] }; throw Object.assign(new Error('No trip sheets'), { status: 422 }); };
  const linked = [];
  const docs = { storeDocs: async () => [{ id: 991 }], linkDocs: async (a) => linked.push(a) };
  const h = setup([useTool('attach_document', { docId: '991', trip: '624399' }), say('Attached the photo to 624399.')], { packets, docs });
  const r = await h.call('POST /jarvis/chat', { message: 'This is the damaged pallet photo', files: [{ filename: 'trip sheet 624520.pdf', mediaType: 'application/pdf', dataBase64: 'JVBE' }, { filename: 'pallet.jpg', mediaType: 'image/jpeg', dataBase64: '/9j/' }] });
  assert.match(r.body.uploads[0].result, /trip sheet read and filed for 624520/);
  assert.equal(r.body.uploads[1].docId, '991');
  assert.match(h.claude.sent[0].messages.at(-1).content, /\[Uploaded: .*pallet\.jpg → not a trip sheet or rate con.*docId 991/);
  assert.deepEqual(linked[0].links, [{ docId: '991', trips: ['624399'] }]);
});

import { truckNow } from '../jarvischat.js';
test('every load Jarvis lists says where the truck is, rolling or stopped, and the next stop', () => {
  const now = Date.parse('2026-10-08T16:00:00Z');
  const it = { trip: { tripNumber: '624460', powerUnit: '1811' }, _samsara: { location: 'I 5, Stanislaus County, CA', gpsAt: '2026-10-08T15:58:00Z', speedMph: 0, hos: { status: 'onDuty', driveLeftMin: 0 } } };
  const w = { units: { 1811: { stoppedSince: now - 95 * 60000 } }, etas: { 624460: { stops: [{ label: 'TRACY, CA, 95304', etaMs: Date.parse('2026-10-09T02:23:00Z'), miles: 28 }] } } };
  const tn = truckNow(it, w, now);
  assert.equal(tn.motion, 'stopped 1h 35m'); assert.equal(tn.gps, 'live'); assert.equal(tn.driveLeft, '0 min');
  assert.deepEqual(tn.nextStop, { stop: 'TRACY, CA, 95304', eta: 'Thu, Oct 8, 7:23 PM Pacific (local time)', miles: 28 });
  assert.equal(truckNow({ ...it, _samsara: { ...it._samsara, speedMph: 61 } }, w, now).motion, 'rolling 61 mph');
  assert.equal(truckNow({ ...it, _samsara: { ...it._samsara, gpsAt: '2026-10-08T13:00:00Z' } }, w, now).gps, 'last seen 3h 0m ago');
});

test('voice: a spoken turn asks for a short answer; speech is transcribed only with a key', async () => {
  const h = setup([say('Truck 724 is near Cranbury, New Jersey, rolling 64.')]);
  await h.call('POST /jarvis/chat', { message: 'where is 624399', voice: true });
  assert.match(h.claude.sent[0].system, /SPOKEN conversation/);
  const off = setup([]);
  assert.equal((await off.call('GET /jarvis/voice')).body.serverStt, false);
  const no = await off.call('POST /jarvis/transcribe', { audio: 'AAAA', mimeType: 'audio/webm' });
  assert.equal(no.status, 503);
  const seen = [];
  const on = setup([], { env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'sk-test' }, fetchFn: async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ text: ' Where is load 624399? ' }) }; } });
  const r = await on.call('POST /jarvis/transcribe', { audio: Buffer.from('fake').toString('base64'), mimeType: 'audio/mp4', lang: 'en' });
  assert.equal(r.body.text, 'Where is load 624399?');
  assert.match(seen[0].url, /audio\/transcriptions/);
  assert.equal(seen[0].opts.body.get('file').name, 'speech.m4a');
});

test('loads_to_place: "Lombard IL" finds the loads stopping there', async () => {
  const LOMBARD = { trip: { tripNumber: '624520', status: 'DEPSHIP', powerUnit: 'OC1' }, freightBills: [{ billNumber: 'B1', billToName: 'MAYESH', endZoneDescription: 'LOMBARD, IL, 60148', actualDelivery: null }] };
  const db = memDb(); const app = { get: () => {}, post: () => {} };
  const chat = initJarvisChat(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [JSON.parse(JSON.stringify(LOAD)), LOMBARD], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const r = await chat.runTool('loads_to_place', { place: 'Lombard IL' }, { user: { id: 7, name: 'Rosa' }, did: [], proposed: [] });
  assert.deepEqual(r.loads.map((x) => [x.trip, x.stop, x.delivered]), [['624520', 'LOMBARD, IL, 60148', false]]);
  const none = await chat.runTool('loads_to_place', { place: 'Boise, ID' }, { user: { id: 7, name: 'Rosa' }, did: [], proposed: [] });
  assert.equal(none.loads.length, 0);
});

test('customer mode (emails from customers / brokers): only look-up tools, nothing private comes back', async () => {
  const { customerSafe } = await import('../jarvischat.js');
  assert.deepEqual(customerSafe({ trip: '1', location: 'I-95', driverPhone: '305', rate: 2500, notes: ['x'], stops: [{ city: 'Lombard', contactEmail: 'a@b.c' }] }), { trip: '1', location: 'I-95', stops: [{ city: 'Lombard' }] });
  const h = setup([useTool('propose_action', { type: 'text_driver', trip: '624399', message: 'hi' }), say('What is your PO number?')]);
  const r = await h.chat.turn({ mode: 'customer', user: { id: 'email:ana@mayesh.com', name: 'Ana <ana@mayesh.com>' }, threadId: 'abcdef012345', text: 'where are my flowers' });
  assert.match(h.claude.sent[0].system, /answering an email from Ana/);
  assert.deepEqual(h.claude.sent[0].tools.map((t) => t.name).sort(), ['find_load', 'load_details', 'loads_to_place', 'staff_directory', 'update_email']);
  assert.match(h.claude.sent[1].messages.at(-1).content[0].content, /Not available/);
  assert.equal(r.actions.length, 0, 'a customer can never make Jarvis contact anyone');
});

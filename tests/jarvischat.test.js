import test from 'node:test';
import assert from 'node:assert/strict';
import { initJarvisChat, TOOLS, billsByStop, loadsByDriver } from '../jarvischat.js';

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
  assert.match(txt(h.claude.sent[0].system), /Rosa, a dispatcher/);
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
  assert.match(txt(h.claude.sent[0].messages.at(-1).content), /\[Uploaded: .*pallet\.jpg → not a trip sheet or rate con.*docId 991/);
  assert.deepEqual(linked[0].links, [{ docId: '991', trips: ['624399'] }]);
});

// the request is cached (system / last message as blocks) — read it as text
const txt = (v) => (Array.isArray(v) ? v.map((b) => b.text || '').join('') : String(v || ''));
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
  assert.match(txt(h.claude.sent[0].system), /SPOKEN conversation/);
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
  assert.match(txt(h.claude.sent[0].system), /answering an email from Ana/);
  assert.deepEqual(h.claude.sent[0].tools.map((t) => t.name).sort(), ['find_load', 'load_details', 'load_documents', 'loads_to_place', 'past_loads', 'staff_directory', 'trip_manifest', 'update_email']);
  assert.match(h.claude.sent[1].messages.at(-1).content[0].content, /Not available/);
  assert.equal(r.actions.length, 0, 'a customer can never make Jarvis contact anyone');
});

import { pickModel, trimHistory, withCache } from '../jarvischat.js';

test('cheaper: routine questions and email answers use the light model; planning / several loads use the heavy one', () => {
  const env = {};
  assert.equal(pickModel({ text: 'where is 624318?' }, env), 'claude-haiku-4-5-20251001');
  assert.equal(pickModel({ mode: 'staff_email', text: 'why is it late and should we swap trucks?' }, env), 'claude-haiku-4-5-20251001');
  assert.equal(pickModel({ mode: 'customer', text: 'where is my load' }, env), 'claude-haiku-4-5-20251001');
  assert.equal(pickModel({ text: 'which trucks should cover the Northeast tomorrow?' }, env), 'claude-sonnet-5-5');
  assert.equal(pickModel({ text: 'status of 624318, 624320 and 624325' }, env), 'claude-sonnet-5-5');
  assert.equal(pickModel({ text: 'hi', uploads: [{}] }, env), 'claude-sonnet-5-5');
  assert.equal(pickModel({ text: 'where is 624318?' }, { JARVIS_CHAT_ROUTING: 'off' }), 'claude-sonnet-5-5');
});

test('cheaper: only the last 6 turns go with each question, older long answers shortened', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i} ${'x'.repeat(i === 10 ? 3000 : 10)}` }));
  const h = trimHistory(msgs);
  assert.equal(h.length, 12);
  assert.equal(h[0].content.startsWith('8 '), true);
  assert.ok(h[2].content.length <= 1501, 'old long answer shortened');
});

test('cheaper: instructions, tools and the conversation so far are marked for prompt caching', () => {
  const c = withCache({ system: 'S', tools: [{ name: 'a' }, { name: 'b' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }] }] });
  assert.deepEqual(c.system, [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(c.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(c.tools[0].cache_control, undefined);
  assert.deepEqual(c.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(c.messages[0].content, 'hi', 'earlier messages untouched');
});

test('typed chat gets what the phone gets: "ETA to Native" by customer name, and truck 2217\'s driving hours', async () => {
  const NATIVE = { trip: { tripNumber: '625490', status: 'DEPSHIP', powerUnit: '2095', trailer: '2069', driver2: '6193' },
    freightBills: [{ billNumber: 'C1', billToName: 'NATIVE Detroit-WESTLAND', endZoneDescription: 'WESTLAND, MI, 48185', pieces: 28 }],
    _manifest: { stops: [{ action: 'DELIVER', customer: 'NATIVE Detroit-WESTLAND', city: 'WESTLAND', state: 'MI', stopNumber: 5 }] },
    _samsara: { location: 'I 44, Oklahoma City, OK', gpsAt: '2026-10-22T13:58:00Z', speedMph: 70, driver1: 'Juan Vanegas', driver2: 'Reynaldo Picado',
      hos: { status: 'driving', driveLeftMin: 312, shiftLeftMin: 400, cycleLeftMin: 2100, breakInMin: 95, at: '2026-10-22T13:55:00Z' }, hos2: { status: 'sleeperBed', driveLeftMin: 660, shiftLeftMin: 840, cycleLeftMin: 3000 } } };
  const TRUCK = { ...NATIVE, trip: { ...NATIVE.trip, tripNumber: '625308', powerUnit: '2217' } };
  const db = memDb(); const app = { get: () => {}, post: () => {} };
  await db.set('taWatch:florida-beauty', { alerts: {}, etas: { 625490: { stops: [{ label: 'WESTLAND, MI, 48185', zip: '48185', miles: 1123, etaMs: Date.parse('2026-10-23T16:07:00Z') }] } } });
  const chat = initJarvisChat(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [JSON.parse(JSON.stringify(LOAD)), NATIVE, TRUCK], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const ctx = { user: { id: 7, name: 'Rosa' }, did: [], proposed: [] };
  const r = await chat.runTool('customer_etas', { customer: 'native' }, ctx);
  assert.equal(r.found, true);
  const one = r.loads.find((x) => x.trip === '625490');
  assert.match(one.truck_now, /Oklahoma City/);
  assert.match(JSON.stringify(one.deliveries), /WESTLAND/i);
  assert.match(JSON.stringify(one.deliveries), /Oct 23/);
  assert.equal((await chat.runTool('customer_etas', { customer: 'Nobody Flowers' }, ctx)).found, false);
  const h = await chat.runTool('truck_hours', { truck: '2217' }, ctx);
  assert.equal(h.trip, '625308');
  assert.deepEqual(h.crew.map((c) => [c.driver, c.duty, c.driveLeft]), [['Juan Vanegas', 'driving', '5h 12m'], ['Reynaldo Picado', 'in the sleeper', '11h 0m']]);
  assert.equal(h.crew[0].cycleLeft70h, '35h 0m');
  assert.equal((await chat.runTool('truck_hours', { truck: '9999' }, ctx)).found, false);
  // the prompt sends business names to customer_etas, not the place search
  const { SYSTEM, TOOLS: T } = await import('../jarvischat.js');
  assert.match(SYSTEM('Rosa'), /customer_etas/); assert.match(SYSTEM('Rosa'), /truck_hours/);
  assert.match(T.find((t) => t.name === 'loads_to_place').description, /never a customer name/);
});

test('trip manifest by trip + stop number, and by date from ARTIS when the trip is off the board', async () => {
  const board = { trips: [{ ...JSON.parse(JSON.stringify(LOAD)), trip: { ...LOAD.trip, tripNumber: '625541' }, _manifest: { stops: [{ stopNumber: 8, action: 'DELIVER', customer: 'CARBONE R.J CO. CHELSEA', city: 'CHELSEA', state: 'MA' }] } }], unclosed: [] };
  const asked = [];
  const artisWeb = {
    clientIdFor: async ({ name }) => (/CARBONE/i.test(name) ? '04411' : /KUHN/i.test(name) ? '07777' : null),
    tripStatus: async (id, from, to) => { asked.push({ id, from, to }); return [{ trip: '624900', clientId: '07777', name: 'KUHN FLOWERS', city: 'JACKSONVILLE', delivered: true, boxes: 40 }]; },
    manifestDoc: async ({ item, clientId }) => ({ id: `d-${item.tripNumber || item.trip.tripNumber}-${clientId}`, name: `Trip-Manifest-Detail-${item.tripNumber || item.trip.tripNumber}-${clientId}.pdf` }),
  };
  const h = setup([useTool('trip_manifest', { trip: '625541', stop: 8 }), say('Attached.'), useTool('trip_manifest', { customer: 'Kuhn', date: '2026-10-20' }), say('Attached.')], { artisWeb, getBoard: async () => board });
  const r1 = await h.call('POST /jarvis/chat', { message: 'manifest for stop 8 on 625541' });
  assert.match(h.claude.sent[1].messages.at(-1).content[0].content, /Trip-Manifest-Detail-625541-04411/);
  assert.equal(r1.body.docs[0].id, 'd-625541-04411');
  await h.call('POST /jarvis/chat', { message: 'trip manifest for Kuhn on Oct 20' });
  assert.deepEqual(asked[0], { id: '07777', from: '2026-10-19', to: '2026-10-21' });
  assert.match(h.claude.sent[3].messages.at(-1).content[0].content, /624900.*fromArtisHistory/);
});

test('client lookup carries the customer\'s geofence; load details carry committed times, ARTIS ETA and geofence visits (staff only)', async () => {
  const clients = { byId: () => ({ id: '9273', name: 'WESTLAND FLORAL', serviceDays: ['MO'] }), byEmail: () => null, byPhone: () => null, byName: () => [], loads: () => [] };
  const geofences = { fences: async () => ({ '09273': { lat: 34.39, lng: -119.51, radiusM: 300, active: true } }) };
  const board = { trips: [{ ...JSON.parse(JSON.stringify(LOAD)), _commit: { 'CLIFTON|NJ': { local: '2026-10-24T06:00' } }, _artisEta: { at: 'x', stops: [{ name: 'MAIN WHOLESALE', etaText: '10/24 06:34 AM', miles: 120 }] } }], unclosed: [] };
  const h = setup([useTool('client_lookup', { query: '9273' }), say('ok'), useTool('load_details', { trip: '624399' }), say('ok')], { clients, geofences, getBoard: async () => board });
  await h.call('POST /jarvis/chat', { message: 'info for 9273' });
  assert.match(h.claude.sent[1].messages.at(-1).content[0].content, /"radiusM":300/);
  await h.db.set('taStopVisits:florida-beauty', { 624399: { a: { stopKey: 'a', geofence: { name: 'MAIN WHOLESALE', source: 'Customer geofence' }, state: 'departed', enteredAt: 1, exitedAt: 2, dwellMin: 40 } } });
  await h.call('POST /jarvis/chat', { message: 'details 624399' });
  const out = h.claude.sent[3].messages.at(-1).content[0].content;
  assert.match(out, /committedTimes/); assert.match(out, /10\/24 06:34 AM/); assert.match(out, /"minutesThere":40/);
});

test('Jarvis\'s voice: text → a natural OpenAI voice (mp3), only with a key; Spanish asks for Latin American Spanish', async () => {
  const routes = {}; const seen = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  const mk = (env) => { Object.keys(routes).forEach((k) => delete routes[k]); initJarvisChat(app, { requireAuth: (q, r, n) => n(), db: memDb(), getBoard: async () => ({ trips: [] }), env, fetchFn: async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } }); };
  const call = async (key, body) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; }, set(k, v) { out[k] = v; }, send(b) { out.sent = b; } }; await routes[key]({ body, user: { id: 7 } }, res); return out; };
  mk({});
  assert.equal((await call('GET /jarvis/voice', {})).json.tts, false);
  assert.equal((await call('POST /jarvis/speak', { text: 'hi' })).status, 503);
  mk({ OPENAI_API_KEY: 'sk-test' });
  assert.equal((await call('GET /jarvis/voice', {})).json.tts, true);
  const r = await call('POST /jarvis/speak', { text: 'Good afternoon, Nadim. Jarvis here — what can I do for you?', lang: 'en-US' });
  assert.equal(r['content-type'], 'audio/mpeg'); assert.equal(r.sent.length, 3);
  assert.match(seen[0].url, /audio\/speech/); assert.equal(seen[0].body.voice, 'onyx'); assert.match(seen[0].body.instructions, /calm, composed/);
  await call('POST /jarvis/speak', { text: 'Buenas tardes', lang: 'es-US' });
  assert.match(seen[1].body.instructions, /Latin American Spanish/);
  assert.equal((await call('POST /jarvis/speak', { text: '  ' })).status, 400);
});

test('Jarvis sees everything new (Nov 19): yard releases, closed loads and who closed them, entered time, the driver\'s "done" answer, the 24-h driving log', async () => {
  const { releaseRows, closedRows } = await import('../jarvischat.js');
  const NOW = Date.parse('2026-11-19T15:00:00Z');
  const REL = { trip: { tripNumber: '627164', powerUnit: '2019', trailer: '2022', status: 'SPTLD', destZoneDesc: 'PORT SAINT LUCIE, FL, 34987' }, freightBills: [{ billNumber: 'B180987', billToName: 'COSTCO' }],
    _yardRelease: { hub: 'MIAMI', yard: 'Miami', stage: 'at-yard', review: true, localDriver: 'JULIO GUTIERREZ', localTruck: '2019', appt: { date: '2026-11-19', time: '05:30', tz: 'America/New_York', raw: '5:30 AM' }, sourceStatus: 'A', sources: ['Miami yard sheet'] } };
  const [r] = releaseRows([REL, { trip: { tripNumber: '1' } }], {}, NOW);
  assert.deepEqual([r.trip, r.yard, r.stage, r.late, r.localDriver, r.customer, r.redelivery, r.needsCheck], ['627164', 'Miami', 'at the yard', true, 'JULIO GUTIERREZ', 'COSTCO', '2026-11-19 5:30 AM', true]);
  assert.equal(releaseRows([REL], { yard: 'bartow' }, NOW).length, 0);
  const delivered = { items: [
    { tripNumber: '625241', deliveredAt: '2026-11-19T14:00:00Z', reason: 'taken off the board (not delivered) by Ana — cancelled by the broker', billNumbers: ['B180538'] },
    { tripNumber: '627168', deliveredAt: '2026-11-19T13:00:00Z', reason: 'completed in TruckMate — at the last consignee (ARRCONS), left the last delivery — WEST PALM BEACH (GPS), no TruckMate change for 27h' },
    { tripNumber: '600000', deliveredAt: '2026-11-10T13:00:00Z' },
  ] };
  const rows = closedRows(delivered, { 625241: { by: 'Ana', removed: true } }, {}, NOW);
  assert.deepEqual(rows.map((x) => [x.trip, x.how, x.by]), [['625241', 'taken off the board — not delivered', 'Ana'], ['627168', 'closed from TruckMate', null]]);
  assert.equal(closedRows(delivered, {}, { trip: '600000' }, NOW)[0].how, 'closed from TruckMate');
  // through the tools
  const db = memDb();
  await db.set('taTruckMateDelivered:florida-beauty', delivered);
  await db.set('taDoneAsk:florida-beauty', { asks: { 627159: { askedAt: '2026-11-18T23:16:00Z', answer: { choice: 'no', text: 'still unloading', by: 'Carlos Rojas', at: '2026-11-18T23:30:00Z' } } } });
  const GUESS = { trip: { tripNumber: '627159', powerUnit: '4566', status: 'ARRCONS' }, freightBills: [], _finishGuess: 'left the last delivery — POMPANO BEACH (GPS)', _times: { createdAt: '2026-11-13T21:53:53.000Z', createdBy: 'BBARCELO' } };
  const app = { get: () => {}, post: () => {} };
  const chat = initJarvisChat(app, { requireAuth: (q, rs, n) => n(), db, getBoard: async () => ({ trips: [JSON.parse(JSON.stringify(REL)), JSON.parse(JSON.stringify(GUESS)), { trip: { tripNumber: '627494', powerUnit: null } }], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const c = { user: { id: 7, name: 'Rosa' }, did: [], proposed: [] };
  const yr = await chat.runTool('yard_releases', { yard: 'miami' }, c);
  assert.equal(yr.count, 1); assert.equal(yr.late, 1);
  const cl = await chat.runTool('closed_loads', { trip: '625241' }, c);
  assert.equal(cl.loads[0].how, 'taken off the board — not delivered');
  assert.match((await chat.runTool('closed_loads', { trip: '627159' }, c)).note, /still on the active board/);
  const sum = await chat.runTool('board_summary', {}, c);
  assert.deepEqual([sum.waitingForTruck, sum.atTheYards, sum.probablyFinished], [1, 1, 1]);
  const ld = await chat.runTool('load_details', { trip: '627159' }, c);
  assert.deepEqual(ld.enteredInTruckMate, { at: 'Fri, Nov 13, 4:53 PM ET', by: 'BBARCELO' });
  assert.equal(ld.finishCheck.driverAnswer.text, 'still unloading');
  assert.equal(ld.finishCheck.driverAnswer.by, 'Carlos Rojas');
  assert.equal((await chat.runTool('load_details', { trip: '627164' }, c)).yardRelease.localDriver, 'JULIO GUTIERREZ');
  assert.match((await chat.runTool('driving_log', { truck: '4566' }, c)).note, /Samsara isn't connected|No ELD driver/);
  // customers never get these
  const cust = { ...c, customer: { id: 'x' } };
  assert.equal((await chat.runTool('yard_releases', {}, cust)).error, 'Not available.');
});

test('Jarvis sees driver-app check-ins and the driver profiles / local fleet (staff only)', async () => {
  const { checkinRows, driverRows } = await import('../jarvischat.js');
  assert.deepEqual(checkinRows({ steps: { loaded: { at: '2026-11-18T14:00:00Z', by: 'Carlos' }, 'at-shipper': { at: '2026-11-18T12:00:00Z', by: 'Carlos' }, 'delivered:3.0|COSTCO|PORT SAINT LUCIE|FL': { at: '2026-11-19T15:00:00Z', by: 'Carlos' } } }).map((x) => x.step),
    ['At the shipper', 'Loaded & leaving', 'Delivered — 3.0|COSTCO|PORT SAINT LUCIE|FL']);
  const data = { profiles: { '0992': { name: 'Yordan Gonzalez', phones: [{ number: '(786) 474-0992', label: 'cell' }] }, 5937: { name: 'Yordanis Gonzalez', phones: [{ number: '(645) 200-3042' }] } },
    fleet: { '0992': { hub: 'MIAMI', name: 'Yordan Gonzalez' } }, samsara: { 5937: { name: 'Yordanis Gonzalez', phone: '+17864740992' } }, pins: { '0992': {} },
    items: [{ trip: { tripNumber: '627164', driver: '0992', powerUnit: '2019', status: 'SPTLD', destZoneDesc: 'PORT SAINT LUCIE, FL' } }] };
  const y = driverRows(data, 'yordan gonzalez');
  assert.equal(y.length, 1); assert.equal(y[0].localFleet, 'Miami yard'); assert.equal(y[0].onLoad.trip, '627164'); assert.equal(y[0].driverAppSignedIn, true);
  assert.deepEqual(driverRows(data, '786-474-0992').map((d) => d.code).sort(), ['0992', '5937']);   // that cell shows on both (Samsara has it on 5937)
  assert.deepEqual(driverRows(data, '5937')[0].phones.map((p) => p.number), ['(645) 200-3042', '+17864740992']);
  const db = memDb();
  await db.set('taDriverCheckins:florida-beauty', { 627164: { steps: { 'at-shipper': { at: '2026-11-18T12:00:00Z', by: 'Julio' } } } });
  await db.set('taDriverProfiles:florida-beauty', data.profiles); await db.set('taLocalFleet', data.fleet);
  const chat = initJarvisChat({ get: () => {}, post: () => {} }, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: JSON.parse(JSON.stringify(data.items)), unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const c = { user: { id: 7 }, did: [], proposed: [] };
  assert.equal((await chat.runTool('driver_checkins', { trip: '627164' }, c)).checkins[0].step, 'At the shipper');
  assert.match((await chat.runTool('driver_checkins', { trip: '1' }, c)).note, /hasn't checked in/);
  assert.equal((await chat.runTool('driver_profiles', { query: 'miami' }, c)).drivers[0].name, 'Yordan Gonzalez');
  assert.equal((await chat.runTool('load_details', { trip: '627164' }, c)).driverCheckins[0].by, 'Julio');
  assert.equal((await chat.runTool('driver_profiles', {}, { ...c, customer: { id: 'x' } })).error, 'Not available.');
});

test('voice picker: anyone hears a voice first; only an admin changes Jarvis\'s voice for everyone', async () => {
  const routes = {}; const seen = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  const db = memDb();
  initJarvisChat(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), env: { OPENAI_API_KEY: 'sk-test' }, fetchFn: async (url, opts) => { seen.push(JSON.parse(opts.body)); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer }; } });
  const call = async (key, body, user = { id: 7, name: 'Rosa' }) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; }, set() {}, send(b) { out.sent = b; } }; await routes[key]({ body, user }, res); return out; };
  const v = (await call('GET /jarvis/voice', {})).json;
  assert.equal(v.voice, 'onyx'); assert.equal(v.voices.length, 11); assert.equal(v.canChange, false);
  await call('POST /jarvis/speak', { text: 'Good afternoon, Rosa.', voice: 'fable' });
  assert.equal(seen[0].voice, 'fable');                                                       // a preview in another voice
  assert.equal((await call('PUT /jarvis/voice', { voice: 'ash' })).status, 403);              // a dispatcher can't change it
  const admin = { id: 1, name: 'nadim', admin: true };
  assert.equal((await call('PUT /jarvis/voice', { voice: 'robot' }, admin)).status, 400);
  assert.equal((await call('PUT /jarvis/voice', { voice: 'ash' }, admin)).json.voice, 'ash');
  const after = (await call('GET /jarvis/voice', {}, admin)).json;
  assert.deepEqual([after.voice, after.canChange, after.changedBy], ['ash', true, 'nadim']);
  await call('POST /jarvis/speak', { text: 'Hello.' });
  assert.equal(seen[1].voice, 'ash');                                                         // everyone hears the saved voice
});

test('Jarvis reads the whole Phone & Messages inbox and his own call transcripts (staff only)', async () => {
  const db = memDb();
  const now = Date.now(); const ago = (h) => new Date(now - h * 3600000).toISOString();
  await db.set('taMsgThreads:florida-beauty', {
    'p:7867945307': { id: 'p:7867945307', kind: 'person', name: 'Carlos Rojas', role: 'driver', trip: '627159', truck: '4566', last: { at: ago(2), text: 'still unloading' } },
    'g:abc': { id: 'g:abc', kind: 'group', name: 'Miami yard', members: [{ name: 'Gus', phone: '3055550111' }], last: { at: ago(5), text: 'costco moved to 9' } },
  });
  await db.set('taMsgLog:florida-beauty:p:7867945307', [{ at: ago(3), dir: 'out', by: 'Ana', text: 'Are you empty?' }, { at: ago(2), dir: 'in', text: 'still unloading' }]);
  await db.set('taMsgLog:florida-beauty:g:abc', [{ at: ago(5), dir: 'in', name: 'Gus', text: 'Costco moved to 9 AM tomorrow' }]);
  await db.set('taJarvisCalls:florida-beauty', [{ callId: 'c1', at: ago(1), direction: 'outbound', phone: '+17867945307', trip: '627159', minutes: 1.2, summary: 'Driver says 30 more minutes to unload.', transcript: 'Agent: Hi Carlos… User: thirty more minutes' }]);
  const chat = initJarvisChat({ get: () => {}, post: () => {} }, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const c = { user: { id: 7 }, did: [], proposed: [] };
  const carlos = await chat.runTool('text_messages', { who: 'carlos' }, c);
  assert.equal(carlos.conversations[0].with, 'Carlos Rojas');
  assert.deepEqual(carlos.conversations[0].messages.map((m) => [m.from, m.text]), [['Ana', 'Are you empty?'], ['Carlos Rojas', 'still unloading']]);
  assert.equal((await chat.runTool('text_messages', { who: '627159' }, c)).conversations[0].with, 'Carlos Rojas');   // by trip
  const words = await chat.runTool('text_messages', { words: 'costco' }, c);
  assert.equal(words.conversations[0].with, 'Miami yard'); assert.equal(words.conversations[0].messages[0].from, 'Gus');
  const calls = await chat.runTool('jarvis_calls', { query: '627159', full: true }, c);
  assert.equal(calls.calls[0].direction, 'Jarvis called'); assert.match(calls.calls[0].transcript, /thirty more minutes/);
  assert.equal((await chat.runTool('text_messages', {}, { ...c, customer: { id: 'x' } })).error, 'Not available.');
});

test('Ask Jarvis on the Dispatch desk: the open truck is "this truck"; desk notes and any truck from Samsara (Nov 22)', async () => {
  const idx = {
    fetchedAt: '2026-11-22T15:00:00Z', driversByCode: {}, reeferByKey: {},
    vehByUnit: { 2219: { name: '2219' } },
    statsByUnit: { 2219: { name: '2219', gps: { latitude: 30.28, longitude: -82.12, speedMilesPerHour: 77, reverseGeo: { formattedLocation: 'I 10, Baker County, FL' }, time: new Date().toISOString() } } },
    hosById: { d1: { vehicle: '2219', driverName: 'Jaime Rivera', status: 'sleeperBed', driveLeftMin: 0, shiftLeftMin: 0, cycleLeftMin: 1200 } },
  };
  const h = setup([useTool('truck_live', { truck: '2219' }), useTool('conversations', { trip: '624399' }), say('Truck 2219 is on I-10 in Baker County.')], { liveIndex: async () => idx });
  await h.db.set('taDeskNotes:florida-beauty', { 624399: [{ id: 'n1', at: '2026-11-22T14:00:00Z', by: 'Rosa', text: 'Relay planned in Jacksonville' }] });
  const r = await h.call('POST /jarvis/chat', { message: 'How far is this truck from Miami?', focus: { trip: '624399', truck: '724' } });
  assert.equal(r.status, 200);
  assert.match(JSON.stringify(h.claude.sent[0].messages.at(-1).content), /Dispatch desk with truck 724 \(trip 624399\) open/);
  const live = JSON.parse(h.claude.sent[1].messages.at(-1).content[0].content);
  assert.equal(live.found, true); assert.equal(live.truck, '2219'); assert.equal(live.latLng, '30.28,-82.12');
  assert.equal(live.loggedIn[0].name, 'Jaime Rivera');
  const conv = JSON.parse(h.claude.sent[2].messages.at(-1).content[0].content);
  assert.equal(conv.deskNotes[0].text, 'Relay planned in Jacksonville');
});

test('a driver by first name finds his load (Nov 22: "how far is ferney" was answered for the open truck)', () => {
  const items = [
    { trip: { tripNumber: '627572', powerUnit: '2219', status: 'DEPCONS', destZoneDesc: 'MIAMI, FL' }, _samsara: { driver1: 'Jaime Rivera', driver2: 'Jose Lanuza' } },
    { trip: { tripNumber: '627656', powerUnit: '4504', status: 'DEPSHIP', destZoneDesc: 'MELBOURNE, FL' }, _samsara: { driver1: 'Ferney Urrego', driver2: 'Wilber Echeverri' } },
  ];
  assert.deepEqual(loadsByDriver(items, 'ferney').map((x) => [x.trip, x.truck]), [['627656', '4504']]);
  assert.deepEqual(loadsByDriver(items, 'how far is Ferney from hes delivery').map((x) => x.trip), []);   // a sentence is not a name
  assert.deepEqual(loadsByDriver(items, 'Ferney Urrego').map((x) => x.trip), ['627656']);
  assert.deepEqual(loadsByDriver(items, 'jose').map((x) => x.truck), ['2219']);
});

test('a long load (66 bills) comes back one line per stop, delivered or not', () => {
  const bills = [
    ...Array.from({ length: 5 }, (_, i) => ({ billNumber: `C${i}`, billTo: 'HARRISON WHOLESALE', stop: 'ODESSA, TX, 79761', pieces: 2, deliveredAt: '2026-11-21T02:48:28' })),
    { billNumber: 'S1', billTo: 'LORISA, INC.', stop: 'MIAMI, FL, 33185', pieces: 1, deliveredAt: null },
  ];
  const g = billsByStop(bills);
  assert.equal(g.length, 2);
  assert.deepEqual(g.map((x) => [x.stop, x.bills, x.allDelivered]), [['ODESSA, TX, 79761', 5, true], ['MIAMI, FL, 33185', 1, false]]);
});

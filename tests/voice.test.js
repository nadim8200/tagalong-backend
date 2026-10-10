import test from 'node:test';
import assert from 'node:assert/strict';
import Retell from 'retell-sdk';
import { initVoice, findLoad, voiceFacts, PROMPT, staffGreeting } from '../voice.js';

const KEY = 'key_' + 'x'.repeat(30);
const board = [
  { trip: { tripNumber: '624393', status: 'DEPSHIP', powerUnit: '2607', trailer: '7131' }, _ratecon: { loadNumber: 'LD-425397', referenceNumbers: ['PU#5103730'] }, freightBills: [{ billNumber: 'B0180251', billToName: 'Native Chicago', endZoneDescription: 'LOMBARD, IL, 60148', actualDelivery: null }, { billNumber: 'B0180252', billToName: 'Gateway', endZoneDescription: 'EDWARDSVILLE, IL, 62025', actualDelivery: '2026-10-06T10:00:00' }], _samsara: { location: 'I 57, Effingham, IL', gpsAt: '2026-10-06T18:00:00Z', speedMph: 63, driver1Info: { name: 'Michel Gonzalez', phone: '(786) 439-4668' } }, _manifest: { stops: [{ customer: 'Native Chicago', references: ['M5038497: ELITE FLOWER SERVICE / SEAL#6641429'], callAhead: [{ contact: 'Dock', phone: '630-555-0101' }] }] } },
  { trip: { tripNumber: '624500', status: 'ASSGN', powerUnit: '2607', trailer: '7131' }, freightBills: [{ billNumber: 'B0190001', endZoneDescription: 'MIAMI, FL, 33178' }] },
  { trip: { tripNumber: '624297', status: 'DISP', powerUnit: '4504' }, freightBills: [{ billNumber: 'B0177001', endZoneDescription: 'LYONS, GA, 30436' }] },
];

function memDb() {
  const m = new Map();
  return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
}
function setup(extraEnv = {}, opts = {}) {
  const routes = {}; const logged = []; const checkins = []; const retellCalls = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = memDb();
  const fetchFn = async (url, opts) => {
    retellCalls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
    const drafted = retellCalls.some((c) => c.url.includes('/create-agent-version/'));
    const body = url.includes('create-retell-llm') ? { llm_id: 'llm_1', version: 0 }
      : url.includes('update-retell-llm') ? { llm_id: 'llm_1', version: 5 }
      : url.includes('/get-agent/') ? { agent_id: 'agent_1', version: 4, is_published: true, response_engine: { type: 'retell-llm', llm_id: 'llm_1', version: 4 } }
      : url.includes('/create-agent-version/') ? { agent_id: 'agent_1', version: 5, is_published: false, response_engine: { type: 'retell-llm', llm_id: 'llm_1', version: 5 } }
      : /\/update-agent\//.test(url) ? { agent_id: 'agent_1', version: drafted ? 5 : 4 }
      : url.includes('/create-agent') ? { agent_id: 'agent_1', version: 0 }
      : url.includes('create-phone-call') ? { call_id: 'call_9', call_status: 'registered' } : {};
    return { ok: true, status: 201, json: async () => body };
  };
  initVoice(app, { ...(opts.profiles ? { profiles: opts.profiles } : {}), ...(opts.clients ? { clients: opts.clients } : {}), ...(opts.directory ? { directory: opts.directory } : {}), requireAuth: (q, r, n) => n(), db, comms: { log: async (s, t, e) => logged.push({ trip: t, ...e }) }, carriers: { addCheckins: async (s, t, l) => checkins.push({ trip: t, ...l[0] }) }, getBoard: async () => ({ trips: board }), env: { RETELL_API_KEY: KEY, RETELL_FROM_NUMBER: '+13055550000', RETELL_TRANSFER_NUMBER: '305-503-1200', PUBLIC_URL: 'https://mytagalong.app', ...extraEnv }, fetchFn });
  const hit = async (route, body, { sign = true, user = { name: 'Ana' } } = {}) => {
    const raw = JSON.stringify(body);
    const sig = sign ? await Retell.sign(raw, KEY) : 'v=1,d=bad';
    let code = 200; let out;
    const res = { status(c) { code = c; return this; }, json(j) { out = j; }, end() {} };
    const req = { body, rawBody: raw, params: body.params || {}, user, get: (h) => (h === 'x-retell-signature' ? sig : undefined) };
    const hs = routes[route];
    let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); };
    await next();
    return { code, out };
  };
  return { hit, db, logged, checkins, retellCalls };
}

test('finds the load by trip, bill, truck, or the caller\'s phone (driver or contact)', () => {
  assert.equal(findLoad(board, { trip: '624393' }).by, 'trip number');
  assert.equal(findLoad(board, { bill: 'b0180251' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { truck: '4504' }).item.trip.tripNumber, '624297');
  // trailer, and truck/trailer on two loads → the one on the road
  assert.equal(findLoad(board, { trailer: '7131' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { trailer: 'trailer 7131' }).by, 'trailer number');
  assert.equal(findLoad(board, { truck: '2607' }).item.trip.tripNumber, '624393');
  // rate-con load #, PO on the trip sheet, partial bill number
  assert.equal(findLoad(board, { bill: 'LD-425397' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { bill: 'M5038497' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { bill: '0190001' }).item.trip.tripNumber, '624500');
  // broker load number, with or without the broker's letters
  assert.equal(findLoad(board, { loadNumber: 'LD-425397' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { bill: '425397' }).item.trip.tripNumber, '624393');
  assert.equal(findLoad(board, { phone: '+17864394668' }).role, 'driver');
  assert.equal(findLoad(board, { phone: '6305550101' }).role, 'contact');
  assert.equal(findLoad(board, { phone: '3055559999' }), null);
  const f = voiceFacts(board[0], { stops: [{ label: 'LOMBARD, IL, 60148', etaMs: Date.parse('2026-10-07T03:00:00Z'), miles: 212, apptMs: null }] });
  assert.equal(f.next_stop, 'Native Chicago, LOMBARD, IL');
  assert.match(f.estimated_arrival_next_stop, /Central \(local time\)$/);
  assert.deepEqual(f.stops_delivered, ['EDWARDSVILLE, IL']);
  assert.ok(!JSON.stringify(f).includes('4394668'), 'no driver phone in the facts');
  assert.match(PROMPT, /Never give out a driver's phone number/);
});

test('only Retell (valid signature) can use the tools', async () => {
  const v = setup();
  assert.equal((await v.hit('POST /retell/fn/lookup_load', { args: { trip_number: '624393' }, call: {} }, { sign: false })).code, 401);
  const ok = await v.hit('POST /retell/fn/lookup_load', { args: { trip_number: '624393' }, call: { call_id: 'c1', direction: 'inbound', from_number: '+13125550000' } });
  assert.equal(ok.out.found, true); assert.equal(ok.out.trip, '6 2 4 3 9 3');            // read digit by digit assert.equal(ok.out.stops_remaining, undefined);
});

test('driver confirms a delivery by phone; a stranger cannot', async () => {
  const v = setup();
  const no = await v.hit('POST /retell/fn/confirm_delivered', { args: { trip_number: '624393', stop: 'Native Chicago' }, call: { direction: 'inbound', from_number: '+13125550000' } });
  assert.equal(no.out.saved, false);
  const yes = await v.hit('POST /retell/fn/confirm_delivered', { args: { trip_number: '624393', stop: 'Native Chicago', pieces: '482' }, call: { direction: 'inbound', from_number: '+17864394668' } });
  assert.equal(yes.out.saved, true);
  assert.ok(Object.keys((await v.db.get('taStopConfirm:florida-beauty', {}))['624393'])[0].startsWith('voice:'));
  assert.match(v.checkins[0].text, /Delivered: Native Chicago · 482 boxes/);
});

test('problems and messages land on the load; the finished call (summary) too', async () => {
  const v = setup();
  await v.hit('POST /retell/fn/report_problem', { args: { problem_type: 'breakdown', details: 'Blown tire', location: 'I-57 mile 160' }, call: { call_id: 'c2', direction: 'inbound', from_number: '+17864394668' } });
  assert.equal(v.checkins[0].issue, true); assert.match(v.checkins[0].text, /^BREAKDOWN: Blown tire · at I-57 mile 160/);
  await v.hit('POST /retell/webhook', { event: 'call_analyzed', call: { call_id: 'c2', direction: 'inbound', from_number: '+17864394668', start_timestamp: 1, end_timestamp: 90001, transcript: 'Agent: hi\nUser: blown tire', call_analysis: { call_summary: 'Driver reported a blown tire on I-57.' } } });
  assert.equal(v.logged.at(-1).trip, '624393'); assert.equal(v.logged.at(-1).ai, true);
  assert.equal(v.logged.at(-1).text, 'Driver reported a blown tire on I-57.');
});

test('setup creates Jarvis in Retell (Claude, English + Spanish + Hebrew, our tools, webhook)', async () => {
  const v = setup();
  const r = await v.hit('POST /voice/setup', {});
  assert.deepEqual(r.out && { llm: r.out.llmId, agent: r.out.agentId }, { llm: 'llm_1', agent: 'agent_1' });
  const llm = v.retellCalls.find((c) => c.url.endsWith('/create-retell-llm')).body;
  assert.match(llm.model, /^claude/);
  assert.deepEqual(llm.general_tools.map((t) => t.name), ['lookup_load', 'take_message', 'staff_directory', 'confirm_delivered', 'report_problem', 'end_call', 'transfer_to_dispatch']);
  assert.equal(llm.general_tools[0].url, 'https://tagalong-backend-fdzx.onrender.com/retell/fn/lookup_load');
  const agent = v.retellCalls.find((c) => c.url.endsWith('/create-agent')).body;
  assert.deepEqual(agent.language, ['en-US', 'es-419', 'he-IL']);
  assert.match(llm.general_prompt, /English, Spanish or Hebrew/);
  assert.equal(llm.default_dynamic_variables.greeting, "Hi, this is Jarvis, Florida Beauty Flora's assistant. This call may be recorded. How can I help you?");
  assert.equal(agent.webhook_url, 'https://tagalong-backend-fdzx.onrender.com/retell/webhook');
  assert.equal(agent.stt_mode, 'accurate'); assert.ok(agent.boosted_keywords.includes('Florida Beauty Flora'));
  assert.equal(v.retellCalls[0].auth, `Bearer ${KEY}`);
  // the agent runs the exact new LLM version, that version is published, the number answers with it
  assert.deepEqual(agent.response_engine, { type: 'retell-llm', llm_id: 'llm_1', version: 0 });
  assert.deepEqual(v.retellCalls.find((c) => c.url.includes('/publish-agent-version/agent_1')).body.version, 0);
  const num = v.retellCalls.find((c) => c.url.includes('/update-phone-number/'));
  assert.ok(num.url.endsWith('%2B13055550000'));
  assert.deepEqual(num.body.inbound_agents, [{ agent_id: 'agent_1', agent_version: 'latest_published', weight: 1 }]);
  assert.equal(r.out.published, 0);
  // second update: same agent/LLM, voice picked in Retell is kept
  await v.hit('POST /voice/setup', {});
  const upd = v.retellCalls.filter((c) => c.url.includes('/update-agent/agent_1')).at(-1);
  assert.equal(upd.method, 'PATCH'); assert.equal(upd.body.voice_id, undefined);
  // published → a new draft from it (base 4), fresh instructions, then publish the new version 5
  assert.deepEqual(v.retellCalls.find((c) => c.url.includes('/create-agent-version/agent_1')).body, { base_version: 4 });
  assert.equal(upd.body.response_engine, undefined, 'agent keeps its own matching instruction version');
  const llmEdit = v.retellCalls.find((c) => c.url.includes('update-retell-llm'));
  assert.ok(llmEdit.url.endsWith('/update-retell-llm/llm_1?version=5'), 'edits the DRAFT copy (v5), never the published v4');
  assert.equal(v.retellCalls.filter((c) => c.url.includes('/publish-agent-version/')).at(-1).body.version, 5);
});

test('Jarvis calls a driver only with consent, never after STOP, not twice in 30 min', async () => {
  const v = setup();
  await v.db.set('taRetellCfg', { agentId: 'agent_1', llmId: 'llm_1' });
  const call = () => v.hit('POST /truckmate/trips/:trip/ai-call', { params: { trip: '624393' }, purpose: 'confirm-stop' });
  assert.equal((await call()).out.needConsent, true);
  await v.db.set('taSmsConsent:florida-beauty', { 7864394668: { by: 'Ana', at: '2026-10-06T12:00:00Z' } });
  await v.db.set('taSmsOptOut', { 7864394668: { at: '2026-10-06T13:00:00Z' } });
  assert.match((await call()).out.error, /replied STOP/);
  await v.db.set('taSmsOptOut', {});
  const ok = await call();
  assert.equal(ok.out.ok, true);
  const body = v.retellCalls.at(-1).body;
  assert.equal(body.to_number, '+17864394668'); assert.equal(body.override_agent_id, 'agent_1');
  assert.match(body.retell_llm_dynamic_variables.call_context, /confirm whether Native Chicago, LOMBARD, IL was delivered/);
  assert.equal((await call()).code, 429);
});

import { customerStops, nameScore } from '../voice.js';
test('flower customers by name: their own stop only — boxes, cubes, stop number, ETA', () => {
  assert.equal(nameScore("Johnson's Wholesale Florist", "JOHNSON'S WHOLESALE FLORIST LLC"), 1);
  assert.ok(nameScore('Springfield Florist', 'SPRINGFIELD FLORIST') === 1);
  assert.ok(nameScore('Springfield Florist', 'FALL RIVER FLORIST SUPPLY') < 0.75);
  const items = [{ trip: { tripNumber: '624297', powerUnit: '4504', status: 'DEPSHIP' },
    freightBills: [{ billNumber: 'B1', endZoneDescription: 'SPRINGFIELD, MA, 01104', actualDelivery: null }, { billNumber: 'B2', endZoneDescription: 'LYONS, GA, 30436', actualDelivery: '2026-10-05T10:00:00' }],
    _manifest: { stops: [
      { stopNumber: 2, action: 'DELIVER', customer: "JOHNSON'S WHOLESALE FLORIST LLC", city: 'LYONS', state: 'GA', pieces: 72, cubes: 107.09 },
      { stopNumber: 6, action: 'DELIVER', customer: 'SPRINGFIELD FLORIST', city: 'SPRINGFIELD', state: 'MA', zip: '01104', pieces: 139, piecesText: '139 BOXES', cubes: 187.71 },
      { stopNumber: 7, action: 'DELIVER', customer: 'BIG Y APPOINTMENT', city: 'SPRINGFIELD', state: 'MA', pieces: 87, cubes: 93.87 },
    ] } }];
  const etas = { 624297: { stops: [{ label: 'SPRINGFIELD, MA, 01104', zip: '01104', etaMs: Date.parse('2026-10-07T14:00:00Z'), miles: 300 }] } };
  const r = customerStops(items, 'Springfield Florist', etas);
  assert.equal(r.length, 1);
  assert.deepEqual({ trip: r[0].trip, truck: r[0].truck, stop: r[0].stop, boxes: r[0].boxes, cubes: r[0].cubes, delivered: r[0].delivered }, { trip: '624297', truck: '4504', stop: undefined, boxes: '139 BOXES', cubes: 187.71, delivered: false });
  assert.match(r[0].estimated_arrival, /Eastern$/);
  const j = customerStops(items, "Johnson's Wholesale", etas)[0];
  assert.equal(j.delivered, true); assert.equal(j.boxes, '72 boxes'); assert.equal(j.estimated_arrival, null);
  assert.ok(!JSON.stringify(r).includes('BIG Y'), 'never other customers');
});

test('a business name in the wrong box still searches trip-sheet customers', async () => {
  const items = [{ trip: { tripNumber: '624297', powerUnit: '4504', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'SPRINGFIELD, MA, 01104' }], _manifest: { stops: [{ stopNumber: 6, action: 'DELIVER', customer: 'SPRINGFIELD FLORIST', city: 'SPRINGFIELD', state: 'MA', pieces: 139, cubes: 187.71 }] } }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const m = new Map();
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY } });
  const body = { args: { bill_number: 'Springfield Florist' }, call: { direction: 'inbound', from_number: '+14135550000' } };
  const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
  let out; const res = { status() { return this; }, json(j) { out = j; } };
  const req = { body, rawBody: raw, get: () => sig };
  const [guard, handler] = routes['POST /retell/fn/lookup_load'];
  await guard(req, res, () => handler(req, res));
  assert.equal(out.found, true); assert.equal(out.matched_by, 'customer name');
  assert.equal(out.loads[0].deliveries[0].boxes, '139 boxes'); assert.equal(out.loads[0].deliveries[0].cubes, 187.71);
});

test('a customer name together with a trip number answers for THAT customer stop, not the whole load', async () => {
  const items = [{ trip: { tripNumber: '624399', powerUnit: '724', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'GWYNN OAK, MD, 21207' }, { billNumber: 'M2', endZoneDescription: 'MERCHANTVILLE, NJ, 08109' }], _manifest: { stops: [{ stopNumber: 2, action: 'DELIVER', customer: 'DBG - BALTIMORE', city: 'WOODLAWN', state: 'MD', tmPlace: 'GWYNN OAK, MD' }, { stopNumber: 3, action: 'DELIVER', customer: 'MAIN WHOLESALE FLORIST PENNSAUKEN LLC.', city: 'PENNSAUKEN', state: 'NJ', tmPlace: 'MERCHANTVILLE, NJ', pieces: 135, cubes: 168.85 }] } }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY } });
  const body = { args: { trip_number: '624399', customer_name: 'Main Wholesale' }, call: { direction: 'inbound', from_number: '+18565550000' } };
  const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
  let out; const res = { status() { return this; }, json(j) { out = j; } };
  const req = { body, rawBody: raw, get: () => sig };
  const [guard, handler] = routes['POST /retell/fn/lookup_load'];
  await guard(req, res, () => handler(req, res));
  assert.equal(out.found, true); assert.equal(out.matched_by, 'trip number + customer name');
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].customer, 'MAIN WHOLESALE FLORIST PENNSAUKEN LLC.');
  assert.equal(out.deliveries[0].boxes, '135 boxes');
});

test('no ETA → Jarvis is told not to guess one', () => {
  const items = [{ trip: { tripNumber: '624481', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'CHELSEA, MA, 02150' }], _manifest: { stops: [{ stopNumber: 6, action: 'DELIVER', customer: 'CHELSEA MARKET - RICCARDI WHOLESALE', city: 'CHELSEA', state: 'MA', pieces: 10 }] } }];
  const r = customerStops(items, 'Riccardi', {})[0];
  assert.equal(r.estimated_arrival, null);
  assert.match(r.eta_note, /do NOT estimate or guess/);
});

// A customer calling about trailer 2029 (trip 624481, 8 deliveries) hears where the truck is and THEIR stop — nothing else.
test('customers never hear the other stops; the name said earlier in the call picks their stop', async () => {
  const items = [{ trip: { tripNumber: '624481', powerUnit: '2618', trailer: '2029', status: 'DEPSHIP' },
    freightBills: [{ billNumber: 'M1', billToName: 'ALCOCK WHOLESALE FLOWERS', endZoneDescription: 'KINSTON, NC, 28501' }, { billNumber: 'M2', billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453' }],
    _manifest: { stops: [{ stopNumber: 2, action: 'DELIVER', customer: 'ALCOCK WHOLESALE FLOWERS', city: 'KINSTON', state: 'NC' }, { stopNumber: 9, action: 'DELIVER', customer: 'BOKHARY FARMS LLC *', city: 'WALTHAM', state: 'MA', piecesText: '4 PALLETS', cubes: 400 }] },
    _samsara: { location: '3315 NW 70th Ave, Miami, FL, 33122', gpsAt: '2026-10-07T02:33:12Z', speedMph: 0 } }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY } });
  const ask = async (args) => {
    const body = { args, call: { call_id: 'bk1', direction: 'inbound', from_number: '+17815550000' } };
    const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
    let out; const res = { status() { return this; }, json(j) { out = j; } };
    const [guard, handler] = routes['POST /retell/fn/lookup_load'];
    await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
    return out;
  };
  const byName = await ask({ customer_name: 'Bokori Farms' });              // misheard "Bokhary"
  assert.equal(byName.found, true);
  assert.equal(byName.loads[0].deliveries[0].customer, 'BOKHARY FARMS LLC *');
  assert.equal(byName.speaking_with, 'Bokhary Farms');                     // the real name, not the misheard one
  assert.match(byName.say, /anything else I can help you with.*feel free to hang up/);
  const byTrailer = await ask({ trailer_number: '2029' });                 // same call, now by trailer
  const text = JSON.stringify(byTrailer);
  assert.ok(!/KINSTON|ALCOCK|next_stop|stops_remaining/.test(text), text);
  assert.equal(byTrailer.deliveries[0].city, 'WALTHAM, MA');
  assert.match(byTrailer.truck_now, /Miami/);
  assert.match(byTrailer.say, /Never mention other stops/);
});

import { spokenName, customerKeywords, nameCandidates } from '../voice.js';
test('customer names the way people say them, fed to the transcriber', () => {
  assert.equal(spokenName('CHELSEA MARKET - RICCARDI WHOLESALE'), 'Riccardi Wholesale');
  assert.equal(spokenName('BOKHARY FARMS LLC *'), 'Bokhary Farms');
  assert.equal(spokenName('JEWETT CITY C/O CARBONE CRANSTON'), 'Jewett City');
  assert.equal(spokenName('CARBONE -DERRY BILLING'), 'Carbone Derry');
  const items = [{ trip: { tripNumber: '1' }, freightBills: [{ billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453' }, { billToName: 'RICCARDI WHOLESALE', endZoneDescription: 'CHELSEA, MA, 02150' }, { billToName: 'RICCARDI WHOLESALE', endZoneDescription: 'CHELSEA, MA, 02150' }] }];
  const k = customerKeywords(items);
  assert.ok(k.includes('Bokhary Farms') && k.includes('Riccardi Wholesale') && k.includes('Waltham'));
  // misheard name + their town → offer the real names in THAT town only
  assert.deepEqual(nameCandidates(items, 'Bokori Farm', 'Waltham'), ['Bokhary Farms']);
  assert.deepEqual(nameCandidates(items, 'Bokori Farm', ''), []);                  // no town → no list read out
  assert.ok(!nameCandidates(items, 'Ricardo', 'Chelsea').includes('Bokhary Farms'));
});

test('a caller who found their stop before is recognized by phone next time', async () => {
  const items = [{ trip: { tripNumber: '624481', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M2', billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453' }], _manifest: { stops: [{ stopNumber: 9, action: 'DELIVER', customer: 'BOKHARY FARMS LLC *', city: 'WALTHAM', state: 'MA' }] } }];
  const routes = {}; const m = new Map();
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const ask = async (args, id) => {
    const body = { args, call: { call_id: id, direction: 'inbound', from_number: '+17815550123' } };
    const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
    let out; const res = { status() { return this; }, json(j) { out = j; } };
    const [guard, handler] = routes['POST /retell/fn/lookup_load'];
    await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
    return out;
  };
  assert.equal((await ask({ customer_name: 'Bokhary Farms' }, 'a')).found, true);
  const again = await ask({}, 'b');                                                // next call, says nothing yet
  assert.equal(again.found, true); assert.match(again.confirm, /Is this Bokhary Farms\?/);
  assert.equal(again.loads[0].deliveries[0].city, 'WALTHAM, MA');
});

import { digitByDigit } from '../voice.js';
test('truck, trailer, trip and bill numbers are spoken digit by digit', () => {
  assert.equal(digitByDigit('2026'), '2 0 2 6');
  assert.equal(digitByDigit(2029), '2 0 2 9');
  assert.equal(digitByDigit('M5038379'), 'M 5 0 3 8 3 7 9');
  assert.match(PROMPT, /one digit at a time/);
});

import { ETA_DISCLAIMER, CUSTOMER_RULE } from '../voice.js';
test('every customer ETA ends with the estimated-time disclaimer', () => {
  assert.match(ETA_DISCLAIMER, /estimated time of arrival.*may change.*keep you updated/);
  assert.ok(PROMPT.includes(ETA_DISCLAIMER) && CUSTOMER_RULE.includes(ETA_DISCLAIMER));
});

import { brokerView } from '../voice.js';
test('brokers get their whole load by load number or company name — not "which business is yours"', async () => {
  const items = [{ trip: { tripNumber: '623869', powerUnit: '2008', trailer: '7141', status: 'DEPSHIP', origZoneDesc: 'WEST PALM BEACH, FL, 33404' },
    freightBills: [{ billNumber: 'B180400', endZoneDescription: 'BLOOMFIELD, CT, 06002' }, { billNumber: 'B180401', endZoneDescription: 'HARTFORD, CT, 06101' }],
    _ratecon: { data: { broker: 'RXO Capacity Solutions', loadNumber: 'RXO 24261611', deliveries: [{ name: 'ACME DC', city: 'Bloomfield', state: 'CT', date: '10/08', time: '06:00' }, { name: 'BETA', city: 'Hartford', state: 'CT' }] } },
    _samsara: { location: 'New Jersey Turnpike, East Windsor Township, NJ, 08520', gpsAt: '2026-10-07T12:00:00Z', speedMph: 64 } }];
  const v = brokerView(items[0], { stops: [{ label: 'BLOOMFIELD, CT, 06002', etaMs: Date.parse('2026-10-07T17:00:00Z') }, { label: 'HARTFORD, CT, 06101', etaMs: Date.parse('2026-10-07T18:00:00Z') }] });
  assert.equal(v.pickup, 'West Palm Beach, Florida'); assert.equal(v.deliveries.length, 2);
  assert.match(v.deliveries[0].estimated_arrival, /Eastern$/); assert.equal(v.deliveries[0].appointment, '10/08 06:00');
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const ask = async (args, id) => {
    const body = { args, call: { call_id: id, direction: 'inbound', from_number: '+16305550100' } };
    const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
    let out; const res = { status() { return this; }, json(j) { out = j; } };
    const [guard, handler] = routes['POST /retell/fn/lookup_load'];
    await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
    return out;
  };
  const byLoad = await ask({ broker_load_number: '24261611' }, 'r1');
  assert.equal(byLoad.found, true); assert.equal(byLoad.deliveries.length, 2); assert.equal(byLoad.speaking_with, 'RXO Capacity Solutions');
  assert.match(byLoad.say, /broker on this load/); assert.equal(byLoad.ask, undefined);
  const byName = await ask({ customer_name: 'RXO' }, 'r2');
  assert.equal(byName.matched_by, 'broker name'); assert.equal(byName.truck, '2 0 0 8');
  const byTrailer = await ask({ trailer_number: '7141' }, 'r3');                 // trailer alone: not the full broker view
  assert.equal(byTrailer.deliveries, undefined); assert.match(byTrailer.ask, /several deliveries/);
  assert.equal(byTrailer.coming_from, 'West Palm Beach, Florida');
});

import { originOf, customerView } from '../voice.js';
test('customers hear whether their truck left from Ventura, California or Miami, Florida', () => {
  assert.equal(originOf({ trip: { origZoneDesc: 'VENTURA TERMINAL' } }), 'Ventura, California');
  assert.equal(originOf({ trip: { origZoneDesc: 'MIAMI TERMINAL' } }), 'Miami, Florida');
  assert.equal(originOf({ trip: { origZoneDesc: 'YARD' }, _ratecon: { data: { pickups: [{ city: 'VENTURA', state: 'CA' }] } } }), 'Ventura, California');   // live load per the rate con
  assert.equal(originOf({ trip: { origZoneDesc: 'YARD' } }), null);                              // unknown → say nothing, never "Miami"
  const v = customerView({ trip: { tripNumber: '1', status: 'ARRSHIP', origZoneDesc: 'VENTURA TERMINAL' }, freightBills: [{ endZoneDescription: 'DENVER, CO, 80216' }] }, null);
  assert.equal(v.coming_from, 'Ventura, California'); assert.equal(v.status, 'being loaded in Ventura, California');
});

import { fmtLocal, fmtLocalShort, tzOf } from '../localtime.js';
test('ETAs in the delivery\'s local time: 4:00 AM in Miami is 1:00 AM in California', async () => {
  const t = Date.parse('2026-10-08T08:00:00Z');                                 // 4:00 AM Eastern
  assert.equal(fmtLocal(t, 'VENTURA, CA, 93003'), 'Thu, Oct 8, 1:00 AM Pacific (local time)');
  assert.equal(fmtLocal(t, 'DALLAS, TX, 75201'), 'Thu, Oct 8, 3:00 AM Central (local time)');
  assert.equal(fmtLocal(t, 'MIAMI, FL, 33122'), 'Thu, Oct 8, 4:00 AM Eastern');
  assert.equal(fmtLocalShort(t, 'LOMBARD, IL, 60148'), 'Oct 8, 4:00 AM ET (3:00 AM CT local)');
  assert.equal(tzOf('Oxnard, California'), 'America/Los_Angeles');
  // a California customer calling Jarvis hears their own clock
  const items = [{ trip: { tripNumber: '624426', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M1', endZoneDescription: 'CARPINTERIA, CA, 93013' }], _manifest: { stops: [{ stopNumber: 2, action: 'DELIVER', customer: 'WESTERLAY ORCHIDS', city: 'CARPINTERIA', state: 'CA' }] } }];
  const r = customerStops(items, 'Westerlay Orchids', { 624426: { stops: [{ label: 'CARPINTERIA, CA, 93013', zip: '93013', etaMs: t }] } });
  assert.equal(r[0].estimated_arrival, 'Thu, Oct 8, 1:00 AM Pacific (local time)');
  assert.match(PROMPT, /delivery's LOCAL time, so always say the time zone/);
});

test('a caller leaves a message with Jarvis → a callback request goes to the right people', async () => {
  const raised = [];
  const items = [{ trip: { tripNumber: '624481', powerUnit: '2606', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M2', billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453' }] }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: items }), help: { raise: async (r) => { raised.push(r); return r; } }, env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const body = { args: { message: 'Bokhary Farms wants to know if the truck can come before 6 AM', caller_name: 'Sam at Bokhary Farms', callback_number: '781-555-0123', trip_number: '624481' }, call: { call_id: 'c77', direction: 'inbound', from_number: '+17815550123' } };
  const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
  let out; const res = { status() { return this; }, json(j) { out = j; } };
  const [guard, handler] = routes['POST /retell/fn/take_message'];
  await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
  assert.equal(out.saved, true);
  assert.deepEqual({ source: raised[0].source, role: raised[0].role, trip: raised[0].trip, name: raised[0].from.name, phone: raised[0].from.phone }, { source: 'call', role: 'customer', trip: '624481', name: 'Sam at Bokhary Farms', phone: '781-555-0123' });
});

test('authorized numbers only: an unknown phone asking about a customer gets no details — offered a callback', async () => {
  const items = [{ trip: { tripNumber: '624481', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'M2', billToName: 'BOKHARY FARMS LLC *', endZoneDescription: 'WALTHAM, MA, 02453' }], _manifest: { stops: [{ stopNumber: 9, action: 'DELIVER', customer: 'BOKHARY FARMS LLC *', city: 'WALTHAM', state: 'MA' }] } }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  const profiles = { allowed: async ({ phone }) => ({ ok: String(phone).endsWith('5550123') }), anyLoad: async () => false };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, profiles, getBoard: async () => ({ trips: items }), env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const ask = async (from) => {
    const body = { args: { customer_name: 'Bokhary Farms' }, call: { call_id: `c${from}`, direction: 'inbound', from_number: from } };
    const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
    let out; const res = { status() { return this; }, json(j) { out = j; } };
    const [guard, handler] = routes['POST /retell/fn/lookup_load'];
    await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
    return out;
  };
  const stranger = await ask('+17865550000');
  assert.equal(stranger.found, false); assert.equal(stranger.private, true); assert.match(stranger.say, /only go to the phone numbers they authorized/);
  assert.equal(JSON.stringify(stranger).includes('WALTHAM'), false, 'nothing about the load');
  const owner = await ask('+17815550123');
  assert.equal(owner.found, true);
});

import { transcriptEmail } from '../voice.js';
test('every Jarvis call can be emailed with the whole conversation', () => {
  const call = { call_id: 'c1', direction: 'inbound', from_number: '+17815550123', start_timestamp: Date.parse('2026-10-08T14:05:00Z'), recording_url: 'https://example.com/rec.wav', disconnection_reason: 'user_hangup',
    call_analysis: { call_summary: 'Bokhary Farms asked for the ETA on load 624481.' },
    transcript: 'Agent: Hi, this is Jarvis, Florida Beauty Flora\'s assistant.\nUser: Hi, this is Sam from Bokhary Farms, where is my truck?\nAgent: Your delivery is expected Thu, Oct 8, 9:00 AM Eastern.' };
  const m = transcriptEmail(call, { trip: '624481', callerName: 'Bokhary Farms', minutes: 2.4 });
  assert.equal(m.subject, 'Jarvis call — from Bokhary Farms (781) 555-0123 · load 624481 · 2.4 min');
  assert.match(m.html, /<b style="color:#2563eb">Jarvis:<\/b> Hi, this is Jarvis/);
  assert.match(m.html, /<b style="color:#0f172a">Caller:<\/b> Hi, this is Sam from Bokhary Farms/);
  assert.match(m.html, /Summary:<\/b> Bokhary Farms asked for the ETA/); assert.match(m.html, /Listen to the recording/); assert.match(m.html, /ended: user hangup/);
});

test('when a call ends, the transcript is emailed once to the addresses set in Calls, texts & email', async () => {
  const m = new Map([['taJarvisTranscriptCfg', { to: ['nadim8200@outlook.com', 'dispatch@floridabeauty.us'], which: 'all' }]]);
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  const sent = [];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), mail: { ready: () => true, send: async (x) => sent.push(x) }, env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const fire = async (event) => {
    const body = { event, call: { call_id: 'cx1', direction: 'inbound', from_number: '+17815550123', start_timestamp: 1, end_timestamp: 61000, transcript: 'Agent: Hi, this is Jarvis.\nUser: Where is my truck?', call_analysis: { call_summary: 'Caller asked for an ETA.' } } };
    const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
    const res = { status() { return this; }, end() {}, json() {} };
    const [guard, handler] = routes['POST /retell/webhook'];
    await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
  };
  await fire('call_ended');
  assert.equal(sent.length, 0, 'waits for the summary');
  await fire('call_analyzed');
  await fire('call_analyzed');
  assert.equal(sent.length, 1, 'once per call');
  assert.deepEqual(sent[0].to, ['nadim8200@outlook.com', 'dispatch@floridabeauty.us']);
  assert.match(sent[0].subject, /^Jarvis call — from \(781\) 555-0123 · 1 min$/);
  assert.match(sent[0].html, /Where is my truck\?/);
});

test('every Jarvis call lands in the Calls & texts log with both numbers and the transcript', async () => {
  const recorded = [];
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, put: () => {} };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), activity: { record: async (e) => { recorded.push(e); return e; } }, env: { RETELL_API_KEY: KEY, RETELL_AUTO_KEYWORDS: 'off' } });
  const body = { event: 'call_analyzed', call: { call_id: 'cz', direction: 'inbound', from_number: '+17815550123', to_number: '+17862040122', start_timestamp: Date.parse('2026-10-08T14:05:00Z'), end_timestamp: Date.parse('2026-10-08T14:07:00Z'), transcript: 'Agent: Hi\nUser: Where is my truck?', recording_url: 'https://x/r.wav', call_analysis: { call_summary: 'ETA question' } } };
  const raw = JSON.stringify(body); const sig = await Retell.sign(raw, KEY);
  const res = { status() { return this; }, end() {}, json() {} };
  const [guard, handler] = routes['POST /retell/webhook'];
  await guard({ body, rawBody: raw, get: () => sig }, res, () => handler({ body, rawBody: raw, get: () => sig }, res));
  assert.deepEqual({ id: recorded[0].id, from: recorded[0].from, to: recorded[0].to, ourLine: recorded[0].ourLine, minutes: recorded[0].minutes, recording: recorded[0].recording }, { id: 'call:cz', from: '+17815550123', to: '+17862040122', ourLine: '+17862040122', minutes: 2, recording: 'https://x/r.wav' });
  assert.match(recorded[0].transcript, /Where is my truck\?/);
});

test('names: "Calvert Wholesale" never matches "United Wholesale Flowers" just because both say Wholesale', () => {
  assert.equal(nameScore('Calvert Wholesale', 'UNITED WHOLESALE FLOWERS MIDDLETOWN NJ'), 0);
  assert.equal(nameScore('Calvert Wholesale', 'CALVERTS WHOLESALE'), 1);
  assert.ok(nameScore('Springfield Florist', 'BIG Y APPOINTMENT SPRINGFIELD') < 0.75);
  const items = [{ trip: { tripNumber: '1' }, freightBills: [{ billToName: 'UNITED WHOLESALE FLOWERS', endZoneDescription: 'MIDDLETOWN, NJ, 07748' }, { billToName: 'CALVERTS WHOLESALE', endZoneDescription: 'MIDDLETOWN, NJ, 07748' }] }];
  assert.deepEqual(nameCandidates(items, 'Calvert Wholesale', 'Middletown')[0], 'Calverts Wholesale', 'the closest name first, not the one sharing "Wholesale"');
});

import { joinSpelled } from '../voice.js';

test('the "DBEC Wholesale" call: spelled letters kept, "Wholesale" alone matches nobody, another customer is never shared', async () => {
  // only Riccardi Wholesale delivers in Greensburg, PA
  const ric = { trip: { tripNumber: '624800', status: 'DEPSHIP', powerUnit: '2700', origZoneDesc: 'VENTURA, CA' }, freightBills: [{ billNumber: 'B0200001', billToName: 'CHELSEA MARKET - RICCARDI WHOLESALE', endZoneDescription: 'GREENSBURG, PA, 15601', pieces: 8 }] };
  board.push(ric);
  try {
    assert.equal(joinSpelled('D B E C Wholesale'), 'DBEC WHOLESALE');
    assert.equal(joinSpelled('DBE C Wholesale'), 'DBEC WHOLESALE');
    assert.equal(nameScore('D B E C Wholesale', 'RICCARDI WHOLESALE'), 0);
    assert.equal(nameScore('Wholesale', 'RICCARDI WHOLESALE'), 0);
    assert.equal(nameScore('D B E C Wholesale', 'DBEC WHOLESALE INC'), 1);
    assert.deepEqual(nameCandidates(board, 'DBE C Wholesale', 'Greensburg'), [], 'no suggestion that sounds nothing like it');
    const v = setup();
    const call = { call_id: 'c77', direction: 'inbound', from_number: '+17245550100' };
    for (const args of [{ customer_name: 'DBE C Wholesale' }, { customer_name: 'DBE C Wholesale', customer_city: 'Greensburg' }, { customer_name: 'D B E C Wholesale', customer_city: 'Greensburg, Pennsylvania' }]) {
      const r = await v.hit('POST /retell/fn/lookup_load', { args, call });
      assert.equal(r.out.found, false, JSON.stringify(args));
      assert.ok(!JSON.stringify(r.out).includes('RICCARDI') && !JSON.stringify(r.out).includes('Riccardi'), 'nothing about another customer');
    }
  } finally { board.pop(); }
});

test('a name Jarvis suggested (did_you_mean) needs the caller\'s yes before anything is shared', async () => {
  const ric = { trip: { tripNumber: '624801', status: 'DEPSHIP', powerUnit: '2701' }, freightBills: [{ billNumber: 'B0200002', billToName: 'RICCARDI WHOLESALE', endZoneDescription: 'GREENSBURG, PA, 15601', pieces: 8 }] };
  board.push(ric);
  try {
    const v = setup();
    const call = { call_id: 'c78', direction: 'inbound', from_number: '+17245550101' };
    const first = await v.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ricardo Wholesale', customer_city: 'Greensburg' }, call });
    assert.equal(first.out.found, true, 'close enough to match directly');
    const v2 = setup();
    const call2 = { call_id: 'c79', direction: 'inbound', from_number: '+17245550102' };
    const miss = await v2.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Rikkard Produce', customer_city: 'Greensburg' }, call: call2 });
    assert.equal(miss.out.found, false);
    assert.deepEqual(miss.out.did_you_mean, ['Riccardi Wholesale']);
    const unconfirmed = await v2.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Riccardi Wholesale' }, call: call2 });
    assert.equal(unconfirmed.out.found, false);
    assert.match(unconfirmed.out.say, /Not confirmed yet\. Ask exactly: "Is that Riccardi Wholesale\?"/);
    const confirmed = await v2.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Riccardi Wholesale', caller_confirmed: true }, call: call2 });
    assert.equal(confirmed.out.found, true);
  } finally { board.pop(); }
});

import { initClients } from '../clients.js';

test('client list: "DBE C Wholesale" in Greensburg is D.B.E.C. WHOLESALE — its load found by client ID; never another customer', async () => {
  const clients = initClients({ score: nameScore });
  assert.ok(clients.size() > 1500);
  assert.equal(clients.byName('DBE C Wholesale', { city: 'Greensburg' })[0].id, '00983');
  assert.equal(clients.byPhone('(724) 834-6200').name, 'D.B.E.C. WHOLESALE');
  // the Greensburg delivery is billed to another name, but TruckMate's consignee record carries DBEC's client ID
  const dbecLoad = { trip: { tripNumber: '624802', status: 'DEPSHIP', powerUnit: '2702' }, freightBills: [{ billNumber: 'B0200003', billToName: 'CHELSEA MARKET - RICCARDI WHOLESALE', consignee: { clientId: '00983', name: 'D.B.E.C. WHOLESALE' }, endZoneDescription: 'GREENSBURG, PA, 15601', pieces: 8 }] };
  board.push(dbecLoad);
  try {
    const v = setup({}, { clients });
    const r = await v.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'D B E C Wholesale', customer_city: 'Greensburg' }, call: { call_id: 'c90', direction: 'inbound', from_number: '+17245550199' } });
    assert.equal(r.out.found, true);
    assert.match(r.out.speaking_with, /D\s?B\s?E\s?C/i);
    assert.ok(!/Riccardi/i.test(r.out.speaking_with));
    // calling from DBEC's own number: recognized, asked to confirm first
    const v2 = setup({}, { clients });
    const r2 = await v2.hit('POST /retell/fn/lookup_load', { args: {}, call: { call_id: 'c91', direction: 'inbound', from_number: '+17248346200' } });
    assert.equal(r2.out.found, true);
    assert.match(r2.out.confirm || '', /Is this/);
  } finally { board.pop(); }
  // a client with nothing on the board: said so, no guessing, no contact details read out
  const v3 = setup({}, { clients });
  const r3 = await v3.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Sunbelt Wholesale Florists' }, call: { call_id: 'c92', direction: 'inbound', from_number: '+16015550000' } });
  assert.equal(r3.out.found, false);
  assert.match(r3.out.say, /one of our customers.*no load for them is on the board/);
  assert.ok(!/601-?261|trussell/i.test(JSON.stringify(r3.out)));
});

test('phone rules: staff numbers aren\'t tied to a business; a number saved for another customer gets the "contact Frank" message', async () => {
  const clients = initClients({ score: nameScore });
  const directory = { load: async () => ({ people: [{ name: 'Frank Ducassi', phone: '305-748-5611' }] }), find: async () => [{ name: 'Frank Ducassi', department: 'Customer Service', extension: '259' }], main: async () => '305-503-1200' };
  const ash = { trip: { tripNumber: '624803', status: 'DEPSHIP', powerUnit: '2703' }, freightBills: [{ billNumber: 'B0200004', billToName: 'ASHLAND ADDISON', endZoneDescription: 'CHICAGO, IL, 60612', pieces: 12 }] };
  board.push(ash);
  try {
    // Frank's cell: no Bokhary guess, and Ashland Addison's ETA is given
    const v = setup({}, { clients, directory });
    await v.db.set('taJarvisCallers:florida-beauty', { '3057485611': { name: 'BOKHARY PRODUCE' } });
    const r0 = await v.hit('POST /retell/fn/lookup_load', { args: {}, call: { call_id: 'c93', direction: 'inbound', from_number: '+13057485611' } });
    assert.ok(!/BOKHARY/i.test(JSON.stringify(r0.out)), 'no guess from a staff phone');
    const r1 = await v.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: { call_id: 'c93', direction: 'inbound', from_number: '+13057485611' } });
    assert.equal(r1.out.found, true);
    // a customer number saved for Bokhary asks about Ashland Addison → the message, nothing shared, nothing named
    const v2 = setup({}, { clients, directory });
    await v2.db.set('taJarvisCallers:florida-beauty', { '7735550100': { name: 'BOKHARY PRODUCE' } });
    const r2 = await v2.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: { call_id: 'c94', direction: 'inbound', from_number: '+17735550100' } });
    assert.equal(r2.out.found, false);
    assert.equal(r2.out.saved_for_other_customer, true);
    assert.match(r2.out.say, /saved for another customer.*Frank Ducassi in Customer Service at extension 259 — main number 305-503-1200/);
    assert.ok(!/BOKHARY|12 boxes|CHICAGO/i.test(r2.out.say));
    // a number on Ashland Addison's own client record → gets it
    const own = clients.byId('03625');
    const v3 = setup({}, { clients, directory });
    const r3 = await v3.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: { call_id: 'c95', direction: 'inbound', from_number: `+1${own.phone}` } });
    assert.equal(r3.out.found, true);
    // a brand-new number → gets it (and is saved for Ashland Addison)
    const v4 = setup({}, { clients, directory });
    const r4 = await v4.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: { call_id: 'c96', direction: 'inbound', from_number: '+13125550177' } });
    assert.equal(r4.out.found, true);
    assert.equal((await v4.db.get('taJarvisCallers:florida-beauty', {}))['3125550177'].name, 'ASHLAND ADDISON');
  } finally { board.pop(); }
});

test('saved caller numbers: list, change to a real client name, remove', async () => {
  const clients = initClients({ score: nameScore });
  const v = setup({}, { clients });
  await v.db.set('taJarvisCallers:florida-beauty', { '7735550100': { name: 'BOKHARY PRODUCE', at: '2026-10-09T17:00:00Z' } });
  const list = await v.hit('GET /truckmate/caller-numbers', { query: {} });
  assert.deepEqual(list.out.rows.map((r) => [r.phone, r.name]), [['7735550100', 'BOKHARY PRODUCE']]);
  const ch = await v.hit('POST /truckmate/caller-numbers/:phone', { params: { phone: '(773) 555-0100' }, name: 'ashland addison' }, { user: { name: 'Frank Ducassi' } });
  assert.deepEqual([ch.out.name, ch.out.client], ['ASHLAND ADDISON', '03625']);
  const saved = (await v.db.get('taJarvisCallers:florida-beauty', {}))['7735550100'];
  assert.deepEqual([saved.name, saved.by], ['ASHLAND ADDISON', 'Frank Ducassi']);
  assert.equal((await v.hit('POST /truckmate/caller-numbers/:phone', { params: { phone: '123' }, name: 'x' })).code, 400);
  await v.hit('POST /truckmate/caller-numbers/:phone/remove', { params: { phone: '7735550100' } });
  assert.deepEqual(await v.db.get('taJarvisCallers:florida-beauty', {}), {});
});

test('prompt: a misheard "ETA" ("a new TA") is an ETA request, and ETA is a boosted word', async () => {
  const { BASE_WORDS } = await import('../voice.js');
  assert.match(PROMPT, /"a new TA".*mean "I need an ETA"/);
  assert.ok(BASE_WORDS.includes('ETA'));
});

test('employee phones get any ETA: past the authorized-numbers rule, by name or by number', async () => {
  const clients = initClients({ score: nameScore });
  const directory = { load: async () => ({ people: [{ name: 'Frank Ducassi', phone: '305-748-5611' }] }) };
  const profiles = { allowed: async () => ({ ok: false }), anyLoad: async () => false };
  const ash = { trip: { tripNumber: '624803', status: 'DEPSHIP', powerUnit: '2703' }, freightBills: [{ billNumber: 'B0200004', billToName: 'ASHLAND ADDISON', endZoneDescription: 'CHICAGO, IL, 60612', pieces: 12 }] };
  board.push(ash);
  try {
    const v = setup({}, { clients, directory, profiles });
    const staff = { call_id: 'c97', direction: 'inbound', from_number: '+13057485611' };
    const r1 = await v.hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: staff });
    assert.equal(r1.out.found, true);
    assert.match(r1.out.caller_is, /Florida Beauty staff/);
    const r2 = await v.hit('POST /retell/fn/lookup_load', { args: { trip_number: '624803' }, call: { ...staff, call_id: 'c98' } });
    assert.equal(r2.out.found, true);
    assert.match(r2.out.caller_is, /Florida Beauty staff/);
    // a customer's unauthorized number still gets nothing
    const r3 = await setup({}, { clients, directory, profiles }).hit('POST /retell/fn/lookup_load', { args: { customer_name: 'Ashland Addison' }, call: { call_id: 'c99', direction: 'inbound', from_number: '+13125550177' } });
    assert.equal(r3.out.found, false);
  } finally { board.pop(); }
});

test('employee calling in: greeted by first name with good morning / afternoon / evening (Miami time)', async () => {
  assert.equal(staffGreeting('Frank Ducassi', Date.parse('2026-10-10T13:00:00Z')), 'Good morning, Frank! This is Jarvis — this call may be recorded. How can I help you today?');
  assert.match(staffGreeting('Frank Ducassi', Date.parse('2026-10-10T19:00:00Z')), /^Good afternoon, Frank!/);
  assert.match(staffGreeting('Frank Ducassi', Date.parse('2026-10-11T01:30:00Z')), /^Good evening, Frank!/);
  const directory = { load: async () => ({ people: [{ name: 'Frank Ducassi', phone: '305-748-5611' }] }) };
  const v = setup({}, { directory });
  const staff = await v.hit('POST /retell/inbound', { event: 'call_inbound', call_inbound: { from_number: '+13057485611', to_number: '+13055031200' } });
  assert.match(staff.out.call_inbound.dynamic_variables.greeting, /^Good (morning|afternoon|evening), Frank! .*How can I help you today\?$/);
  const other = await v.hit('POST /retell/inbound', { event: 'call_inbound', call_inbound: { from_number: '+17735550100' } });
  assert.deepEqual(other.out, { call_inbound: {} }, 'everyone else: the normal greeting');
  const unsigned = await v.hit('POST /retell/inbound', { event: 'call_inbound', call_inbound: { from_number: '+13057485611' } }, { sign: false });
  assert.deepEqual(unsigned.out, { call_inbound: {} }, 'unverified request: no name');
});

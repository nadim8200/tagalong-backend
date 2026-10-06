import test from 'node:test';
import assert from 'node:assert/strict';
import Retell from 'retell-sdk';
import { initVoice, findLoad, voiceFacts, PROMPT } from '../voice.js';

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
function setup(extraEnv = {}) {
  const routes = {}; const logged = []; const checkins = []; const retellCalls = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const db = memDb();
  const fetchFn = async (url, opts) => {
    retellCalls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
    const body = url.includes('create-retell-llm') ? { llm_id: 'llm_1' } : url.includes('create-agent') ? { agent_id: 'agent_1' } : url.includes('create-phone-call') ? { call_id: 'call_9', call_status: 'registered' } : {};
    return { ok: true, status: 201, json: async () => body };
  };
  initVoice(app, { requireAuth: (q, r, n) => n(), db, comms: { log: async (s, t, e) => logged.push({ trip: t, ...e }) }, carriers: { addCheckins: async (s, t, l) => checkins.push({ trip: t, ...l[0] }) }, getBoard: async () => ({ trips: board }), env: { RETELL_API_KEY: KEY, RETELL_FROM_NUMBER: '+13055550000', RETELL_TRANSFER_NUMBER: '305-503-1200', PUBLIC_URL: 'https://mytagalong.app', ...extraEnv }, fetchFn });
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
  assert.equal(findLoad(board, { phone: '+17864394668' }).role, 'driver');
  assert.equal(findLoad(board, { phone: '6305550101' }).role, 'contact');
  assert.equal(findLoad(board, { phone: '3055559999' }), null);
  const f = voiceFacts(board[0], { stops: [{ label: 'LOMBARD, IL, 60148', etaMs: Date.parse('2026-10-07T03:00:00Z'), miles: 212, apptMs: null }] });
  assert.equal(f.next_stop, 'Native Chicago, LOMBARD, IL');
  assert.match(f.estimated_arrival_next_stop, /Eastern$/);
  assert.deepEqual(f.stops_delivered, ['EDWARDSVILLE, IL']);
  assert.ok(!JSON.stringify(f).includes('4394668'), 'no driver phone in the facts');
  assert.match(PROMPT, /Never give out a driver's phone number/);
});

test('only Retell (valid signature) can use the tools', async () => {
  const v = setup();
  assert.equal((await v.hit('POST /retell/fn/lookup_load', { args: { trip_number: '624393' }, call: {} }, { sign: false })).code, 401);
  const ok = await v.hit('POST /retell/fn/lookup_load', { args: { trip_number: '624393' }, call: { call_id: 'c1', direction: 'inbound', from_number: '+13125550000' } });
  assert.equal(ok.out.found, true); assert.equal(ok.out.trip, '624393'); assert.equal(ok.out.ok_to_share, true);
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

test('setup creates Jarvis in Retell (Claude, English + Spanish, our tools, webhook)', async () => {
  const v = setup();
  const r = await v.hit('POST /voice/setup', {});
  assert.deepEqual(r.out && { llm: r.out.llmId, agent: r.out.agentId }, { llm: 'llm_1', agent: 'agent_1' });
  const llm = v.retellCalls.find((c) => c.url.endsWith('/create-retell-llm')).body;
  assert.match(llm.model, /^claude/);
  assert.deepEqual(llm.general_tools.map((t) => t.name), ['lookup_load', 'take_message', 'confirm_delivered', 'report_problem', 'end_call', 'transfer_to_dispatch']);
  assert.equal(llm.general_tools[0].url, 'https://tagalong-backend-fdzx.onrender.com/retell/fn/lookup_load');
  const agent = v.retellCalls.find((c) => c.url.endsWith('/create-agent')).body;
  assert.deepEqual(agent.language, ['en-US', 'es-ES']);
  assert.equal(agent.webhook_url, 'https://tagalong-backend-fdzx.onrender.com/retell/webhook');
  assert.equal(v.retellCalls[0].auth, `Bearer ${KEY}`);
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

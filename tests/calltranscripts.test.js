import test from 'node:test';
import assert from 'node:assert/strict';
import { initCallTranscripts, callOf, tripFor, signLink, linkOk, loadsAt, parseSummary } from '../calltranscripts.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const REC = (id, extra = {}) => ({ id, startTime: '2026-11-03T20:00:00Z', duration: 180, direction: 'Outbound', from: { phoneNumber: '+13055550000', name: 'Geo Dispatch' }, to: { phoneNumber: '+17865550111' }, recording: { id: `r${id}`, contentUri: `https://media.ringcentral.com/restapi/v1.0/account/1/recording/r${id}/content` }, ...extra });

test('a call-log record in our words; which load a call was about', () => {
  const c = callOf(REC('1'));
  assert.deepEqual([c.direction, c.other, c.by, c.recordingId, c.seconds], ['outbound', '+17865550111', 'Geo Dispatch', 'r1', 180]);
  const inb = callOf(REC('2', { direction: 'Inbound', from: { phoneNumber: '+17865550111', name: 'WIRELESS CALLER' }, to: { phoneNumber: '+13055550000', name: 'Geo Dispatch' } }));
  assert.deepEqual([inb.other, inb.by], ['+17865550111', 'Geo Dispatch']);
  const intents = [{ to: '7865550111', trip: '626300', at: '2026-11-03T19:59:00Z' }, { to: '7865550111', trip: '626001', at: '2026-11-03T15:00:00Z' }];
  assert.equal(tripFor(c, { intents }), '626300', 'called from that load a minute before');
  assert.equal(tripFor(c, { intents: [], mentioned: '626282', onBoard: (t) => t === '626282' }), '626282', 'the trip said on the call');
  assert.equal(tripFor(c, { mentioned: '999999', onBoard: () => false, who: { trips: ['626265'] } }), '626265', 'not on the board: the driver\'s one load');
  assert.equal(tripFor(c, { who: { trips: ['1', '2'] } }), null, 'two loads: can\'t tell');
});

test('recording links: signed, expire, can\'t be changed', () => {
  const exp = Date.now() + 1000;
  assert.equal(linkOk('r1', exp, signLink('r1', exp, 's'), 's'), true);
  assert.equal(linkOk('r2', exp, signLink('r1', exp, 's'), 's'), false);
  assert.equal(linkOk('r1', exp, signLink('r1', exp, 's'), 'other'), false);
  assert.equal(linkOk('r1', Date.now() - 1, signLink('r1', Date.now() - 1, 's'), 's'), false);
});

test('new recordings are transcribed, summarized, put in Calls & texts and on the load, once each; long and short calls are skipped', async () => {
  const db = mem(); const routes = {}; const recorded = []; const logged = []; const asked = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const recs = [REC('1'), REC('2', { duration: 5 }), REC('3', { duration: 3600 }), REC('4', { recording: null })];
  const fetchFn = async (url, init = {}) => {
    asked.push(String(url));
    if (url.includes('/call-log')) return { ok: true, status: 200, json: async () => ({ records: recs }) };
    if (url.includes('media.ringcentral.com')) { assert.equal(init.headers.Authorization, 'Bearer tok'); return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(8) }; }
    if (url.includes('openai.com')) return { ok: true, status: 200, json: async () => ({ text: 'Hi, this is Geo from Florida Beauty, how far are you from Apopka on 626300? About two hours.' }) };
    if (url.includes('anthropic.com')) return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"summary":"Geo checked on the driver: about two hours from Apopka.","trip":"626300","followUp":null}' }] }) };
    throw new Error(`unexpected ${url}`);
  };
  const rc = { configFor: async () => ({ server: 'https://platform.ringcentral.com' }), accessToken: async () => 'tok' };
  const activity = { record: async (e) => { recorded.push(e); }, lookup: async () => ({ role: 'driver', name: 'Frank U', trips: ['626265'] }) };
  const ct = initCallTranscripts(app, { requireAuth: (q, r, n) => n(), db, rc, activity, log: async (site, trip, e) => { logged.push([trip, e]); }, secret: 's', publicUrl: 'https://api.example', env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, fetchFn, start: false, getBoard: async () => ({ trips: [{ trip: { tripNumber: '626300' } }] }) });
  const r = await ct.run();
  assert.equal(r.done, 1);
  assert.equal(recorded.length, 1);
  assert.deepEqual([recorded[0].id, recorded[0].source, recorded[0].trip, recorded[0].name, recorded[0].recording, recorded[0].minutes], ['call:rc-1', 'ringcentral', '626300', 'Frank U', 'rc:r1', 3]);
  assert.match(recorded[0].transcript, /two hours/);
  assert.equal(logged[0][0], '626300'); assert.match(logged[0][1].label, /^Geo Dispatch called Frank U \(3 min, recorded\)$/); assert.match(logged[0][1].text, /two hours from Apopka/);
  assert.deepEqual(Object.entries(db.s['taCallRec:florida-beauty'].done).sort(), [['r1', 'done'], ['r2', 'too short'], ['r3', 'too long']]);
  await ct.run();
  assert.equal(recorded.length, 1, 'once each');
  assert.equal((await ct.search({ trip: '626300' }))[0].summary, 'Geo checked on the driver: about two hours from Apopka.');
  // the recording plays through a signed link only
  const url = new URL(ct.link('rc:r1'));
  const call = async (key, req) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; }, set() {}, send(b) { out.sent = b; } }; const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out; };
  assert.equal((await call('GET /truckmate/call-recording/:id', { params: { id: 'r1' }, query: Object.fromEntries(url.searchParams) })).status, 200);
  assert.equal((await call('GET /truckmate/call-recording/:id', { params: { id: 'r1' }, query: { exp: url.searchParams.get('exp'), sig: 'nope' } })).status, 403);
});

test('a missing permission stops the run and says what to fix; no keys, no run', async () => {
  const db = mem();
  const fetchFn = async (url) => (url.includes('/call-log') ? { ok: true, json: async () => ({ records: [REC('1')] }) } : { ok: false, status: 403 });
  const ct = initCallTranscripts({ get() {}, post() {} }, { requireAuth: () => {}, db, rc: { configFor: async () => ({}), accessToken: async () => 't' }, secret: 's', env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, fetchFn, start: false });
  const r = await ct.run();
  assert.match(r.lastError, /Read Call Recording/);
  const none = initCallTranscripts({ get() {}, post() {} }, { requireAuth: () => {}, db, rc: null, secret: 's', env: {}, fetchFn, start: false });
  assert.deepEqual(await none.run(), { skipped: true });
});

test('the Phone tab history: every RingCentral call (missed too) with its summary, transcript and recording; Jarvis\'s calls; dispatch only, read-only', async () => {
  const db = mem(); const routes = {}; const t = Date.parse('2026-11-04T15:00:00Z');
  const day = '2026-11-04';
  db.s[`taActivity:florida-beauty:${day}`] = [
    { id: 'call:rc-1', kind: 'call', source: 'ringcentral', at: '2026-11-04T14:00:00Z', direction: 'outbound', minutes: 3, trip: '626300', summary: 'Checked on the driver.', transcript: 'Hi…', name: 'Frank U', role: 'driver' },
    { id: 'call:abc', kind: 'call', at: '2026-11-04T13:00:00Z', direction: 'inbound', from: '+13055550199', minutes: 2, summary: 'A customer asked for an ETA.', transcript: 'Hello…', recording: 'https://retell/rec.wav' },
    { id: 'txt1', kind: 'text', at: '2026-11-04T12:00:00Z' },
  ];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const recs = [REC('1'), { ...REC('2', { recording: null, direction: 'Inbound', from: { phoneNumber: '+17865550000' }, to: { phoneNumber: '+13053955415', name: 'Geo Dispatch' } }), result: 'Missed', startTime: '2026-11-04T14:30:00Z', duration: 0 }];
  const fetchFn = async (url) => (url.includes('/call-log') ? { ok: true, json: async () => ({ records: recs }) } : { ok: true, json: async () => ({}) });
  initCallTranscripts(app, { requireAuth: (q, r, n) => n(), db, rc: { configFor: async () => ({}), accessToken: async () => 'tok' }, activity: { lookup: async () => ({ role: 'customer', name: 'Native Flowers' }) }, secret: 's', publicUrl: 'https://api.example', env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, fetchFn, start: false, now: () => t });
  const call = async (user) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const hs = routes['GET /truckmate/phone/history']; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h({ user, query: { days: '7' } }, res, next); }; await next(); return out; };
  assert.equal((await call({ role: 'customer' })).status, 403);
  const { calls, manager } = (await call({ id: 1, role: 'dispatcher', companyAdmin: true })).body;
  assert.equal(manager, true);
  assert.deepEqual(calls.map((c) => [c.id, c.direction, c.missed, c.name, c.hasTranscript, !!c.recording]), [
    ['rc-2', 'inbound', true, 'Native Flowers', false, false],
    ['call:abc', 'inbound', false, null, true, true],
    ['rc-1', 'outbound', false, 'Frank U', true, true],
  ], 'newest first');
  const rc1 = calls.find((c) => c.id === 'rc-1');
  assert.equal(rc1.summary, 'Checked on the driver.'); assert.equal(rc1.trip, '626300'); assert.equal(rc1.callId, 'rc-1');
  assert.match(rc1.recording, /^https:\/\/api\.example\/truckmate\/call-recording\/r1\?exp=/, 'plays through a signed link');
  assert.equal(calls.find((c) => c.id === 'call:abc').by, 'Jarvis');
});

test('a dispatcher sees only their own line\'s calls; a manager (ticked on their login) sees everyone\'s; no line yet says so', async () => {
  const db = mem(); const routes = {}; const t = Date.parse('2026-11-04T15:00:00Z');
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const mineRec = REC('1', { from: { phoneNumber: '+13053955415', name: 'Geo', extensionNumber: '102', extensionId: 'e102' } });
  const otherRec = REC('2', { from: { phoneNumber: '+13053955415', name: 'Jenny', extensionNumber: '103', extensionId: 'e103' } });
  const fetchFn = async (url) => (url.includes('/call-log') ? { ok: true, json: async () => ({ records: [mineRec, otherRec] }) } : { ok: true, json: async () => ({}) });
  const ct = initCallTranscripts(app, { requireAuth: (q, r, n) => n(), db, rc: { configFor: async () => ({}), accessToken: async () => 'tok' }, secret: 's', publicUrl: 'https://api.example', env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, fetchFn, start: false, now: () => t });
  ct.useLineOf(async (id) => (id === 'geo' ? { ext: '102', extensionId: 'e102' } : null));
  const call = async (user) => { const out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; } }; const hs = routes['GET /truckmate/phone/history']; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h({ user, query: {} }, res, next); }; await next(); return out.body; };
  assert.deepEqual((await call({ id: 'geo', role: 'dispatcher' })).calls.map((c) => c.id), ['rc-1'], 'only Geo\'s own calls');
  const none = await call({ id: 'val', role: 'dispatcher' });
  assert.deepEqual([none.calls.length, none.needsLine], [0, true], 'no phone connected yet');
  assert.deepEqual((await call({ id: 'boss', role: 'dispatcher', phoneManager: true })).calls.map((c) => c.id).sort(), ['rc-1', 'rc-2'], 'a manager sees everyone\'s');
});

test('a call keeps what the driver was hauling: truck, trailer, trip, bills, broker load number', () => {
  const board = [
    { trip: { tripNumber: '626418', powerUnit: '2619', trailer: '7301' }, freightBills: [{ billNumber: 'B180900' }], _ratecon: { loadNumber: 'LD-55123' } },
    { trip: { tripNumber: '626431', powerUnit: '2619', trailer: '7301' }, freightBills: [{ billNumber: 'B180911' }, { billNumber: 'B180912' }] },
  ];
  assert.deepEqual(loadsAt(board, ['626418', '626431', '626418']), [
    { trip: '626418', truck: '2619', trailer: '7301', bills: ['B180900'], brokerLoad: 'LD-55123' },
    { trip: '626431', truck: '2619', trailer: '7301', bills: ['B180911', 'B180912'], brokerLoad: null },
  ]);
  assert.deepEqual(loadsAt(board, ['999999']), [{ trip: '999999', truck: null, trailer: null, bills: [], brokerLoad: null }], 'off the board: the trip alone');
  assert.deepEqual(loadsAt(board, []), []);
});

test('a summary cut off mid-way still reads as a summary, never raw JSON', () => {
  assert.deepEqual(parseSummary('{"summary":"Geo checked the ETA.","trip":"626300","followUp":null}'), { summary: 'Geo checked the ETA.', trip: '626300', followUp: null });
  const cut = parseSummary('{"summary":"Jorge called about a trailer pin that won\'t engage and an air leak. Giovanni agreed to');
  assert.equal(cut.summary, 'Jorge called about a trailer pin that won\'t engage and an air leak. Giovanni agreed to');
  assert.equal(cut.trip, null);
  assert.equal(parseSummary('Plain words.').summary, 'Plain words.');
});

test('summaries from before the fix are written again from the saved transcript, once', async () => {
  const db = mem(); const t = Date.parse('2026-11-04T20:00:00Z'); const asked = [];
  db.s['taCallTranscripts:florida-beauty'] = [{ id: 'rc-9', at: '2026-11-04T17:16:00Z', by: 'Giovanni Di muro', other: '+17867683338', name: 'Jorge Rodriguez', direction: 'outbound', minutes: 8, loads: [], summary: 'Giovanni Di muro, a driver, called dispatcher Jorge' }];
  db.s['taActivity:florida-beauty:2026-11-04'] = [{ id: 'call:rc-9', transcript: 'Jefe, el pin del trailer no engancha.' }];
  const recorded = [];
  const fetchFn = async (url, init = {}) => {
    if (url.includes('/call-log')) return { ok: true, json: async () => ({ records: [] }) };
    asked.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"summary":"Dispatcher Giovanni called driver Jorge about a trailer pin.","trip":null,"followUp":"Get the pin fixed."}' }] }) };
  };
  const ct = initCallTranscripts({ get() {}, post() {} }, { requireAuth: () => {}, db, rc: { configFor: async () => ({}), accessToken: async () => 't' }, activity: { lookup: async () => ({ role: 'driver', name: 'Jorge Rodriguez' }), record: async (e) => recorded.push(e) }, secret: 's', env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, fetchFn, start: false, now: () => t });
  await ct.run(); await ct.run();
  const x = db.s['taCallTranscripts:florida-beauty'][0];
  assert.equal(x.summary, 'Dispatcher Giovanni called driver Jorge about a trailer pin.'); assert.equal(x.v, 2);
  assert.equal(asked.length, 1, 'once');
  assert.match(asked[0], /The dispatcher \(our side\) is Giovanni Di muro; the other side is Jorge Rodriguez \(driver\)/);
  assert.equal(recorded[0].summary, x.summary);
});

test('a voice clip: admins only, short text, a known voice; OpenAI does the speaking', async () => {
  const routes = {}; const app = { get() {}, post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const asked = [];
  const fetchFn = async (url, init) => { asked.push([url, JSON.parse(init.body)]); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  initCallTranscripts(app, { requireAuth: (q, r, n) => n(), db: mem(), secret: 's', env: { OPENAI_API_KEY: 'x' }, fetchFn, start: false });
  const call = async (user, body) => { const out = { code: 200 }; await routes['/admin/voice-clip']({ user, body }, { status(c) { out.code = c; return this; }, json(b) { out.body = b; }, set(k, v) { out.type = v; }, send(b) { out.sent = b; } }); return out; };
  assert.equal((await call({ role: 'dispatcher' }, { text: 'hi' })).code, 403);
  const ok = await call({ admin: true }, { text: 'Hi, thank you for calling Florida Beauty!', voice: 'fable' });
  assert.equal(ok.type, 'audio/mpeg'); assert.equal(ok.sent.length, 3);
  assert.equal(asked[0][0], 'https://api.openai.com/v1/audio/speech');
  assert.deepEqual([asked[0][1].voice, asked[0][1].input, asked[0][1].response_format], ['fable', 'Hi, thank you for calling Florida Beauty!', 'mp3']);
  assert.equal((await call({ admin: true }, { text: '', voice: 'x' })).code, 400);
});

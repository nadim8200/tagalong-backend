import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMiss, callMiss, grade, cleanTest, seedTests, initJarvisLearn, DEAD_END } from '../jarvislearn.js';
import { DRY_BLOCK } from '../jarvischat.js';

function memDb() { const m = new Map(); return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, JSON.parse(JSON.stringify(v))); return v; } }; }
const people = [
  { id: 's1', name: 'Tamara Koubi', ext: '241', phone: '3054967042', department: 'Human Resources' },
  { id: 's2', name: 'Gussi Goose', ext: '250', department: 'Dispatch' },
  { id: 's3', name: 'Frank Ducassi', ext: '259', phone: '3057485611', department: 'Customer Service' },
];
function setup({ answers = {}, user = { admin: true, name: 'Nadim' } } = {}) {
  const routes = {}; const db = memDb(); const mails = []; const asked = [];
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const turn = async (x) => { asked.push(x); return { answer: answers[x.text] || 'Sure.' }; };
  const api = initJarvisLearn(app, { db, requireAuth: (q, r, n) => n(), turn, mail: { ready: () => true, send: async (m) => mails.push(m) }, directory: { load: async () => ({ people }) }, env: {} });
  const hit = async (route, body = {}, params = {}, u = user) => {
    let code = 200; let out;
    const res = { status(c) { code = c; return this; }, json(j) { out = j; } };
    const req = { body, params, user: u };
    const hs = routes[route]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
    return { code, out };
  };
  return { api, db, hit, mails, asked };
}

test('misses: dead ends and empty lookups in chat are caught; good answers are not', () => {
  const miss = chatMiss({ question: 'whats gus extension', answer: 'No result for "Gus" in the directory. Can you give me his full name?', trace: [{ tool: 'staff_directory', found: false }], who: 'nadim', ref: 't1' });
  assert.equal(miss.reason, 'dead_end'); assert.deepEqual(miss.tools, ['staff_directory']); assert.equal(miss.status, 'open');
  assert.equal(chatMiss({ question: 'gussi', answer: 'Gussi Goose (Dispatch Manager) — ext. 250.' }), null);
  assert.equal(chatMiss({ question: 'where is 2403', answer: '', trace: [{ tool: 'find_load', found: false }] }).reason, 'lookup_failed');
  assert.ok(DEAD_END.test("I'm not finding an active load for truck 123."));
  assert.ok(!DEAD_END.test('BAY State has 2 loads: one from Ventura and one from Miami. Do you want both?'));
});

test('misses: a phone call that found nothing or hung up without an answer', () => {
  const tamara = callMiss({ callId: 'c1', at: '2026-11-27T20:24:10Z', ended: 'user_hangup', minutes: 0.6, lookups: [], summary: 'Caller requested the extension for Camara/Camaras. The directory search found no matching entry, and the agent asked the caller to spell the name.', transcript: 'Agent: Good afternoon!\nUser: What?\nUser:  Camaras Extension.\nAgent: …' });
  assert.equal(tamara.reason, 'dead_end'); assert.equal(tamara.question, 'Camaras Extension.'); assert.equal(tamara.channel, 'call');
  const trucks = callMiss({ callId: 'c2', lookups: [{ asked: { truck_number: '123' }, answer: '{"found":false}' }], summary: 'Caller asked for an ETA.', transcript: 'User: Truck number 123.' });
  assert.equal(trucks.reason, 'lookup_failed'); assert.deepEqual(trucks.tools, ['truck_number']);
  assert.equal(callMiss({ callId: 'c3', ended: 'agent_hangup', minutes: 2, lookups: [{ answer: '{"found":true}' }], summary: 'Gave the ETA for Bay State.' }), null);
});

test('grading: must say / must never say / no dead end', () => {
  assert.deepEqual(grade('Gussi Goose — ext. 250.', { must: ['250'] }), { pass: true, failed: [] });
  assert.equal(grade('No result for Gus.', { must: ['250'] }).pass, false);
  assert.equal(grade('305-503-1200 is the main number', { must: ['305-503-1200|(305) 503-1200'] }).pass, true);
  assert.deepEqual(grade("Frank's cell is 305-748-5611", { mustNot: ['5611'] }).failed, ['must not say "5611"']);
  assert.equal(grade("I couldn't find that.", { mustNot: ['x'] }).pass, false, 'a dead end fails even without a must');
  assert.equal(cleanTest({ question: '' }).error, 'Write the question.');
  assert.match(cleanTest({ question: 'q' }).error, /must include/);
  assert.deepEqual(cleanTest({ question: "What's Gus's extension?", must: '250\n' }).test.must, ['250']);
});

test('starting tests come from the live directory and the rules that must never break', () => {
  const s = seedTests(people);
  const q = (id) => s.find((t) => t.id === id);
  assert.deepEqual(q('seed-tamara').must, ['241']);
  assert.deepEqual(q('seed-gus').must, ['250']);
  assert.deepEqual(q('seed-nocell').mustNot, ['7042', '496']);
  assert.ok(s.some((t) => t.question === "What's Frank's extension?" && t.must[0] === '259'));
});

test('test runs go through Jarvis dry (nothing acts) and keep the score; admins only', async () => {
  const v = setup({ answers: { "What's Tamara's extension?": 'Tamara Koubi — ext. 241.', 'whats gus extension': 'No result for Gus.' } });
  const no = await v.hit('GET /jarvis/learn', {}, {}, { name: 'Mary', role: 'dispatcher' });
  assert.equal(no.code, 403);
  const r = await v.hit('POST /jarvis/learn/run');
  assert.equal(r.out.ok, true);
  const p = v.api.waitRun(); if (p) await p;
  const runs = await v.db.get('taJarvisTestRuns:florida-beauty', []);
  const last = runs[0];
  assert.equal(last.status, 'done'); assert.equal(last.total, v.asked.length);
  assert.ok(v.asked.every((x) => x.dryRun === true && x.user.id === 'jarvis-tests'));
  assert.equal(last.results.find((x) => x.id === 'seed-tamara').pass, true);
  assert.equal(last.results.find((x) => x.id === 'seed-gus').pass, false);
  // test runs never act: the writing tools are blocked in a dry turn
  for (const t of ['add_note', 'set_hold', 'request_callback', 'propose_action', 'learn_lesson']) assert.ok(DRY_BLOCK.has(t), t);
});

test('a 👎 is a miss; Fixed with the right answer adds a test; the weekly email to the owner', async () => {
  const v = setup();
  await v.db.set('taJarvisChat:7', { threads: { abc123abc123: { id: 'abc123abc123', messages: [{ role: 'user', text: 'whats gus extension', at: 'a1' }, { role: 'assistant', text: 'No result for Gus.', at: 'a2' }] } } });
  const fb = await v.hit('POST /jarvis/feedback', { threadId: 'abc123abc123', at: 'a2', vote: 'down', note: 'It is Gussi' }, {}, { id: 7, name: 'Mary' });
  assert.equal(fb.out.vote, 'down');
  const th = await v.db.get('taJarvisChat:7', {}); assert.equal(th.threads.abc123abc123.messages[1].vote, 'down');
  const list = (await v.hit('GET /jarvis/learn')).out;
  const m = list.misses.find((x) => x.reason === 'thumbs_down');
  assert.deepEqual([m.question, m.who, m.note], ['whats gus extension', 'Mary', 'It is Gussi']);
  const fixed = await v.hit('POST /jarvis/learn/misses/:id', { status: 'fixed', note: 'nicknames match now', test: { question: 'whats gus extension', must: ['250'] } }, { id: m.id });
  assert.equal(fixed.out.ok, true);
  const tests = (await v.hit('GET /jarvis/learn')).out.tests;
  assert.ok(tests.some((t) => t.id === fixed.out.test.id && t.from === `miss ${m.id}`));
  // the weekly email: misses this week + the score, "A note from Jarvis"
  const e = v.api.weeklyEmail([{ ...m, at: new Date().toISOString(), status: 'open' }], [{ status: 'done', passed: 9, total: 10 }, { status: 'done', passed: 8, total: 10 }], Date.now());
  assert.match(e.subject, /Jarvis report card — 1 miss this week · 9\/10 tests/);
  assert.match(e.html, /A note from Jarvis/); assert.match(e.html, /last time 8 of 10/); assert.match(e.html, /whats gus extension/);
});

test('calls are read from the call log once each', async () => {
  const v = setup();
  await v.db.set('taJarvisCalls:florida-beauty', [{ callId: 'c1', at: '2026-11-27T20:24:10Z', ended: 'user_hangup', minutes: 0.6, lookups: [], summary: 'The directory search found no matching entry.', transcript: 'User: Camaras extension' }, { callId: 'c2', summary: 'Gave the ETA.', lookups: [{ answer: '{"found":true}' }] }]);
  assert.equal(await v.api.scanCalls(), 1);
  assert.equal(await v.api.scanCalls(), 0);
  const misses = await v.db.get('taJarvisMisses:florida-beauty', []);
  assert.equal(misses.length, 1); assert.equal(misses[0].question, 'Camaras extension');
});

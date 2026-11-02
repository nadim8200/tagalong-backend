import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFor, readQuestions, initJarvisAsks } from '../jarvisasks.js';
import { renderLessonEmail } from '../handoffmail.js';
import { readToken } from '../breakdownreport.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };
const NOON = Date.parse('2026-11-02T17:00:00Z');   // noon in Miami
const NIGHT = Date.parse('2026-11-03T04:00:00Z');
const gio = { name: 'Giovanni Dimuro', email: 'g@floridabeauty.us' };

test('each person sees their own question first, then anyone\'s, never one they passed on', () => {
  const list = [{ id: 'a', status: 'open', passed: [] }, { id: 'b', status: 'open', to: 'giovanni dimuro', passed: [] }, { id: 'c', status: 'answered', to: 'Giovanni Dimuro' }];
  assert.equal(nextFor(list, gio).id, 'b');
  assert.equal(nextFor(list, { name: 'Sara' }).id, 'a');
  assert.equal(nextFor([{ id: 'b', status: 'open', to: 'Giovanni Dimuro', passed: ['Giovanni Dimuro'] }], gio), null);
  assert.equal(nextFor([{ id: 'b', status: 'open', to: 'Sara', passed: [] }], gio), null, 'someone else\'s stays theirs');
});

test('the AI\'s questions are cleaned: three at most, no repeats, only people it saw', () => {
  const raw = JSON.stringify({ questions: [{ to: 'Sara', question: 'Why did you hold the load?', trip: '626133' }, { to: 'Hacker', question: 'Second good question here?', trip: 'x' }, { to: 'Sara', question: 'why did you HOLD the load' }, { question: 'short' }, { question: 'Third question goes here?' }, { question: 'Fourth question goes here?' }, { question: 'Fifth question goes here?' }] });
  const q = readQuestions(raw, { actors: ['Sara'], earlier: ['Fifth question goes here?'] });
  assert.equal(q.length, 3); assert.equal(q[0].to, 'Sara'); assert.equal(q[0].trip, '626133'); assert.equal(q[1].to, null); assert.equal(q[1].trip, null);
  assert.deepEqual(readQuestions('not json'), []);
});

const setup = ({ time = NOON, audit = [], ai = '{"questions":[]}' } = {}) => {
  const env = { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'k', JARVIS_ASKS: 'on' };
  const db = mem(); const mails = []; const removed = []; const lessons = [{ id: 'pb1', title: 'Hotel stops', when: 'a team is out of hours', do: 'Approve the hotel with Armando.' }];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; } };
  const playbook = { text: async () => '', all: async () => lessons, remove: async (ids) => removed.push(...ids), learn: async ({ text }) => { playbook.lastText = text; return { lessons }; } };
  let calls = 0;
  const a = initJarvisAsks(app, { requireAuth: (q, s, n) => n(), db, secret: 's', playbook, sendMail: async (m) => mails.push(m), readAudit: async () => audit, env, fetchFn: async () => { calls += 1; return { ok: true, json: async () => ({ content: [{ type: 'text', text: ai }] }) }; }, now: () => time });
  return { a, db, env, mails, removed, routes, playbook, calls: () => calls };
};
const row = (x = {}) => ({ at: new Date(NOON - 60000).toISOString(), actor: 'Sara', role: 'dispatcher', action: 'Resolved an alert', status: 200, trip: '626133', detail: { note: 'hotel approved' }, ...x });
const AI = JSON.stringify({ questions: [{ to: 'Sara', question: 'What makes a hotel stop OK to approve?', why: 'To know when to stay quiet', trip: '626133' }] });
const call = (route, req) => new Promise((resolve) => { let code = 200; route(req, { status(c) { code = c; return this; }, json: (j) => resolve({ code, ...j }), set() { return this; }, type() { return this; }, send: (html) => resolve({ code, html }) }); });

test('questions are written from what people did, by day, with no repeats of the same work', async () => {
  const s = setup({ audit: [row()], ai: AI });
  assert.equal(await s.a.generate(), 1);
  const [q] = s.db.s['taJarvisAsks:florida-beauty'];
  assert.equal(q.to, 'Sara'); assert.equal(q.status, 'open');
  assert.equal(await s.a.generate(), 0, 'nothing new since the last look');
  const night = setup({ time: NIGHT, audit: [row()], ai: AI });
  assert.equal(await night.a.generate(), 0); assert.equal(night.calls(), 0, 'no AI at night');
  const noise = setup({ audit: [row({ action: 'Signed in' }), row({ status: 403 }), row({ action: 'Did /admin/waiting-example' }), row({ action: 'Answered a Jarvis question' }), row({ action: 'Wrote in Teach Jarvis' }), row({ action: 'Changed /truckmate/x' })], ai: AI });
  assert.equal(await noise.a.generate(), 0); assert.equal(noise.calls(), 0);
});

test('an answer becomes a lesson, the owner gets it with an erase link, and only one person can answer', async () => {
  const s = setup({ audit: [row()], ai: AI });
  await s.a.generate();
  const { ask } = await call(s.routes['GET /truckmate/asks/next'], { user: { name: 'Sara' } });
  assert.match(ask.question, /hotel stop/);
  assert.equal((await call(s.routes['POST /truckmate/asks/:id'], { params: { id: ask.id }, body: { answer: ' ' }, user: { name: 'Sara' } })).code, 400);
  const r = await call(s.routes['POST /truckmate/asks/:id'], { params: { id: ask.id }, body: { answer: 'Only if Armando says so' }, user: { name: 'Sara', email: 's@floridabeauty.us' } });
  assert.equal(r.learned, 1); assert.match(s.playbook.lastText, /Sara answered: Only if Armando says so/);
  assert.deepEqual(s.mails[0].to, ['ntellez@floridabeauty.us']);
  assert.match(s.mails[0].text, /Approve the hotel with Armando/); assert.match(s.mails[0].text, /They answered: Only if Armando says so/);
  assert.equal((await call(s.routes['POST /truckmate/asks/:id'], { params: { id: ask.id }, body: { answer: 'again' }, user: { name: 'Ana' } })).code, 409);
  assert.equal((await call(s.routes['GET /truckmate/asks/next'], { user: { name: 'Sara' } })).ask, null);
});

test('opening the erase link changes nothing; pressing the button erases it', async () => {
  const s = setup();
  const url = s.a.eraseLink({ id: 'pb1' }); const token = url.split('/lesson/')[1];
  assert.equal(readToken(token, 's', NOON, 'lesson-erase').l, 'pb1');
  const pagePage = await call(s.routes['GET /lesson/:token'], { params: { token } });
  assert.match(pagePage.html, /Erase this lesson\?/); assert.deepEqual(s.removed, []);
  assert.equal((await call(s.routes['POST /lesson/:token'], { params: { token } })).ok, true);
  assert.deepEqual(s.removed, ['pb1']);
  assert.equal((await call(s.routes['POST /lesson/:token'], { params: { token: 'bad' } })).code, 403);
});

test('the lesson email escapes what people typed', () => {
  const m = renderLessonEmail({ lessons: [{ title: '<b>x', do: 'y', eraseUrl: 'https://x/lesson/t' }], by: 'Sara', question: 'q', answer: '<script>', now: NOON });
  assert.doesNotMatch(m.html, /<script>/); assert.match(m.html, /Erase this lesson/); assert.match(m.subject, /1 new lesson from Sara/);
});

test('off by default: nobody gets a question, even one already waiting', async () => {
  const s = setup({ audit: [row()], ai: AI });
  await s.a.generate();
  assert.ok((await call(s.routes['GET /truckmate/asks/next'], { user: { name: 'Sara' } })).ask);
  delete s.env.JARVIS_ASKS;
  assert.equal((await call(s.routes['GET /truckmate/asks/next'], { user: { name: 'Sara' } })).ask, null);
});

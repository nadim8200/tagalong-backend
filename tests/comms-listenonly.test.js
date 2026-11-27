import test from 'node:test';
import assert from 'node:assert/strict';
import { initComms, jarvisKeyword } from '../comms.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const fakeApp = () => ({ get() {}, post() {}, put() {}, delete() {} });

const run = async (env, texts = null) => {
  const sent = []; const asked = []; const cases = [];
  const ringcentral = { configFor: async () => ({ fromNumber: '+17867233912' }), inboundSince: async () => texts || [{ id: 'r1', from: '+13055040711', text: 'Is truck 4550 on time?', at: '2026-11-05T19:18:00Z' }, { id: 'r2', from: '+19545550000', text: 'We are missing 3 boxes from today', at: '2026-11-05T19:19:00Z' }],
    sendSms: async (o, m) => { sent.push(m); return { id: 'x' }; } };
  const c = initComms(fakeApp(), { requireAuth: () => {}, db: mem(), ringcentral, getBoard: async () => ({ trips: [] }), env,
    staffAsk: async (q) => { if (!String(q.phone).endsWith('5040711')) return null; asked.push(q.text); return 'Truck 4550 is on time.'; },
    missingCases: { fromText: async (m) => { if (!/missing/i.test(m.text)) return null; cases.push(m.text); return { reply: 'A case is open.' }; } } });
  await c.pollReplies();
  return { sent, asked, cases };
};

test('listen-only: Jarvis reads texts (cases still open) but texts nobody back; JARVIS_TEXT_REPLIES=on turns the answers back on', async () => {
  const off = await run({});
  assert.deepEqual(off.sent, [], 'no text goes back');
  assert.deepEqual(off.asked, [], 'no answer is even written');
  assert.deepEqual(off.cases, ['We are missing 3 boxes from today'], 'the missing-boxes case still opens for the office');
  const on = await run({ JARVIS_TEXT_REPLIES: 'on' });
  assert.deepEqual(on.sent.map((m) => m.text), ['Truck 4550 is on time.', 'A case is open.']);
});

// Nov 27: "Jarvis, what's Tamara's extension?" — answered on the shared line even listen-only, only for employees; other texts stay silent
test('keyword: a text starting with "Jarvis" from an employee gets the answer; dispatch / driver texts and non-employees get nothing', async () => {
  assert.equal(jarvisKeyword("Jarvis, what's Tamara's extension?"), "what's Tamara's extension?");
  assert.equal(jarvisKeyword('hey jarvis: truck 4550?'), 'truck 4550?');
  assert.equal(jarvisKeyword('Jarvis'), 'hi');
  assert.equal(jarvisKeyword('Ask Jarvis later'), null);
  assert.equal(jarvisKeyword('Jarvisito'), null);
  const texts = [
    { id: 'k1', from: '+13055040711', text: "Jarvis, what's Tamara's extension?", at: '2026-11-27T20:00:00Z' },
    { id: 'k2', from: '+13055040711', text: 'Is truck 4550 on time?', at: '2026-11-27T20:01:00Z' },
    { id: 'k3', from: '+19545550000', text: 'Jarvis where is my load', at: '2026-11-27T20:02:00Z' },
  ];
  const r = await run({}, texts);
  assert.deepEqual(r.asked, ["what's Tamara's extension?"], 'only the employee\'s Jarvis text is asked (without the name)');
  assert.deepEqual(r.sent.map((m) => [m.to, m.text]), [['+13055040711', 'Truck 4550 is on time.']]);
  const off = await run({ JARVIS_KEYWORD_TEXTS: 'off' }, texts);
  assert.deepEqual(off.sent, []);
});

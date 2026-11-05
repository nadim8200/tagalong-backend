import test from 'node:test';
import assert from 'node:assert/strict';
import { initComms } from '../comms.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
const fakeApp = () => ({ get() {}, post() {}, put() {}, delete() {} });

const run = async (env) => {
  const sent = []; const asked = []; const cases = [];
  const ringcentral = { configFor: async () => ({ fromNumber: '+17867233912' }), inboundSince: async () => [{ id: 'r1', from: '+13055040711', text: 'Is truck 4550 on time?', at: '2026-11-05T19:18:00Z' }, { id: 'r2', from: '+19545550000', text: 'We are missing 3 boxes from today', at: '2026-11-05T19:19:00Z' }],
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

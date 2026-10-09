import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrainingEmail, removals, playbookText, initPlaybook } from '../playbook.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }

test('training emails are recognized; REMOVE replies; playbook text', () => {
  assert.equal(isTrainingEmail('TRAINING: morning routine', ''), true);
  assert.equal(isTrainingEmail('RE: Training - RXO rules', ''), true);
  assert.equal(isTrainingEmail('Fw: loads', 'For training: this is what Andres sends every morning'), true);
  assert.equal(isTrainingEmail('Update', 'I need an update on Lombard IL'), false);
  assert.deepEqual(removals('Remove 2 and 3\n\nFrom: Jarvis\n1. x'), [2, 3]);
  assert.deepEqual(removals('looks good'), []);
  const t = playbookText([{ category: 'rule', when: 'RXO books a load', do: 'Send check calls every 2 hours.', appliesTo: ['RXO'], active: true }, { category: 'routine', do: 'off', active: false }]);
  assert.match(t, /1\. \[rule\] When RXO books a load: Send check calls every 2 hours\. — applies to RXO/);
  assert.doesNotMatch(t, /off/);
});

test('learn: lessons saved from a training email, then shown in the playbook', async () => {
  const db = memDb(); const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, delete: () => {}, put: () => {} };
  const out = { lessons: [{ category: 'routine', title: 'Morning outbound report', when: 'every weekday morning', do: 'Andres sends the outbound report to Ronen by 6 AM.', schedule: 'weekdays 6:00 AM ET', appliesTo: ['Andres'] }], questions: ['Should I send it if Andres is out?'] };
  const pb = initPlaybook(app, { requireAuth: () => {}, db, env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: async () => ({ json: async () => ({ content: [{ type: 'text', text: JSON.stringify(out) }] }) }) });
  const r = await pb.learn({ from: { name: 'Nadim', address: 'ntellez@floridabeauty.us' }, subject: 'TRAINING: mornings', text: 'Every weekday Andres sends…' });
  assert.equal(r.lessons.length, 1); assert.deepEqual(r.questions, ['Should I send it if Andres is out?']);
  assert.equal((await pb.routines()).length, 1);
  assert.match(await pb.text(), /Morning|outbound report/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { initTraining, redirectEmail, heldCopy } from '../training.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) }; }

test('training: emails go to the test addresses with who they were for; texts / calls are held and copied', async () => {
  const r = redirectEmail({ to: ['ops@broker.com'], subject: 'Location update — Load 1', html: '<p>hi</p>' }, ['test1@floridabeauty.us', 'test2@floridabeauty.us']);
  assert.deepEqual(r.to, ['test1@floridabeauty.us', 'test2@floridabeauty.us']);
  assert.match(r.subject, /^\[TRAINING → ops@broker\.com\] Location update/);
  assert.match(r.html, /would have gone to: <b>ops@broker\.com/);
  assert.match(heldCopy('text', { to: '+13055550117', text: 'Pick up at 9', trip: '623869' }).subject, /would have texted \+13055550117 · load 623869/);

  const db = memDb(); const sent = []; const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  const t = initTraining(app, { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), db, sendDirect: async (m) => { sent.push(m); } });
  // off: everything passes through untouched
  assert.deepEqual(await t.mailGuard({ to: ['a@x.com'], subject: 's', html: '' }), { to: ['a@x.com'], subject: 's', html: '' });
  assert.equal(await t.hold('text', { to: '+1305', text: 'x' }), null);
  let out; let code = 200; const res = { status(c) { code = c; return this; }, json(j) { out = j; } };
  await routes['PUT /admin/training']({ body: { on: true, to: [] } }, res);
  assert.equal(code, 400, 'needs a test email');
  await routes['PUT /admin/training']({ body: { on: true, to: ['Test1@FloridaBeauty.us', 'test2@floridabeauty.us'] }, user: { name: 'Nadim' } }, res);
  assert.deepEqual(out.to, ['test1@floridabeauty.us', 'test2@floridabeauty.us']);
  assert.deepEqual((await t.mailGuard({ to: ['ops@broker.com'], subject: 'S', html: '' })).to, ['test1@floridabeauty.us', 'test2@floridabeauty.us']);
  const held = await t.hold('call', { to: '+13055550117', trip: '623869', purpose: 'pickup check' });
  assert.equal(held.training, true);
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /would have called/);
  await routes['GET /truckmate/training']({}, res);
  assert.equal(out.on, true);
});

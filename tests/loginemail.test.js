import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLoginEmail } from '../handoffmail.js';
import { initDispatchers } from '../dispatchers.js';

const routes = {};
const app = { get() {}, put() {}, delete() {}, post(p, ...h) { routes[p] = h[h.length - 1]; } };
const mem = () => { const s = {}; return { enabled: true, get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };
const call = (body) => new Promise((resolve) => { const res = { status() { return this; }, json: resolve }; routes['/admin/dispatchers']({ body, user: { admin: true, name: 'Nadim' } }, res); });
const setup = (mail) => initDispatchers(app, { requireAuth: (q, s, n) => n(), db: mem(), hashPassword: (p) => `h${p}`, verifyPassword: () => true, sign: () => 't', setCookie() {}, mail });

test('the email has the username, temporary password, link and steps, in both languages', () => {
  const m = renderLoginEmail({ name: 'Example Person', email: 'a@floridabeauty.us', tempPassword: 'Rose-Truck-1234', url: 'https://x/truckmate?admin', by: 'Nadim' });
  for (const v of ['a@floridabeauty.us', 'Rose-Truck-1234', 'https://x/truckmate?admin', 'Hi Example', 'Hola Example', 'temporary', 'contraseña temporal', 'Follow these steps']) assert.ok(m.html.includes(v), v);
  assert.match(m.text, /Temporary password: Rose-Truck-1234/);
  assert.doesNotMatch(renderLoginEmail({ name: '<b>', email: 'a@b.co', tempPassword: 'x', url: 'u' }).html, /<b>,/);
});

test('emailing is only on request, goes to that person, and a failure keeps the login', async () => {
  const sent = [];
  setup({ ready: () => true, send: async (m) => sent.push(m) });
  const off = await call({ name: 'A', email: 'a@floridabeauty.us', temp: true });
  assert.equal(sent.length, 0); assert.equal(off.emailed, undefined); assert.ok(off.tempPassword);
  const on = await call({ name: 'B', email: 'b@floridabeauty.us', temp: true, sendEmail: true });
  assert.equal(on.emailed, true); assert.deepEqual(sent[0].to, ['b@floridabeauty.us']); assert.ok(sent[0].html.includes(on.tempPassword));
  setup({ ready: () => true, send: async () => { throw new Error('no'); } });
  const bad = await call({ name: 'C', email: 'c@floridabeauty.us', temp: true, sendEmail: true });
  assert.equal(bad.emailed, false); assert.ok(bad.tempPassword);
  setup({ ready: () => false });
  assert.equal((await call({ name: 'D', email: 'd@floridabeauty.us', temp: true, sendEmail: true })).emailed, false);
});

test('training mode keeps the password from an outside address', async () => {
  const sent = [];
  setup({ ready: () => true, send: async (m) => sent.push(m), mayReach: async (to) => /@floridabeauty\.us$/.test(to) });
  const r = await call({ name: 'E', email: 'e@example.com', temp: true, sendEmail: true });
  assert.equal(r.emailed, false); assert.match(r.emailError, /Training mode/); assert.equal(sent.length, 0);
});

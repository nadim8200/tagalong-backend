import test from 'node:test';
import assert from 'node:assert/strict';
import { seedPeople, findStaff, mentionedStaff, publicView, initDirectory } from '../directory.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) }; }
const P = seedPeople();

test('directory: find by name / department / role; mentions; only name + extension are shareable', () => {
  assert.equal(P.length, 80);
  assert.deepEqual(findStaff(P, 'Frank').map((p) => p.name), ['Frank Ducassi']);
  assert.deepEqual(findStaff(P, 'rosa reategui').map((p) => p.ext), ['263']);
  assert.ok(findStaff(P, 'billing').every((p) => p.department === 'Billing'));
  assert.ok(findStaff(P, 'claims').some((p) => p.name === 'Kristian Duran'));
  assert.deepEqual(mentionedStaff(P, 'Please have Frank call me about the claim').map((p) => p.name), ['Frank Ducassi']);
  assert.deepEqual(mentionedStaff(P, 'Carlos said hi'), [], 'more than one Carlos — not a match');
  assert.deepEqual(mentionedStaff(P, 'tell Gus Duarte the truck is late').map((p) => p.name), ['Gus Duarte']);
  const v = publicView(P.find((p) => p.name === 'Frank Ducassi'));
  assert.deepEqual(v, { name: 'Frank Ducassi', department: 'Customer Service', extension: '259', departmentLine: '676', role: null, mainNumber: '305-503-1200' });
  assert.ok(!JSON.stringify(v).includes('748'), 'never the cell');
});

test('dispatchers can\'t open the directory; admins see the system-only cell', async () => {
  const routes = {};
  initDirectory({ get: (p, ...h) => { routes[p] = h.at(-1); }, put: () => {}, post: () => {} }, { requireAuth: () => {}, requireAdmin: () => {}, db: memDb() });
  let out; const res = { json: (j) => { out = j; } };
  let code = 200; res.status = (c) => { code = c; return res; };
  await routes['/truckmate/directory']({ user: { role: 'dispatcher' } }, res);
  assert.equal(code, 403, 'the Employees tab is admin-only');
  await routes['/truckmate/directory']({ user: { admin: true } }, res);
  assert.equal(out.people.find((p) => p.name === 'Frank Ducassi').phone, '3057485611');
});

test('reaching an employee: their chosen ways; a call while texting is not live; never shows the number', async () => {
  const { reachPlan } = await import('../directory.js');
  const p = { phone: '3057485611', email: 'f@floridabeauty.us', channels: { text: true, email: true, call: false } };
  assert.deepEqual(reachPlan(p, { textingLive: true }), { email: true, text: true, call: false });
  assert.deepEqual(reachPlan(p, { textingLive: false }), { email: true, text: false, call: true });
  assert.deepEqual(reachPlan({ phone: null, email: null }, {}), { email: false, text: false, call: false });
  const routes = {}; const sent = [];
  initDirectory({ get: () => {}, put: () => {}, post: (pth, ...h) => { routes[pth] = h.at(-1); } }, { requireAuth: () => {}, requireAdmin: () => {}, db: (() => { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } }; })(),
    contact: { textingLive: async () => false, text: async () => ({}), email: async (to, s, b) => sent.push(['email', to, b]), call: async (o) => { sent.push(['call', o.to, o.message]); return { called: true }; } } });
  let out; let code = 200; const res = { json: (j) => { out = j; }, status(c) { code = c; return this; } };
  const frank = seedPeople().find((x) => x.name === 'Frank Ducassi');
  await routes['/truckmate/directory/:id/contact']({ params: { id: frank.id }, body: { message: 'Mayesh called about the Lombard load' }, user: { name: 'Rosa', admin: true } }, res);
  assert.equal(code, 200); assert.deepEqual(out.result, { call: 'calling' });
  assert.deepEqual(sent[0], ['call', '3057485611', 'Mayesh called about the Lombard load — from Rosa']);
  assert.ok(!JSON.stringify(out).includes('3057485611'), 'the number never comes back to the screen');
  const nobody = seedPeople().find((x) => x.name === 'Carlos Bolivar');
  await routes['/truckmate/directory/:id/contact']({ params: { id: nobody.id }, body: { message: 'hi' }, user: { admin: true } }, res);
  assert.equal(code, 409);
});

import { groupFor, cleanGroups, SEED_GROUPS } from '../directory.js';

test('email groups: "dispatch", "the dispatch group", "Dispatches", aliases like billing → Accounting', () => {
  assert.equal(groupFor(SEED_GROUPS, 'dispatch').email, 'dispatches@floridabeauty.us');
  assert.equal(groupFor(SEED_GROUPS, 'the dispatch group').name, 'Dispatch');
  assert.equal(groupFor(SEED_GROUPS, 'Dispatches').name, 'Dispatch');
  assert.equal(groupFor(SEED_GROUPS, 'billing').name, 'Accounting');
  assert.equal(groupFor(SEED_GROUPS, 'CS').name, 'Customer Service');
  assert.equal(groupFor(SEED_GROUPS, 'sales'), null);
  assert.equal(groupFor([{ name: 'Dispatch', email: 'x@y.com', active: false }], 'dispatch'), null, 'inactive groups are skipped');
});

test('saving groups keeps only valid emails and trims aliases', () => {
  assert.deepEqual(cleanGroups([{ name: ' Sales ', email: 'SALES@floridabeauty.us', aliases: 'sales team, quotes' }, { name: '', email: 'x@y.com' }, { name: 'Bad', email: 'nope' }]).map((g) => [g.name, g.email, g.aliases]), [['Sales', 'sales@floridabeauty.us', ['sales team', 'quotes']], ['Bad', '', []]]);
});

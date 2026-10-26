import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import express from 'express';
import { companyGate, companyMayUse, companyOf, DEFAULT_COMPANY } from '../companies.js';
import { initDispatchers, dispatcherMayUse } from '../dispatchers.js';

const fbDisp = { id: 'D1', role: 'dispatcher', company: 'florida-beauty' };
const acme = { id: 'D9', role: 'dispatcher', company: 'acme-logistics' };
const run = (user, path, { query = {}, body } = {}) => {
  const req = { path, query: { ...query }, body: body ? { ...body } : undefined }; let code = 200;
  companyGate(() => user)(req, { status: (c) => { code = c; return { json: () => {} }; } }, () => {});
  return { code, req };
};

test('the company comes from the login — a Florida Beauty login asking for another company still gets Florida Beauty', () => {
  const r = run(fbDisp, '/truckmate/active', { query: { site: 'acme-logistics' }, body: { site: 'acme-logistics', x: 1 } });
  assert.equal(r.code, 200); assert.equal(r.req.query.site, 'florida-beauty'); assert.equal(r.req.body.site, 'florida-beauty'); assert.equal(r.req.company, 'florida-beauty');
  assert.equal(run({ id: 'D0', role: 'dispatcher' }, '/truckmate/active').req.company, DEFAULT_COMPANY, 'logins from before companies = Florida Beauty');
  assert.equal(run({ role: 'admin', admin: true }, '/truckmate/active', { query: { site: 'acme-logistics' } }).req.company, 'acme-logistics', 'platform admin picks');
  assert.equal(companyOf({ id: 5, role: 'owner' }), null, 'TagAlong customers are not in a dispatch company');
});

// every route in the backend: a login from a NEW company must be refused everywhere that is not yet company-aware
const routes = [];
for (const f of readdirSync(new URL('..', import.meta.url)).filter((x) => x.endsWith('.js'))) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*['`]([^'`]+)['`]/g)) routes.push({ file: f, method: m[1], path: m[2].replace(/:[a-zA-Z]+/g, 'x').replace(/\*/g, 'x') });
}
test(`a new company's login is refused on every route not yet built for companies (${routes.length} routes checked)`, () => {
  assert.ok(routes.length > 200, `found ${routes.length} routes`);
  const open = [];
  for (const r of routes) {
    const { code } = run(acme, r.path);
    if (code !== 403) open.push(`${r.method.toUpperCase()} ${r.path}`);
  }
  // only sign-in / own account / own-company logins / push registration may answer a new company today
  for (const p of open) assert.ok(companyMayUse('acme-logistics', p.split(' ')[1]), `open to another company: ${p}`);
  assert.ok(!open.some((p) => /truckmate|watchtower|voice|jarvis|ringcentral|directory|training|artis|loads|pod/.test(p)), open.join(', '));
  // Florida Beauty's own logins are not affected
  for (const r of routes) assert.equal(run(fbDisp, r.path).code, 200, r.path);
});

test('company admins (Nadim, Ronen): their company\'s settings + logins; dispatchers still read-only on settings', () => {
  assert.equal(dispatcherMayUse('PUT', '/truckmate/profiles/5', { ...fbDisp, companyAdmin: true }), null);
  assert.equal(dispatcherMayUse('PUT', '/truckmate/profiles/5', fbDisp), 'settings');
  assert.equal(dispatcherMayUse('POST', '/admin/dispatchers', { ...fbDisp, companyAdmin: true }), null);
  assert.equal(dispatcherMayUse('POST', '/admin/dispatchers', fbDisp), 'outside');
  assert.equal(dispatcherMayUse('PUT', '/admin/directory', { ...fbDisp, companyAdmin: true }), null);
});

test('logins page: a company admin sees and changes only their own company\'s logins', async () => {
  const mm = new Map([['taDispatchers', { list: [
    { id: 'D1', email: 'ronen@floridabeauty.us', name: 'Ronen', company: 'florida-beauty', companyAdmin: true, active: true, pass: 'x' },
    { id: 'D2', email: 'val@floridabeauty.us', name: 'Valeria', active: true, pass: 'x' },
    { id: 'D9', email: 'boss@acme.com', name: 'Acme boss', company: 'acme-logistics', companyAdmin: true, active: true, pass: 'x' },
  ] }]]);
  const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const app = express(); app.use(express.json());
  let who = null;
  initDispatchers(app, { requireAuth: (req, res, next) => { req.user = who; next(); }, db, hashPassword: (p) => `h:${p}`, verifyPassword: () => true, sign: () => 't', setCookie: () => {} });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const url = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, body) => { const r = await fetch(url + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    who = { id: 'D9', role: 'dispatcher', company: 'acme-logistics', companyAdmin: true };
    assert.deepEqual((await call('GET', '/admin/dispatchers')).body.map((d) => d.email), ['boss@acme.com'], 'never Florida Beauty’s people');
    const made = (await call('POST', '/admin/dispatchers', { name: 'Acme disp', email: 'd@acme.com', password: 'Truck-Mile-1234', company: 'florida-beauty' })).body;
    assert.equal(made.company, 'acme-logistics', 'cannot create into another company');
    assert.equal((await call('PUT', '/admin/dispatchers/D2', { active: false })).status, 404, 'cannot touch Florida Beauty logins');
    assert.equal((await call('DELETE', '/admin/dispatchers/D2')).status, 200);
    assert.ok(mm.get('taDispatchers').list.some((d) => d.id === 'D2'), 'Valeria still there');
    who = { id: 'D2', role: 'dispatcher', company: 'florida-beauty' };
    assert.equal((await call('GET', '/admin/dispatchers')).status, 403, 'a plain dispatcher cannot manage logins');
    who = { id: 'D1', role: 'dispatcher', company: 'florida-beauty', companyAdmin: true };
    assert.deepEqual((await call('GET', '/admin/dispatchers')).body.map((d) => d.name).sort(), ['Ronen', 'Valeria']);
    who = { id: 1, role: 'admin', admin: true };
    assert.equal((await call('GET', '/admin/dispatchers')).body.length, 4, 'platform admin: everyone');
  } finally { srv.close(); }
});

import { initCompanies, nextCustomerId } from '../companies.js';
test('a new AI-dispatcher customer: next customer ID + its first admin login (temporary password shown once)', async () => {
  assert.equal(nextCustomerId([{ customerId: 'DD-1001' }]), 'DD-1002');
  assert.equal(nextCustomerId([]), 'DD-1001');
  const mm = new Map(); const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const app = express(); app.use(express.json());
  const made = [];
  initCompanies(app, { db, requireAdmin: (req, res, next) => { req.user = { name: 'Nadim', admin: true }; next(); }, createLogin: async (x) => { made.push(x); return { tempPassword: 'Truck-Rose-1234' }; } });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const list0 = await (await fetch(`${url}/platform/companies`)).json();
    assert.deepEqual(list0.map((c) => [c.id, c.customerId]), [['florida-beauty', 'DD-1001']]);
    const r = await (await fetch(`${url}/platform/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ABC Logistics', adminName: 'Ana', adminEmail: 'ana@abc.com' }) })).json();
    assert.equal(r.customerId, 'DD-1002'); assert.equal(r.id, 'abc-logistics'); assert.equal(r.admin.tempPassword, 'Truck-Rose-1234');
    assert.deepEqual(made[0], { email: 'ana@abc.com', name: 'Ana', company: 'abc-logistics', companyAdmin: true, by: 'Nadim' });
    const dup = await fetch(`${url}/platform/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ABC Logistics' }) });
    assert.equal(dup.status, 409);
  } finally { srv.close(); }
});

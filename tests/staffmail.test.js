import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffList, staffEmail, initStaffMail } from '../staffmail.js';

test('staff email: our addresses only; plain text → paragraphs + list; review copy says who it will go to', async () => {
  assert.deepEqual(staffList('strujillo@floridabeauty.us'), ['strujillo@floridabeauty.us']);
  assert.equal(staffList('someone@gmail.com'), null);
  assert.equal(staffList(['strujillo@floridabeauty.us', 'x@other.com']), null);
  const m = staffEmail({ subject: 'Sorry about the extra emails', body: 'Hi Saray,\n\nThat glitch is fixed:\n\n- one email per load\n- 3 h worse', copyFor: ['strujillo@floridabeauty.us'] });
  assert.match(m.subject, /^\[Copy for review\] Sorry/);
  assert.match(m.html, /<li[^>]*>one email per load<\/li>/);
  assert.match(m.html, /It will go to: strujillo@floridabeauty\.us/);
  assert.match(m.text, /^COPY FOR REVIEW/);
  assert.doesNotMatch(staffEmail({ subject: 'x', body: 'y' }).html, /Copy for review/);

  const routes = {}; const app = { post: (p, g, h) => { routes[`POST ${p}`] = h; }, get: (p, g, h) => { routes[`GET ${p}`] = h; } };
  const m2 = new Map(); const db = { get: async (k, fb) => (m2.has(k) ? JSON.parse(JSON.stringify(m2.get(k))) : fb), update: async (k, fn, fb) => { const v = fn(m2.has(k) ? m2.get(k) : fb); m2.set(k, v); return v; } };
  const sent = [];
  initStaffMail(app, { requireAdmin: () => {}, db, sendMail: async (x) => sent.push(x) });
  const call = async (k, req) => { let out; let code = 200; await routes[k]({ user: { name: 'Nadim' }, params: {}, ...req }, { status: (c) => { code = c; return { json: (j) => { out = j; } }; }, json: (j) => { out = j; } }); return { code, out }; };
  assert.equal((await call('POST /truckmate/staff-email/draft', { body: { to: 'a@gmail.com', subject: 's', body: 'b' } })).code, 400);
  const d = await call('POST /truckmate/staff-email/draft', { body: { to: 'strujillo@floridabeauty.us', subject: 'Sorry', body: 'Hi' } });
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']); assert.match(sent[0].subject, /Copy for review/);
  const s = await call('POST /truckmate/staff-email/:id/send', { params: { id: d.out.id } });
  assert.equal(s.out.ok, true); assert.deepEqual(sent[1].to, ['strujillo@floridabeauty.us']); assert.equal(sent[1].subject, 'Sorry');
  assert.equal((await call('POST /truckmate/staff-email/:id/send', { params: { id: d.out.id } })).out.already, true, 'never twice');
});

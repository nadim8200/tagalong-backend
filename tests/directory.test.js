import test from 'node:test';
import assert from 'node:assert/strict';
import { seedPeople, findStaff, mentionedStaff, publicView, initDirectory, employeeCalls } from '../directory.js';

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

test('every dispatch login sees the whole directory (cells too); nobody else does', async () => {
  const routes = {};
  initDirectory({ get: (p, ...h) => { routes[p] = h.at(-1); }, put: () => {}, post: () => {} }, { requireAuth: () => {}, requireAdmin: () => {}, db: memDb() });
  let out; const res = { json: (j) => { out = j; } };
  let code = 200; res.status = (c) => { code = c; return res; };
  await routes['/truckmate/directory']({ user: { role: 'dispatcher' } }, res);
  assert.equal(code, 200); assert.equal(out.people.find((p) => p.name === 'Frank Ducassi').phone, '3057485611');
  await routes['/truckmate/directory']({ user: { admin: true } }, res);
  assert.equal(out.people.find((p) => p.name === 'Frank Ducassi').phone, '3057485611');
  await routes['/truckmate/directory']({ user: { role: 'owner' } }, res);
  assert.equal(code, 403, 'a TagAlong customer never');
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

// call 10/13: "tell Ronan Colby to call me back" → Ronen Koubi (heard on the phone)
test('a staff name heard on the phone matches the one employee it sounds like', async () => {
  const { soundsLikeStaff } = await import('../directory.js');
  const people = [{ name: 'Ronen Koubi', phone: '3055550001' }, { name: 'Rosa Reategui' }, { name: 'Frank Ducassi' }, { name: 'Nadim Tellez' }];
  assert.deepEqual(soundsLikeStaff(people, 'Ronan Colby').map((p) => p.name), ['Ronen Koubi']);
  assert.deepEqual(soundsLikeStaff(people, 'Frank Ducasse').map((p) => p.name), ['Frank Ducassi']);
  assert.deepEqual(soundsLikeStaff(people, 'Maria'), []);
});

test('departments: admins add one before anyone is in it; its line is written on its people; edits keep the list', async () => {
  const puts = {}; const gets = {};
  initDirectory({ get: (p, ...h) => { gets[p] = h.at(-1); }, put: (p, ...h) => { puts[p] = h.at(-1); }, post: () => {} }, { requireAuth: () => {}, requireAdmin: () => {}, db: memDb() });
  let out; const res = { json: (j) => { out = j; }, status() { return res; } };
  await gets['/truckmate/directory']({ user: { admin: true } }, res);
  const people = out.people;
  await puts['/admin/directory/departments']({ body: { departments: [{ name: 'Billing', line: '271' }, { name: 'Quality Control', line: '700' }, { name: 'billing', line: 'dup' }] } }, res);
  assert.deepEqual(out.departments, [{ name: 'Billing', line: '271' }, { name: 'Quality Control', line: '700' }]);
  await gets['/truckmate/directory']({ user: { admin: true } }, res);
  assert.deepEqual(out.departments.map((x) => x.name), ['Billing', 'Quality Control'], 'an empty department is kept');
  assert.ok(out.people.filter((p) => p.department === 'Billing').every((p) => p.departmentExt === '271'), 'the line reaches its people');
  // saving one employee (no departments in the body) keeps the department list
  await puts['/admin/directory']({ body: { main: '305-503-1200', people: people.map((p) => (p.name === 'Frank Ducassi' ? { ...p, department: 'Quality Control' } : p)) } }, res);
  await gets['/truckmate/directory']({ user: { admin: true } }, res);
  assert.equal(out.departments.length, 2);
  assert.equal(out.people.find((p) => p.name === 'Frank Ducassi').department, 'Quality Control');
});

test('directory: an employee\'s Recents — Jarvis + desk calls, missed, and who sent a call from Employees', () => {
  const calls = employeeCalls({
    jarvis: [
      { id: 'call:a', at: '2026-10-25T12:29:00Z', direction: 'inbound', minutes: 2, summary: 'Asked about 2604', recording: 'https://r/a.wav', hasTranscript: true },
      { id: 'call:b', at: '2026-10-23T21:50:30Z', direction: 'outbound', minutes: 0.3, ended: 'dial_no_answer' },
      { id: 'call:c', at: '2026-10-23T21:52:00Z', direction: 'outbound', minutes: 0.4, ended: 'voicemail_reached' },
    ],
    desk: [{ id: 9, at: '2026-10-24T15:00:00Z', direction: 'Inbound', durationSec: 0, result: 'Missed', answered: false, extension: '201' }],
    staff: [
      { at: '2026-10-23T21:50:00Z', by: 'Nadim Tellez', message: 'Call me about 2604', result: { call: 'calling' } },
      { at: '2026-10-20T10:00:00Z', by: 'Ana', message: 'hi', result: { call: 'held (training mode)' } },
      { at: '2026-10-21T10:00:00Z', by: 'Ana', message: 'text only', result: { text: 'sent' } },
    ],
  });
  assert.deepEqual(calls.map((c) => c.id), ['call:a', 'rc:9', 'call:c', 'call:b', 'sent:2026-10-20T10:00:00Z']);
  assert.equal(calls[0].direction, 'in'); assert.equal(calls[0].missed, false); assert.equal(calls[0].recording, 'https://r/a.wav');
  assert.equal(calls[1].missed, true); assert.equal(calls[1].line, 'RingCentral'); assert.equal(calls[1].ext, '201');
  assert.equal(calls[2].status, 'Voicemail');
  assert.equal(calls[3].status, 'Not answered'); assert.equal(calls[3].sentBy, 'Nadim Tellez'); assert.equal(calls[3].message, 'Call me about 2604');
  assert.equal(calls[4].missed, true); assert.equal(calls[4].status, 'held (training mode)');
});

test('employees one at a time: add, edit, erase; a manager only adds, erases and fills in a missing email', async () => {
  const gets = {}; const puts = {}; const posts = {};
  const removed = []; const db = memDb();
  db.update = async (k, fn, fb) => { const v = fn(await db.get(k, fb)); await db.set(k, v); return v; };
  initDirectory({ get: (p, ...h) => { gets[p] = h.at(-1); }, put: (p, ...h) => { puts[p] = h.at(-1); }, post: (p, ...h) => { posts[p] = h.at(-1); } }, { requireAuth: () => {}, requireAdmin: () => {}, db, logins: { eraseProblem: async (p) => (p.name === 'Frank Ducassi' ? 'Only an admin can erase an admin.' : null), removeFor: async (p) => { removed.push(p.name); return true; } } });
  let out; let code = 200; const res = { json: (j) => { out = j; }, status(c) { code = c; return res; } };
  const go = async (fn, req) => { code = 200; await fn(req, res); return out; };
  const list = async () => (await go(gets['/truckmate/directory'], { user: { admin: true } })).people;
  const was = (await list()).length;
  assert.equal(out.can.manage, true);
  assert.equal((await go(gets['/truckmate/directory'], { user: { role: 'dispatcher' } })).can.manage, false);
  assert.equal((await go(gets['/truckmate/directory'], { user: { role: 'dispatcher', staffAdmin: true } })).can.manage, true);
  const add = posts['/admin/directory/people']; const edit = puts['/admin/directory/people/:id']; const erase = posts['/admin/directory/people/:id/erase'];
  await go(add, { body: { name: 'Liz Test', department: 'Dispatch', email: 'Liz@FloridaBeauty.us', phone: '(305) 555-0100' } });
  assert.equal(out.person.email, 'liz@floridabeauty.us'); assert.equal(out.person.phone, '3055550100');
  const id = out.person.id;
  assert.equal((await list()).length, was + 1); assert.equal(out.people[0].name, 'Liz Test');
  await go(add, { body: { name: 'Twin', email: 'liz@floridabeauty.us' } }); assert.equal(code, 409);
  await go(add, { body: { name: '  ' } }); assert.equal(code, 400);
  await go(edit, { params: { id }, body: { note: 'Night shift' } });
  assert.equal(out.person.note, 'Night shift'); assert.equal(out.person.phone, '3055550100', 'the rest stays');
  // an employee manager can't edit: only fill in a missing email
  await go(add, { body: { name: 'No Mail', department: 'Sales' } }); const blank = out.person.id;
  const staff = { user: { role: 'dispatcher' }, staffOnly: true };
  await go(edit, { ...staff, params: { id }, body: { email: 'other@floridabeauty.us' } }); assert.equal(code, 403);
  await go(edit, { ...staff, params: { id: blank }, body: { email: 'x@floridabeauty.us', name: 'Changed' } }); assert.equal(code, 403);
  await go(edit, { ...staff, params: { id: blank }, body: { email: 'nomail@floridabeauty.us' } }); assert.equal(code, 200); assert.equal(out.person.name, 'No Mail');
  // erase
  const frank = (await list()).find((p) => p.name === 'Frank Ducassi');
  await go(erase, { ...staff, params: { id: frank.id } }); assert.equal(code, 403); assert.deepEqual(removed, [], 'refused: the login stays too');
  assert.ok((await list()).some((p) => p.name === 'Frank Ducassi'));
  const req = { user: { name: 'Val' }, params: { id }, body: {} };
  await go(erase, req); assert.equal(code, 200); assert.equal(out.loginRemoved, true); assert.deepEqual(removed, ['Liz Test']);
  assert.deepEqual(req.body, { employee: 'Liz Test', loginRemoved: true }, 'the activity log names them');
  assert.ok(!(await list()).some((p) => p.id === id));
  assert.deepEqual(findStaff(await list(), 'Liz Test'), [], 'Jarvis no longer knows them');
  await go(erase, { user: {}, params: { id } }); assert.equal(code, 404);
  assert.equal((await db.get('taStaffErased', []))[0].by, 'Val');
});

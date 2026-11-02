import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cleanBody, auditLabel, auditEntry, auditTrail } from '../audit.js';
import { dispatcherMayUse } from '../dispatchers.js';

const staff = { id: 'D1', name: 'Giovanni Dimuro', role: 'dispatcher', company: 'fb' };

test('passwords, tokens and files never reach the record', () => {
  const c = cleanBody({ password: 'x', next: 'y', current: 'z', tempPassword: 'a', token: 'b', dataBase64: 'c', apiKey: 'd', trip: '626133', note: 'hotel', photos: [{ dataBase64: 'x', filename: 'a.jpg' }], nested: { authorization: 'e', ok: 1 } });
  assert.deepEqual(c, { trip: '626133', note: 'hotel', photos: '1 items', nested: { ok: 1 } });
  assert.equal(cleanBody('a'.repeat(500)).length, 201);
});

test('a staff change is signed with who, what and which load', () => {
  const e = auditEntry({ method: 'POST', path: '/watchtower/resolve', body: { id: 'x', note: 'hotel approved', trip: '626133' }, status: 200, user: staff, ip: '1.2.3.4', agent: 'iPhone' });
  assert.equal(e.actor, 'Giovanni Dimuro'); assert.equal(e.action, 'Resolved an alert'); assert.equal(e.trip, '626133'); assert.equal(e.role, 'dispatcher'); assert.equal(e.detail.note, 'hotel approved'); assert.equal(e.ip, '1.2.3.4');
  assert.equal(auditEntry({ method: 'POST', path: '/truckmate/breakdown/626133', status: 200, user: staff }).trip, '626133');
});

test('sign-ins are recorded good and bad, with no password, by the email tried', () => {
  const bad = auditEntry({ method: 'POST', path: '/auth/dispatcher/login', body: { email: 'A@B.CO', password: 'nope' }, status: 401 });
  assert.equal(bad.action, 'Failed sign-in'); assert.equal(bad.actor, 'a@b.co'); assert.equal(JSON.stringify(bad).includes('nope'), false);
  assert.equal(auditEntry({ method: 'POST', path: '/auth/dispatcher/login', body: { email: 'a@b.co' }, status: 200 }).action, 'Signed in');
  const pw = auditEntry({ method: 'POST', path: '/auth/dispatcher/password', body: { current: 'old', next: 'new', hint: 'x' }, status: 200, user: staff });
  assert.deepEqual(pw.detail, {});
});

test('email links sign with the name typed, and the link itself is never stored', () => {
  const e = auditEntry({ method: 'POST', path: '/sr/abc.secret', body: { status: 'authorized', reason: 'hotel', name: 'Sara' }, status: 200 });
  assert.equal(e.actor, 'Sara'); assert.equal(e.role, 'email link'); assert.equal(e.path, '/sr/link'); assert.equal(e.action, 'Answered a stop from an email link');
});

test('reads, customers, phone webhooks and noise are left out', () => {
  assert.equal(auditEntry({ method: 'GET', path: '/truckmate/active', status: 200, user: staff }), null);
  assert.equal(auditEntry({ method: 'POST', path: '/fleet/x', status: 200, user: { role: 'owner' } }), null);
  assert.equal(auditEntry({ method: 'POST', path: '/retell/fn/x', status: 200 }), null);
  assert.equal(auditEntry({ method: 'POST', path: '/jarvis/transcribe', status: 200, user: staff }), null);
});

test('anything without a name gets a plain fallback', () => assert.equal(auditLabel('PUT', '/truckmate/x'), 'Changed /truckmate/x'));

test('the record waits for the answer, keeps a refusal, and a failed save never hurts the request', async () => {
  const saved = [];
  const mw = auditTrail({ userOf: () => staff, write: (e) => { saved.push(e); return Promise.reject(new Error('db down')); } });
  const res = new EventEmitter(); let nexted = false;
  mw({ method: 'POST', originalUrl: '/admin/training?x=secret', body: {}, headers: {} }, res, () => { nexted = true; });
  assert.equal(nexted, true); assert.equal(saved.length, 0);
  res.statusCode = 403; res.emit('finish');
  await new Promise((r) => setImmediate(r));
  assert.equal(saved[0].status, 403); assert.equal(saved[0].path, '/admin/training', 'no query string');
  const get = auditTrail({ userOf: () => { throw new Error('bad'); }, write: () => saved.push('no') });
  const r2 = new EventEmitter(); get({ method: 'GET', headers: {} }, r2, () => {}); r2.emit('finish');
  assert.equal(saved.length, 1);
});

test('the log screen: company admins can open it, plain dispatchers cannot', () => {
  assert.equal(dispatcherMayUse('GET', '/admin/audit', { companyAdmin: true }), null);
  assert.equal(dispatcherMayUse('GET', '/admin/audit', { companyAdmin: false }), 'outside');
});

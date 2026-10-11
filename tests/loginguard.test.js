import test from 'node:test';
import assert from 'node:assert/strict';
import { loginGuard, loginGuardMiddleware, sessionTooOld } from '../loginguard.js';
import { initDbpo } from '../dbpo.js';

test('password guessing: 6 wrong tries on one email → locked 15 min; a success clears it; other emails unaffected', () => {
  let t = 0; const g = loginGuard({ now: () => t });
  for (let i = 0; i < 6; i++) { assert.equal(g.blocked('1.1.1.1', 'gus@x.com'), 0); g.failed('1.1.1.1', 'gus@x.com'); }
  assert.ok(g.blocked('1.1.1.1', 'gus@x.com') > 0);
  assert.equal(g.blocked('2.2.2.2', 'ana@x.com'), 0);
  t += 15 * 60000 + 1;
  assert.equal(g.blocked('1.1.1.1', 'gus@x.com'), 0, 'unlocks after 15 minutes');
  g.failed('1.1.1.1', 'gus@x.com'); g.succeeded('1.1.1.1', 'gus@x.com');
  assert.equal(g.blocked('1.1.1.1', 'gus@x.com'), 0);
});

test('one address trying many emails is locked after 30 failures', () => {
  const g = loginGuard({ now: () => 0 });
  for (let i = 0; i < 30; i++) g.failed('9.9.9.9', `u${i}@x.com`);
  assert.ok(g.blocked('9.9.9.9', 'new@x.com') > 0);
});

test('middleware answers 429 with Retry-After once locked, and counts 401 responses', () => {
  const g = loginGuard({ now: () => 0 });
  const mw = loginGuardMiddleware(g);
  const fire = () => { let code = 0; let fin; const res = { statusCode: 401, set() {}, status(c) { code = c; return { json() {} }; }, on(ev, f) { fin = f; } }; let passed = false; mw({ headers: { 'x-forwarded-for': '5.5.5.5' }, body: { email: 'A@x.com' } }, res, () => { passed = true; }); if (passed && fin) fin(); return passed ? 'next' : code; };
  for (let i = 0; i < 6; i++) assert.equal(fire(), 'next');
  assert.equal(fire(), 429);
});

test('admin and dispatcher sessions end after 7 days; customer sessions do not', () => {
  const now = 1_800_000_000; const old = now - 8 * 86400; const fresh = now - 86400;
  assert.equal(sessionTooOld({ admin: true, iat: old }, now), true);
  assert.equal(sessionTooOld({ role: 'dispatcher', iat: old }, now), true);
  assert.equal(sessionTooOld({ admin: true, iat: fresh }, now), false);
  assert.equal(sessionTooOld({ role: 'owner', iat: old }, now), false);
});

test('BPO health-screening records are never open: no sign-in and no token → refused', async () => {
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const db = { enabled: true, get: async (k, fb) => fb, set: async () => {}, update: async (k, fn, fb) => fn(fb) };
  const requireAuth = (req, res) => res.status(401).json({ error: 'Not signed in.' });
  initDbpo(app, { db, requireAuth });
  const [gate] = routes['GET /dbpo/state'];
  let code = 0; let passed = false;
  gate({ headers: {} }, { status: (c) => { code = c; return { json() {} }; } }, () => { passed = true; });
  assert.equal(passed, false); assert.equal(code, 401);
});

test('the owner\'s own login keeps its long session; other admins still end after 7 days', () => {
  const now = 1_800_000_000; const old = now - 30 * 86400;
  assert.equal(sessionTooOld({ admin: true, email: 'NTellez@floridabeauty.us', iat: old }, now, {}), false);
  assert.equal(sessionTooOld({ admin: true, email: 'frank@floridabeauty.us', iat: old }, now, {}), true);
  assert.equal(sessionTooOld({ admin: true, email: 'frank@floridabeauty.us', iat: old }, now, { LONG_SESSION_EMAILS: 'frank@floridabeauty.us' }), false);
});

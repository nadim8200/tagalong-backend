import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pickAccount, initSignin, HOME } from '../signin.js';

test('pickAccount: admin before dispatcher before fleet / owner / broker / family; a pin wins', () => {
  const m = (kind) => ({ kind, token: `t-${kind}`, user: { email: 'a@x.com' } });
  assert.equal(pickAccount([m('owner'), m('dispatcher')]).chosen.kind, 'dispatcher');
  assert.deepEqual(pickAccount([m('owner'), m('dispatcher')]).others, ['owner']);
  assert.equal(pickAccount([m('broker'), m('owner')]).chosen.kind, 'owner');
  assert.equal(pickAccount([m('broker'), m('owner')], 'broker').chosen.kind, 'broker');
  assert.equal(pickAccount([m('owner')], 'fleet').chosen.kind, 'owner', 'a pin for an account they do not have is ignored');
  assert.equal(pickAccount([null, { kind: 'owner' }]), null, 'no token → no match');
});

async function serve(checks, db = null) {
  const app = express(); app.use(express.json());
  const cookies = [];
  initSignin(app, { checks, db, setCookie: (res, t, kind) => cookies.push([t, kind]) });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = async (body) => { const r = await fetch(`${url}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { post, cookies, close: () => srv.close() };
}

test('/auth/signin: one form — lands on the service the account is for', async () => {
  const s = await serve({
    traccar: async (e, pw) => (e === 'ronen@floridabeauty.us' && pw === 'pw' ? { kind: 'owner', user: { id: 1, email: e, role: 'owner' }, token: 'T1' } : null),
    dispatcher: async (e, pw) => (e === 'val@floridabeauty.us' && pw === 'pw' ? { user: { id: 'D1', email: e, role: 'dispatcher' }, token: 'D1', mustChange: true } : e === 'off@x.com' ? { error: 'This dispatcher account is turned off. Ask an admin.', status: 403 } : null),
    broker: async (e, pw) => (e === 'b@x.com' && pw === 'pw' ? { user: { id: 'B1', email: e, role: 'broker' }, token: 'B1' } : null),
    fleet: async () => { throw new Error('db down'); },
  });
  try {
    const owner = await s.post({ email: 'Ronen@FloridaBeauty.us ', password: 'pw' });
    assert.equal(owner.status, 200); assert.equal(owner.body.kind, 'owner'); assert.equal(owner.body.home, HOME.owner); assert.equal(owner.body.token, 'T1');
    const disp = await s.post({ email: 'val@floridabeauty.us', password: 'pw' });
    assert.equal(disp.body.kind, 'dispatcher'); assert.equal(disp.body.home, '/truckmate?admin'); assert.equal(disp.body.mustChange, true);
    assert.equal((await s.post({ email: 'b@x.com', password: 'pw' })).body.home, '/broker');
    const wrong = await s.post({ email: 'ronen@floridabeauty.is', password: 'pw' });
    assert.equal(wrong.status, 401); assert.equal(wrong.body.error, 'Wrong email or password.');
    const off = await s.post({ email: 'off@x.com', password: 'pw' });
    assert.equal(off.status, 403); assert.match(off.body.error, /turned off/);
    assert.deepEqual(s.cookies.map((c) => c[1]), ['owner', 'dispatcher', 'broker']);
  } finally { s.close(); }
});


test('/auth/signin: one email with a TagAlong car AND a dispatcher login → both come back, as tabs to pick', async () => {
  const s = await serve({
    traccar: async (e) => (e === 'sarai@floridabeauty.us' ? { kind: 'owner', user: { id: 9, email: e, role: 'owner' }, token: 'T9' } : null),
    dispatcher: async (e) => (e === 'sarai@floridabeauty.us' ? { user: { id: 'D9', email: e, role: 'dispatcher' }, token: 'D9' } : null),
  });
  try {
    const r = await s.post({ email: 'sarai@floridabeauty.us', password: 'pw' });
    assert.equal(r.body.kind, 'dispatcher');
    assert.deepEqual(r.body.accounts.map((a) => [a.kind, a.label, a.home, a.token]), [['dispatcher', 'AI Dispatcher console', '/truckmate?admin', 'D9'], ['owner', 'TagAlong app', '/', 'T9']]);
    const one = await s.post({ email: 'nobody-else@x.com', password: 'pw' });
    assert.equal(one.status, 401);
  } finally { s.close(); }
});

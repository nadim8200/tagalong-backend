import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyRule, holdsDevice, sneakyPath, allowRoles } from '../access.js';
import { dispatcherMayUse } from '../dispatchers.js';

const owner = { id: 12, role: 'owner' }; const broker = { id: 'B1', role: 'broker' }; const member = { id: 'M1', role: 'member' }; const fleet = { id: 'F1', role: 'fleet' };

test('Traccar proxy: a customer gets their app, never admin powers', () => {
  assert.equal(proxyRule({ role: 'admin', admin: true }, 'PUT', 'users/5').ok, true, 'admin: everything');
  for (const u of [owner, broker, member, fleet]) {
    assert.ok(proxyRule(u, 'GET', 'devices').ok, `${u.role} reads its cars`);
    assert.ok(proxyRule(u, 'POST', 'session/token').deny, `${u.role}: no admin token`);
    assert.ok(proxyRule(u, 'GET', 'users').deny, `${u.role}: no user list`);
    assert.ok(proxyRule(u, 'POST', 'permissions', { userId: 12, deviceId: 7 }).deny, `${u.role}: cannot grant itself cars`);
    assert.ok(proxyRule(u, 'PUT', 'server').deny);
    assert.ok(proxyRule(u, 'GET', './users').deny, 'no path tricks');
  }
  assert.ok(proxyRule(owner, 'PUT', 'users/99', {}).deny, 'only your own profile');
  const self = proxyRule(owner, 'PUT', 'users/12', { id: 12, name: 'Ronen', administrator: true, attributes: { account: 'A-2', phone: '1' } });
  assert.equal(self.ok, true); assert.equal(self.body.administrator, undefined); assert.equal(self.body.attributes.account, undefined); assert.equal(self.body.attributes.phone, '1');
  assert.deepEqual(proxyRule(owner, 'POST', 'commands/send', { deviceId: 7, type: 'engineStop' }), { ok: true, device: 7 }, 'engine stop: only after the server checks the car is theirs');
  assert.ok(proxyRule(owner, 'POST', 'commands/send', { deviceId: 7, type: 'custom', attributes: { data: 'x' } }).deny);
  assert.ok(proxyRule(broker, 'POST', 'commands/send', { deviceId: 7, type: 'engineStop' }).deny, 'brokers: no engine cut');
  assert.deepEqual(proxyRule(owner, 'POST', 'permissions', { deviceId: 7, geofenceId: 3 }), { ok: true, device: 7 });
  assert.ok(proxyRule(fleet, 'PUT', 'devices/7').deny, 'fleet: read only');
  assert.ok(proxyRule({ id: 'D', role: 'dispatcher' }, 'GET', 'devices').deny);
  assert.ok(proxyRule(owner, 'GET', 'reports/route').ok); assert.ok(proxyRule(owner, 'GET', 'reports/route/xlsx').deny);
  assert.equal(sneakyPath('devices'), false); assert.equal(sneakyPath('%2e%2e/users'), true);
});

test('holdsDevice: owner / approved family / approved broker / its fleet', () => {
  const d = { id: 7, attributes: { ownerUserId: 12, memberLinks: [{ memberId: 'M1', status: 'approved' }], brokerLinks: [{ brokerId: 'B1', status: 'pending' }], taFleetId: 'F1' } };
  assert.equal(holdsDevice(owner, d, { ownerOwns: (x) => x.attributes.ownerUserId === 12 }), true);
  assert.equal(holdsDevice({ id: 13, role: 'owner' }, d, { ownerOwns: () => false }), false);
  assert.equal(holdsDevice(member, d), true);
  assert.equal(holdsDevice(broker, d), false, 'pending is not approved');
  assert.equal(holdsDevice(fleet, d), true);
});

test('module gates: RingCentral for dispatch, Samsara / loads for fleet — customers get 403', () => {
  const run = (gate, user) => { let code = 200; gate({ user }, { status: (c) => { code = c; return { json: () => {} }; } }, () => {}); return code; };
  assert.equal(run(allowRoles('dispatcher'), owner), 403);
  assert.equal(run(allowRoles('dispatcher'), { role: 'dispatcher' }), 200);
  assert.equal(run(allowRoles('fleet'), broker), 403);
  assert.equal(run(allowRoles('fleet'), { role: 'admin', admin: true }), 200);
});

test('dispatcher logins: upper-case paths do not slip past the settings lock', () => {
  assert.equal(dispatcherMayUse('PUT', '/Truckmate/Profiles/5'), 'settings');
  assert.equal(dispatcherMayUse('POST', '/VOICE/setup'), 'settings');
  assert.equal(dispatcherMayUse('GET', '/truckmate/active'), null);
});

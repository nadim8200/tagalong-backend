import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, initAssistant } from '../assistant.js';

test('phones and emails are masked everywhere', () => {
  const out = mask({ driverPhone: '786-326-1126', note: 'call Israel 413-883-7695 or ana@rosebrokers.com', to: '+13055550101', pieces: 482, trip: '624393' });
  assert.equal(out.driverPhone, '***-***-1126');
  assert.equal(out.note, 'call Israel ***-***-7695 or a***@rosebrokers.com');
  assert.equal(out.to, '***-***-0101');
  assert.equal(out.pieces, 482); assert.equal(out.trip, '624393');
});

test('needs the read-only key; GET only; masked answers', async () => {
  const routes = {}; const methods = [];
  const app = { get: (p, ...h) => { methods.push('GET'); routes[p] = h; }, post: () => methods.push('POST'), put: () => methods.push('PUT'), delete: () => methods.push('DELETE') };
  const env = { ASSISTANT_READ_KEY: 'k'.repeat(40) };
  const board = { trips: [{ trip: { tripNumber: '624393', powerUnit: '2607', status: 'DISP' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'LOMBARD, IL, 60148', pieces: 483 }], _oc: { driverPhone: '7864394668', truck: '77' } }] };
  initAssistant(app, { db: { enabled: false }, env, buildBoard: async () => board });
  assert.ok(methods.every((m) => m === 'GET'));
  const call = async (path, key, params = {}) => {
    let code = 200; let body;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
    const req = { path, params, query: {}, get: (h) => (h === 'x-assistant-key' ? key : undefined) };
    const [guard, handler] = routes[path];
    await new Promise((resolve) => { guard(req, res, async () => { await handler(req, res); resolve(); }); if (code !== 200) resolve(); });
    return { code, body };
  };
  assert.equal((await call('/assistant/board', 'wrong')).code, 401);
  const ok = await call('/assistant/trip/:trip', 'k'.repeat(40), { trip: '624393' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.truck, '2607');
  assert.ok(!JSON.stringify(ok.body).includes('7864394668'));
  env.ASSISTANT_READ_KEY = '';
  assert.equal((await call('/assistant/board', 'x')).code, 503);
});

test('one truck straight from Samsara, loaded or not: where, moving, engine, fuel, who is logged in, its load (Nov 21)', async () => {
  const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h; } };
  const env = { ASSISTANT_READ_KEY: 'k'.repeat(40) };
  const idx = {
    fetchedAt: '2026-11-22T14:20:00Z', driversByCode: {}, reeferByKey: {}, vehByUnit: { 4504: { name: '4504', staticAssignedDriver: { name: 'Ferney Urrego' } } },
    statsByUnit: { 4504: { name: '4504', gps: { latitude: 25.82, longitude: -80.32, speedMilesPerHour: 0, time: new Date(Date.now() - 6 * 60000).toISOString(), reverseGeo: { formattedLocation: 'NW 70th Ave, Miami, FL' } }, engineState: { value: 'Off' }, fuelPercent: { value: 64 } } },
    hosById: { 11: { driverName: 'Ferney Urrego', status: 'offDuty', vehicle: '4504', driveLeftMin: 660, shiftLeftMin: 840, cycleLeftMin: 2100 }, 12: { driverName: 'Someone Else', status: 'driving', vehicle: '2210' } },
  };
  const board = { trips: [{ trip: { tripNumber: '627999', powerUnit: '2210', status: 'DEPSHIP' } }] };
  initAssistant(app, { db: { enabled: false }, env, buildBoard: async () => board, liveIndex: async () => idx });
  const call = async (unit) => {
    let code = 200; let body;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
    const req = { params: { unit }, query: {}, get: (h) => (h === 'x-assistant-key' ? 'k'.repeat(40) : undefined) };
    const [guard, handler] = routes['/assistant/truck/:unit'];
    await new Promise((resolve) => { guard(req, res, async () => { await handler(req, res); resolve(); }); });
    return { code, body };
  };
  const r = await call('04504');
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.truck, r.body.location, r.body.moving, r.body.engine, r.body.fuelPct, r.body.gpsMinutesAgo], ['4504', 'NW 70th Ave, Miami, FL', false, 'Off', 64, 6]);
  assert.deepEqual(r.body.loggedIn.map((d) => [d.name, d.status, d.driveLeftMin]), [['Ferney Urrego', 'offDuty', 660]]);
  assert.deepEqual(r.body.loads, [], 'between loads');
  assert.equal((await call('9999')).code, 404);
});

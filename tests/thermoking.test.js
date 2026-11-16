import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initThermoKing, latestByTrailer, needLogin, cToF, tkStamp, MAX_LOGINS_A_DAY } from '../thermoking.js';

const NOW = Date.parse('2026-11-16T18:00:00Z');
const unit = (name, retC, setC, at) => ({ vehicleName: name, externalId: name, reeferSerialNumber: '600', dataDate: at, returnAir1: retC, dischargeAir1: retC - 1, setPoint1: setC, powerOn: true, alarms: [{ alarmCode: 3, alarmDescription: 'Check Return Air Sensor', alarmSeverity: 'Y' }], latitude: 25.8, longitude: -80.3, locationDescription: 'Miami, FL' });

test('readings in °C / UTC → °F per trailer, newest wins; "07200" is trailer 7200', () => {
  assert.equal(cToF(1.7), 35.1); assert.equal(cToF(null), null);
  assert.equal(tkStamp(NOW), '2026-11-16 18:00:00');
  const r = latestByTrailer({ data: [unit('07200', 2, 1.7, '2026-11-16 17:40:00'), unit('7200', 5, 1.7, '2026-11-16 17:55:00'), unit('2077', 1.5, 1.7, '2026-11-16T17:50:00.000+0000')] });
  assert.equal(r['7200'].returnF, 41); assert.equal(r['7200'].at, '2026-11-16T17:55:00.000Z');
  assert.equal(r['2077'].setF, 35.1); assert.equal(r['2077'].alarms[0].text, 'Check Return Air Sensor');
  assert.deepEqual(Object.keys(latestByTrailer([unit('7137', 2, 2, '2026-11-16 17:00:00')])), ['7137'], 'v1 answers are a plain list');
});

test('login at most once a day and never past the cap or while blocked', () => {
  const day = '2026-11-16';
  assert.equal(needLogin({}, NOW, day), true);
  assert.equal(needLogin({ accessToken: 't', obtainedAt: NOW - 3600000, refreshExpiresAt: NOW + 4 * 86400000 }, NOW, day), false);
  assert.equal(needLogin({ accessToken: 't', obtainedAt: NOW - 25 * 3600000 }, NOW, day), true, 'a day old');
  assert.equal(needLogin({ accessToken: 't', obtainedAt: NOW - 3600000, refreshExpiresAt: NOW + 3600000 }, NOW, day), true, 'refresh runs out soon');
  assert.equal(needLogin({ attempts: { [day]: MAX_LOGINS_A_DAY } }, NOW, day), false, 'daily cap');
  assert.equal(needLogin({ blockedUntil: NOW + 1 }, NOW, day), false, 'blocked (423)');
});

test('poll: one login, then readings with the token; a 423 stops logins for 24 h; the board gets fresh readings by trailer', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const calls = [];
  let block = false;
  const fetchFn = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', h: o.headers || {} });
    if (/obtainToken/.test(url)) return block ? { ok: false, status: 423, json: async () => ({ status: 423 }) } : { ok: true, status: 200, json: async () => ({ accessToken: 'TOK', expiresIn: 400000 }) };
    return { ok: true, status: 200, json: async () => [unit('7200', 5, 1.7, '2026-11-16 17:55:00')] };
  };
  const env = { NODE_ENV: 'test', THERMOKING_USER: 'u', THERMOKING_PASSWORD: 'p', THERMOKING_CUSTOMER_ID: 'C-1' };
  let clock = NOW;
  const tk = initThermoKing({ db, env, fetchFn, now: () => clock });
  await tk.poll(); clock += 15 * 60000; await tk.poll();
  assert.equal(calls.filter((c) => /obtainToken/.test(c.url)).length, 1, 'one login');
  const reads = calls.filter((c) => /getTemperatureDataForVehicles/.test(c.url));
  assert.equal(reads.length, 2); assert.equal(reads[1].h['X-OAuth2-Token'], 'TOK'); assert.equal(reads[1].h['X-External-ID'], 'C-1');
  assert.match(reads[0].url, /getTemperatureDataForVehicles\/2026-11-16%2016%3A00%3A00\/2026-11-16%2018%3A00%3A00\/$/);
  assert.ok(!calls.some((c) => /command/i.test(c.url)), 'never the Command API');
  const trips = [{ trip: { tripNumber: '627130', trailer: '7200' } }, { trip: { tripNumber: '1', trailer: '9999' } }];
  await tk.overlay('s', trips);
  assert.equal(trips[0]._tkApi.returnF, 41); assert.equal(trips[1]._tkApi, undefined);
  // blocked: no more logins for a day
  m.set('taThermoKingToken', {}); block = true;
  await tk.poll().catch(() => {}); await tk.poll().catch(() => {});
  assert.equal(calls.filter((c) => /obtainToken/.test(c.url)).length, 2, 'one try, then waits');
  assert.ok(m.get('taThermoKingToken').blockedUntil > clock);
});

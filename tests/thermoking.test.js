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
  assert.equal(reads.length, 9, '7 one-time days back (they came back with readings: not again) + 2 regular reads'); assert.equal(reads[8].h['X-OAuth2-Token'], 'TOK'); assert.equal(reads[8].h['X-External-ID'], 'C-1');
  assert.match(reads[0].url, /getTemperatureDataForVehicles\/2026-11-16%2016%3A00%3A00\/2026-11-16%2018%3A00%3A00\/$/);
  assert.match(reads[1].url, /getTemperatureDataForVehicles\/2026-11-09%2018%3A00%3A00\/2026-11-10%2018%3A00%3A00\/$/, 'look-back: 24 h windows, 7 days');
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

test('parked since: from the readings — stays within half a mile and still → keeps the time; moves → starts over', async () => {
  const { parkedSinceOf, nextParked } = await import('../thermoking.js');
  const r = (at, lat, lng, mph = 0) => ({ at, lat, lng, mph });
  assert.deepEqual(parkedSinceOf([r('2026-11-13T10:00:00Z', 33.0, -84.0, 60), r('2026-11-13T12:00:00Z', 33.5, -84.2), r('2026-11-15T12:00:00Z', 33.5001, -84.2001)]), { parkedSince: '2026-11-13T12:00:00Z', atLeast: false });
  assert.deepEqual(parkedSinceOf([r('2026-11-13T12:00:00Z', 33.5, -84.2), r('2026-11-15T12:00:00Z', 33.5, -84.2)]), { parkedSince: '2026-11-13T12:00:00Z', atLeast: true }, 'parked at our oldest reading');
  const prev = { at: '2026-11-15T12:00:00Z', lat: 33.5, lng: -84.2, parkedSince: '2026-11-13T12:00:00Z', atLeast: false };
  assert.equal(nextParked(prev, r('2026-11-16T12:00:00Z', 33.5, -84.2)).parkedSince, '2026-11-13T12:00:00Z');
  assert.equal(nextParked(prev, r('2026-11-16T12:00:00Z', 34.0, -84.2)).parkedSince, '2026-11-16T12:00:00Z');
});

test('token expired and the new login is refused: the status says the login was refused (Thermo King\'s words), no login spent twice an hour', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const env = { THERMOKING_USER: 'u', THERMOKING_PASSWORD: 'p', THERMOKING_CUSTOMER_ID: 'c' };
  let clock = Date.parse('2026-11-17T14:00:00Z'); const calls = [];
  m.set('taThermoKingToken', { accessToken: 'old', obtainedAt: clock - 2 * 86400000 + 3600000, attempts: {} });   // logged in ~2 days ago
  const fetchFn = async (url, o = {}) => {
    calls.push(url.includes('obtainToken') ? 'login' : 'read');
    if (url.includes('obtainToken')) return { status: 403, ok: false, json: async () => ({ message: 'User account is disabled' }) };
    return { status: 403, ok: false, json: async () => ({}) };
  };
  const routes = {}; const app = { get: (p, a, h) => { routes[p] = h; }, post: () => {} };
  const tk = initThermoKing({ app, requireAuth: () => {}, db, env, fetchFn, now: () => clock });
  const r1 = await tk.poll();
  assert.match(r1.error, /login refused \(HTTP 403\): User account is disabled/);
  assert.equal(JSON.stringify(m.get('taThermoKingToken')).includes('"p"'), false, 'the password is never stored');
  let out; await routes['/truckmate/thermoking/status']({}, { json: (j) => { out = j; } });
  assert.match(out.loginError, /User account is disabled/);
  assert.equal(out.loginsToday, 2, 'the daily-age login + the refused-read retry');
  clock += 15 * 60000; calls.length = 0;
  await tk.poll();
  assert.ok(calls.filter((c) => c === 'login').length <= 1, 'at most one more login, then the daily cap holds');
});

test('retry now: a dispatcher can try the login past the 3-a-day cap (5 a day), and hears the result', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const env = { THERMOKING_USER: 'u', THERMOKING_PASSWORD: 'p', THERMOKING_CUSTOMER_ID: 'c' };
  const clock = Date.parse('2026-11-17T17:00:00Z'); const day = new Date(clock).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  m.set('taThermoKingToken', { accessToken: 'old', obtainedAt: clock - 2 * 86400000, attempts: { [day]: 3 } });   // today's 3 used
  let ok = false;
  const fetchFn = async (url) => (url.includes('obtainToken')
    ? (ok ? { status: 200, ok: true, json: async () => ({ accessToken: 'NEW', expiresIn: 172800 }) } : { status: 403, ok: false, json: async () => ({ message: 'Invalid username or password' }) })
    : { status: 200, ok: true, json: async () => [] });
  const routes = {}; const app = { get: () => {}, post: (p, a, h) => { routes[p] = h; } };
  initThermoKing({ app, requireAuth: () => {}, db, env, fetchFn, now: () => clock });
  const call = async () => { let out; await routes['/truckmate/thermoking/retry']({}, { json: (j) => { out = j; }, status: () => ({ json: (j) => { out = j; } }) }); return out; };
  const a = await call();
  assert.equal(a.login, 'refused'); assert.match(a.error, /Invalid username or password/);
  ok = true;
  const b = await call();
  assert.equal(b.login, 'ok'); assert.equal(b.ok, true);
  assert.equal(m.get('taThermoKingToken').accessToken, 'NEW');
  for (let i = 0; i < 3; i += 1) await call();
  const f = await call();
  assert.match(f.error, /Already retried 5 times today/);
});

test('parked: a trailer that sat at a customer before Jarvis was watching gets its time from the look-back; never seen moving since tracking began → listed after 12 h, marked', async () => {
  const { yardReport } = await import('../yardreport.js');
  const NOW2 = Date.parse('2026-11-17T20:42:00Z');
  const units = {
    7300: { trailer: '7300', lat: 35.2, lng: -80.8, at: '2026-11-17T20:30:00Z', parkedSince: '2026-11-16T23:25:00Z', atLeast: true, location: 'Charlotte, NC' },   // never moved since tracking began
    7301: { trailer: '7301', lat: 27.95, lng: -82.46, at: '2026-11-17T20:30:00Z', parkedSince: '2026-11-17T15:00:00Z', atLeast: false, location: 'Tampa, FL' },   // moved today
    7302: { trailer: '7302', lat: 35.2, lng: -80.8, at: '2026-11-17T20:30:00Z', parkedSince: '2026-11-13T10:00:00Z', atLeast: true, location: 'Charlotte, NC' },   // 4 days (look-back)
  };
  const r = yardReport({ units, items: [], points: {}, now: NOW2, trackingSince: '2026-11-16T23:25:00Z' });
  const byT = Object.fromEntries(r.parked.map((p) => [p.trailer, p]));
  assert.equal(byT['7300'].sinceTracking, true); assert.equal(byT['7300'].hours, 21);
  assert.equal(byT['7302'].sinceTracking, false); assert.equal(byT['7302'].days, 4);
  assert.equal(byT['7301'], undefined, 'moved today: not parked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRecipe, trailersToRead, initReeferAgent, noteRead, skipNoTemp } from '../reeferagent.js';

test('recipe: only read-only steps are accepted', () => {
  const ok = cleanRecipe({ windowTitle: 'TruckMate', steps: [{ do: 'click', x: 0.1, y: 0.2 }, { do: 'type', text: '{trailer}' }, { do: 'key', key: 'enter' }, { do: 'wait', ms: 1500 }, { do: 'doubleclick', x: 0.5, y: 0.5 }, { do: 'shot' }] });
  assert.equal(ok.ok, true); assert.deepEqual(ok.recipe.after, [{ do: 'key', key: 'ESC' }]);
  assert.match(cleanRecipe({ steps: [{ do: 'type', text: 'DELETE' }, { do: 'shot' }] }).error, /only the trailer number/);
  assert.match(cleanRecipe({ steps: [{ do: 'key', key: 'DEL' }, { do: 'shot' }] }).error, /key must be one of/);
  assert.equal(cleanRecipe({ steps: [{ do: 'key', key: 'menu' }, { do: 'key', key: 'w' }, { do: 'shot' }], after: [{ do: 'key', key: 'alt+c' }] }).recipe.after[0].key, 'ALT+C');
  assert.match(cleanRecipe({ steps: [{ do: 'key', key: 'ALT+F4' }, { do: 'shot' }] }).error, /key must be one of/);
  assert.match(cleanRecipe({ steps: [{ do: 'key', key: 'CTRL+S' }, { do: 'shot' }] }).error, /key must be one of/);
  assert.match(cleanRecipe({ steps: [{ do: 'click', x: 2, y: 0 }, { do: 'shot' }] }).error, /x and y are 0–1/);
  assert.match(cleanRecipe({ steps: [{ do: 'click', x: 0.1, y: 0.1 }] }).error, /screenshot/);
  assert.match(cleanRecipe({ steps: [{ do: 'drag' }, { do: 'shot' }] }).error, /not allowed/);
});

test('trailers to read: active company loads, one per trailer, no outside carriers', () => {
  const t = (n, trailer, x = {}) => ({ trip: { tripNumber: n, trailer, powerUnit: '2403', status: 'DISP', ...(x.trip || {}) }, freightBills: [{ temperature: 34 }], ...(x.item || {}) });
  assert.deepEqual(trailersToRead([t('1', '7303'), t('2', '7303'), t('3', '7296'), t('4', '7650', { item: { _oc: {} } }), t('5', '7651', { trip: { status: 'CANCL' } }), t('6', '')]), [{ trailer: '7303', trip: '1' }, { trailer: '7296', trip: '3' }]);
  assert.deepEqual(trailersToRead([{ trip: { tripNumber: '7', trailer: '7400', status: 'DISP' }, freightBills: [{ temperature: null }] }]), [], 'dry load: not read');
  assert.equal(trailersToRead([{ trip: { tripNumber: '8', trailer: '7401', status: 'DISP' }, _ratecon: { tempSetting: '34-36F' } }]).length, 1, 'rate con temperature: read');
});

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
test('agent: needs its key; a reading lands on the trailer; a wrong window skips that trailer', async () => {
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  const db = memDb();
  let ai = { isReeferEvents: true, trailer: '7303', returnTemp: 34.5, setTemp: 34, supplyTemp: 33, tempUnits: 'F' };
  const fetchFn = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(ai) }] }) });
  const board = { trips: [{ trip: { tripNumber: '621053', trailer: '7303', status: 'DEPSHIP' }, freightBills: [{ temperature: 34 }] }] };
  const ra = initReeferAgent(app, { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), db, getBoard: async () => board, env: { ANTHROPIC_API_KEY: 'x' }, fetchFn });
  let out; let code = 200; const res = { status(c) { code = c; return this; }, json(j) { out = j; return this; }, type() { return this; }, send() { return this; }, end() { return this; } };
  const req = (body = {}, key = '') => ({ body, get: (h) => (h === 'x-agent-key' ? key : ''), user: { name: 'Nadim' } });
  await routes['GET /reefer-agent/jobs'](req(), res); assert.equal(code, 401);
  code = 200; await routes['POST /truckmate/reefer-agent/key'](req(), res); const key = out.key; assert.match(key, /^RA-/);
  await routes['GET /reefer-agent/jobs'](req({}, key), res); assert.equal(out.recipe, null); assert.deepEqual(out.trailers, [{ trailer: '7303', trip: '621053' }]);
  await routes['POST /reefer-agent/shot'](req({ kind: 'reading', trailer: '7303', trip: '621053', png: 'aGk=' }, key), res); assert.equal(out.ok, true);
  await ra.overlay('florida-beauty', board.trips);
  assert.equal(board.trips[0]._tkReefer.reading.returnTemp, 34.5);
  ai = { isReeferEvents: false };
  await routes['POST /reefer-agent/shot'](req({ kind: 'reading', trailer: '7303', png: 'aGk=' }, key), res);
  assert.equal(out.skip, true); assert.equal(out.stop, undefined); assert.match(out.why, /not the Reefer Events window/);
  await routes['GET /truckmate/reefer-agent/status'](req(), res);
  assert.equal(out.shots[0].kind, 'unexpected'); assert.equal(out.shots[0].png, undefined, 'no picture in the status list');
  code = 200; await routes['PUT /truckmate/reefer-agent/recipe'](req({ steps: [{ do: 'key', key: 'F2' }, { do: 'shot' }] }), res); assert.equal(code, 400);
});

test('enrollment: the agent waits, an admin approves, the agent gets its key once', async () => {
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  initReeferAgent(app, { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), db: memDb(), getBoard: async () => ({ trips: [] }), env: {} });
  let out; let code = 200; const res = { status(c) { code = c; return this; }, json(j) { out = j; return this; } };
  const id = 'abcdefghijklmnop1234';
  await routes['POST /reefer-agent/enroll']({ body: { id, machine: 'EC2AMAZ' } }, res); assert.equal(out.waiting, true);
  await routes['POST /truckmate/reefer-agent/approve']({ user: { name: 'Nadim' } }, res); assert.equal(out.ok, true); assert.equal(out.key, undefined, 'the admin never sees the key');
  await routes['POST /reefer-agent/enroll']({ body: { id } }, res); assert.equal(out.approved, true); assert.match(out.key, /^RA-/);
  const key = out.key;
  await routes['POST /reefer-agent/enroll']({ body: { id } }, res); assert.notEqual(out.key, key, 'handed over once');
  await routes['GET /reefer-agent/jobs']({ get: () => key }, res); assert.notEqual(code, 401);
});

test('every 2 hours: after a full read the hourly check-in gets no trailers, and its empty run is not recorded', async () => {
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  let t = Date.parse('2026-11-11T02:00:00Z');
  const board = { trips: [{ trip: { tripNumber: '1', trailer: '7303', status: 'DEPSHIP' }, freightBills: [{ temperature: 34 }] }] };
  initReeferAgent(app, { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), db: memDb(), getBoard: async () => board, env: {}, now: () => t });
  let out; const res = { status() { return this; }, json(j) { out = j; return this; } };
  await routes['POST /truckmate/reefer-agent/key']({ user: {} }, res); const key = out.key;
  const req = (body = {}) => ({ body, get: () => key });
  await routes['GET /reefer-agent/jobs'](req(), res); assert.equal(out.trailers.length, 1);
  await routes['POST /reefer-agent/run'](req({ read: 1, of: 1 }), res);
  t += 60 * 60000; await routes['GET /reefer-agent/jobs'](req(), res); assert.equal(out.trailers.length, 0, 'an hour later: nothing');
  await routes['POST /reefer-agent/run'](req({ read: 0, of: 0 }), res); assert.equal(out.skipped, true);
  t += 60 * 60000; await routes['GET /reefer-agent/jobs'](req(), res); assert.equal(out.trailers.length, 1, 'two hours later: read again');
});

test('no temp tracking: 3 active temperature loads without a reading → flagged and skipped; re-checked weekly; a reading clears it', () => {
  const at = (d) => new Date(Date.parse('2026-11-11T00:00:00Z') + d * 86400000).toISOString();
  let e = noteRead(undefined, { trip: '1', hasTemp: false, tempLoad: true, at: at(0) });
  e = noteRead(e, { trip: '1', hasTemp: false, tempLoad: true, at: at(0) });        // same load twice counts once
  e = noteRead(e, { trip: '2', hasTemp: false, tempLoad: false, at: at(0) });       // not a temperature load: no strike
  assert.deepEqual(e.loads, ['1']); assert.equal(e.flaggedAt, null);
  e = noteRead(e, { trip: '3', hasTemp: false, tempLoad: true, at: at(1) });
  e = noteRead(e, { trip: '4', hasTemp: false, tempLoad: true, at: at(2) });
  assert.equal(e.flaggedAt, at(2));
  const now = Date.parse(at(3));
  assert.equal(skipNoTemp(e, now), true);
  assert.deepEqual(trailersToRead([{ trip: { tripNumber: '9', trailer: '7303', status: 'DEPSHIP' }, freightBills: [{ temperature: 34 }] }], 40, { noTemp: { 7303: e }, now }), []);
  assert.equal(skipNoTemp(e, Date.parse(at(10))), false, 'weekly re-check');
  assert.equal(noteRead(e, { trip: '5', hasTemp: true, tempLoad: true, at: at(10) }), null, 'a reading clears it');
});

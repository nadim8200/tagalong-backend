import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRecipe, trailersToRead, initReeferAgent } from '../reeferagent.js';

test('recipe: only read-only steps are accepted', () => {
  const ok = cleanRecipe({ windowTitle: 'TruckMate', steps: [{ do: 'click', x: 0.1, y: 0.2 }, { do: 'type', text: '{trailer}' }, { do: 'key', key: 'enter' }, { do: 'wait', ms: 1500 }, { do: 'doubleclick', x: 0.5, y: 0.5 }, { do: 'shot' }] });
  assert.equal(ok.ok, true); assert.deepEqual(ok.recipe.after, [{ do: 'key', key: 'ESC' }]);
  assert.match(cleanRecipe({ steps: [{ do: 'type', text: 'DELETE' }, { do: 'shot' }] }).error, /only the trailer number/);
  assert.match(cleanRecipe({ steps: [{ do: 'key', key: 'DEL' }, { do: 'shot' }] }).error, /key must be one of/);
  assert.match(cleanRecipe({ steps: [{ do: 'key', key: 'CTRL+S' }, { do: 'shot' }] }).error, /key must be one of/);
  assert.match(cleanRecipe({ steps: [{ do: 'click', x: 2, y: 0 }, { do: 'shot' }] }).error, /x and y are 0–1/);
  assert.match(cleanRecipe({ steps: [{ do: 'click', x: 0.1, y: 0.1 }] }).error, /screenshot/);
  assert.match(cleanRecipe({ steps: [{ do: 'drag' }, { do: 'shot' }] }).error, /not allowed/);
});

test('trailers to read: active company loads, one per trailer, no outside carriers', () => {
  const t = (n, trailer, x = {}) => ({ trip: { tripNumber: n, trailer, powerUnit: '2403', status: 'DISP', ...(x.trip || {}) }, ...(x.item || {}) });
  assert.deepEqual(trailersToRead([t('1', '7303'), t('2', '7303'), t('3', '7296'), t('4', '7650', { item: { _oc: {} } }), t('5', '7651', { trip: { status: 'CANCL' } }), t('6', '')]), [{ trailer: '7303', trip: '1' }, { trailer: '7296', trip: '3' }]);
});

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
test('agent: needs its key; a reading lands on the trailer; a wrong window stops the run', async () => {
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: (p, ...h) => { routes[`PUT ${p}`] = h.at(-1); } };
  const db = memDb();
  let ai = { isReeferEvents: true, trailer: '7303', returnTemp: 34.5, setTemp: 34, supplyTemp: 33, tempUnits: 'F' };
  const fetchFn = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(ai) }] }) });
  const board = { trips: [{ trip: { tripNumber: '621053', trailer: '7303', status: 'DEPSHIP' } }] };
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
  assert.equal(out.stop, true); assert.match(out.why, /not the Reefer Events window/);
  await routes['GET /truckmate/reefer-agent/status'](req(), res);
  assert.equal(out.shots[0].kind, 'unexpected'); assert.equal(out.shots[0].png, undefined, 'no picture in the status list');
  code = 200; await routes['PUT /truckmate/reefer-agent/recipe'](req({ steps: [{ do: 'key', key: 'F2' }, { do: 'shot' }] }), res); assert.equal(code, 400);
});

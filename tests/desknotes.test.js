import test from 'node:test';
import assert from 'node:assert/strict';
import { initDeskNotes } from '../desknotes.js';

test('internal notes on a load: saved with who and when, read back in order; an empty note is refused (Nov 21)', async () => {
  const s = {}; const db = { get: async (k, d) => (k in s ? s[k] : d), update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } };
  const routes = {}; const app = { get: (p, a, h) => { routes[`GET ${p}`] = h; }, post: (p, a, h) => { routes[`POST ${p}`] = h; } };
  let t = Date.parse('2026-11-21T18:00:00Z');
  initDeskNotes(app, { db, requireAuth: () => {}, now: () => t });
  const call = async (k, req) => { let out = null; let code = 200; await routes[k]({ user: { name: 'Ana' }, body: {}, ...req }, { json: (j) => { out = j; }, status: (c) => { code = c; return { json: (j) => { out = j; } }; } }); return { code, out }; };
  assert.equal((await call('POST /truckmate/desk/notes/:trip', { params: { trip: '627549' }, body: { text: '  ' } })).code, 400);
  await call('POST /truckmate/desk/notes/:trip', { params: { trip: '627549' }, body: { text: 'Called the receiver: door 4 after 2 PM' } });
  t += 60000;
  const r = await call('POST /truckmate/desk/notes/:trip', { params: { trip: '627549' }, body: { text: 'Driver on break until 3' } });
  assert.deepEqual(r.out.notes.map((n) => [n.by, n.text]), [['Ana', 'Called the receiver: door 4 after 2 PM'], ['Ana', 'Driver on break until 3']]);
  assert.equal((await call('GET /truckmate/desk/notes/:trip', { params: { trip: '627549' } })).out.notes.length, 2);
  assert.deepEqual((await call('GET /truckmate/desk/notes/:trip', { params: { trip: '1' } })).out.notes, []);
});

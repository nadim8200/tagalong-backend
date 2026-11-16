import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initOutreach } from '../outreach.js';

test('"Jarvis contacted a driver" emails are off unless turned back on', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb) };
  const o = initOutreach({ db, getBoard: async () => ({ trips: [] }), env: {} });
  assert.deepEqual(await o.notify({ trip: '627109', channel: 'text' }), { emailed: false, off: true });
});

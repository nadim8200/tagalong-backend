import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskStatus, applyTaskChange } from '../helpdesk.js';

const NOW = Date.parse('2026-10-09T15:00:00Z');
const base = { id: 'h1', at: '2026-10-08T16:45:00Z', status: 'open', need: 'Confirm solo or team on 2612', history: [] };

test('task status comes from real fields — an old call with no due time is never "overdue"', () => {
  assert.equal(taskStatus(base, NOW), 'requested');
  assert.equal(taskStatus({ ...base, owner: 'Rosa' }, NOW), 'assigned');
  assert.equal(taskStatus({ ...base, owner: 'Rosa', dueAt: '2026-10-09T18:00:00Z' }, NOW), 'scheduled');
  assert.equal(taskStatus({ ...base, dueAt: '2026-10-09T14:00:00Z' }, NOW), 'overdue');
  assert.equal(taskStatus({ ...base, status: 'handled', dueAt: '2026-10-09T14:00:00Z' }, NOW), 'completed');
});

test('assign, schedule, attempts (no answer / voicemail stay open), completion — all in the history', () => {
  let t = applyTaskChange(base, { assignTo: 'Rosa' }, { by: 'Rosa', now: NOW });
  t = applyTaskChange(t, { dueAt: '2026-10-09T18:00:00Z', nextStep: 'Call Calverts back' }, { by: 'Rosa', now: NOW + 1000 });
  t = applyTaskChange(t, { complete: { outcome: 'no_answer', note: 'rang out', nextDueAt: '2026-10-09T20:00:00Z' } }, { by: 'Rosa', now: NOW + 2000 });
  assert.equal(t.status, 'open', 'no answer does not resolve it');
  assert.equal(t.dueAt, '2026-10-09T20:00:00.000Z');
  t = applyTaskChange(t, { complete: { outcome: 'voicemail' } }, { by: 'Rosa', now: NOW + 3000 });
  assert.equal(t.status, 'open');
  assert.equal(t.attempts.length, 2);
  t = applyTaskChange(t, { complete: { outcome: 'reached', note: 'Team drivers — confirmed' } }, { by: 'Mike', now: NOW + 4000 });
  assert.deepEqual([t.status, t.handledBy, t.handledAt, t.outcome, t.note], ['handled', 'Mike', new Date(NOW + 4000).toISOString(), 'reached', 'Team drivers — confirmed']);
  assert.deepEqual(t.history.map((h) => h.action), ['assigned', 'scheduled', 'next step', 'attempt', 'scheduled', 'attempt', 'completed']);
  assert.throws(() => applyTaskChange(base, { complete: { outcome: 'played the recording' } }), /Pick an outcome/);
  assert.throws(() => applyTaskChange(base, { dueAt: 'tomorrow-ish' }), /not valid/);
});

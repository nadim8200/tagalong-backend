import test from 'node:test';
import assert from 'node:assert/strict';
import { makeToken, readToken, breakdownSubject, loadLabel, renderBreakdownEmail, reportPage, initBreakdownReport } from '../breakdownreport.js';
import { renderTeamStopEmail, teamStopFacts } from '../teamstopmail.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const flowers = { trip: { tripNumber: '625878', powerUnit: '2602', trailer: '7323' }, _tb: { hub: 'Miami' }, freightBills: [{ billNumber: 'M1' }] };
const broker = { trip: { tripNumber: '625932', powerUnit: '2202', trailer: 'DV8009' }, _ratecon: {}, freightBills: [{ billNumber: 'B180615' }] };
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, fn, d) => { s[k] = fn(k in s ? s[k] : d); return s[k]; }, s }; };

test('the subject follows the way dispatch writes it, and says flowers or broker', () => {
  assert.equal(breakdownSubject(flowers, 'truck air leak'), 'FLOWERS BREAKDOWN TRUCK AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878');
  assert.equal(breakdownSubject(broker, 'Flat\ntire\r\nBcc: x@y.com'), 'BROKER BREAKDOWN FLAT TIRE BCC: X@Y.COM - TK# 2202 TL# DV8009 - TRIP# 625932', 'one line, always');
  assert.equal(loadLabel(flowers), 'FLOWERS'); assert.equal(loadLabel(broker), 'BROKER');
});

test('the link only works for that stop, untouched and in time', () => {
  const t = makeToken({ a: 'stopped:1', t: '1', u: '9' }, 's', NOW);
  assert.equal(readToken(t, 's', NOW).a, 'stopped:1');
  assert.equal(readToken(t, 'other', NOW), null);
  assert.equal(readToken(`${t}x`, 's', NOW), null);
  const forged = `${Buffer.from(JSON.stringify({ a: 'x', e: NOW + 1e9 })).toString('base64url')}.${t.split('.')[1]}`;
  assert.equal(readToken(forged, 's', NOW), null);
  assert.equal(readToken(t, 's', NOW + 8 * 86400000), null, 'expired');
});

function rig(at = NOW) {
  const db = mem(); const sent = []; let t = at;
  const r = initBreakdownReport(null, { db, secret: 's', now: () => t, getBoard: async () => ({ trips: [flowers] }), send: async (rep) => sent.push(rep) });
  return { r, sent, db, later: (ms) => { t += ms; } };
}
const p = { a: 'stopped:625878', t: '625878', u: '2602' };

test('submitting sends one email and opens no road call; a second press does nothing', async () => {
  const v = rig();
  assert.equal((await v.r.submit(p, { reason: 'Truck air leak', name: 'Ana' })).ok, true);
  assert.equal(v.sent.length, 1); assert.equal(v.sent[0].by, 'Ana'); assert.equal('roadCall' in v.sent[0], false);
  assert.equal((await v.r.submit(p, { reason: 'Again', name: 'Bob' })).code, 409);
  assert.equal(v.sent.length, 1);
  assert.equal((await v.r.forTrip('625878')).subject, 'FLOWERS BREAKDOWN TRUCK AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878');
});

test('a reason and a name are required', async () => {
  const v = rig();
  assert.equal((await v.r.submit(p, { reason: '  ', name: 'Ana' })).code, 400);
  assert.equal((await v.r.submit(p, { reason: 'Air leak', name: '' })).code, 400);
  assert.equal(v.sent.length, 0);
});

test('a report holds the rolling email until Breakdown is off or 5 days pass', async () => {
  const v = rig();
  assert.deepEqual(await v.r.held(), []);
  await v.r.submit(p, { reason: 'Air leak', name: 'Ana' });
  assert.deepEqual(await v.r.held(), ['625878', '2602']);
  await v.r.clear('625878');
  assert.deepEqual(await v.r.held(), []);
  const w = rig();
  await w.r.submit(p, { reason: 'Air leak', name: 'Ana' });
  w.later(6 * 86400000);
  assert.deepEqual(await w.r.held(), []);
});

test('the breakdown email: what, who, next step, nobody is told customers were contacted', () => {
  const m = renderBreakdownEmail({ item: flowers, report: { atMs: NOW, by: 'Ana <x>', reason: 'Air <leak>', trip: '625878', unit: '2602' }, now: NOW, sheetNote: 'Trip sheet attached', sheetAttached: true });
  assert.equal(m.subject, 'FLOWERS BREAKDOWN AIR <LEAK> - TK# 2602 TL# 7323 - TRIP# 625878');
  assert.match(m.html, /BREAKDOWN REPORTED[^]*FLOWERS LOAD/); assert.match(m.html, /Air &lt;leak&gt;/); assert.match(m.html, /Ana &lt;x&gt;/); assert.match(m.html, /Road service has NOT been called/); assert.doesNotMatch(m.html, /provider|road call/i); assert.match(m.html, /Trip sheet attached/);
  assert.match(m.html, /jarvis:training-slot/);
});

test('the stopped email carries the button only when there is a link; the page escapes and says what happens', () => {
  const a = { unit: '2602', trip: '625878', severity: 'critical', title: 'Team truck stopped 2h 0m' };
  assert.match(renderTeamStopEmail(teamStopFacts(a, flowers, { now: NOW, reportUrl: 'https://x/br/abc' })).html, /Report breakdown/);
  assert.doesNotMatch(renderTeamStopEmail(teamStopFacts(a, flowers, { now: NOW })).html, /Report breakdown/);
  assert.match(reportPage({ a: 'x', t: '1', u: '<b>' }, 't'), /&lt;b&gt;/);
  assert.match(reportPage({ a: 'x', t: '1', u: '2' }, 't'), /does not call road service or contact customers/);
  assert.match(reportPage(null, 't'), /expired/);
  assert.match(reportPage({ a: 'x', t: '1', u: '2' }, 't', { by: 'Ana', reason: 'Leak' }), /Already reported/);
});

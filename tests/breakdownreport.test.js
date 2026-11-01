import test from 'node:test';
import assert from 'node:assert/strict';
import { makeToken, readToken, breakdownSubject, loadLabel, renderBreakdownEmail, reportPage, initBreakdownReport } from '../breakdownreport.js';
import { renderTeamStopEmail, teamStopFacts } from '../teamstopmail.js';
import { transferPlan } from '../transferwatch.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const flowers = { trip: { tripNumber: '625878', powerUnit: '2602', trailer: '7323' }, _tb: { hub: 'Miami' }, freightBills: [{ billNumber: 'M1' }] };
const broker = { trip: { tripNumber: '625932', powerUnit: '2202', trailer: 'DV8009' }, _ratecon: {}, freightBills: [{ billNumber: 'B180615' }] };
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, fn, d) => { s[k] = fn(k in s ? s[k] : d); return s[k]; }, s }; };

test('the subject follows the way dispatch writes it, and says flowers or broker', () => {
  assert.equal(breakdownSubject(flowers, 'truck air leak'), 'FLOWERS BREAKDOWN TRUCK AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878');
  assert.equal(breakdownSubject(broker, 'Flat\ntire\r\nBcc: x@y.com'), 'BROKER BREAKDOWN FLAT TIRE BCC: X@Y.COM - TK# 2202 TL# DV8009 - TRIP# 625932', 'one line, always');
  assert.equal(loadLabel(flowers), 'FLOWERS'); assert.equal(loadLabel(broker), 'BROKER');
  const bills = (...b) => ({ freightBills: b.map((billNumber) => ({ billNumber })) });
  assert.equal(loadLabel({ ...bills('C1', 'N2') }), 'FLOWERS'); assert.equal(loadLabel(bills('N1')), 'FLOWERS');
  assert.equal(loadLabel(bills('T85286')), 'FLOWERS'); assert.equal(loadLabel(bills('T1', 'N2', 'Y3')), 'FLOWERS', 'any letter but B and H');
  assert.equal(loadLabel(bills('H5035887')), 'TENNESSEE HUB');
  assert.equal(loadLabel({ _plan: { kind: 'flowers' }, ...bills('B1') }), 'BROKER', 'broker bills win');
  assert.equal(breakdownSubject({ trip: { tripNumber: '1', powerUnit: '2', trailer: '3' }, ...bills('H1') }, 'air leak'), 'TENNESSEE HUB BREAKDOWN AIR LEAK - TK# 2 TL# 3 - TRIP# 1');
  const unknown = { trip: { tripNumber: '1', powerUnit: '2', trailer: '3' }, _plan: { kind: 'flowers' }, ...bills('H1', 'T2') };
  assert.equal(loadLabel(unknown), null, 'no proof, no label');
  assert.equal(loadLabel({ trip: {} }), null);
  assert.equal(breakdownSubject(unknown, 'air leak'), 'BREAKDOWN AIR LEAK - TK# 2 TL# 3 - TRIP# 1');
  assert.match(renderBreakdownEmail({ item: unknown, report: { atMs: NOW, by: 'A', reason: 'air leak', trip: '1', unit: '2' }, now: NOW }).html, /Load type not confirmed/);
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

test('reported down stays down until someone says fixed; the chain hears it; old truck and trip are both held', async () => {
  const chain = []; const db = mem();
  const r = initBreakdownReport(null, { db, secret: 's', now: () => NOW, getBoard: async () => ({ trips: [flowers] }), send: async () => {}, sendChain: async (rep, m) => chain.push(m) });
  await r.submit(p, { reason: 'Air leak', name: 'Ana' });
  assert.deepEqual(await r.held(), ['625878', '2602']);
  const later = initBreakdownReport(null, { db, secret: 's', now: () => NOW + 30 * 86400000, getBoard: async () => ({ trips: [flowers] }), send: async () => {}, sendChain: async (rep, m) => chain.push(m) });
  assert.deepEqual(await later.held(), ['625878', '2602'], 'no timer: it waits for word');
  assert.equal((await r.fixed('625878', 'Gio')).ok, true);
  assert.deepEqual(await r.held(), []);
  assert.match(chain[0].subject, /^Re: FLOWERS BREAKDOWN/); assert.match(chain[0].text, /Reported fixed by Gio/);
  assert.equal((await r.fixed('625878', 'Gio')).ok, false, 'nothing open');
});

test('rescue: the plan feeds the transfer watch; TruckMate on the new truck closes it once, on the chain', async () => {
  const chain = []; const db = mem();
  const r = initBreakdownReport(null, { db, secret: 's', now: () => NOW, getBoard: async () => ({ trips: [flowers] }), send: async () => {}, sendChain: async (rep, m) => chain.push(m) });
  assert.equal((await r.rescuePlan('625878', { to: '4504', by: 'Gio' })).ok, false, 'no breakdown open');
  await r.submit(p, { reason: 'Air leak', name: 'Ana' });
  assert.equal((await r.rescuePlan('625878', { to: '4504', by: 'Gio' })).ok, true);
  const it = { ...flowers }; await r.overlay('fb', [it]);
  assert.deepEqual(it._rescue, { from: '2602', to: '4504', subject: 'FLOWERS BREAKDOWN AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878' });
  assert.deepEqual(transferPlan(it), { trip: '625878', from: '2602', to: '4504', trailer: '7323', rescue: { subject: it._rescue.subject } });
  await r.process('fb', { trips: [flowers] }); assert.equal(chain.length, 0, 'still on the broken truck');
  const moved = { ...flowers, trip: { ...flowers.trip, powerUnit: '4504' } };
  await r.process('fb', { trips: [moved] }); await r.process('fb', { trips: [moved] });
  assert.equal(chain.length, 1); assert.match(chain[0].subject, /^Re: /); assert.match(chain[0].text, /Transfer completed: truck 2602 to 4504/); assert.match(chain[0].text, /TruckMate shows trip 625878 on truck 4504/);
  assert.deepEqual(await r.held(), [], 'the new truck is not held');
});

test('the breakdown email: what, who, next step, nobody is told customers were contacted', () => {
  const m = renderBreakdownEmail({ item: flowers, report: { atMs: NOW, by: 'Ana <x>', reason: 'Air <leak>', trip: '625878', unit: '2602' }, now: NOW, sheetNote: 'Trip sheet attached', sheetAttached: true });
  assert.equal(m.subject, 'FLOWERS BREAKDOWN AIR <LEAK> - TK# 2602 TL# 7323 - TRIP# 625878');
  assert.match(m.html, /FLOWER BREAKDOWN/); assert.match(renderBreakdownEmail({ item: broker, report: { atMs: NOW, by: 'A', reason: 'x y', trip: '1', unit: '2' }, now: NOW }).html, /BROKER BREAKDOWN/); assert.match(m.html, /Air &lt;leak&gt;/); assert.match(m.html, /Ana &lt;x&gt;/); assert.match(m.html, /Road service has NOT been called/); assert.doesNotMatch(m.html, /provider|road call/i); assert.match(m.html, /Trip sheet attached/);
  assert.match(m.html, /jarvis:training-slot/);
  assert.match(m.html, /truckmate\?admin&amp;tab=active&amp;trip=625878/);
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

test('a staff email: same template, once per load, the people on it passed along', async () => {
  const v = rig();
  let extra = null;
  const db = mem(); const sent = [];
  const r = initBreakdownReport(null, { db, secret: 's', now: () => NOW, getBoard: async () => ({ trips: [flowers] }), send: async (rep, item, to) => { sent.push(rep); extra = to; } });
  const out = await r.fromEmail({ trip: '625878', reason: 'Truck air leak', by: 'Gio', emailId: 'm1', to: ['gio@floridabeauty.us', 'carlos@floridabeauty.us'] });
  assert.equal(out.subject, 'FLOWERS BREAKDOWN TRUCK AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878');
  assert.deepEqual(extra, ['gio@floridabeauty.us', 'carlos@floridabeauty.us']);
  assert.equal(sent[0].by, 'Gio');
  assert.deepEqual(await r.held(), ['625878', '2602'], 'the rolling email waits too');
  const again = await r.fromEmail({ trip: '625878', reason: 'Still broken', by: 'Ana', emailId: 'm2', to: [] });
  assert.equal(again.duplicate, true); assert.equal(sent.length, 1);
  await r.clear('625878');
  assert.equal((await r.fromEmail({ trip: '625878', reason: 'Broke down again', by: 'Ana', emailId: 'm3', to: [] })).ok, true, 'a new breakdown after Breakdown was turned off');
  assert.equal((await v.r.fromEmail({ trip: '999', reason: 'Air leak', by: 'Gio', emailId: 'm4' })).ok, false, 'not on the board');
  assert.equal((await v.r.fromEmail({ trip: '625878', reason: '', by: 'Gio', emailId: 'm5' })).ok, false, 'no reason');
});

// The real inbox, end to end, with the AI's answer stubbed.
import { initInbox } from '../inbox.js';
function inboxRig({ fromAddr = 'gio@floridabeauty.us', instruction = { kind: 'report_breakdown', truck: '231', reason: 'truck air leak' }, trips = [{ trip: { tripNumber: '626500', powerUnit: '231', trailer: '7001', status: 'DEPSHIP' } }], cc = ['carlos@floridabeauty.us', 'broker@outside.com'] }) {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'k' };
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  const rec = (a) => ({ emailAddress: { address: a } });
  const msg = { id: 'm1', subject: 'Truck 231', from: { emailAddress: { name: 'Gio', address: fromAddr } }, toRecipients: [rec('jarvis@floridabeauty.us')], ccRecipients: cc.map(rec), receivedDateTime: '2026-11-02T12:00:00Z', body: { contentType: 'text', content: 'Hey Jarvis, truck 231 is broken down, driver says air leak' }, conversationId: 'c1', hasAttachments: false };
  const fetchFn = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (u.includes('anthropic')) return ok({ content: [{ text: JSON.stringify({ summary: 'Breakdown', actions: [], reply: { needed: true, kind: 'acknowledge', documents: [] }, instructions: [instruction] }) }], usage: {} });
    if (u.includes('/mailFolders/inbox/messages')) return ok({ value: [msg] });
    if (u.includes('/messages/m1')) return ok(msg);
    return ok({});
  };
  const calls = [];
  const inbox = initInbox({ get() {}, post() {}, put() {} }, { requireAuth: (q, r, n) => n(), db: mem2(), env, fetchFn, getBoard: async () => ({ trips }), breakdownEmail: async (x) => { calls.push(x); return { ok: true, subject: 'S' }; } });
  return { inbox, calls };
}
function mem2() { const m = new Map(); return { enabled: true, get: async (k, f) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : f), set: async (k, v) => { m.set(k, v); }, update: async (k, fn, f) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : f); m.set(k, v); return v; } }; }
const settle = () => new Promise((r) => setTimeout(r, 30));

test('Gio emails Jarvis: the truck is found, and everyone of ours on the email gets it; an outside address does not', async () => {
  const h = inboxRig({});
  await h.inbox.poll(); await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].trip, '626500'); assert.equal(h.calls[0].reason, 'truck air leak'); assert.equal(h.calls[0].by, 'Gio');
  assert.deepEqual(h.calls[0].to.sort(), ['carlos@floridabeauty.us', 'gio@floridabeauty.us']);
});

test('someone outside the company cannot trigger it', async () => {
  const h = inboxRig({ fromAddr: 'someone@outside.com' });
  await h.inbox.poll(); await settle();
  assert.equal(h.calls.length, 0);
});

test('a truck on two trips, or none named: nothing goes out until they say which', async () => {
  const two = [{ trip: { tripNumber: '626500', powerUnit: '231' } }, { trip: { tripNumber: '626501', powerUnit: '231' } }];
  const h = inboxRig({ trips: two });
  await h.inbox.poll(); await settle();
  assert.equal(h.calls.length, 0);
});

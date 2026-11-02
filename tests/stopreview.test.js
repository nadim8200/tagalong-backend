import test from 'node:test';
import assert from 'node:assert/strict';
import { teamStopsDue, personClosed, stopAuthorized, applyStopReview, stopEpisodeFor, TEAM_STOP_MIN } from '../watchtower.js';
import { initStopReview, reviewPage } from '../stopreview.js';
import { renderTeamStopEmail, teamStopFacts } from '../teamstopmail.js';
import { renderStopReviewEmail } from '../handoffmail.js';
import { parseInstructions } from '../inbox.js';

const a = (severity = 'warning') => ({ id: 'stopped:626133', code: 'stopped', teamStop: true, unit: '4560', trip: '626133', severity, title: 'Team truck stopped 1h 15m', stoppedSinceMs: 1000 });
const fakeDb = (start) => { let v = start; return { get: async () => v, update: async (k, fn) => { v = fn(v); return v; }, peek: () => v }; };
const review = { status: 'authorized', reason: 'hotel approved', by: 'Sara', source: 'email button', atMs: 5000 };

test('first team stop alert is at 1h 15m', () => assert.equal(TEAM_STOP_MIN, 75));

test('Solved pressed: the same stop never emails again when the alert reopens', () => {
  const units = { 4560: { stopEpisode: { unit: '4560', mailLevel: 1, stoppedSinceMs: 1000 } } };
  assert.equal(teamStopsDue([a()], { 'stopped:626133': {} }, new Set(), units).length, 0, 'fresh alert, same stop');
  assert.equal(teamStopsDue([a('critical')], { 'stopped:626133': {} }, new Set(), units).length, 1, 'the 2 hour email still goes');
});

test('a closed alert stays closed while the problem continues, and comes back if worse or after it cleared', () => {
  const closed = { resolvedAt: 1, resolvedBy: 'sara', severity: 'warning' };
  assert.equal(personClosed(closed, a()), true);
  assert.equal(personClosed(closed, a('critical')), false, 'worse news');
  assert.equal(personClosed({ ...closed, clearedAt: 2 }, a()), false, 'cleared, then back');
  assert.equal(personClosed({ ...closed, resolvedBy: 'auto' }, a()), false, 'auto never holds');
  assert.equal(teamStopsDue([a()], { 'stopped:626133': closed }).length, 0);
});

test('authorized: no more emails, even at 2 hours, and the open alert closes with the reason', () => {
  const state = { alerts: { 'stopped:626133': { code: 'stopped', unit: '4560' } }, units: { 4560: { stopEpisode: { unit: '4560', trip: '626133', mailLevel: 1, stoppedSinceMs: 1000 } } } };
  const { state: s, out } = applyStopReview(state, { unit: '4560', since: 1000, review });
  assert.ok(out.ok);
  assert.equal(stopAuthorized(s.units, a()), true);
  assert.equal(teamStopsDue([a('critical')], { 'stopped:626133': {} }, new Set(), s.units).length, 0);
  assert.equal(s.alerts['stopped:626133'].note, 'hotel approved');
  assert.equal(s.alerts['stopped:626133'].resolvedBy, 'Sara');
});

test('not authorized: alerts carry on', () => {
  const state = { units: { 4560: { stopEpisode: { unit: '4560', trip: '626133', mailLevel: 1, stoppedSinceMs: 1000 } } } };
  const { state: s } = applyStopReview(state, { unit: '4560', review: { ...review, status: 'unauthorized' } });
  assert.equal(teamStopsDue([a('critical')], { 'stopped:626133': {} }, new Set(), s.units).length, 1);
});

test('an old link cannot answer a newer stop', () => {
  const state = { units: { 4560: { stopEpisode: { unit: '4560', stoppedSinceMs: 2000 } } } };
  assert.equal(applyStopReview(state, { unit: '4560', since: 1000, review }).out.ok, false);
});

test('a reply naming only the trip finds the stop', () => {
  const state = { units: { 4560: { stopEpisode: { unit: '4560', trip: '626133', stoppedSinceMs: 1 } } } };
  assert.equal(stopEpisodeFor(state, { trip: '626133' }).unit, '4560');
  assert.equal(stopEpisodeFor(state, { trip: '999999' }), null);
});

test('decide: reason and name required to authorize, one email per answer, a failed email is reported', async () => {
  const start = { alerts: {}, units: { 4560: { stopEpisode: { unit: '4560', trip: '626133', stoppedSinceMs: 1000, title: 'x' } } } };
  const sent = []; const db = fakeDb(start);
  const r = initStopReview(null, { db, secret: 's', send: async (ep, rv) => sent.push([ep.unit, rv.reason]), now: () => 5000 });
  assert.equal((await r.decide({ unit: '4560', status: 'authorized', reason: ' ', by: 'Sara', source: 'console' })).code, 400);
  assert.equal((await r.decide({ unit: '4560', status: 'authorized', reason: 'hotel approved', by: '', source: 'console' })).code, 400);
  assert.equal((await r.decide({ unit: '4560', status: 'authorized', reason: 'hotel approved', by: 'Sara', source: 'console' })).emailed, true);
  assert.equal((await r.decide({ unit: '4560', status: 'authorized', reason: 'again', by: 'Ana', source: 'email button' })).already, true);
  assert.deepEqual(sent, [['4560', 'hotel approved']]);
  assert.equal(await r.isAuthorized({ unit: '4560' }), true);
  const bad = initStopReview(null, { db: fakeDb(structuredClone(start)), secret: 's', send: async () => { throw new Error('no'); } });
  assert.equal((await bad.decide({ unit: '4560', status: 'unauthorized', by: 'Sara', source: 'console' })).emailed, false);
});

test('the stop email has the two buttons, updates do not', () => {
  const f = teamStopFacts(a(), null, { reviewUrl: 'https://x/sr/t' });
  const m = renderTeamStopEmail(f);
  assert.match(m.html, /sr\/t\?d=authorized/); assert.match(m.html, /sr\/t\?d=unauthorized/); assert.match(m.text, /Or reply to this email/);
  assert.doesNotMatch(renderTeamStopEmail(teamStopFacts(a(), null)).html, /Is this stop authorized/);
});

test('the answer email says who, why and what happens next', () => {
  const m = renderStopReviewEmail({ a: a(), item: null, review, subject: 'Re: x' });
  assert.match(m.html, /STOP AUTHORIZED/); assert.match(m.text, /Approved by Sara/); assert.match(m.text, /hotel approved/); assert.match(m.text, /will not send more alerts/);
  const no = renderStopReviewEmail({ a: a(), item: null, review: { ...review, status: 'unauthorized', reason: '' }, subject: 'Re: x' });
  assert.match(no.html, /STOP NOT AUTHORIZED/); assert.match(no.text, /No note added/);
});

test('the page escapes what people typed and preselects the button', () => {
  const p = { u: '4560', t: '626133' };
  assert.match(reviewPage(p, { pick: 'authorized' }), /id="sa" value="authorized" checked/);
  assert.doesNotMatch(reviewPage(p, { review: { ...review, reason: '<script>x' } }), /<script>x/);
  assert.match(reviewPage(p, { ended: true }), /stop has ended/);
  assert.match(reviewPage(null), /expired/);
});

test('staff replies become a stop answer with the reason', () => {
  const [x] = parseInstructions([{ kind: 'stop_authorized', truck: '4560', reason: 'hotel approved' }]);
  assert.equal(x.reason, 'hotel approved'); assert.equal(x.truck, '4560');
});

test('the email signs the stop with who, their email, when and how', () => {
  const m = renderStopReviewEmail({ a: a(), item: null, review: { ...review, by: 'Saray Trujillo', email: 'strujillo@floridabeauty.us', source: 'console' }, subject: 'Re: x' });
  assert.match(m.html, /Approved by Saray Trujillo/); assert.match(m.html, /strujillo@floridabeauty\.us/); assert.match(m.text, /Marked Solved in the console/);
  assert.match(renderStopReviewEmail({ a: a(), item: null, review, subject: 'x' }).text, /name as typed/, 'a typed name says so');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrailers, trailerWatchEmail, initTrailerWatch, trailersOnLoads } from '../trailerwatch.js';

const NOW = Date.parse('2026-12-20T15:00:00Z');
const MIAMI = { MIAMI: [{ lat: 25.7947, lng: -80.3099, miles: 0.5 }] };
const ago = (min) => new Date(NOW - min * 60000).toISOString();

test('parked 30+ days → once per parked stretch (silent trailers count)', () => {
  const units = { 7140: { trailer: '7140', lat: 35.5, lng: -79.2, at: ago(60 * 24 * 10), parkedSince: '2026-11-10T12:00:00Z', atLeast: true, location: 'Sanford, NC', source: 'Thermo King' } };
  const a = checkTrailers(units, [], MIAMI, {}, NOW);
  assert.equal(a.longParked.length, 1); assert.equal(a.longParked[0].days, 40); assert.equal(a.longParked[0].where, 'Sanford, NC');
  assert.equal(checkTrailers(units, [], MIAMI, a.next, NOW).longParked.length, 0, 'said once');
  const moved = { 7140: { ...units['7140'], parkedSince: '2026-12-01T12:00:00Z' } };
  assert.equal(checkTrailers(moved, [], MIAMI, a.next, NOW).longParked.length, 0, 'moved and parked again: not 30 days yet');
});

test('moving without a load → said (every 12 h at most); on a load, or jockeying inside one yard → nothing', () => {
  const parked = { 7200: { trailer: '7200', lat: 26.6, lng: -81.9, at: ago(120), parkedSince: ago(60 * 24 * 3), atLeast: true, location: 'Fort Myers, FL' } };
  let st = checkTrailers(parked, [], MIAMI, {}, NOW - 30 * 60000).next;   // learned where it sat
  const rolling = { 7200: { trailer: '7200', lat: 26.9, lng: -81.7, at: ago(5), mph: 58, parkedSince: ago(20), atLeast: false, location: 'Punta Gorda, FL', source: 'Samsara' } };
  const r = checkTrailers(rolling, [], MIAMI, st, NOW);
  assert.equal(r.movingNoLoad.length, 1); assert.equal(r.movingNoLoad[0].from, 'Fort Myers, FL'); assert.equal(r.movingNoLoad[0].mph, 58);
  st = r.next;
  assert.equal(checkTrailers(rolling, [], MIAMI, st, NOW + 60 * 60000).movingNoLoad.length, 0, 'not again within 12 h');
  assert.equal(checkTrailers(rolling, [{ trip: { tripNumber: '1', trailer: '07200' } }], MIAMI, {}, NOW).movingNoLoad.length, 0, 'on a load');
  // inside the Miami yard: was at the yard, still at the yard
  const y0 = { 7300: { trailer: '7300', lat: 25.7947, lng: -80.3099, at: ago(60), parkedSince: ago(600), atLeast: true } };
  const y1 = { 7300: { trailer: '7300', lat: 25.7950, lng: -80.3105, at: ago(2), mph: 8, parkedSince: ago(3), atLeast: false } };
  assert.equal(checkTrailers(y1, [], MIAMI, checkTrailers(y0, [], MIAMI, {}, NOW - 3600000).next, NOW).movingNoLoad.length, 0, 'yard jockey');
  assert.deepEqual([...trailersOnLoads([{ trip: { trailer: '7141', trailer2: 'tl 07142' } }])], ['7141', '7142']);
});

test('one email to Nadim per check; the first check only learns where trailers are (no moving email)', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v) };
  const sent = []; let clock = NOW;
  const w = initTrailerWatch({ db, sendMail: async (x) => sent.push(x), to: async () => ['ntellez@floridabeauty.us'], now: () => clock });
  const rolling = { 7200: { trailer: '7200', lat: 26.9, lng: -81.7, at: ago(5), mph: 58, parkedSince: ago(20), atLeast: false, location: 'Punta Gorda, FL' } };
  await w.check(rolling, [], MIAMI);
  assert.equal(sent.length, 0, 'first check: learn');
  clock += 20 * 60000;
  await w.check({ 7200: { ...rolling['7200'], at: new Date(clock - 60000).toISOString(), parkedSince: new Date(clock - 120000).toISOString() } }, [], MIAMI);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  assert.match(sent[0].subject, /^Trailer watch: 1 trailer moving without a load/);
  assert.match(sent[0].html, /Trailer 7200 is moving — not on any load/);
  const e = trailerWatchEmail({ longParked: [{ trailer: '7140', days: 40, atLeast: true, parkedSince: '2026-11-10T12:00:00Z', where: 'Sanford, NC' }], movingNoLoad: [] });
  assert.match(e.subject, /1 trailer parked 30\+ days/); assert.match(e.html, /hasn&#39;t moved in 40\+ days|hasn't moved in 40\+ days/);
});

test('a shuttle from the Miami yard to a cooler 3 miles away: quiet; leaving the 5-mile area without a load: an email', async () => {
  const { checkTrailers } = await import('../trailerwatch.js');
  const yard = { 7400: { trailer: '7400', lat: 25.7947, lng: -80.3099, at: ago(90), parkedSince: ago(600), atLeast: true } };
  const st = checkTrailers(yard, [], MIAMI, {}, NOW - 3600000).next;
  const cooler = { 7400: { trailer: '7400', lat: 25.835, lng: -80.33, at: ago(3), mph: 30, parkedSince: ago(10), atLeast: false } };   // ~3 mi north
  assert.equal(checkTrailers(cooler, [], MIAMI, st, NOW).movingNoLoad.length, 0, 'cooler shuttle');
  const away = { 7400: { trailer: '7400', lat: 26.1, lng: -80.25, at: ago(3), mph: 62, parkedSince: ago(15), atLeast: false } };      // ~21 mi north
  assert.equal(checkTrailers(away, [], MIAMI, st, NOW).movingNoLoad.length, 1, 'left the yard area without a load');
});

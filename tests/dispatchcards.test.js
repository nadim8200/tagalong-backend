import test from 'node:test';
import assert from 'node:assert/strict';
import { tripCard, customerAnswer, loadAnswer, placeOfGps } from '../dispatchcards.js';
import { customerStops } from '../voice.js';
import { initJarvisChat } from '../jarvischat.js';

// fixture shaped like the Designers Choice Boston example (test data only)
const ACTIVE = { trip: { tripNumber: '625534', status: 'DEPSHIP', powerUnit: '733', trailer: '7235' },
  freightBills: [{ billNumber: 'C0981234', billToName: 'DESIGNERS CHOICE', endZoneDescription: 'BOSTON, MA, 02118', pieces: null }, { billNumber: 'C0981240', billToName: 'DESIGNERS CHOICE', endZoneDescription: 'HYDE PARK, MA, 02136', pieces: 1 }, { billNumber: 'C0999999', billToName: 'OTHER FLORIST', endZoneDescription: 'BOSTON, MA, 02118', pieces: 40 }],
  _manifest: { version: 1, uploadedAt: '2026-10-21T02:00:00Z', stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL', city: 'MIAMI', state: 'FL' }, { action: 'DELIVER', customer: 'DESIGNERS CHOICE BOSTON', city: 'BOSTON', state: 'MA', stopNumber: 2, piecesText: '1 LOAD · 2,600 CUBES' }, { action: 'DELIVER', customer: 'DESIGNERS CHOICE', city: 'HYDE PARK', state: 'MA', stopNumber: 3 }] },
  _samsara: { location: 'I 95, Skippers, VA, 23879', gpsAt: '2026-10-22T20:18:00Z', speedMph: 0 } };
const DONE = { trip: { tripNumber: '625468', status: 'DEPCONS', powerUnit: '2601', trailer: '2048' },
  freightBills: [{ billNumber: 'M5048345', billToName: 'DESIGNERS CHOICE', endZoneDescription: 'BOSTON, MA, 02118', pieces: 38, actualDelivery: '2026-10-22T12:41:00' }] };
const ETAS = { 625534: { at: Date.parse('2026-10-22T20:15:00Z'), team: true, passed: [], stops: [
  { label: 'BOSTON, MA, 02118', zip: '02118', miles: 560, etaMs: Date.parse('2026-10-23T07:30:00Z'), apptMs: Date.parse('2026-10-23T07:00:00Z'), apptFrom: 'handwritten' },
  { label: 'HYDE PARK, MA, 02136', zip: '02136', miles: 570, etaMs: Date.parse('2026-10-23T08:40:00Z') }] } };

test('a customer answer: their stops only, ETA + appointment (with its source), location + time, delivered kept apart', () => {
  const stops = customerStops([ACTIVE, DONE], 'Designers Choice', ETAS, { staff: true });
  const d = customerAnswer({ heading: 'Designers Choice', items: [ACTIVE, DONE], stops, etas: ETAS, now: Date.parse('2026-10-22T20:19:00Z') });
  assert.equal(d.kind, 'customer'); assert.equal(d.trips.length, 2);
  const [a, b] = d.trips;
  assert.equal(a.trip, '625534'); assert.equal(a.status, 'active');
  assert.deepEqual(a.location, { text: 'Skippers, VA', motion: 'Stopped', atMs: Date.parse('2026-10-22T20:18:00Z'), source: 'Samsara GPS' });
  assert.equal(a.stops[0].place, 'Boston, MA'); assert.equal(a.stops[0].tz, 'America/New_York');
  assert.equal(a.stops[0].etaMs, Date.parse('2026-10-23T07:30:00Z'));
  assert.deepEqual(a.stops[0].appt, { ms: Date.parse('2026-10-23T07:00:00Z'), source: 'Handwritten on the trip sheet', verified: false });
  assert.equal(a.stops[0].cargo, '1 LOAD · 2,600 CUBES', 'no box count on the bill → the sheet\'s own units, never 0');
  assert.deepEqual(a.stops[0].bills, ['C0981234'], 'another customer\'s bill at the same town stays out');
  assert.equal(a.stops[1].place, 'Hyde Park, MA'); assert.equal(a.stops[1].cargo, '1 box');
  assert.equal(b.trip, '625468'); assert.equal(b.status, 'delivered');
  assert.equal(b.stops[0].deliveredLocal, '2026-10-22T12:41'); assert.equal(b.stops[0].etaMs, null);
  assert.equal(b.location, null, 'no GPS → no made-up location');
});

test('a load answer covers every stop; GPS places read as city, state', () => {
  const d = loadAnswer({ item: ACTIVE, eta: ETAS[625534] });
  assert.equal(d.heading, 'Trip 625534'); assert.equal(d.trips[0].stops.length, 2);
  assert.match(d.trips[0].stops[0].customers.join(), /DESIGNERS CHOICE BOSTON/);
  assert.equal(placeOfGps('Ventura Freeway, Thousand Oaks, CA, 91320'), 'Thousand Oaks, CA');
  assert.equal(tripCard({ trip: { tripNumber: '1' }, freightBills: [] }, null).stops.length, 0);
});

test('the chat answer carries the cards (saved with the message) — never in customer email mode', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  await db.set('taWatch:florida-beauty', { alerts: {}, etas: ETAS });
  const steps = [() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'customer_etas', input: { customer: 'Designers Choice' } }] }), () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'load_details', input: { trip: '625534' } }] }), () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'One arriving, one delivered.' }] })];
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  initJarvisChat(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [ACTIVE, DONE], unclosed: [] }), env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: async () => ({ ok: true, status: 200, json: async () => steps.shift()() }) });
  let out; await routes['POST /jarvis/chat']({ body: { message: 'ETA to Designers Choice?' }, params: {}, user: { id: 7, name: 'Rosa' } }, { status() { return this; }, json(j) { out = j; } });
  assert.equal(out.dispatch.length, 1, 'trip 625534 is already in the customer cards — not drawn twice');
  assert.equal(out.dispatch[0].trips.length, 2);
  const th = await db.get('taJarvisChat:7', {});
  assert.equal(Object.values(th.threads)[0].messages[1].dispatch[0].heading, 'Designers Choice Boston');
});

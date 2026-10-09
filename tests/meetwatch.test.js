import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrived, radiusFor, verifyText, initMeetWatch } from '../meetwatch.js';
import { tripBlock } from '../followupmail.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const FORT_PIERCE = { lat: 27.4467, lng: -80.3256 };
const NOW = Date.parse('2026-10-09T03:40:00Z');

test('arrived = fresh GPS inside the radius and stopped / slow (or inside twice), not driving through', () => {
  const at = (lat, lng, mph, ageMin = 2) => ({ _samsara: { lat, lng, speedMph: mph, gpsAt: new Date(NOW - ageMin * 60000).toISOString() } });
  assert.equal(arrived(at(25.8, -80.3, 0), FORT_PIERCE, { now: NOW }).done, false, 'Miami is not Fort Pierce');
  assert.equal(arrived(at(27.45, -80.33, 62), FORT_PIERCE, { now: NOW }).done, false, 'passing through at 62 mph');
  assert.equal(arrived(at(27.45, -80.33, 62), FORT_PIERCE, { now: NOW, wasInside: true }).done, true, 'still there on the next check');
  assert.equal(arrived(at(27.45, -80.33, 0), FORT_PIERCE, { now: NOW }).done, true);
  assert.equal(arrived(at(27.45, -80.33, 0, 90), FORT_PIERCE, { now: NOW }).fresh, false, 'old GPS does not count');
  assert.equal(radiusFor('Fort Pierce'), 5);
  assert.equal(radiusFor('3400 NW 74th Ave, Miami'), 1);
});

test('the driver text asks exactly what dispatch wants verified', () => {
  assert.equal(verifyText({ name: 'Frankie Patterson', trip: '624620', place: 'Fort Pierce', verify: 'both drivers are together on the truck', atPlace: true }),
    'Florida Beauty Flora dispatch: Hi Frankie, this is Jarvis (automated). Load 624620: I see you reached Fort Pierce. Please confirm: both drivers are together on the truck? Reply here. Reply STOP to opt out.');
});

test('the email says Jarvis tracks the truck to the place (no time needed) and what it will verify', () => {
  const b = tripBlock({ kind: 'pickup_followup', trip: '624620', event: 'meetup', date: '2026-10-08', place: 'Fort Pierce', region: 'Florida', verify: 'both drivers are together on the truck', result: { watching: 'tracking' } }, { trip: { status: 'DEPSHIP', origZoneDesc: 'MIAMI, FL' } }, { now: NOW });
  assert.equal(b.next, 'Jarvis tracks the truck and replies here when it reaches Fort Pierce, then texts the driver to confirm: both drivers are together on the truck');
  assert.equal(b.need, null);
});

test('loop: tracks to Fort Pierce → replies on the chain + texts the driver → driver answer on the chain', async () => {
  const db = memDb();
  const item = { trip: { tripNumber: '624620', status: 'DEPSHIP', powerUnit: '2612', trailer: 'R9' }, _samsara: { lat: 26.7, lng: -80.1, speedMph: 60, gpsAt: new Date(NOW).toISOString(), driver1: 'Frankie Patterson' } };
  const replies = []; const texts = [];
  let clock = NOW;
  const w = initMeetWatch({ db, getBoard: async () => ({ trips: [item] }), geocode: async () => FORT_PIERCE, textDriver: async (site, trip, text) => { texts.push(text); return { sent: true, via: 'app (push)' }; }, replyInThread: async (site, id, b) => { replies.push({ id, ...b }); return { sent: true }; }, env: { NODE_ENV: 'test' }, now: () => clock });
  assert.deepEqual(await w.add({ trip: '624620', place: 'Fort Pierce', region: 'Florida', verify: 'both drivers are together on the truck', emailId: 'rosa1' }), { ok: true, tracking: true });
  await w.run();
  assert.equal(replies.length, 0); assert.equal(texts.length, 0);
  Object.assign(item._samsara, { lat: 27.45, lng: -80.33, speedMph: 0, gpsAt: new Date(clock + 60000).toISOString(), location: 'I-95, Fort Pierce, FL' });
  clock += 2 * 60000; await w.run();
  assert.equal(texts.length, 1); assert.match(texts[0], /I see you reached Fort Pierce\. Please confirm: both drivers are together on the truck\?/);
  assert.equal(replies.length, 1); assert.equal(replies[0].id, 'rosa1');
  assert.match(replies[0].text, /Trip 624620 — REACHED FORT PIERCE/);
  assert.match(replies[0].text, /Asked the driver to confirm: both drivers are together on the truck \(app \(push\)\)/);
  clock += 2 * 60000; await w.run(); assert.equal(replies.length, 1, 'arrival told once');
  await db.set('taTripComms:florida-beauty', { 624620: [{ type: 'reply', from: 'driver app', text: 'Yes, Mike is with me', at: new Date(clock + 1000).toISOString() }] });
  clock += 2 * 60000; await w.run();
  assert.equal(replies.length, 2);
  assert.match(replies[1].text, /“Yes, Mike is with me” — TagAlong app/);
  assert.match(replies[1].text, /Jarvis does not mark it verified on its own/);
});

test('something to verify with no place: text the driver right away', async () => {
  const db = memDb(); const texts = [];
  const w = initMeetWatch({ db, getBoard: async () => ({ trips: [{ trip: { tripNumber: '1', status: 'DISP' } }] }), geocode: async () => null, textDriver: async (s, t, text) => { texts.push(text); return { sent: true }; }, env: { NODE_ENV: 'test' }, now: () => NOW });
  await w.add({ trip: '1', verify: 'the trailer swap is done' });
  await w.run();
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Load 1\. Please confirm: the trailer swap is done\?/);
});

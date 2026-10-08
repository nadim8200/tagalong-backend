import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedPickup, nextStep, readReply, textFor, initPickupFollow } from '../pickupfollow.js';

const MIN = 60000;
const load = (extra = {}) => ({ trip: { tripNumber: '624520', status: 'DISP', powerUnit: '2202', trailer: '7140', origZoneDesc: 'MIAMI TERMINAL' },
  freightBills: [{ billNumber: 'M5040168', endZoneDescription: 'LOMBARD, IL, 60148' }],
  _manifest: { pickupAt: '2026-10-08T20:30', docIds: ['77'], stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL' }] },
  _samsara: { location: 'Doral, FL', gpsAt: '2026-10-08T23:50:00Z', speedMph: 0, lat: 25.8, lng: -80.33, driver1: 'Frankie Patterson', driver1Info: { name: 'Frankie Patterson', phone: '7866964090' } }, ...extra });

test('when the pickup is: a dispatcher email beats the trip sheet; the rate con pickup in its own time zone', () => {
  assert.equal(plannedPickup(load()).source, 'trip sheet');
  assert.equal(new Date(plannedPickup(load()).ms).toISOString(), '2026-10-09T00:30:00.000Z');      // 8:30 PM Eastern
  assert.equal(plannedPickup(load({ _hold: { kind: 'pickup_delayed', newPickupAt: '2026-10-09T06:00' } })).source, 'email');
  const rc = plannedPickup({ trip: { tripNumber: '1' }, _ratecon: { data: { pickups: [{ name: 'Mission Produce', city: 'Oxnard', state: 'CA', date: '10/08/2026', time: '2:00 PM' }] } } });
  assert.equal(rc.source, 'rate con'); assert.equal(new Date(rc.ms).toISOString(), '2026-10-08T21:00:00.000Z'); assert.match(rc.place, /Mission Produce, Oxnard, CA/);
});

test('the timeline: got-it text, 1 hour before, 30 minutes before (only if still unknown)', () => {
  const plan = { ms: Date.parse('2026-10-09T00:30:00Z') };
  assert.equal(nextStep(null, plan, plan.ms - 5 * 60 * MIN), 'ack');
  assert.equal(nextStep({ plannedAt: plan.ms, steps: { ack: {} } }, plan, plan.ms - 55 * MIN), 't60');
  assert.equal(nextStep({ plannedAt: plan.ms, steps: { ack: {}, t60: {} } }, plan, plan.ms - 25 * MIN), 't30');
  assert.equal(nextStep({ plannedAt: plan.ms, steps: { ack: {}, t60: {} }, outcome: { status: 'rolling' } }, plan, plan.ms - 25 * MIN), null);
  assert.equal(nextStep({ plannedAt: plan.ms - 3600000, steps: { ack: {}, t60: {}, t30: {} } }, plan, plan.ms - 5 * 60 * MIN), 'ack', 'a new pickup time starts over');
  assert.match(textFor('ack', { name: 'Frankie Patterson', trip: '624520', plan: { ...plan, source: 'trip sheet', place: 'MIAMI TERMINAL' } }), /^Florida Beauty Flora dispatch: Hi Frankie, this is Jarvis \(automated\)\. Got the trip sheet for load 624520: pickup at MIAMI TERMINAL Thu, Oct 8, 8:30 PM\. .*Reply STOP to opt out\.$/);
  assert.equal(readReply('Rolling now, 20 min out'), 'rolling'); assert.equal(readReply('running late, be there at 10'), 'delayed'); assert.equal(readReply('truck broke down'), 'issue'); assert.equal(readReply('not yet'), 'not_yet');
});

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; }, _m: m }; }

test('end to end: texts the driver, reads "rolling", emails dispatch with the words, tracking and the trip sheet', async () => {
  const db = memDb();
  await db.set('taSmsConsent:florida-beauty', { 7866964090: { by: 'Rosa', at: '2026-10-01' } });
  await db.set('taPickupFollowCfg', { to: ['dispatch@floridabeauty.us'] });
  const texts = []; const mails = [];
  const ringcentral = { configFor: async () => ({ fromNumber: '+17865550000' }), sendSms: async (o, m) => texts.push(m) };
  const logs = [];
  const comms = { log: async (site, trip, e) => { logs.push(e); await db.update('taTripComms:florida-beauty', (cur) => ({ ...(cur || {}), [trip]: [{ ...e, at: e.at || new Date(clock).toISOString() }, ...((cur || {})[trip] || [])] }), {}); } };
  const fetchFn = async (url, opts = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('/sendMail')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({}) }; }
    return ok({});
  };
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
  let clock = Date.parse('2026-10-08T19:00:00Z');                          // 3 PM — pickup 8:30 PM
  const board = { trips: [load()] };
  const docs = { readDocs: async () => [{ id: '77', mediaType: 'image/jpeg', data: Buffer.from('jpg') }] };
  const f = initPickupFollow({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => board, ringcentral, comms, docs, env, fetchFn, now: () => clock });
  await f.run();
  assert.equal(texts.length, 1); assert.match(texts[0].text, /Got the trip sheet for load 624520/);
  clock = Date.parse('2026-10-08T23:35:00Z');                              // 55 min before
  await f.run();
  assert.equal(texts.length, 2); assert.match(texts[1].text, /in about 1 hour/);
  // the driver answers
  await comms.log('florida-beauty', '624520', { type: 'reply', from: '7866964090', text: 'Rolling now, 20 min out', at: new Date(clock + 2 * MIN).toISOString() });
  clock += 4 * MIN;
  await f.run();
  assert.equal(mails.length, 1);
  const m = mails[0].message;
  assert.match(m.subject, /^Trip 624520 — Frankie Patterson: rolling to pickup/);
  assert.match(m.body.content, /Rolling now, 20 min out/); assert.match(m.body.content, /maps\.google\.com\/\?q=25\.8,-80\.33/);
  assert.equal(m.attachments[0].name, 'trip-sheet-624520.jpg');
  clock = Date.parse('2026-10-09T00:05:00Z');                              // 25 min before: already known, no more texts
  await f.run();
  assert.equal(texts.length, 2);
});

test('no consent → no texts; already rolling loads never trigger an email', async () => {
  const db = memDb();
  await db.set('taPickupFollowCfg', { to: ['dispatch@floridabeauty.us'] });
  const texts = []; const ringcentral = { configFor: async () => ({ fromNumber: '+1' }), sendSms: async (o, m) => texts.push(m) };
  let clock = Date.parse('2026-10-08T19:00:00Z');
  const board = { trips: [load(), { ...load(), trip: { ...load().trip, tripNumber: '624481', status: 'DEPSHIP' } }] };
  const f = initPickupFollow({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => board, ringcentral, env: { NODE_ENV: 'test' }, now: () => clock });
  const r = await f.run();
  assert.equal(texts.length, 0);
  assert.ok(!r.some((x) => x.outcome), 'nothing reported');
});

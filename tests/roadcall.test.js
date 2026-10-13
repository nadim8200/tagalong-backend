import test from 'node:test';
import assert from 'node:assert/strict';
import { roadCallType, tirePosition, tireSize, missing, packet, packetText, michelinProvider, initRoadCalls } from '../roadcall.js';

test('a driver\'s words: what broke, which tire, the size (English / Spanish)', () => {
  assert.equal(roadCallType('I got a flat on the trailer'), 'tire');
  assert.equal(roadCallType('se me ponchó una llanta'), 'tire');
  assert.equal(roadCallType('truck broke down, check engine light, derate'), 'mechanical');
  assert.equal(roadCallType('el camión no arranca'), 'mechanical');
  assert.equal(roadCallType('need a tow'), 'tow');
  assert.equal(roadCallType('running late, traffic'), null);
  assert.deepEqual(tirePosition('left front steer'), { axle: 'steer', side: 'left', pos: null, which: null, label: 'Steer · left' });
  assert.equal(tirePosition('trailer rear axle right side inside').label, 'Trailer · rear axle · right · inner');
  assert.equal(tirePosition('llanta del tráiler lado derecho de afuera').label, 'Trailer · right · outer');
  assert.equal(tireSize('it says 295/75 R 22.5 on it'), '295/75R22.5');
  assert.equal(tireSize('11R22.5 drive'), '11R22.5');
  assert.equal(tireSize('445/50R22.5'), '445/50R22.5');
  assert.equal(tireSize('no idea'), null);
});

test('the packet: everything the provider needs, nothing guessed; what is still missing', () => {
  const rc = { id: 'RC-1013-123', trip: '624889', type: 'tire', truck: '2220', trailer: '7235', reefer: true, location: { lat: 35.42, lng: -84.6, address: 'I 75, McMinn County, TN', text: 'I-75 north mile marker 49' }, driver: { name: 'Wilden De Armas', phone: '7864444512' }, tire: { position: tirePosition('trailer right outside'), size: '295/75R22.5', condition: 'blowout' }, faults: [{ code: 'SPN 110 FMI 0', description: 'coolant temp high' }], safe: true, loaded: true };
  assert.deepEqual(missing(rc), []);
  const p = packet(rc);
  assert.equal(p.serviceType, 'TIRE'); assert.equal(p.unit.type, 'trailer'); assert.equal(p.tire.size, '295/75R22.5'); assert.equal(p.location.latitude, 35.42); assert.equal(p.reference, 'RC-1013-123');
  assert.match(packetText(rc), /Tire: Trailer · right · outer · size 295\/75R22.5 · blowout/);
  assert.deepEqual(missing({ type: 'tire', location: { lat: 1 } }), ['which tire (steer / drive / trailer, left / right)', 'tire size (or a photo of the sidewall)', 'is the truck in a safe spot']);
  assert.equal(michelinProvider({ env: {} }).ready, false);
});

test('a driver texts a flat → road call opens with GPS + fault codes, asks what is missing; the photo gives the size; approve → Michelin', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  const board = { trips: [{ trip: { tripNumber: '624889', powerUnit: '2220', trailer: '7235' }, _samsara: { lat: 35.42, lng: -84.6, location: 'I 75, McMinn County, TN', driver1: 'WILDEN DE ARMAS', dtcCodes: [{ code: 'SPN 110 FMI 0', description: 'Coolant temp high' }] } }] };
  const mails = []; const sent = [];
  const fetchFn = async (url) => { assert.match(url, /anthropic/); return { ok: true, json: async () => ({ content: [{ text: '{"size": "295/75R22.5", "brand": "Michelin"}' }] }) }; };
  const provider = { name: 'Michelin ONCall', phone: '1-800-847-3911', ready: true, create: async (p) => { sent.push(p); return { ref: 'ONC-55501', status: 'Received', eta: null }; } };
  const routes = {}; const app = { get: (p, a, h) => { routes[`GET ${p}`] = h || a; }, post: (p, a, h) => { routes[`POST ${p}`] = h || a; } };
  const rcs = initRoadCalls(app, { requireAuth: () => {}, db, getBoard: async () => board, sendMail: async (m) => mails.push(m), recipients: async () => ['dispatch@floridabeauty.us'], docs: { readDocs: async () => [{ mediaType: 'image/jpeg', data: 'AAAA' }] }, provider, env: { ANTHROPIC_API_KEY: 'k', ROADCALL_CALLBACK_KEY: 'cb' }, fetchFn });
  const first = await rcs.fromDriverText({ trip: '624889', from: '+17864444512', text: 'I have a flat tire on the trailer, right side outside' });
  assert.equal(first.rc.type, 'tire'); assert.equal(first.rc.truck, '2220'); assert.equal(first.rc.location.lat, 35.42); assert.equal(first.rc.faults[0].code, 'SPN 110 FMI 0');
  assert.equal(first.rc.tire.position.label, 'Trailer · right · outer');
  assert.match(first.reply, /road call RC-\d{4}-\d{3} is open\. Please reply with a photo of the tire sidewall .*; are you in a safe spot/);
  assert.match(mails[0].subject, /Road call opened \(tire\) — road call RC-.* · truck 2220 · trip 624889/);
  // the sidewall photo → the size; "on the shoulder" → safe → ready to approve
  const withSize = await rcs.photos('florida-beauty', '624889', { docIds: ['d1'], by: 'driver app' });
  assert.equal(withSize.tire.size, '295/75R22.5'); assert.equal(withSize.tire.sizeFrom, 'sidewall photo');
  const ready = (await rcs.fromDriverText({ trip: '624889', from: '+17864444512', text: 'on the shoulder, loaded' })).rc;
  assert.equal(ready.status, 'ready');
  assert.match(mails[mails.length - 1].subject, /Road call ready to approve/);
  // dispatch approves → sent to Michelin with the packet; their update comes back
  const ap = await rcs.approve(ready.id, 'Rosa');
  assert.equal(ap.status, 'sent'); assert.equal(ap.provider.ref, 'ONC-55501');
  assert.equal(sent[0].serviceType, 'TIRE'); assert.equal(sent[0].tire.size, '295/75R22.5'); assert.equal(sent[0].approvedBy, 'Rosa');
  const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  await routes['POST /roadcall/provider/callback']({ query: { key: 'cb' }, body: { caseNumber: 'ONC-55501', status: 'Technician Dispatched', eta: '45 min' }, get: () => undefined }, r);
  assert.equal(r.body.used, true);
  const now = (await rcs.list())[0];
  assert.equal(now.status, 'tech en route'); assert.equal(now.provider.eta, '45 min');
  const bad = { code: 200, status(c) { bad.code = c; return bad; }, json(b) { bad.body = b; return bad; } };
  await routes['POST /roadcall/provider/callback']({ query: { key: 'nope' }, body: {}, get: () => undefined }, bad);
  assert.equal(bad.code, 401);
});

test('no Michelin API yet → approving gives dispatch the packet to call 1-800-TIRE911', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  const mails = [];
  const rcs = initRoadCalls(null, { db, sendMail: async (m) => mails.push(m), recipients: async () => ['d@x.us'], env: {} });
  const rc = await rcs.open({ trip: '1', truck: '2220', type: 'mechanical', details: 'won\'t start', location: { text: 'TA Knoxville' }, safe: true });
  const ap = await rcs.approve(rc.id, 'Rosa');
  assert.equal(ap.status, 'approved'); assert.equal(ap.provider, undefined);
  assert.match(mails[mails.length - 1].subject, /Approved — call Michelin ONCall \(1-800-847-3911/);
});

// option 1 (Oct 13): the dispatcher asks Jarvis to check on the driver
test('dispatch asks Jarvis to check on a driver → text with the questions + a breakdown photo link; no answer in 15 min → Jarvis calls', async () => {
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  let T = Date.parse('2026-10-13T20:00:00Z');
  const texts = []; const calls = [];
  const board = { trips: [{ trip: { tripNumber: '624889', powerUnit: '2220', trailer: '7235' }, _samsara: { lat: 35.4, lng: -84.6, driver1: 'WILDEN DE ARMAS' } }] };
  const rcs = initRoadCalls(null, { db, getBoard: async () => board, env: {}, now: () => T,
    textDriver: async (site, trip, text) => { texts.push(text); return { sent: true }; }, callDriver: async (trip) => { calls.push(trip); }, photoLink: async () => 'https://mytagalong.app/t/abc123' });
  const rc = await rcs.checkDriver('624889', 'Rosa', "2220 hasn't moved in 2 hours");
  assert.equal(rc.source, 'dispatch'); assert.equal(rc.check.texted, true);
  assert.match(texts[0], /Hi WILDEN, this is Jarvis \(automated\)\. Dispatch is checking on you — are you OK\? Are you broken down\?/);
  assert.match(texts[0], /Send photos here: https:\/\/mytagalong\.app\/t\/abc123\?photo=breakdown/);
  T += 10 * 60000; await rcs.tick(); assert.deepEqual(calls, []);
  T += 6 * 60000; await rcs.tick(); assert.deepEqual(calls, ['624889']);
  T += 10 * 60000; await rcs.tick(); assert.deepEqual(calls, ['624889']);    // once
  // a driver who answered by text isn't called
  const rc2 = await rcs.checkDriver('624889', 'Rosa');
  assert.equal(rc2.id, rc.id);
});

test('the Michelin packet carries lat / long, the GPS time and a map link — refreshed when dispatch approves', async () => {
  const rc = { id: 'RC-1', type: 'mechanical', truck: '2220', details: 'won\'t start', safe: true, location: { lat: 35.423456, lng: -84.601234, gpsAt: '2026-10-13T20:05:00Z', source: 'truck ELD', address: 'I 75, McMinn County, TN', text: 'northbound mile marker 49' } };
  const p = packet(rc);
  assert.equal(p.location.latitude, 35.423456); assert.equal(p.location.longitude, -84.601234);
  assert.equal(p.location.mapUrl, 'https://maps.google.com/?q=35.423456,-84.601234');
  const txt = packetText(rc);
  assert.match(txt, /GPS: 35\.423456, -84\.601234 \(as of Oct 13, 4:05 PM ET, truck ELD\) · Map: https:\/\/maps\.google\.com\/\?q=35\.423456,-84\.601234/);
  assert.match(txt, /driver says: northbound mile marker 49/);
  assert.match(packetText({ ...rc, location: { text: 'TA Knoxville' } }), /GPS: not available — use the location the driver gave/);
  // approve → the truck's newest GPS goes out, not the one from when the call opened
  const store = {}; const db = { enabled: true, get: async (k, d) => store[k] ?? d, update: async (k, fn, d) => { store[k] = fn(store[k] ?? d); return store[k]; } };
  const board = { trips: [{ trip: { tripNumber: '624889', powerUnit: '2220' }, _samsara: { lat: 35.4, lng: -84.6, gpsAt: '2026-10-13T20:00:00Z' } }] };
  const sent = [];
  const rcs = initRoadCalls(null, { db, getBoard: async () => board, env: {}, provider: { name: 'Michelin ONCall', phone: 'x', ready: true, create: async (pk) => { sent.push(pk); return { ref: 'ONC-1' }; } } });
  const opened = await rcs.open({ trip: '624889', type: 'mechanical', details: 'no start', safe: true });
  board.trips[0]._samsara = { lat: 35.55, lng: -84.45, gpsAt: '2026-10-13T20:40:00Z' };
  await rcs.approve(opened.id, 'Rosa');
  assert.equal(sent[0].location.latitude, 35.55); assert.equal(sent[0].location.gpsAt, '2026-10-13T20:40:00Z');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { transferPlan, transferStatus, readTransferReply, step, initTransferWatch, transferEmail } from '../transferwatch.js';

const item = { trip: { tripNumber: '624773', status: 'DEPSHIP', powerUnit: '4504', trailer: '7137' }, _manifest: { truck: '734', transferTruck: '4504', trailer: '7137' } };
const MIAMI = { lat: 25.83, lng: -80.33 }; const MACON = { lat: 32.84, lng: -83.63 };

test('the planned transfer on a sheet, and where the two trucks are', () => {
  assert.deepEqual(transferPlan(item), { trip: '624773', from: '734', to: '4504', trailer: '7137' });
  assert.equal(transferPlan({ ...item, _manifest: { truck: '4504' } }), null, 'no transfer planned');
  const apart = transferStatus({ ...MIAMI, speedMph: 62 }, { ...MACON, speedMph: 0 });
  assert.equal(apart.together, false); assert.ok(apart.distanceMi > 400); assert.deepEqual([apart.aRolling, apart.bRolling], [true, false]);
  const near = transferStatus({ ...MACON, speedMph: 0 }, { lat: MACON.lat + 0.002, lng: MACON.lng, speedMph: 0 });
  assert.equal(near.together, true);
  assert.equal(readTransferReply('Yes done, hooked up'), 'done');
  assert.equal(readTransferReply('no todavía no'), 'not_done');
  assert.equal(readTransferReply('ok'), null);
});

test('steps: report → report every 2 h apart → together report → text after 15 min → call after 15 more', () => {
  const t0 = Date.parse('2026-10-12T02:00:00Z'); const M = 60000;
  const far = { together: false, distanceMi: 300 }; const close = { together: true, distanceMi: 0.1 };
  let r = step(null, far, t0); assert.deepEqual(r.actions, ['report_start']);
  r = step(r.state, far, t0 + 60 * M); assert.deepEqual(r.actions, []);
  r = step(r.state, far, t0 + 121 * M); assert.deepEqual(r.actions, ['report_update']);
  r = step(r.state, close, t0 + 200 * M); assert.deepEqual(r.actions, ['report_together']);
  r = step(r.state, close, t0 + 210 * M); assert.deepEqual(r.actions, []);
  r = step(r.state, close, t0 + 216 * M); assert.deepEqual(r.actions, ['text']);
  r = step(r.state, close, t0 + 232 * M); assert.deepEqual(r.actions, ['call']);
  r = step({ ...r.state, outcome: { status: 'done' } }, close, t0 + 300 * M); assert.deepEqual(r.actions, []);
});

test('the whole run: emails to the Truck transfer list, text, then the driver says done → final report, watch ends', async () => {
  const store = new Map(); const sent = []; const texts = []; const calls = [];
  const db = { enabled: true, get: async (k, fb) => (store.has(k) ? store.get(k) : fb), set: async (k, v) => store.set(k, v), update: async (k, fn, fb) => { const v = fn(store.has(k) ? store.get(k) : fb); store.set(k, v); return v; } };
  let t = Date.parse('2026-10-12T02:00:00Z');
  let at734 = { ...MIAMI, speedMph: 60 }; const at4504 = { ...MACON, speedMph: 0, location: 'Macon, GA' };
  const w = initTransferWatch({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['ntellez@floridabeauty.us'], now: () => t,
    textDriver: async (site, trip, text) => { texts.push(text); return { sent: true }; }, voice: { placeCall: async (trip, o) => calls.push(o), callsFor: async () => [] },
    livePos: (u) => (u === '734' ? at734 : at4504) });
  const board = { trips: [item] };
  await w.process('fb', board);
  assert.match(sent[0].subject, /Transfer planned — trip 624773: truck 734 → 4504/);
  at734 = { lat: MACON.lat + 0.001, lng: MACON.lng, speedMph: 0 }; t += 300 * 60000;
  await w.process('fb', board);
  assert.match(sent[1].subject, /Trucks together — trip 624773/);
  t += 16 * 60000; await w.process('fb', board);
  assert.equal(texts.length, 1); assert.match(texts[0], /is the transfer done\? Reply YES/);
  // the driver texts back
  await db.set('taTripComms:florida-beauty', { 624773: [{ type: 'reply', at: new Date(t + 60000).toISOString(), text: 'Yes done' }] });
  t += 2 * 60000; await w.process('fb', board);
  assert.match(sent.at(-1).subject, /Transfer done — trip 624773/);
  assert.match(sent.at(-1).html, /Driver replied: &quot;Yes done&quot;/);
  t += 60 * 60000; const n = sent.length; await w.process('fb', board);
  assert.equal(sent.length, n, 'nothing more after done'); assert.equal(calls.length, 0, 'answered by text — no call');
});

test('report email shows both trucks, rolling or stopped, and the distance', () => {
  const e = transferEmail('update', { trip: '1', from: '734', to: '4504', trailer: '7137' }, { location: 'I-75, GA', speedMph: 61 }, { location: 'Macon, GA', speedMph: 0 }, { distanceMi: 87.4, aRolling: true, bRolling: false, together: false });
  assert.match(e.text, /Truck 734\n  I-75, GA\n  Status: Rolling · 61 mph/);
  assert.match(e.text, /Truck 4504\n  Macon, GA\n  Status: Stopped/);
  assert.match(e.html, /87.4 mi/);
});

import { doneInTruckMate } from '../transferwatch.js';

test('a transfer TruckMate already shows done (624773: spotted, then 4504 departed) is not watched — no emails', async () => {
  const doneItem = { ...item, _times: { statusHistory: [{ status: 'DEPSHIP', at: '2026-10-11T21:11:34Z' }, { status: 'SPTLD', at: '2026-10-12T06:46:38Z' }, { status: 'DEPSHIP', at: '2026-10-12T06:48:39Z' }] } };
  assert.equal(doneInTruckMate(doneItem, transferPlan(doneItem)), '2026-10-12T06:48:39Z');
  assert.equal(doneInTruckMate(item, transferPlan(item)), null);
  const store = new Map(); const sent = [];
  const db = { enabled: true, get: async (k, fb) => (store.has(k) ? store.get(k) : fb), update: async (k, fn, fb) => { const v = fn(store.has(k) ? store.get(k) : fb); store.set(k, v); return v; } };
  const w = initTransferWatch({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['x@y.com'], livePos: () => ({ ...MIAMI, speedMph: 50 }) });
  await w.process('fb', { trips: [doneItem] }); await w.process('fb', { trips: [doneItem] });
  assert.equal(sent.length, 0);
});

import { transferSpot } from '../transferwatch.js';
import { fitView, transferMapSvg, placeLabel } from '../truckmap.js';
test('the transfer location: a named place, or a parked broken truck marked as assumed, never a guess', () => {
  const a = { lat: 38.1, lng: -122.2, speedMph: 0, location: 'Vallejo, CA' }; const b = { lat: 38.5, lng: -122.2, speedMph: 60 };
  const base = { trip: '1', from: '2617', to: '2202' };
  const geo = () => ({ lat: 38.3, lng: -122.2 });
  const named = transferSpot({ ...base, place: 'Pilot, Ocala, FL', rescue: {} }, a, b, geo);
  assert.equal(named.label, 'Pilot, Ocala, FL'); assert.ok(named.aMi > 16 && named.aMi < 18, 'straight line × 1.2 until Google has it'); assert.equal(transferSpot({ ...base, place: 'P' }, a, b, geo, () => 21.4).aMi, 21.4, 'Google road miles when there');
  const unknown = transferSpot({ ...base, place: 'Somewhere' }, a, b, () => undefined);
  assert.equal(unknown.lat, null); assert.equal(unknown.aMi, null); assert.equal(unknown.label, 'Somewhere', 'shows what staff wrote, no dot');
  const parked = transferSpot({ ...base, rescue: {} }, a, b);
  assert.match(parked.label, /^Assumed: where truck 2617 is stopped \(Vallejo, CA\)\. No place was given\.$/); assert.equal(parked.aMi, 0); assert.ok(parked.bMi > 33);
  assert.equal(transferSpot({ ...base, rescue: {} }, { ...a, speedMph: 50 }, b), null, 'moving: no assumption');
  assert.equal(transferSpot(base, a, b), null, 'trip sheet transfer with no place');
  const e = transferEmail('start', base, a, b, transferStatus(a, b), { spot: null });
  assert.match(e.text, /Transfer location: Not on file/);
  const m = transferEmail('update', base, a, b, transferStatus(a, b), { spot: { label: 'P', aMi: 0.2, bMi: 12.6 }, mapCid: 'transfermap' });
  assert.match(m.text, /Truck 2617 to transfer location: At the transfer location/); assert.match(m.text, /Truck 2202 to transfer location: About 13 road mi \(estimated\)/); assert.match(m.html, /cid:transfermap/);
  assert.doesNotMatch(transferEmail('together', base, a, a, transferStatus(a, a), {}).text, /Transfer location:/, 'only planned and update');
});
test('the map fits every point and shows the red dot only when there is a place', () => {
  const pts = [{ lat: 38.1, lng: -122.2 }, { lat: 38.5, lng: -122.2 }];
  const near = fitView(pts); const far = fitView([{ lat: 25, lng: -80 }, { lat: 45, lng: -122 }]);
  assert.ok(near.zoom > far.zoom); assert.ok(far.zoom >= 3);
  assert.equal(fitView([pts[0]]).zoom, 13);
  const svg = (spot) => transferMapSvg([], fitView(pts), { trucks: pts.map((p, i) => ({ ...p, label: `Truck <${i}>`, miles: 12.4 })), spot });
  assert.match(svg({ lat: 38.3, lng: -122.2 }), /Transfer location/); assert.match(svg({ lat: 38.3, lng: -122.2 }), /12 mi/); assert.match(svg({ lat: 38.3, lng: -122.2 }), /Truck &lt;0&gt;/);
  assert.doesNotMatch(svg(null), /Transfer location|#C62828/);
});
test('map labels stay on the picture and off each other', () => {
  const taken = [{ l: 500, r: 700, t: 200, b: 300 }];
  assert.deepEqual(placeLabel('Truck 1', [{ x: 600, y: 250 }, { x: 600, y: 400 }], taken), { x: 600, y: 400 }, 'takes the free spot');
  assert.equal(taken.length, 2);
  assert.deepEqual(placeLabel('Truck 2', [{ x: 5, y: 250 }, { x: 300, y: 250 }], []), { x: 300, y: 250 }, 'not off the edge');
});

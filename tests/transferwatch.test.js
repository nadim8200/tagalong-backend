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
  assert.match(e.html, /734<\/b><\/td><td>I-75, GA<\/td><td>rolling \(61 mph\)/);
  assert.match(e.html, /4504<\/b><\/td><td>Macon, GA<\/td><td>stopped/);
  assert.match(e.html, /87.4 mi/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { findStops, classifyStop, wheelChanges, pointAt, tripStart, thin, fuelAround } from '../journey.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
// driving east, a 10h stop, driving, a 20 min stop, driving, a 5 min stop (ignored)
const pts = [];
let lng = -100;
for (let m = 0; m < 60; m += 5) { pts.push({ t: at(m), lat: 35, lng, mph: 60 }); lng += 0.07; }
for (let m = 60; m <= 660; m += 30) pts.push({ t: at(m), lat: 35, lng, mph: 0 });
for (let m = 665; m < 720; m += 5) { lng += 0.07; pts.push({ t: at(m), lat: 35, lng, mph: 60 }); }
for (let m = 720; m <= 740; m += 10) pts.push({ t: at(m), lat: 35, lng, mph: 0 });
for (let m = 745; m < 780; m += 5) { lng += 0.07; pts.push({ t: at(m), lat: 35, lng, mph: 60 }); }

test('journey: stops of 15+ min along the whole trail', () => {
  const s = findStops(pts);
  assert.equal(s.length, 2);
  assert.equal(s[0].minutes, 605);
  assert.equal(s[1].minutes, 30);   // arrived 715, left after 740
});

test('journey: what happened at each stop — reset, restart, driver change, fuel, delivery, breakdown', () => {
  const names = { a: 'Anibal Reyes', m: 'Michel Gonzalez' };
  const stop = { fromMs: T0 + 60 * 60000, toMs: T0 + 665 * 60000, minutes: 605 };
  const sleep = [{ driverId: 'a', status: 'sleeperBerth', from: stop.fromMs, to: stop.toMs }, { driverId: 'm', status: 'sleeperBerth', from: stop.fromMs, to: stop.toMs }];
  assert.equal(classifyStop(stop, { logs: sleep, names }).label, '10-hour reset');
  assert.equal(classifyStop({ ...stop, toMs: stop.fromMs + 35 * 3600000, minutes: 35 * 60 }, { logs: sleep.map((l) => ({ ...l, to: l.from + 35 * 3600000 })), names }).label, '34-hour restart');
  // a 20-min stop where Anibal drove in and Michel drove out → driver change
  const s2 = { fromMs: T0 + 720 * 60000, toMs: T0 + 740 * 60000, minutes: 20 };
  const swap = [{ driverId: 'a', status: 'driving', from: T0 + 665 * 60000, to: s2.fromMs }, { driverId: 'a', status: 'onDuty', from: s2.fromMs, to: s2.toMs }, { driverId: 'm', status: 'driving', from: s2.toMs, to: s2.toMs + 3600000 }];
  const c = classifyStop(s2, { logs: swap, names });
  assert.equal(c.label, 'Driver change');
  assert.deepEqual(c.swap, { from: 'Anibal Reyes', to: 'Michel Gonzalez' });
  assert.equal(classifyStop(s2, { logs: [{ driverId: 'a', status: 'onDuty', from: s2.fromMs, to: s2.toMs }], names }).label, 'Fuel / work (on duty)');
  assert.equal(classifyStop(s2, { visits: [{ name: 'WELCH WHOLESALE FLORIST', enteredAt: s2.fromMs + 60000, exitedAt: s2.toMs }] }).label, 'At WELCH WHOLESALE FLORIST');
  const rc = classifyStop(s2, { roadCalls: [{ at: new Date(s2.fromMs + 5 * 60000).toISOString(), type: 'tire', details: 'drive axle left outside flat' }] });
  assert.equal(rc.kind, 'breakdown'); assert.equal(rc.notes[0], 'drive axle left outside flat');
  assert.equal(classifyStop(s2, {}).label, 'Stopped (no duty status)');
  // a long stop where the driver who drove in did a few on-duty minutes first, then slept → a reset, with the swap noted
  const long = { fromMs: T0, toMs: T0 + 646 * 60000, minutes: 646 };
  const lg = [{ driverId: 'a', status: 'driving', from: T0 - 3600000, to: T0 }, { driverId: 'a', status: 'onDuty', from: T0, to: T0 + 20 * 60000 }, { driverId: 'a', status: 'sleeperBerth', from: T0 + 20 * 60000, to: long.toMs }, { driverId: 'm', status: 'sleeperBerth', from: T0 - 3600000, to: long.toMs }, { driverId: 'm', status: 'driving', from: long.toMs, to: long.toMs + 3600000 }];
  const r = classifyStop(long, { logs: lg, names });
  assert.equal(r.label, '10-hour reset'); assert.ok(r.notes.includes('Driver change: Anibal Reyes → Michel Gonzalez'));
  // 52 min: one off duty, the other in the sleeper → a break, not fuel / work
  assert.equal(classifyStop(s2, { logs: [{ driverId: 'a', status: 'offDuty', from: s2.fromMs, to: s2.toMs }, { driverId: 'm', status: 'sleeperBerth', from: s2.fromMs, to: s2.toMs }], names }).label, 'Short break');
});

test('journey: wheel changes, pinning a moment on the trail, trip start, thinning', () => {
  const w = wheelChanges([{ driverId: 'a', status: 'driving', from: 1, to: 2 }, { driverId: 'a', status: 'driving', from: 3, to: 4 }, { driverId: 'm', status: 'driving', from: 5, to: 6 }], { a: 'Anibal', m: 'Michel' });
  assert.deepEqual(w, [{ atMs: 5, from: 'Anibal', to: 'Michel' }]);
  assert.deepEqual(pointAt(pts, T0 + 61 * 60000), { lat: 35, lng: pts.find((p) => p.t === at(60)).lng });
  assert.equal(pointAt(pts, T0 + 30 * 3600000), null);
  const item = { _times: { dispatchedAt: '2026-10-24T04:53:45Z', statusHistory: [{ status: 'DEPSHIP', at: '2026-10-24T14:19:48Z' }] } };
  assert.equal(tripStart(item, Date.parse('2026-10-26T05:00:00Z')), Date.parse('2026-10-24T13:19:48Z'));   // DEPART SHIPPER − 1h
  assert.equal(tripStart({ _times: { dispatchedAt: '2026-10-24T04:53:45Z' } }, Date.parse('2026-10-26T05:00:00Z')), Date.parse('2026-10-24T03:53:45Z'));
  assert.equal(tripStart({}, Date.parse('2026-10-26T05:00:00Z')), Date.parse('2026-10-23T05:00:00Z'));
  assert.ok(thin(Array.from({ length: 5000 }, (_, i) => ({ t: i })), 1000).length <= 1001);
});

test('journey: fuel — a 10+ point rise during a stop is a fill-up', () => {
  const s = { fromMs: T0, toMs: T0 + 40 * 60000, minutes: 40 };
  const fuel = [{ t: T0 - 30 * 60000, pct: 30 }, { t: T0 + 10 * 60000, pct: 31 }, { t: T0 + 30 * 60000, pct: 96 }, { t: T0 + 50 * 60000, pct: 95 }];
  assert.deepEqual(fuelAround(s, fuel), { from: 30, to: 96, filled: true });
  const c = classifyStop(s, { logs: [{ driverId: 'a', status: 'onDuty', from: s.fromMs, to: s.toMs }], names: { a: 'Anibal' }, fuel });
  assert.equal(c.label, 'Fuel stop'); assert.ok(c.notes.includes('Fueled: 30% → 96%'));
  assert.equal(fuelAround(s, [{ t: T0 - 60000, pct: 50 }, { t: T0 + 60000, pct: 49 }]).filled, false);
  assert.equal(fuelAround(s, []), null);
  // a 10-hour reset where they also fueled stays a reset (fuel noted)
  const long = { fromMs: T0, toMs: T0 + 620 * 60000, minutes: 620 };
  const r = classifyStop(long, { logs: [{ driverId: 'a', status: 'sleeperBerth', from: long.fromMs, to: long.toMs }], fuel: [{ t: T0 - 60000, pct: 20 }, { t: T0 + 600 * 60000, pct: 90 }] });
  assert.equal(r.label, '10-hour reset'); assert.ok(r.notes.includes('Fueled: 20% → 90%'));
});

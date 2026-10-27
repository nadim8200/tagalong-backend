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
  assert.equal(classifyStop(stop, { logs: sleep.map((l) => ({ ...l, status: 'sleeperBed' })), names }).label, '10-hour reset');   // Samsara's spelling
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

test('samsara: when the current rest began (back-to-back off duty / sleeper join)', async () => {
  const { restStart } = await import('../samsara.js');
  const logs = [{ driverId: 'j', status: 'driving', from: 0, to: 100 }, { driverId: 'j', status: 'offDuty', from: 100, to: 200 }, { driverId: 'j', status: 'sleeperBed', from: 200, to: 900 }, { driverId: 'f', status: 'driving', from: 0, to: 900 }];
  assert.equal(restStart(logs, 'j'), 100);
  assert.equal(restStart(logs, 'f'), null);
  assert.equal(restStart([], 'j'), null);
});

test('voice: "just the California one" / "only truck 2404" keeps only those loads', async () => {
  const { narrowStops } = await import('../voice.js');
  const all = [
    { trip: { tripNumber: 625778, powerUnit: '2404', origZoneDesc: 'VENTURA, CA, 93003' }, _tb: { hub: 'Ventura' } },
    { trip: { tripNumber: 625790, powerUnit: '2604', origZoneDesc: 'MIAMI, FL, 33178' }, _tb: { hub: 'Miami' } },
    { trip: { tripNumber: 625801, powerUnit: '1911', origZoneDesc: 'MIAMI, FL, 33178' } },
  ];
  const stops = [{ trip: '625778' }, { trip: '625790' }, { trip: '625801' }];
  assert.deepEqual(narrowStops(stops, all, { fromHub: 'California' }).stops.map((x) => x.trip), ['625778']);
  assert.deepEqual(narrowStops(stops, all, { fromHub: 'the Miami one' }).stops.map((x) => x.trip), ['625790', '625801']);
  assert.deepEqual(narrowStops(stops, all, { truck: '2604' }).stops.map((x) => x.trip), ['625790']);
  const none = narrowStops(stops, all, { fromHub: 'Texas' });
  assert.equal(none.none, true); assert.equal(none.stops.length, 3);
  assert.equal(narrowStops(stops, all, {}).stops.length, 3);
});

test('voice: several loads → how many and from where, to ask which one', async () => {
  const { loadsSummary } = await import('../voice.js');
  const all = [
    { trip: { tripNumber: 1, origZoneDesc: 'VENTURA, CA' }, _tb: { hub: 'Ventura' } },
    { trip: { tripNumber: 2, origZoneDesc: 'MIAMI, FL' }, _tb: { hub: 'Miami' } },
    { trip: { tripNumber: 3, origZoneDesc: 'MIAMI, FL' }, _tb: { hub: 'Miami' } },
  ];
  assert.equal(loadsSummary(['1', '2', '3'], all), '3 loads: 1 from our Ventura, California hub and 2 from our Miami, Florida hub');
  assert.equal(loadsSummary(['2', '3'], all), '2 loads: 2 from our Miami, Florida hub');
});

test('fleet map: trucks at our Miami yard lots or the Ventura hub are marked atHub', async () => {
  const { hubAt } = await import('../fleetmap.js');
  assert.equal(hubAt({ lat: 25.8026, lng: -80.3102 }), 'Miami');     // 3315 NW 70th Ave
  assert.equal(hubAt({ lat: 34.272, lng: -119.232 }), 'Ventura');
  assert.equal(hubAt({ lat: 25.86, lng: -80.29 }), null);            // Hialeah — Miami area, not the yard
  assert.equal(hubAt({ lat: 37.08, lng: -94.32 }), null);
  assert.equal(hubAt({}), null);
});

test('synergize → billing: one email per load with the POD / BOL found (bills, bill-to, delivered, broker + rate)', async () => {
  const { billingEmail, BILLING_TYPES } = await import('../synergize.js');
  assert.ok(BILLING_TYPES.test('POD')); assert.ok(BILLING_TYPES.test('BOL')); assert.ok(!BILLING_TYPES.test('Rate Confirmation')); assert.ok(!BILLING_TYPES.test('Invoice'));
  const item = { trip: { tripNumber: 625502, powerUnit: '2219', trailer: '18077' }, freightBills: [{ billNumber: 'B180600', billToName: 'OTR TRANSPORTATION LLC *', actualDelivery: '2026-10-23T14:05:00' }] };
  const { subject, html, text } = billingEmail({ trip: '625502', item, rc: { broker: 'OTR TRANSPORTATION LLC', loadNumber: '467818', rateText: '$3,200', accessorials: ['Lumper $150'] },
    docs: [{ type: 'POD', bill: 'B180600', created: '2026-10-24T09:12', name: 'POD-B180600.pdf', bytes: Buffer.alloc(132096) }, { type: 'BOL', bill: 'B180600', name: 'BOL-B180600.pdf', attached: false }] });
  assert.equal(subject, 'POD + BOL for billing — Trip 625502 · B180600 · OTR TRANSPORTATION LLC');
  for (const x of ['Delivery paperwork received', 'OTR TRANSPORTATION LLC', 'Trip 625502 · Bill B180600', 'Oct 23, 2026 · 2:05 PM', '$3,200', 'Lumper $150', 'OTR TRANSPORTATION LLC · load 467818', 'Attached documents · 2', 'POD-B180600.pdf', 'PDF · 129 KB', 'Scanned Oct 24, 2026 · 9:12 AM', 'Too large to attach', 'The POD is attached for billing review.', 'The BOL was too large to attach', 'Review the attached POD for billing.', 'Document source: Synergize', '<!--jarvis:training-slot-->']) assert.ok(html.includes(x), x);
  assert.doesNotMatch(html, /Routing notice/, 'Accounting configured → no routing notice');
  assert.match(text, /Delivered: Oct 23, 2026 · 2:05 PM/);
  const off = billingEmail({ trip: '625380', docs: [{ type: 'POD', bill: 'B180573', billTo: 'X-PRESS LOGISTICS', bytes: Buffer.alloc(2000) }], fallback: true });
  assert.equal(off.subject, 'POD for billing — Trip 625380 · B180573 · X-PRESS LOGISTICS');
  assert.ok(off.html.includes('Proof of delivery received')); assert.ok(off.html.includes('Routing notice')); assert.ok(off.html.includes('Dispatch is the designated fallback recipient'));
  assert.doesNotMatch(off.html, />Delivered</, 'off the board, no delivery time → no Delivered row (never assumed from the POD)');
  const onBoard = billingEmail({ trip: '1', item: { trip: {}, freightBills: [{ billNumber: 'B1' }] }, docs: [{ type: 'BOL', bill: 'B1', bytes: Buffer.alloc(10) }] });
  assert.ok(onBoard.html.includes('Bill of lading received')); assert.ok(onBoard.html.includes('Not marked delivered in TruckMate'));
  // BOL only: its own wording; the three delivery states; next step mentions the status only when it isn't marked
  assert.ok(onBoard.html.includes('A bill of lading was received through Synergize. The document is attached for billing review.'));
  assert.ok(onBoard.html.includes('>Delivery status<')); assert.match(onBoard.html, /background:#FFF7E7[^>]*>Not marked delivered in TruckMate</);
  assert.ok(onBoard.html.includes('Review the attached BOL. Delivery is not yet marked in TruckMate.'));
  const bolDone = billingEmail({ trip: '3', item: { trip: {}, freightBills: [{ billNumber: 'B3', actualDelivery: '2026-10-22T09:40:00' }] }, docs: [{ type: 'BOL', bill: 'B3', bytes: Buffer.alloc(10) }] });
  assert.ok(bolDone.html.includes('Delivered · Oct 22, 2026 · 9:40 AM')); assert.ok(bolDone.html.includes('Review the attached BOL.</div>'));
  const bolGone = billingEmail({ trip: '4', docs: [{ type: 'BOL', bill: 'B4', bytes: Buffer.alloc(10) }, { type: 'BOL', bill: 'B5', attached: false }] });
  assert.ok(bolGone.html.includes('Unavailable — the load is no longer on the board'));
  assert.ok(bolGone.html.includes('Bills of lading were received through Synergize. 1 is attached for billing review; 1 was too large to attach'));
  assert.ok(bolGone.html.includes('Attached documents · 2'));
  assert.match(bolGone.text, /Delivery status: Unavailable/);
  // a POD keeps its own wording (unchanged by the BOL design)
  assert.ok(off.html.includes('The POD is attached for billing review.')); assert.doesNotMatch(off.html, /Delivery status/);
  const esc = billingEmail({ trip: '2', docs: [{ type: 'POD', bill: 'B2', billTo: 'A & <B> Co', name: '"x".pdf', bytes: Buffer.alloc(10) }] });
  assert.ok(esc.html.includes('A &amp; &lt;B&gt; Co')); assert.ok(esc.html.includes('&quot;x&quot;.pdf'));
});

test('outbound day = the day the trip was built (boxes in Monday, rolled out Tuesday 1 AM → Monday), not when it left', async () => {
  const { outboundDate, outboundLabel } = await import('../voice.js');
  // ARTIS ship date wins
  assert.equal(outboundDate({ _tb: { date: '2026-10-23' }, _times: { statusHistory: [{ status: 'DEPSHIP', at: '2026-10-24T14:19:48Z' }] } }), '2026-10-23');
  // then the trip sheet's load date
  assert.equal(outboundDate({ _manifest: { dateLoaded: '2026-10-26' }, _times: { statusHistory: [{ status: 'DEPSHIP', at: '2026-10-27T05:00:00Z' }] } }), '2026-10-26');
  // else when TruckMate created the trip — after midnight but before 6 AM ET counts as the night before
  assert.equal(outboundDate({ _times: { statusHistory: [{ status: 'LOADINGMAN', at: '2026-10-26T22:12:03Z' }, { status: 'DEPSHIP', at: '2026-10-27T05:00:00Z' }] } }), '2026-10-26', 'built Monday 6 PM, left Tuesday 1 AM → Monday');
  assert.equal(outboundDate({ _times: { addedAt: '2026-10-27T05:30:00Z' } }), '2026-10-26', 'created Tuesday 1:30 AM → Monday');
  assert.equal(outboundDate({ _times: { addedAt: '2026-10-27T13:00:00Z' } }), '2026-10-27');
  assert.equal(outboundDate({}), null);
  assert.equal(outboundLabel('2026-10-26'), 'Monday, Oct 26 outbound');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readDriver, observe, applyReply, askText, initMilestones } from '../milestones.js';
import { pendingEvents, renderEvent } from '../statusmail.js';

const NOW = Date.parse('2026-10-08T16:00:00Z');
const geo = (zip) => ({ 93612: { lat: 36.82, lng: -119.70 }, 30436: { lat: 32.11, lng: -82.32 } }[zip] || null);
const load = (over = {}) => ({
  trip: { tripNumber: '624194', status: 'DISP', powerUnit: '2019', trailer: '195364', driver: 'D2846', origZoneDesc: 'LYONS, GA, 30436', ...(over.trip || {}) },
  freightBills: [{ billNumber: 'B180215', billToName: 'PAYSTAR LOGISTICS', endZoneDescription: 'CLOVIS, CA, 93612', actualDelivery: null }],
  _samsara: { lat: 32.11, lng: -82.32, gpsAt: new Date(NOW - 60000).toISOString(), speedMph: 0, driver1: 'Ana Ruiz', hos: { status: 'onDuty' }, ...(over.live || {}) },
  _times: { statusHistory: over.hist || [] },
  ...(over.extra || {}),
});

test('readDriver understands the usual driver words (English + Spanish)', () => {
  const k = (t) => readDriver(t).kind;
  assert.equal(k('Loaded and sealed, leaving in 10'), 'loaded');
  assert.equal(k('ya me cargaron'), 'loaded');
  assert.equal(k('unloaded, got the POD'), 'delivered');
  assert.equal(k('Still waiting, no door yet'), 'waiting');
  assert.equal(k("I'm here at the receiver"), 'arrived');
  assert.equal(k('rolling now'), 'departed');
  assert.equal(k('yes'), 'yes');
  assert.equal(k('Sí'), 'yes');
  assert.equal(k('not yet'), 'no');
  assert.equal(k('flat tire on I-10'), 'issue');
});

test('observe: TruckMate statuses and 10+ min parked at the shipper', () => {
  const o = observe(load({ hist: [{ status: 'ARRSHIP' }, { status: 'LOADEDTOGO' }] }), {}, { geo, now: NOW });
  assert.equal(o.ms['arrived-shipper'], 'TruckMate');
  assert.equal(o.ms.loaded, 'TruckMate');
  const a = observe(load(), {}, { geo, now: NOW });
  assert.equal(a.near.place, 'pickup'); assert.equal(a.ms['arrived-shipper'], undefined, 'just got there');
  const b = observe(load(), { near: a.near }, { geo, now: NOW + 11 * 60000 });
  assert.equal(b.ms['arrived-shipper'], 'GPS');
  // parked in our own Miami yard is not "at the shipper"
  const yard = observe(load({ trip: { origZoneDesc: 'MIAMI, FL' }, live: { lat: 25.795, lng: -80.31 } }), { near: { place: 'pickup', since: NOW - 3600000 } }, { geo, now: NOW });
  assert.equal(yard.near, null);
});

test('applyReply: YES confirms the last question; plain words set the step for the current stop', () => {
  const stops = [{ key: 'CLOVIS, CA, 93612', delivered: false }];
  assert.deepEqual(applyReply({ text: 'yes' }, { lastAsk: { key: 'loaded' }, ms: {}, stops }).set, { loaded: true });
  assert.deepEqual(applyReply({ text: 'done' }, { lastAsk: { key: 'left:CLOVIS, CA, 93612' }, ms: { departed: {} }, stops }).set, { 'delivered:CLOVIS, CA, 93612': true });
  assert.deepEqual(applyReply({ text: 'empty now, unloaded' }, { ms: { departed: {} }, stops }).set, { 'arrived:CLOVIS, CA, 93612': true, 'delivered:CLOVIS, CA, 93612': true });
  assert.deepEqual(applyReply({ text: 'still waiting no door' }, { ms: {}, stops }).set, { 'waiting:pickup': true });
  assert.match(askText('loaded', { name: 'Ana Ruiz', trip: '624194' }), /Hi Ana, TruckMate shows load 624194 loaded\. Are you loaded and sealed\? Reply YES/);
});

test('driver confirmations drive the customer emails: at shipper, loaded, rolling, delivered', () => {
  const sure = (keys) => ({ extra: { _milestones: Object.fromEntries(keys.map((k) => [k, { at: '2026-10-08T15:00:00Z', src: 'driver' }])) } });
  const told = { truck: '2019', trailer: '195364', drivers: 'D2846' };
  assert.deepEqual(pendingEvents(load(sure(['arrived-shipper'])), { assigned: 'x', told }, { now: NOW }).map((e) => e.kind), ['at-shipper']);
  const gpsOnly = load({ extra: { _milestones: { 'arrived-shipper': { at: 'x', src: 'GPS' } } } });
  assert.deepEqual(pendingEvents(gpsOnly, { assigned: 'x', told }, { now: NOW }), [], 'a GPS guess alone is not told to the customer');
  assert.deepEqual(pendingEvents(load(sure(['loaded'])), { assigned: 'x', told, atShipper: 'x' }, { now: NOW }).map((e) => e.parts), [['loaded']]);
  const rolling = pendingEvents(load(sure(['loaded', 'departed'])), { assigned: 'x', told: { ...told, loaded: true }, atShipper: 'x' }, { now: NOW });
  assert.deepEqual(rolling.map((e) => [e.kind, e.driver]), [['picked-up', true]]);
  assert.match(renderEvent(rolling[0], load(), { now: NOW }).html, /driver confirmed the trailer departed/);
  const del = pendingEvents(load(sure(['departed', 'delivered:CLOVIS, CA, 93612'])), { assigned: 'x', told, pickedUp: 'x', stops: {} }, { now: NOW });
  assert.deepEqual(del.map((e) => e.kind), ['arrived', 'delivered']);
  assert.match(renderEvent({ kind: 'at-shipper' }, load(), { now: NOW }).subject, /^Driver arrived at the shipper/);
});

function memDb(seed = {}) { const m = new Map(Object.entries(seed)); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; }, raw: m }; }

test('process: asks the driver (app push for OC), reads the reply, alerts dispatch on a long wait', async () => {
  const db = memDb({ taMilestonesCfg: { notify: ['dispatch@floridabeauty.us'], waitMin: 120 } });
  const sentApp = []; const pushed = [];
  let t = NOW;
  const ms = initMilestones({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, driverLinks: { messageDriver: async (site, trip, text) => { sentApp.push(text); return { sent: true, via: 'app (push)' }; } }, push: { sendToEmails: async (to, m) => { pushed.push(m); } }, now: () => t });
  const oc = (over = {}) => load({ ...over, extra: { _oc: { driverName: 'Ana Ruiz', truck: '2019' }, ...(over.extra || {}) } });
  await ms.process('florida-beauty', { trips: [oc()] }, { geo });                      // first sight: nothing asked
  assert.equal(sentApp.length, 0);
  t += 5 * 60000;
  await ms.process('florida-beauty', { trips: [oc({ hist: [{ status: 'LOADEDTOGO' }] })] }, { geo });
  assert.equal(sentApp.length, 1); assert.match(sentApp[0], /Are you loaded and sealed/);
  // driver answers in the app
  await db.update('taTripComms:florida-beauty', () => ({ 624194: [{ type: 'reply', from: 'driver app', text: 'yes sealed', at: new Date(t + 60000).toISOString() }] }), {});
  t += 2 * 60000;
  const board = { trips: [oc({ hist: [{ status: 'LOADEDTOGO' }] })] };
  await ms.process('florida-beauty', board, { geo });
  assert.equal(board.trips[0]._milestones.loaded.src, 'TruckMate + driver');
  // parked at the shipper 2h+ without departing → dispatch alert (once) + the driver is asked
  t += 130 * 60000;
  await ms.process('florida-beauty', { trips: [oc({ hist: [{ status: 'ARRSHIP' }] })] }, { geo });
  assert.equal(pushed.length, 0, 'already loaded — not a wait');

  // a different load: parked at its shipper 2h+, not loaded → one dispatch alert + a question to the driver
  const other = (h = []) => load({ trip: { tripNumber: '700001' }, hist: h, live: { gpsAt: new Date(t - 60000).toISOString() }, extra: { _oc: { driverName: 'Leo', truck: '3001' } } });
  await ms.process('florida-beauty', { trips: [other()] }, { geo });
  t += 125 * 60000;
  await ms.process('florida-beauty', { trips: [other()] }, { geo });
  assert.equal(pushed.length, 1); assert.match(pushed[0].title, /Load 700001 — 2h 5m at the shipper/);
  assert.ok(sentApp.some((x) => /Still waiting\?/.test(x) || /at the shipper/.test(x)));
  t += 10 * 60000;
  await ms.process('florida-beauty', { trips: [other()] }, { geo });
  assert.equal(pushed.length, 1, 'alerted once');
});

test('SOP driver checklists: at the shipper, before and at delivery', async () => {
  const { checklistText } = await import('../milestones.js');
  const a = checklistText('shipper', { name: 'Ana Ruiz', trip: '624194', pu: 'PU 77812' });
  for (const x of ['PU# PU 77812', '"SLC"', 'seal #', 'max 42,000 lbs', '2 load locks', 'photo of the BOL', 'Reply "Done"']) assert.ok(a.includes(x), x);
  assert.match(checklistText('before', { trip: '1', stop: 'Mayesh Lombard' }), /almost at Mayesh Lombard[\s\S]*reefer temperature/);
  assert.match(checklistText('delivery', { trip: '1' }), /signed POD[\s\S]*REJECTED[\s\S]*\$ amount/);
});

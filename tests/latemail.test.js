import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLateEmail, delayText, placeText, addressLines, TRAINING_SLOT } from '../latemail.js';
import { redirectEmail } from '../training.js';
import { lateMessage } from '../commitments.js';

const D = { trip: '625479', truck: '2608', trailer: '7370', receiver: 'TRAFFIC TECH INC', place: 'MIAMI, FL', atMs: Date.parse('2026-10-22T19:00:00Z'), etaMs: Date.parse('2026-10-23T15:01:00Z'), lateMin: 1201, miles: 4, by: 'TruckMate (delivery appointment)', gpsLocation: '3315 Northwest 70th Avenue, Miami, FL, 33122', gpsAt: Date.parse('2026-10-23T14:54:00Z') };

test('helpers: delay, place, address', () => {
  assert.equal(delayText(1201), '20 h 1 min'); assert.equal(delayText(180), '3 h'); assert.equal(delayText(45), '45 min'); assert.equal(delayText(null), null);
  assert.equal(placeText('NEW YORK, NY, 10001'), 'New York, NY 10001');
  assert.deepEqual(addressLines('3315 Northwest 70th Avenue, Miami, FL, 33122'), ['3315 Northwest 70th Avenue', 'Miami, FL 33122']);
  assert.deepEqual(addressLines('New Jersey Turnpike, Cranbury, NJ'), ['New Jersey Turnpike', 'Cranbury, NJ']);
});

test('the late email: sections in order, real values, escaped, plain-text twin in the same order', () => {
  const r = renderLateEmail({ ...D, receiver: 'A&B <Wholesale>' });
  const order = ['DELIVERY DELAY', 'Estimated 20 h 1 min late', 'APPOINTMENT', 'ESTIMATED ARRIVAL', 'ACTION REQUIRED', 'Customer notification: Not sent by Jarvis', 'SHIPMENT', 'LAST REPORTED LOCATION', 'ESTIMATE DETAILS', 'Jarvis · AI Dispatcher'];
  let at = -1; for (const s of order) { const i = r.text.indexOf(s); assert.ok(i > at, `${s} in order`); at = i; }
  assert.match(r.text, /Thu, Oct 22, 2026\n3:00 PM ET/);
  assert.match(r.text, /Fri, Oct 23, 2026\n11:01 AM ET/);
  assert.match(r.text, /Trip: 625479\nTruck: 2608 · Trailer: 7370\nDistance remaining: Approximately 4 miles/);
  assert.match(r.text, /GPS updated Fri, Oct 23, 2026 at 10:54 AM ET\./);
  assert.match(r.text, /Appointment source: TruckMate \(delivery appointment\)\./);
  assert.match(r.text, /55 mph \(an assumption — not the truck's measured speed\)/);
  assert.match(r.html, /A&amp;B &lt;Wholesale&gt;/); assert.ok(!r.html.includes('<Wholesale>'));
  assert.ok(r.html.includes(TRAINING_SLOT));
  assert.ok(!/<script|<form|<button/i.test(r.html));
});

test('missing ETA / appointment / GPS say "Not available" — never zero or invented', () => {
  const r = renderLateEmail({ ...D, atMs: null, etaMs: null, lateMin: null, miles: null, gpsLocation: null, gpsAt: null, trailer: null });
  assert.match(r.text, /Running late/);
  assert.match(r.text, /APPOINTMENT\nNot available/); assert.match(r.text, /ESTIMATED ARRIVAL\nNot available/);
  assert.match(r.text, /Trailer: Not available/); assert.ok(!/Distance remaining/.test(r.text));
  assert.match(r.text, /No location reported/);
});

test('a non-Eastern stop shows its local clock too; FCFS keeps the receiving-hours meaning', () => {
  const r = renderLateEmail({ ...D, place: 'LANCASTER, CA', fcfs: true, hours: '0700–1500' });
  assert.match(r.text, /RECEIVING CLOSES \(First come, first served · receiving 0700–1500\)/);
  assert.match(r.text, /3:00 PM ET \(12:00 PM PT local\)/);
});

test('training: the compact notice goes inside this email; other emails keep the banner on top; subject untouched', () => {
  const m = lateMessage({ trip: { tripNumber: '625479', powerUnit: '2608', trailer: '7370' }, _samsara: { location: D.gpsLocation, gpsAt: '2026-10-23T14:54:00Z' } }, { customer: 'TRAFFIC TECH INC', place: 'MIAMI, FL', atMs: D.atMs, etaMs: D.etaMs, lateMin: 1201, miles: 4, by: 'TruckMate (delivery appointment)' });
  assert.equal(m.subject, 'Late for a committed time — trip 625479 · TRAFFIC TECH INC, MIAMI, FL');
  const t = redirectEmail({ to: ['dispatches@floridabeauty.us'], subject: m.subject, html: m.html, text: m.text }, ['ntellez@floridabeauty.us']);
  assert.ok(!t.html.includes(TRAINING_SLOT)); assert.match(t.html, /TRAINING PREVIEW<\/b> — Not sent to customer\. It would have gone to: <b>dispatches@floridabeauty\.us/);
  assert.ok(t.html.indexOf('TRAINING PREVIEW') > t.html.indexOf('<table'), 'inside the card');
  assert.match(t.subject, /^\[TRAINING → dispatches@floridabeauty\.us\] Late for a committed time/);
  const other = redirectEmail({ to: ['x@broker.com'], subject: 'Location update', html: '<p>hi</p>' }, ['ntellez@floridabeauty.us']);
  assert.match(other.html, /^<div style="font-family:Arial,sans-serif;font-size:13px;background:#fff7cc/);
});

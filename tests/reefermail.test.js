import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDoorTempEmail, imageSize } from '../reefermail.js';
import { redirectEmail } from '../training.js';
import { TRAINING_SLOT } from '../latemail.js';

const X = { id: 7100, trailer: '7141', door: '15', set: 35, actual: 61, atText: '10/26/2026 04:22:12 PM EDT', by: 'Melvis Rodriguez', warehouse: 'Miami', photos: 2 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 0x03, 0x20, 0, 0, 0x02, 0x58]), Buffer.alloc(40)]);   // 800 × 600
const TRIP = { number: '625598', truck: '936', destination: 'NORWOOD, MA, 02062' };

test('reefer alert body: trip + truck + 2 photos — every fact, training slot, plain text in the same order', () => {
  const { html, text } = renderDoorTempEmail(X, { trip: TRIP, photos: [{ cid: 'door1', bytes: PNG }, { cid: 'door2', bytes: PNG }] });
  for (const s of ['FLORIDA BEAUTY', 'Dispatch notifications', 'Temperature alert', 'Trailer 7141', 'Recorded temperature above reefer setpoint', '61°F', '35°F', '+26°F', 'Action requested',
    'Verify reefer operation and the current temperature before departure. If the trailer has already departed, contact the driver to verify.', '625598', '936', 'Miami · Door 15', 'NORWOOD, MA, 02062',
    '10/26/2026 04:22:12 PM EDT', 'Melvis Rodriguez', 'ARTIS Trailer Temp Verifications', 'Inspection photos · 2', 'cid:door1', 'cid:door2', 'Recorded inspection reading — not a live temperature update.', 'AI Dispatcher · Florida Beauty']) assert.ok(html.includes(s), s);
  assert.ok(html.includes(TRAINING_SLOT));
  assert.match(html, /width="264" height="198"/, 'explicit photo size, proportions kept');
  assert.match(html, /alt="Inspection photo 1 of 2 — trailer 7141/);
  assert.doesNotMatch(html, /<script|<form|display:grid/i);
  assert.match(text, /RECORDED: 61°F {3}SETPOINT: 35°F {3}DIFFERENCE: \+26°F/);
  assert.match(text, /Trip: 625598\nTruck: 936\nLocation: Miami · Door 15\nDestination: NORWOOD, MA, 02062/);
  assert.match(text, /Checked: 10\/26\/2026 04:22:12 PM EDT/);
});

test('reefer alert body: no active trip, below setpoint, missing values, photos that did not load', () => {
  const none = renderDoorTempEmail({ ...X, photos: 0 }, { trip: null, photos: [] });
  assert.ok(none.html.includes('No active trip linked')); assert.doesNotMatch(none.html, />Truck</); assert.doesNotMatch(none.html, /Destination/);
  assert.ok(none.html.includes('No photos were recorded with this check.'));
  assert.match(none.text, /Trip: No active trip linked\nLocation:/);
  const below = renderDoorTempEmail({ ...X, actual: 30 }, { trip: TRIP });
  assert.ok(below.html.includes('Recorded temperature below reefer setpoint')); assert.ok(below.html.includes('-5°F'));
  const missing = renderDoorTempEmail({ ...X, set: null, by: null, warehouse: null, door: null, atText: null }, { trip: TRIP });
  assert.ok(missing.html.includes('Recorded temperature compared with the reefer setpoint'));
  assert.doesNotMatch(missing.html, /NaN|>0°F|\+0°F/, 'a missing reading is never zero');
  assert.match(missing.text, /SETPOINT: Not recorded {3}DIFFERENCE: Not available/);
  assert.match(missing.text, /Location: Not recorded/); assert.match(missing.text, /Checked by: Not recorded/); assert.match(missing.text, /Checked: Not recorded/);
  const partial = renderDoorTempEmail(X, { trip: TRIP, photos: [{ cid: 'door1', bytes: Buffer.alloc(10) }] });
  assert.ok(partial.html.includes('Inspection photos · 2')); assert.ok(partial.html.includes('1 more photo could not be loaded'));
  assert.match(partial.html, /width="264" alt=/, 'unknown size → width only');
  const one = renderDoorTempEmail({ ...X, photos: 1 }, { trip: TRIP, photos: [{ cid: 'door1', bytes: PNG }] });
  assert.ok(one.html.includes('Inspection photos · 1')); assert.doesNotMatch(one.html, /could not be loaded/);
  const many = renderDoorTempEmail({ ...X, photos: 4 }, { trip: TRIP, photos: [1, 2, 3, 4].map((n) => ({ cid: `door${n}`, bytes: PNG })) });
  assert.equal((many.html.match(/cid:door/g) || []).length, 4);
});

test('reefer alert body: dynamic text escaped; training notice lands in its slot with long recipients', () => {
  const { html } = renderDoorTempEmail({ ...X, trailer: '<b>7141</b>', by: 'O\'Neil & Co' }, { trip: TRIP });
  assert.ok(html.includes('Trailer &lt;b&gt;7141&lt;/b&gt;')); assert.ok(html.includes('O&#39;Neil &amp; Co'));
  const m = redirectEmail({ to: ['dispatches@floridabeauty.us', 'a.very.long.reefer.team.address.for.testing@floridabeauty.us'], subject: 'Reefer: x', html: renderDoorTempEmail(X, { trip: TRIP }).html, text: 'x' }, ['ntellez@floridabeauty.us']);
  assert.ok(m.html.includes('TRAINING PREVIEW')); assert.ok(!m.html.includes(TRAINING_SLOT));
  assert.ok(m.html.indexOf('TRAINING PREVIEW') > m.html.indexOf('FLORIDA BEAUTY') && m.html.indexOf('TRAINING PREVIEW') < m.html.indexOf('Temperature alert'));
  assert.deepEqual(m.to, ['ntellez@floridabeauty.us']);
});

test('image size from the photo bytes (PNG / JPEG), null when unknown', () => {
  assert.deepEqual(imageSize(PNG), { w: 800, h: 600 });
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]), Buffer.alloc(20)]);
  assert.deepEqual(imageSize(jpg), { w: 800, h: 600 });
  assert.equal(imageSize(Buffer.alloc(30)), null);
});

test('resend one door-temp alert: same subject (marked [RESEND]), same recipients and photos, new body', async () => {
  const { initArtisReports } = await import('../artisreports.js');
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v) };
  m.set('taArtisReports:florida-beauty', { doorIssues: [{ id: 7388, trailer: '7388', door: '25', set: 35, actual: 46, atText: '10/26/2026 04:31:29 PM EDT', by: 'Melvis Rodriguez', warehouse: 'Miami', photos: 1, images: [9] }] });
  const mails = [];
  const r = initArtisReports({ db, artisWeb: { ready: () => true, fetchBuffer: async () => ({ buf: Buffer.concat([PNG, Buffer.alloc(200)]), type: 'image/png' }) }, getBoard: async () => ({ trips: [{ trip: { tripNumber: '625668', powerUnit: '1910', trailer: '7388', destZoneDesc: 'MIAMI, FL, 33122' } }] }), sendMail: async (x) => mails.push(x), tempTeam: async () => ['dispatches@floridabeauty.us'] });
  assert.deepEqual(await r.resendDoorTemp('7388'), { ok: true, id: 7388, trailer: '7388', at: '10/26/2026 04:31:29 PM EDT' });
  assert.equal(mails[0].subject, '[RESEND] Reefer: Trailer 7388 was loaded at 46°F — set 35°F (+11°F) — trip 625668');
  assert.deepEqual(mails[0].to, ['dispatches@floridabeauty.us']);
  assert.equal(mails[0].attachments.length, 1); assert.match(mails[0].html, /Inspection photos · 1/); assert.match(mails[0].html, /625668/);
  assert.equal((await r.resendDoorTemp('9999')).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { testEmails, samplePhoto, initTestEmails } from '../testemails.js';

test('test emails: breakdown, accident, breakdown update, missing boxes, problem — all marked TEST, only to ntellez', async () => {
  const m = testEmails(Date.parse('2026-11-19T23:00:00Z'));
  assert.deepEqual(m.map((x) => x.subject), [
    '[TEST] Tire breakdown | Trailer 18094 | Trip 627549 | BK-TEST-042',
    '[TEST] Accident reported | Truck 4504 | Trip 627549 | BK-TEST-043',
    '[TEST] Breakdown update | BK-TEST-042 | Trip 627549',
    '[TEST] 2 boxes missing | South Windsor, CT | Trip 627549',
    '[TEST] Customer refusal | Clifton, NJ | Trip 627549',
  ]);
  assert.ok(m.every((x) => /TEST · SAMPLE DATA · NOT A REAL REPORT/.test(x.html) && /^TEST · SAMPLE DATA/.test(x.text)));
  assert.ok(m.every((x) => !/sample-link/.test(x.html + x.text)), 'no fake links');
  assert.match(m[2].html, /Status needs reconciliation/);
  assert.match(m[1].html, /Police on the scene<\/td><td[^>]*>Yes</);
  assert.match(m[3].html, /64 of 66 in TruckMate/);
  assert.equal(samplePhoto(10, 20, 30)[0], 0xff, 'a real JPEG');
  const routes = {}; const sent = [];
  initTestEmails({ post: (p, ...h) => { routes[p] = h; } }, { requireAdmin: (q, r, n) => n(), sendMail: async (x) => sent.push(x) });
  let out; await routes['/admin/test-emails/driver-app'][1]({}, { json: (j) => { out = j; }, status: () => ({ json: (j) => { out = j; } }) });
  assert.equal(sent.length, 5); assert.ok(sent.every((x) => x.to.length === 1 && x.to[0] === 'ntellez@floridabeauty.us'));
  assert.equal(out.sent.length, 5);
});

test('the callback test email: the live template, marked [TEST], with the sample driver and load', async () => {
  const { callbackTestEmail } = await import('../testemails.js');
  const m = callbackTestEmail();
  assert.match(m.subject, /^\[TEST\] For Nadim Tellez — URGENT — Call back Ferney Urrego \(test\)/);
  assert.match(m.html, /A message for Nadim Tellez\./); assert.match(m.html, /LOAD 627549/); assert.match(m.html, /tel:/);
  assert.equal(m.attachments.length, 2);
});

test('the wrong-site test email: a sample Tempest load on a Site 2 bill, marked [TEST]', async () => {
  const { wrongSiteTestEmail } = await import('../testemails.js');
  const m = wrongSiteTestEmail();
  assert.match(m.subject, /^\[TEST\] WRONG SITE Bill B181090 Trip 627610$/); assert.match(m.html, /Move bill B181090 to Site 9 \(letter F\)/);
});

test('the temp alert test: the real email and text builders with sample readings, marked TEST', async () => {
  const { tempTestAlert } = await import('../testemails.js');
  const m = tempTestAlert(Date.parse('2026-11-21T02:14:00Z'));
  assert.match(m.subject, /^\[TEST\] LTL reefer 20\.7°F above the set point: trip 627491 · trailer 7387/);
  assert.match(m.sms, /^\[TEST\]\nREEFER TEMP ALERT\nTrailer 7387 \| Trip 627491\nReading: 9\.7°F\nSet point: -11\.0°F\nAbove set point: \+20\.7°F\nAbove set point for: 10 hr 11 min/);
});

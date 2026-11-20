import test from 'node:test';
import assert from 'node:assert/strict';
import { testEmails, samplePhoto, initTestEmails } from '../testemails.js';

test('test emails: breakdown, accident, breakdown update, missing boxes, problem — all marked TEST, only to ntellez', async () => {
  const m = testEmails(Date.parse('2026-11-19T23:00:00Z'));
  assert.deepEqual(m.map((x) => x.subject), [
    '[TEST] BREAKDOWN // TRAILER 18094 // TIRE // TRIP 627549 // BK-TEST-042',
    '[TEST] BREAKDOWN // TRUCK 4504 // ACCIDENT // TRIP 627549 // BK-TEST-043',
    '[TEST] UPDATE // BREAKDOWN // TRAILER 18094 // TIRE // TRIP 627549 // BK-TEST-042',
    '[TEST] MISSING BOXES // 2 BOXES // TRIP 627549 // SOUTH WINDSOR, CT',
    '[TEST] ISSUE AT A STOP // CUSTOMER REFUSED // TRIP 627549 // CLIFTON, NJ',
  ]);
  assert.ok(m.every((x) => /TEST · sample data/.test(x.html)));
  assert.match(m[1].html, /Police on the scene<\/td><td[^>]*><b>yes/);
  assert.match(m[3].html, /64 of 66 in TruckMate/);
  assert.equal(samplePhoto(10, 20, 30)[0], 0xff, 'a real JPEG');
  const routes = {}; const sent = [];
  initTestEmails({ post: (p, ...h) => { routes[p] = h; } }, { requireAdmin: (q, r, n) => n(), sendMail: async (x) => sent.push(x) });
  let out; await routes['/admin/test-emails/driver-app'][1]({}, { json: (j) => { out = j; }, status: () => ({ json: (j) => { out = j; } }) });
  assert.equal(sent.length, 5); assert.ok(sent.every((x) => x.to.length === 1 && x.to[0] === 'ntellez@floridabeauty.us'));
  assert.equal(out.sent.length, 5);
});

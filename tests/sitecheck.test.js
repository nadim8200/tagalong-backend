import test from 'node:test';
import assert from 'node:assert/strict';
import { carrierOf, billSite, wrongSite, siteEmail, initSiteCheck } from '../sitecheck.js';

const TEMPEST_RC = { broker: 'Allen Lund Company', loadNumber: '8702578', summary: 'Tempest Transportation Inc load 8702578', contacts: [{ email: 'gus@floridabeauty.us' }] };
const FBE_RC = { broker: 'Echo Global Logistics', loadNumber: '69950678', summary: 'Florida Beauty Express, MC453152' };
const item = (rc, bills, trip = '627610') => ({ trip: { tripNumber: trip, powerUnit: '4562' }, freightBills: bills, _ratecon: rc });

test('whose rate con: Tempest first (its rate cons can carry a floridabeauty.us email), then Florida Beauty; none → null', () => {
  assert.equal(carrierOf(TEMPEST_RC), 'tempest');
  assert.equal(carrierOf({ summary: 'carrier MC 536134' }), 'tempest');
  assert.equal(carrierOf(FBE_RC), 'fb');
  assert.equal(carrierOf({ summary: 'Florida Beauty Flora load' }), 'fb');
  assert.equal(carrierOf({ summary: 'Some other carrier' }), null);
  assert.equal(carrierOf(null), null);
});

test('a bill\'s site: TruckMate\'s site id, else the bill number\'s letter', () => {
  assert.equal(billSite({ siteId: 'SITE2', billNumber: 'B181078' }), 'SITE2');
  assert.equal(billSite({ billNumber: 'F100001' }), 'SITE9');
  assert.equal(billSite({ billNumber: 'B181078' }), 'SITE2');
  assert.equal(billSite({ billNumber: 'M5066106' }), null);
});

test('wrong site: a Tempest rate con on a Site 2 bill, or a Florida Beauty one on Site 9; right site or other sites → nothing', () => {
  const w = wrongSite(item(TEMPEST_RC, [{ billNumber: 'B181090', siteId: 'SITE2', createdTimestamp: '2026-11-21T09:00:00' }]));
  assert.deepEqual([w.carrier, w.have.site, w.want.site, w.want.letter, w.bills], ['tempest', 'SITE2', 'SITE9', 'F', ['B181090']]);
  assert.equal(wrongSite(item(TEMPEST_RC, [{ billNumber: 'F100001', siteId: 'SITE9' }])), null, 'Tempest in Site 9: right');
  const f = wrongSite(item(FBE_RC, [{ billNumber: 'F100002', siteId: 'SITE9', createdTimestamp: '2026-11-21T09:00:00' }]));
  assert.deepEqual([f.carrier, f.want.site, f.want.letter], ['fb', 'SITE2', 'B']);
  assert.equal(wrongSite(item(FBE_RC, [{ billNumber: 'B181091', siteId: 'SITE2' }])), null, 'FBE in Site 2: right');
  assert.equal(wrongSite(item(TEMPEST_RC, [{ billNumber: 'M5066106', siteId: 'SITE1' }])), null, 'other sites are not part of the rule');
  assert.equal(wrongSite(item(null, [{ billNumber: 'B181090', siteId: 'SITE2', createdTimestamp: '2026-11-21T09:00:00' }])), null, 'no rate con: nothing to go by');
  assert.equal(wrongSite(item(TEMPEST_RC, [{ billNumber: 'B181050', siteId: 'SITE2', createdTimestamp: '2026-11-20T12:03:25' }])), null, 'created before Ronen\'s email (Nov 20, 5:21 PM): not flagged');
  assert.equal(wrongSite(item(TEMPEST_RC, [{ billNumber: 'B181096', siteId: 'SITE2' }])), null, 'no creation time: not flagged');
  assert.ok(wrongSite(item(TEMPEST_RC, [{ billNumber: 'B181095', siteId: 'SITE2', createdTimestamp: '2026-11-20T18:00:00' }])), 'after it: flagged');
});

test('the email says what to move where, and the rule', () => {
  const m = siteEmail(wrongSite(item(TEMPEST_RC, [{ billNumber: 'B181090', siteId: 'SITE2', createdTimestamp: '2026-11-21T09:00:00' }])), { test: true });
  assert.match(m.subject, /^\[TEST\] WRONG SITE Bill B181090 Trip 627610$/);
  assert.match(m.html, /Move bill B181090 to Site 9 \(letter F\)\./); assert.match(m.html, /Allen Lund Company/); assert.match(m.text, /Site 2 \(B\) is only FBE and FBF loads/);
});

test('emailed once per trip and bill; nothing when the board is right', async () => {
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  let trips = [item(TEMPEST_RC, [{ billNumber: 'B181090', siteId: 'SITE2', createdTimestamp: '2026-11-21T09:00:00' }]), item(FBE_RC, [{ billNumber: 'B181091', siteId: 'SITE2' }], '627611')];
  const sent = [];
  const sc = initSiteCheck({ db, getBoard: async () => ({ trips }), sendMail: async (x) => sent.push(x), emails: async () => ['ntellez@floridabeauty.us'], env: { NODE_ENV: 'test' } });
  assert.equal((await sc.check()).length, 1); assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']);
  await sc.check(); assert.equal(sent.length, 1, 'once');
  trips = [];
  assert.deepEqual(await sc.check(), []);
});

test('each load supplies its own bills, direction and trip link, including multiple bills', () => {
  const w = wrongSite(item(FBE_RC, ['F900010','F900011'].map(billNumber=>({billNumber,siteId:'SITE9',createdTimestamp:'2026-11-21T09:00:00'})), '999123'));
  const m = siteEmail(w);
  assert.equal(m.subject, 'WRONG SITE Bills F900010, F900011 Trip 999123');
  assert.match(m.html, /<h1[^>]*>Bills <span[^>]*>F900010, F900011<\/span> are/);
  assert.match(m.html, /Move bills F900010, F900011 to Site 2 \(letter B\)/);
  assert.match(m.html, /href="https:\/\/mytagalong.app\/truckmate\?trip=999123"/);
  assert.doesNotMatch(m.html, /B181090|627610|NOT A REAL REPORT/);
  assert.match(m.html, /NEEDS ATTENTION NOW/);
  assert.match(m.html, /WHAT TO DO/); assert.match(m.html, /Move bills <b>F900010, F900011<\/b> from <b>Site 9 \(F\)<\/b> to <b>Site 2 \(B\)<\/b>/);
  const hostile=siteEmail({...w,bills:['<img src=x>'],carrierName:'<script>bad</script>'});
  assert.doesNotMatch(hostile.html, /<img src=x>|<script>bad/);
  assert.match(hostile.html, /&lt;img src=x&gt;/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learn, usualFor, usualMs, lateCheck, shouldAlert, lateEmail, usualView, isLtl, stopKey } from '../usualarrival.js';

// Boston market (Chelsea, MA): Monday outbounds get there Wednesday about 4 AM
const ET = (iso) => Date.parse(iso);
const rows = [
  { trip: '1', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-10-21T08:05:00Z') },   // Wed 4:05 AM EDT
  { trip: '2', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-10-28T07:50:00Z') },   // Wed 3:50 AM EDT
  { trip: '3', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-11-04T09:00:00Z') },   // Wed 4:00 AM EST
  { trip: '4', customer: 'DIRECT FLOWERS OF BOSTON INC', place: 'CHELSEA, MA', arrivedMs: ET('2026-11-04T09:10:00Z') },   // no outbound known
];
const outbound = { 1: '2026-10-19', 2: '2026-10-26', 3: '2026-11-02' };

test('learns when trucks usually get to a customer: days after the outbound day + local time', () => {
  const st = learn({}, rows, (n) => outbound[n] || null, () => 'MIAMI');
  const rec = st[stopKey('DIRECT FLOWERS OF BOSTON INC', 'CHELSEA, MA')];
  assert.equal(rec.arrivals.length, 3);
  assert.equal(learn(st, rows, (n) => outbound[n] || null, () => 'MIAMI')[stopKey('DIRECT FLOWERS OF BOSTON INC', 'CHELSEA, MA')].arrivals.length, 3, 'each trip once');
  const u = usualFor(rec, '2026-11-09', 'MIAMI');
  assert.equal(u.days, 2);
  assert.equal(u.min, 4 * 60);
  assert.match(u.text, /2 days after the outbound day at about 4:00 AM local \(Monday outbounds\)/);
  assert.equal(new Date(usualMs(u, '2026-11-09', 'CHELSEA, MA')).toISOString(), '2026-11-11T09:00:00.000Z');   // Wed 4 AM EST
  assert.equal(usualFor({ arrivals: rec.arrivals.slice(0, 2) }, '2026-11-09', 'MIAMI'), null, 'needs 3 arrivals');
  assert.equal(usualFor(rec, '2026-11-09', 'VENTURA'), null, 'Miami arrivals say nothing about a Ventura load');
});

test('an LTL ETA past the usual time → alert once, again only an hour worse; broker loads never', () => {
  const learned = learn({}, rows, (n) => outbound[n] || null, () => 'MIAMI');
  const item = { trip: { tripNumber: '626824', powerUnit: '2607', trailer: '7224', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-09', stops: [] },
    _manifest: { stops: [{ action: 'DELIVER', customer: 'DIRECT FLOWERS OF BOSTON INC', city: 'CHELSEA', state: 'MA' }] },
    freightBills: [{ billNumber: 'M1', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150' }] };
  assert.equal(isLtl(item), true);
  const etas = { 626824: { stops: [{ label: 'CHELSEA, MA, 02150', etaMs: ET('2026-11-11T13:57:00Z') }] } };     // 8:57 AM
  const [x] = lateCheck([item], etas, learned);
  assert.equal(x.lateMin, 297);
  assert.equal(shouldAlert(null, x.lateMin), true);
  assert.equal(shouldAlert({ lateMin: 297 }, 330), false);
  assert.equal(shouldAlert({ lateMin: 297 }, 360), true);
  assert.equal(shouldAlert(null, 60), false, 'under 1 h 30 min');
  assert.match(lateEmail(x, item).subject, /Running late: trip 626824 — DIRECT FLOWERS OF BOSTON INC \(CHELSEA, MA\) ETA 4 h 57 min past usual/);
  assert.match(usualView([x])[0].vs_usual, /4 h 57 min later than usual/);
  const broker = { ...item, trip: { ...item.trip, origZoneDesc: 'LAKELAND, FL' }, _tb: undefined, _manifest: undefined, _ratecon: { broker: 'TQL' }, freightBills: [{ billNumber: 'B180922', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150' }] };
  assert.equal(lateCheck([broker], etas, learned).length, 0);
});

test('staff set a usual time ("Pyramid Oxnard: 4 AM") — it wins over the learned one; days after outbound from what was learned', async () => {
  const { parseClock, learnedDays } = await import('../usualarrival.js');
  assert.equal(parseClock('4am'), 240); assert.equal(parseClock('4:30 PM'), 990); assert.equal(parseClock('16:30'), 990); assert.equal(parseClock('13 PM'), null);
  const { initEtaReport } = await import('../etareport.js');
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
  // one Oxnard arrival learned: Monday Nov 2 outbound → Thursday Nov 5 (3 days)
  m.set('taUsualArrival:florida-beauty', { stops: { [stopKey('PYRAMID FLOWERS, INC.-OXNARD', 'OXNARD, CA')]: { customer: 'PYRAMID FLOWERS, INC.-OXNARD', place: 'OXNARD, CA', arrivals: [{ trip: '626362', days: 3, min: 1, dow: 1, outbound: '2026-11-02', ms: 1 }] } } });
  assert.equal(learnedDays(m.get('taUsualArrival:florida-beauty').stops[stopKey('PYRAMID FLOWERS, INC.-OXNARD', 'OXNARD, CA')]), 3);
  const sent = [];
  const r = initEtaReport({ db, sendMail: async (x) => sent.push(x), lateRecipients: async () => ['ntellez@floridabeauty.us'], now: () => Date.parse('2026-11-12T18:00:00Z') });
  const ok = await r.setUsual({ customer: 'Pyramid Flowers Oxnard', time: '4 AM', by: 'Nadim' });
  assert.equal(ok.ok, true);
  assert.match(ok.saved.usual, /3 days after the outbound day at 4:00 AM local \(set by Nadim\)/);
  assert.equal((await r.setUsual({ customer: 'Nobody', time: '4am' })).ok, false);
  // trip 626845 (Monday Nov 9 outbound): ETA Thu 4:04 PM PT vs the set 4 AM PT → alert
  const item = { trip: { tripNumber: '626845', powerUnit: '2611', trailer: '7136', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-09', stops: [] },
    freightBills: [{ billNumber: 'M5060046', billToName: 'PYRAMID FLOWERS, INC.-OXNARD', endZoneDescription: 'OXNARD, CA, 93030' }] };
  m.set('taWatch:florida-beauty', { etas: { 626845: { stops: [{ label: 'OXNARD, CA, 93030', etaMs: Date.parse('2026-11-13T00:04:00Z') }] } } });
  await r.process('florida-beauty', { trips: [item] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Running late: trip 626845 — PYRAMID FLOWERS, INC\.-OXNARD \(OXNARD, CA\) ETA 12 h 4 min past usual/);
  assert.match((await r.usualFor('626845'))[0].vs_usual, /12 h 4 min later than usual/);
});

test('delivery times are per hub (Miami / Ventura), and only Nadim or Ronen may set them', async () => {
  const { maySet, hubOf, hubKey, usualFor: uf } = await import('../usualarrival.js');
  assert.equal(maySet({ phone: '+1 (305) 504-0711' }), true);
  assert.equal(maySet({ phone: '3052063095' }), true);
  assert.equal(maySet({ phone: '7865551234' }), false);
  assert.equal(maySet({ name: 'Ronen Shalom' }), true);
  assert.equal(maySet({ name: 'Andres Leon' }), false);
  assert.equal(hubKey('Ventura'), 'VENTURA'); assert.equal(hubKey('miami'), 'MIAMI');
  assert.equal(hubOf({ trip: { origZoneDesc: 'MIAMI TERMINAL' } }), 'MIAMI');
  assert.equal(hubOf({ trip: {}, _tb: { hub: 'Ventura' } }), 'VENTURA');
  const rec = { customer: 'X', place: 'OXNARD, CA', arrivals: [], fixedByHub: { MIAMI: { days: 3, min: 240, hub: 'MIAMI', by: 'Nadim' }, VENTURA: { days: 0, min: 1260, hub: 'VENTURA', by: 'Ronen' } } };
  assert.match(uf(rec, '2026-11-09', 'MIAMI').text, /3 days after the outbound day at 4:00 AM local from Miami \(set by Nadim\)/);
  assert.match(uf(rec, '2026-11-09', 'VENTURA').text, /the outbound day at 9:00 PM local from Ventura \(set by Ronen\)/);
});

test('the arrival-delay email: customer first, outbound + ETA in the stop\'s zone, delay that matches the shown times, miles or "Unavailable", drivers with tap-to-call, escaped names', async () => {
  const { lateEmail: email, lateShown, whereSaid, driversOf } = await import('../usualarrival.js');
  const x = { trip: '627055', truck: '2220', trailer: '18094', outbound: '2026-11-12', label: 'HUNTSVILLE, AL, 35816', customers: ['THE <CONNECTION>', 'DAVIS WHOLESALE'], customer: 'THE <CONNECTION>',
    etaMs: Date.parse('2026-11-14T00:47:40Z'), usualMs: Date.parse('2026-11-13T09:35:10Z'), usual: { days: 1, min: 215, n: 4, of: 4 }, miles: 312, lateMin: 913 };
  assert.equal(lateShown(x.etaMs, x.usualMs), 912, '3:35 → 6:47 is 15 h 12 min, whatever the seconds');
  const team = { trip: { driver: '1', driver2: '2' }, _samsara: { location: '18435 US 84 / GA 38, Thomas County, GA, 31757', gpsAt: '2026-11-13T14:52:00Z', driver1: 'A One', driver1Info: { name: 'A One', phone: '305-555-0101' }, driver2: 'B Two', driver2Info: { name: 'B Two', phone: null } } };
  const m = email(x, team);
  assert.match(m.html, /THE &lt;CONNECTION&gt;/); assert.doesNotMatch(m.html, /<CONNECTION>/);
  assert.match(m.html, /Davis Wholesale · Huntsville, AL 35816/);
  assert.match(m.html, /Thu, Nov 12/); assert.match(m.html, /6:47 PM CT/); assert.match(m.html, /15 h 12 min past usual arrival/);
  assert.match(m.html, /Usual arrival:<\/b> Nov 13 · 3:35 AM CT/);
  assert.match(m.html, /312 miles/); assert.match(m.html, /href="tel:3055550101"/); assert.match(m.html, /Team driver/);
  assert.match(m.html, /Updated Nov 13 · 9:52 AM ET/); assert.match(m.html, /Based on the last 4 geofence arrivals/);
  assert.deepEqual(m.attachments.map((a) => a.cid).sort(), ['ud-driver', 'ud-mark', 'ud-route', 'ud-truck']);
  assert.match(m.text, /Miles to customer: 312 miles/); assert.match(m.text, /Team driver: B Two/);
  const solo = email({ ...x, miles: null }, { trip: { driver: '9' }, _samsara: {} });
  assert.match(solo.html, /Unavailable/); assert.doesNotMatch(solo.html, /Team driver/); assert.match(solo.text, /Truck location: Unavailable/);
  assert.deepEqual(whereSaid('I 10, Culberson County, TX'), { street: 'I 10', town: 'Culberson County, TX' });
  assert.equal(driversOf({ trip: { driver: '0986' } }).driver.name, 'Driver 0986');
});

test('a Ventura load is compared only with Ventura arrivals (trip 627080: Santa Barbara → Davis Wholesale Birmingham, not the Miami next-day time)', async () => {
  const { hubOf, learn: lrn, lateCheck: lc } = await import('../usualarrival.js');
  const ventura = { trip: { tripNumber: '627080', origZoneDesc: 'SANTA BARBARA, CA, 93108' }, _manifest: { stops: [{ action: 'LOAD', customer: 'VENTURA TERMINAL' }, { action: 'DELIVER', customer: 'DAVIS WHOLESALE -BIRMINGHAM', city: 'BIRMINGHAM', state: 'AL' }] },
    _tb: { date: '2026-11-12', stops: [] }, freightBills: [{ billNumber: 'C981226', billToName: 'DAVIS WHOLESALE -BIRMINGHAM', endZoneDescription: 'BIRMINGHAM, AL, 35222' }] };
  assert.equal(hubOf(ventura), 'VENTURA');
  assert.equal(hubOf({ trip: { origZoneDesc: 'SANTA BARBARA, CA, 93108' } }), 'VENTURA');
  assert.equal(hubOf({ trip: { origZoneDesc: 'MIAMI TERMINAL' } }), 'MIAMI');
  // three Miami (Thursday) outbounds got there the next afternoon
  const arr = (trip, iso, out) => ({ trip, customer: 'DAVIS WHOLESALE -BIRMINGHAM', place: 'BIRMINGHAM, AL', arrivedMs: Date.parse(iso), _out: out });
  const rows = [arr('a', '2026-10-23T20:56:00Z', '2026-10-22'), arr('b', '2026-10-30T20:50:00Z', '2026-10-29'), arr('c', '2026-11-06T21:00:00Z', '2026-11-05')];
  const learned = lrn({}, rows, (n) => rows.find((r) => r.trip === n)._out, () => 'MIAMI');
  const etas = { 627080: { stops: [{ label: 'BIRMINGHAM, AL, 35222', etaMs: Date.parse('2026-11-15T11:07:00Z'), miles: 2055 }] } };
  assert.deepEqual(lc([ventura], etas, learned), [], 'no Ventura history → no "38 h late" alert');
  const miami = { ...ventura, trip: { tripNumber: '627081', origZoneDesc: 'MIAMI TERMINAL' }, _manifest: { stops: [{ action: 'LOAD', customer: 'MIAMI TERMINAL' }, ventura._manifest.stops[1]] } };
  assert.equal(lc([miami], { 627081: etas[627080] }, learned).length, 1, 'a Miami load still gets compared');
});

test('a time saved for one outbound weekday (MOBI\'S Carpinteria: Thursday Miami outbounds → Monday 4 AM) wins for that weekday only', async () => {
  const { usualFor: uf, usualMs: um, parseWeekday, lateCheck: lc } = await import('../usualarrival.js');
  assert.equal(parseWeekday('Thursday'), 4); assert.equal(parseWeekday('jueves'), 4); assert.equal(parseWeekday('x'), null);
  const thu = { customer: "MOBI'S", place: 'CARPINTERIA, CA', hub: 'MIAMI', dow: 4, days: 4, min: 240, by: 'Nadim' };
  const rec = { customer: "MOBI'S", place: 'CARPINTERIA, CA', arrivals: [], fixedByHubDow: { 'MIAMI:4': thu }, fixedByHub: { MIAMI: { ...thu, dow: undefined, days: 3, min: 360 } } };
  const u = uf(rec, '2026-11-12', 'MIAMI');                      // Thu Nov 12
  assert.match(u.text, /4 days after the outbound day at 4:00 AM local from Miami \(Thursday outbounds\)/);
  assert.equal(new Date(um(u, '2026-11-12', 'CARPINTERIA, CA')).toISOString(), '2026-11-16T12:00:00.000Z', 'Mon Nov 16, 4 AM PT');
  assert.equal(uf(rec, '2026-11-09', 'MIAMI').days, 3, 'a Monday outbound uses the any-day time');
  // trip 627063: ETA Sun Nov 15 4:50 PM PT is before Monday 4 AM → not late
  const item = { trip: { tripNumber: '627063', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-12', stops: [] }, freightBills: [{ billNumber: 'M1', billToName: "MOBI'S", endZoneDescription: 'CARPINTERIA, CA, 93013' }] };
  const [x] = lc([item], { 627063: { stops: [{ label: 'CARPINTERIA, CA, 93013', etaMs: Date.parse('2026-11-16T00:50:00Z'), miles: 2189 }] } }, { k: rec });
  assert.ok(x.lateMin < 0, 'early, no alert');
});

test('running-late emails: cc Saray (Fri–Mon list), the hub on the email, a reply line Jarvis learns from; Saray may set times', async () => {
  const { lateEmail: email, maySet } = await import('../usualarrival.js');
  const x = { trip: '626966', hub: 'MIAMI', truck: '2602', trailer: '7234', outbound: '2026-11-11', label: 'HOUSTON, TX, 77040', customers: ['H&T WHOLESALE FLOWERS HOUSTON INC'], customer: 'H&T WHOLESALE FLOWERS HOUSTON INC',
    etaMs: Date.parse('2026-11-13T21:46:00Z'), usualMs: Date.parse('2026-11-13T04:27:00Z'), usual: { days: 1, min: 1347, n: 4, of: 4 }, miles: 32, lateMin: 1039 };
  const m = email(x, { _samsara: {} });
  assert.match(m.html, /2026 · Miami/);
  assert.match(m.text, /Is this right\? Reply to this email: "correct", or when Wednesday outbounds from Miami usually get to H&T WHOLESALE FLOWERS HOUSTON INC/);
  assert.equal(maySet({ name: 'Saray Fabregas' }), true); assert.equal(maySet({ email: 'strujillo@floridabeauty.us' }), true);
  assert.equal(maySet({ name: 'Andres Leon', email: 'aleon@floridabeauty.us' }), false);
  const { initEtaReport } = await import('../etareport.js');
  const kv = {}; const db = { enabled: true, get: async (k, d) => (k in kv ? JSON.parse(JSON.stringify(kv[k])) : d), set: async (k, v) => { kv[k] = v; }, update: async (k, f, d) => { kv[k] = f(k in kv ? JSON.parse(JSON.stringify(kv[k])) : d); return kv[k]; } };
  const { stopKey } = await import('../usualarrival.js');
  const arr = (t, iso, out) => ({ trip: t, ms: Date.parse(iso), outbound: out, dow: 3, days: 1, min: 1347, hub: 'MIAMI' });
  kv['taUsualArrival:florida-beauty'] = { stops: { [stopKey('H&T WHOLESALE FLOWERS HOUSTON INC', 'HOUSTON, TX')]: { customer: 'H&T WHOLESALE FLOWERS HOUSTON INC', place: 'HOUSTON, TX', arrivals: [arr('a', '2026-10-22T04:27:00Z', '2026-10-21'), arr('b', '2026-10-29T04:27:00Z', '2026-10-28'), arr('c', '2026-11-05T04:27:00Z', '2026-11-04')] } } };
  kv['taWatch:florida-beauty'] = { etas: { 626966: { stops: [{ label: 'HOUSTON, TX, 77040', etaMs: x.etaMs, miles: 32 }] } } };
  const sent = [];
  const r = initEtaReport({ db, sendMail: async (msg) => sent.push(msg), lateRecipients: async () => ['ntellez@floridabeauty.us'], lateCc: async () => ['strujillo@floridabeauty.us'], now: () => Date.parse('2026-11-13T21:15:00Z') });
  await r.process('florida-beauty', { trips: [{ trip: { tripNumber: '626966', origZoneDesc: 'MIAMI TERMINAL', powerUnit: '2602' }, _tb: { date: '2026-11-11', stops: [] }, freightBills: [{ billNumber: 'M1', billToName: 'H&T WHOLESALE FLOWERS HOUSTON INC', endZoneDescription: 'HOUSTON, TX, 77040' }] }] });
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['ntellez@floridabeauty.us']); assert.deepEqual(sent[0].cc, ['strujillo@floridabeauty.us']);
});

test('one late email per load (first late stop), again only 3 h worse and 6 h later; any-weekday usual never alerts', async () => {
  const { dueByTrip } = await import('../usualarrival.js');
  const T0 = Date.parse('2026-11-13T18:00:00Z');
  const rows = [
    { trip: '626966', label: 'HOUSTON, TX, 77040', lateMin: 1039 },
    { trip: '626966', label: 'PHOENIX, AZ, 85043', lateMin: 1183 },
    { trip: '627130', label: 'PHOENIX, AZ, 85043', lateMin: 60 },
  ];
  const d = dueByTrip(rows, {}, 90, T0);
  assert.deepEqual(d.map((x) => [x.row.trip, x.row.label, x.worse]), [['626966', 'HOUSTON, TX, 77040', false]]);
  const sent = { 'trip:626966': { lateMin: 1039, at: new Date(T0).toISOString() } };
  assert.equal(dueByTrip([{ trip: '626966', label: 'PHOENIX, AZ, 85043', lateMin: 1150 }], sent, 90, T0 + 7 * 3600000).length, 0, 'next stop just as late: no email');
  assert.equal(dueByTrip([{ trip: '626966', label: 'PHOENIX, AZ, 85043', lateMin: 1300 }], sent, 90, T0 + 2 * 3600000).length, 0, '3 h worse but too soon');
  assert.equal(dueByTrip([{ trip: '626966', label: 'PHOENIX, AZ, 85043', lateMin: 1300 }], sent, 90, T0 + 7 * 3600000)[0].worse, true);
  assert.equal(dueByTrip(rows, { '626966|HOUSTON, TX, 77040': { lateMin: 1039, at: new Date(T0).toISOString() } }, 90, T0 + 3600000).length, 0, 'older per-stop record counts');
  // H&T Phoenix learned from other weekdays' routes (2 days) → a Wednesday load isn't judged against it
  const arr = [1, 2, 3, 4].map((i) => ({ trip: `9${i}`, days: 2, min: 1226, dow: 1, hub: 'MIAMI', outbound: '2026-11-02', ms: i }));
  const learned = { [stopKey('H&T WHOLESALE FLOWERS INC', 'PHOENIX, AZ')]: { customer: 'H&T WHOLESALE FLOWERS INC', place: 'PHOENIX, AZ', arrivals: arr } };
  const item = { trip: { tripNumber: '626966', powerUnit: '2602', origZoneDesc: 'MIAMI TERMINAL' }, _tb: { date: '2026-11-11', stops: [] },
    _manifest: { stops: [{ action: 'DELIVER', customer: 'H&T WHOLESALE FLOWERS INC', city: 'PHOENIX', state: 'AZ' }] }, freightBills: [{ billNumber: 'M1', billToName: 'H&T WHOLESALE FLOWERS INC*', endZoneDescription: 'PHOENIX, AZ, 85043' }] };
  const etas = { 626966: { stops: [{ label: 'PHOENIX, AZ, 85043', etaMs: Date.parse('2026-11-15T00:00:00Z') }] } };
  assert.equal(lateCheck([item], etas, learned).length, 0, 'Wednesday load vs Monday arrivals');
  assert.equal(lateCheck([{ ...item, _tb: { date: '2026-11-09', stops: [] } }], etas, learned).length, 1, 'Monday load vs Monday arrivals');
});

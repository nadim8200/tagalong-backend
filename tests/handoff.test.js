import test from 'node:test';
import assert from 'node:assert/strict';
import { initTransferDone, confirmsHandoff, answerConfirms, findAfter } from '../transferdone.js';
import { initTransferWatch } from '../transferwatch.js';
import { initBreakdownReport } from '../breakdownreport.js';
import { handoffFacts, renderTransferCompletedEmail, renderFixedRollingEmail, currentAssignment, snapshotLoad, crewOf } from '../handoffmail.js';
import { renderRollingEmail } from '../teamstopmail.js';
import { trackRolling } from '../watchtower.js';

const NOW = Date.parse('2026-11-01T16:00:00Z');
const mem = () => { const s = {}; return { enabled: true, get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, fn, d) => { s[k] = fn(k in s ? s[k] : d); return s[k]; }, s }; };
const hos = (status, driveLeftMin = 300) => ({ status, driveLeftMin, shiftLeftMin: 400, cycleLeftMin: 2000, at: new Date(NOW - 60000).toISOString() });
const sam = (over = {}) => ({ driver1: 'Ana Ruiz', driver1Info: { phone: '3055550101' }, hos: hos('driving'), lat: 28.5, lng: -81.4, location: 'Orlando, FL', speedMph: 62, gpsAt: new Date(NOW - 30000).toISOString(), source: 'samsara', rpm: 1300, ...over });
const team = (over) => sam({ driver2: 'Luis Vega', driver2Info: { phone: '3055550102' }, hos2: hos('sleeperBerth'), ...over });
const load = (unit, over = {}) => ({ trip: { tripNumber: '625878', powerUnit: unit, trailer: '7323', driver: 'A1', ...over.trip }, freightBills: [{ billNumber: 'M1', billToName: 'Publix *', pieces: 900, endZoneDescription: 'Ocala, FL' }], _samsara: sam(), _rescue: { from: '2602', to: '4504', subject: 'FLOWERS BREAKDOWN AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878', ...over.rescue }, ...over.top });
const etas = (ms) => ({ stops: [{ label: 'Ocala, FL', etaMs: ms, apptMs: NOW + 8 * 3600000, miles: 80, apptFrom: 'sheet' }] });

function rig() {
  const db = mem(); const sent = []; let t = NOW; let fail = false; const done = [];
  const eta = { 625878: etas(NOW + 3600000) };
  const x = initTransferDone({ db, sendMail: async (m, o) => { if (fail) throw new Error('mail down'); sent.push({ ...m, opts: o }); }, recipients: async () => ['a@floridabeauty.us'], rescueRecipients: async () => ['b@floridabeauty.us'], staffOnly: () => true, etas: async () => eta, onDone: async (r) => done.push(r.trip), now: () => t });
  return { x, db, sent, done, eta, tick: (ms) => { t += ms; }, setFail: (v) => { fail = v; } };
}
const onFrom = () => ({ trips: [load('2602'), { trip: { tripNumber: '700', powerUnit: '4504', trailer: '9', driver: 'B1' }, freightBills: [], _samsara: team({ driver1: 'Rita Sol' }) }] });
const onTo = (over) => ({ trips: [load('4504', { rescue: { recorded: true }, ...over })] });

test('only a clear yes counts as the handoff', () => {
  for (const y of ['YES', 'yes done', 'Sí', 'listo', 'done', 'ya está', 'hooked to 4504', 'transfer done']) assert.equal(confirmsHandoff(y), true, y);
  for (const n of ['ya voy', 'almost done', 'no', 'not yet', 'ya casi', 'yes in 10 minutes going', 'on my way', '', 'ok', 'voicemail']) assert.equal(confirmsHandoff(n), false, n);
  assert.equal(answerConfirms({ status: 'done', source: 'driver text', summary: 'Driver replied: "yes"' }), true);
  assert.equal(answerConfirms({ status: 'done', source: 'driver text', summary: 'Driver replied: "ya voy"' }), false);
  assert.equal(answerConfirms({ status: 'done', source: 'phone call', summary: 'Driver did not confirm; transfer not done' }), false);
  assert.equal(answerConfirms({ status: 'done', source: 'TruckMate', summary: 'yes' }), false, 'TruckMate is never a confirmation');
});

test('TruckMate moving the load sends no Transfer completed; an explicit yes sends exactly one, across repeats and restarts', async () => {
  const r = rig();
  await r.x.observe(onFrom()); await r.x.process(onFrom());
  r.tick(60000); await r.x.observe(onTo()); await r.x.process(onTo());
  assert.equal(r.sent.length, 0, 'an assignment change alone proves nothing');
  await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email', atText: '10:15 AM ET', location: 'Pilot, Ocala', type: 'tractor swap', scope: 'full' });
  await r.x.process(onTo());
  assert.equal(r.sent.length, 1); assert.deepEqual(r.done, ['625878']);
  assert.match(r.sent[0].subject, /^Re: FLOWERS BREAKDOWN/, 'stays on the chain');
  assert.deepEqual(r.sent[0].to, ['b@floridabeauty.us']);
  assert.equal((await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' })).already, true);
  await r.x.process(onTo());
  const again = initTransferDone({ db: r.db, sendMail: async (m) => r.sent.push(m), recipients: async () => ['a@floridabeauty.us'], rescueRecipients: async () => ['b@floridabeauty.us'] });
  await again.process(onTo());
  assert.equal(r.sent.length, 1, 'still one after a restart');
});

test('a failed send retries; a crash mid-send never doubles; retries stop', async () => {
  const r = rig();
  await r.x.observe(onFrom());
  await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' });
  r.setFail(true);
  await r.x.process(onFrom());
  assert.equal(Object.values(r.db.s['taTransferDone:florida-beauty'])[0].status, 'confirmed');
  r.setFail(false); await r.x.process(onFrom()); assert.equal(r.sent.length, 1);
  const c = rig(); await c.x.observe(onFrom()); await c.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' });
  const k = Object.keys(c.db.s['taTransferDone:florida-beauty'])[0]; c.db.s['taTransferDone:florida-beauty'][k].status = 'sending';
  await c.x.process(onFrom()); assert.equal(c.sent.length, 0, 'unsure whether it left: no second copy');
  const f = rig(); await f.x.observe(onFrom()); await f.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' }); f.setFail(true);
  for (let i = 0; i < 8; i += 1) await f.x.process(onFrom()); // eslint-disable-line no-await-in-loop
  assert.equal(Object.values(f.db.s['taTransferDone:florida-beauty'])[0].attempts, 5);
});

test('cancelled or reversed: no stale success', async () => {
  const r = rig(); await r.x.observe(onFrom());
  await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' });
  await r.x.cancel({ trip: '625878', by: 'Gio' });
  await r.x.process(onFrom()); assert.equal(r.sent.length, 0);
  const m = rig(); await m.x.observe(onFrom()); await m.x.observe(onTo());
  await m.x.confirm({ trip: '625878', by: 'Driver', source: 'Driver text reply' });
  await m.x.process(onFrom());
  assert.equal(m.sent.length, 0, 'TruckMate put it back on the first truck');
  assert.equal(Object.values(m.db.s['taTransferDone:florida-beauty'])[0].status, 'reversed');
  const s = rig(); await s.x.observe(onFrom()); await s.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email' }); await s.x.process(onFrom());
  await s.x.cancel({ trip: '625878', by: 'Gio' });
  assert.equal(s.sent.length, 2); assert.match(s.sent[1].text, /Transfer reversed/); assert.match(s.sent[1].text, /Disregard/);
});

test('nothing old goes out: records only start from what this code sees', async () => {
  const r = rig();
  r.db.s['taTransferWatch:florida-beauty'] = { 625878: { from: '2602', to: '4504', outcome: { status: 'done', source: 'driver text' } } };
  await r.x.process(onFrom()); assert.equal(r.sent.length, 0);
  await r.x.observe(onFrom()); await r.x.process(onFrom()); assert.equal(r.sent.length, 0);
});

test('staff can confirm a handoff nobody planned on record, only with both trucks; a wrong truck is refused', async () => {
  const r = rig(); const board = { trips: [{ ...load('2602'), _rescue: undefined }] };
  assert.equal((await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email', board })).ok, false);
  assert.equal((await r.x.confirm({ trip: '625878', toTruck: 'RESCUE TRUCK', by: 'Gio', source: 'Staff email', board })).ok, false, 'a placeholder is not a truck');
  assert.equal((await r.x.confirm({ trip: '625878', toTruck: '4504', by: 'Gio', source: 'Staff email', board })).ok, true);
  const w = rig(); await w.x.observe(onFrom());
  assert.match((await w.x.confirm({ trip: '625878', toTruck: '9999', by: 'Gio', source: 'Staff email' })).error, /not 9999/);
});

const record = async (before, after, confirm = {}) => {
  const r = rig(); await r.x.observe(before); await r.x.observe(after);
  await r.x.confirm({ trip: '625878', by: 'Gio', source: 'Staff email', atText: '10:15 AM ET', ...confirm });
  const k = Object.keys(r.db.s['taTransferDone:florida-beauty'])[0];
  return r.db.s['taTransferDone:florida-beauty'][k];
};

test('the email: team on one side, solo on the other, phones, before and after, previous vs revised ETA', async () => {
  const rec = await record(onFrom(), onTo({ top: { _samsara: team({ driver1: 'Rita Sol' }) } }), { location: 'Pilot, Ocala', type: 'tractor swap', scope: 'full' });
  rec.before.etaMs = NOW + 3600000;
  const f = handoffFacts(rec, onTo({ top: { _samsara: team({ driver1: 'Rita Sol' }) } }).trips[0], { etas: etas(NOW + 2 * 3600000), now: NOW });
  const m = renderTransferCompletedEmail(f);
  assert.match(m.html, /TRANSFER COMPLETED/); assert.match(m.html, /Physical handoff confirmed\./);
  assert.match(m.html, /FROM · ORIGINAL TRUCK/); assert.match(m.html, /Truck 2602 → Truck 4504/);
  assert.equal(f.fromCrew.kind, 'Solo'); assert.equal(f.toCrew.kind, 'Team');
  assert.match(m.html, /Ana Ruiz/); assert.match(m.html, /Rita Sol/); assert.match(m.html, /Luis Vega/); assert.match(m.html, /tel:\+13055550101/);
  assert.match(f.fromCrew.asOf, /Snapshot from .*Newer data may exist/); assert.match(f.toCrew.asOf, /^Current at/);
  assert.equal(f.rows.find((r) => r.label === 'Trailer').after, 'Unchanged'); assert.equal(f.rows.find((r) => r.label === 'Trip').after, 'Unchanged');
  assert.equal(f.change, '1h 0m later (estimated)'); assert.match(f.previousEta, /ET/); assert.match(f.revisedEta, /ET/);
  assert.equal(f.type, 'Tractor swap'); assert.equal(f.departure, 'Departure not confirmed');
  assert.doesNotMatch(m.html.replace(/<!--[\s\S]*?-->/g, '') + m.text, /\[[A-Za-z ]+\]|undefined|null|NaN/);
  assert.match(m.text, /TRANSFER COMPLETED/); assert.doesNotMatch(m.html, /View transfer record/);
});

test('trailer and trip changed, partial, several loads, TruckMate not updated, and everything missing', async () => {
  const swapped = { trips: [{ trip: { tripNumber: '700', powerUnit: '4504', trailer: '8888', driver: 'B1' }, freightBills: [{ billNumber: 'M1', billToName: 'Publix', pieces: 500 }, { billNumber: 'M2', billToName: 'Kroger', pieces: 100 }], _samsara: sam() }] };
  const rec = await record(onFrom(), onFrom(), { scope: 'partial', type: 'transload' });
  assert.equal(findAfter(rec, swapped).trip.tripNumber, '700', 'found by its bills on the receiving truck');
  const f = handoffFacts(rec, findAfter(rec, swapped), { now: NOW });
  assert.equal(f.rows.find((r) => r.label === 'Trailer').after, '8888'); assert.equal(f.rows.find((r) => r.label === 'Trip').after, '700');
  assert.equal(f.rows.find((r) => r.label === 'Bills').after, 'M1, M2'); assert.equal(f.scope, 'Partial');
  const still = handoffFacts(rec, onFrom().trips[0], { now: NOW });
  assert.equal(still.rows.find((r) => r.label === 'Trailer').after, 'Not confirmed'); assert.match(still.truckMate, /Not updated yet/); assert.equal(still.revisedEta, 'Not available');
  const bare = handoffFacts({ trip: '1', from: '2', to: '3', confirm: { by: 'Gio', source: 'Staff email' } }, null, { now: NOW });
  const m = renderTransferCompletedEmail(bare);
  assert.equal(bare.confirmedAt, 'Not recorded'); assert.match(handoffFacts({ trip: '1', from: '2', to: '3', confirm: { reportedAt: NOW } }, null, { now: NOW }).confirmedAt, /^Time not stated\. Reported Nov 1/); assert.equal(bare.location, 'Not recorded'); assert.equal(bare.arrivalFrom, 'Not recorded'); assert.equal(bare.previousEta, 'Not recorded');
  assert.doesNotMatch(m.html.replace(/<!--[\s\S]*?-->/g, '') + m.text, /\[[A-Za-z ]+\]|undefined|null|NaN/);
  const noPhones = handoffFacts(rec, onFrom().trips[0], { now: NOW, showPhones: false });
  assert.doesNotMatch(renderTransferCompletedEmail(noPhones).html, /tel:/);
});

test('names and notes are escaped', async () => {
  const rec = await record(onFrom(), onFrom(), { location: '<script>x</script>', by: '<b>x' });
  const h = renderTransferCompletedEmail(handoffFacts(rec, null, { now: NOW })).html;
  assert.doesNotMatch(h, /<script>x/); assert.match(h, /&lt;script&gt;/);
});

// ---- transfer watch: driver answers
const watchRig = (reply) => {
  const db = mem(); const sent = []; const conf = []; let t = NOW;
  const pos = () => ({ lat: 28.5, lng: -81.4, speedMph: 0, location: 'Pilot, Ocala', at: new Date(NOW).toISOString() });
  db.s['taTripComms:florida-beauty'] = { 625878: [{ type: 'reply', text: reply, at: new Date(NOW + 20 * 60000).toISOString() }] };
  const w = initTransferWatch({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['a@x'], rescueRecipients: async () => ['b@x'], textDriver: async () => ({ sent: true }), livePos: pos, now: () => t, confirms: answerConfirms, onConfirmed: async (p, a) => conf.push([p, a]) });
  return { w, sent, conf, tick: (m) => { t += m * 60000; } };
};
test('a driver YES goes to the record, not the old "done" email; "ya voy" does not', async () => {
  const board = { trips: [load('2602')] };
  const yes = watchRig('YES'); await yes.w.process('s', board); yes.tick(16); await yes.w.process('s', board); yes.tick(5); await yes.w.process('s', board);
  assert.equal(yes.conf.length, 1); assert.equal(yes.conf[0][1].source, 'driver text');
  assert.equal(yes.sent.filter((m) => /Transfer done/.test(m.subject || m.text)).length, 0);
  const soon = watchRig('ya voy'); await soon.w.process('s', board); soon.tick(16); await soon.w.process('s', board); soon.tick(5); await soon.w.process('s', board);
  assert.equal(soon.conf.length, 0);
});
test('after TruckMate moves a rescue the watch stays on it, quietly', async () => {
  const w = watchRig('');
  await w.w.process('s', onTo());
  assert.equal(w.sent.filter((m) => /planned/i.test(m.text + m.subject)).length, 0, 'the chain already heard');
});

// ---- breakdown fixed & rolling
function bd() {
  const db = mem(); const chain = []; let t = NOW;
  const board = { trips: [{ trip: { tripNumber: '625878', powerUnit: '2602', trailer: '7323', driver: 'A1' }, freightBills: [{ billNumber: 'M1' }], _samsara: sam() }] };
  const r = initBreakdownReport(null, { db, secret: 's', getBoard: async () => board, send: async () => {}, sendChain: async (x, m) => chain.push(m), now: () => t });
  return { r, db, chain, board, tick: (ms) => { t += ms; }, at: () => t };
}
const ep = (over) => ({ unit: '2602', trip: '625878', movingSince: NOW - 20 * 60000, confirmedAt: NOW, speedMph: 64, live: sam(), alertsOn: true, openAlerts: [], ...over });
const open = async (b) => { await b.r.fromEmail({ trip: '625878', reason: 'truck air leak', by: 'Gio', emailId: 'e1' }); };

test('reported fixed with the truck still parked: fixed email, waiting on movement, no "rolling"', async () => {
  const b = bd(); await open(b);
  b.tick(5 * 3600000);
  await b.r.fixed('625878', 'Gio', { repair: 'replaced air line', provider: 'TA Ocala' });
  assert.equal(b.chain.length, 1);
  assert.match(b.chain[0].text, /Breakdown reported fixed/); assert.match(b.chain[0].text, /Awaiting confirmed movement/); assert.doesNotMatch(b.chain[0].text, /rolling/i);
  assert.deepEqual(await b.r.held(), [], 'hold lifted');
  assert.equal((await b.r.fixedWaiting()).length, 1);
  assert.equal((await b.r.recoveryFor('02602')).repair, 'replaced air line');
});
test('fixed but another hold is open: says so instead of "alerts back on"', async () => {
  const b = bd(); await open(b);
  const db = b.db; const chain = [];
  const r = initBreakdownReport(null, { db, secret: 's', getBoard: async () => b.board, send: async () => {}, sendChain: async (x, m) => chain.push(m), otherHolds: async () => true, now: () => NOW });
  assert.equal((await r.fixed('625878', 'Gio')).held, true); assert.match(chain[0].text, /stay off/); assert.doesNotMatch(chain[0].text, /back on/);
});
test('movement without a repair never reads as fixed', async () => {
  const b = bd(); await open(b);
  assert.equal(await b.r.recoveryFor('2602'), null);
  assert.equal(trackRolling({ unit: '2602', at: NOW, lat: 1, lng: 1 }, sam(), NOW, { down: (await b.r.held()).includes('2602') }).confirmed, false);
  const plain = renderRollingEmail(ep(), b.board.trips[0], { now: NOW, note: 'No repair has been reported for this breakdown.' });
  assert.match(plain.text, /No repair has been reported/); assert.doesNotMatch(plain.text, /FIXED/);
});
test('one fixed & rolling per breakdown: claim once, a failed send gives it back, old reports never qualify', async () => {
  const b = bd(); await open(b); b.tick(1000); await b.r.fixed('625878', 'Gio');
  const w = await b.r.recoveryFor('2602');
  assert.equal(await b.r.claimRecovery(w.key), true); assert.equal(await b.r.claimRecovery(w.key), false);
  assert.equal(await b.r.recoveryFor('2602'), null, 'no second email');
  await b.r.releaseRecovery(w.key); assert.ok(await b.r.recoveryFor('2602'), 'send failed: try again');
  const old = bd(); await old.db.update('taBreakdownReports:florida-beauty', () => ({ a: { atMs: NOW - 1e7, unit: '1', trip: '1', clearedAt: NOW - 1e6, fixedBy: 'Gio' } }), {});
  assert.deepEqual(await old.r.fixedWaiting(), [], 'fixed before this existed: stays quiet');
  const stale = bd(); await open(stale); await stale.r.fixed('625878', 'Gio'); stale.tick(4 * 86400000);
  assert.deepEqual(await stale.r.fixedWaiting(), [], 'never moved in 3 days: stop waiting');
});
test('truck moved after its load left: can be fixed, email says where the load went and reuses no ETA', async () => {
  const b = bd(); await open(b);
  b.board.trips[0].trip.powerUnit = '4504'; await b.r.process('s', b.board);
  assert.match(b.chain[0].text, /Transfer recorded in TruckMate/); assert.match(b.chain[0].text, /not confirmed yet/); assert.doesNotMatch(b.chain[0].text, /Transfer completed/);
  await b.r.process('s', b.board); assert.equal(b.chain.length, 1, 'recorded once');
  assert.equal((await b.r.fixed('625878', 'Gio', { repair: 'new line' })).ok, true);
  const rep = await b.r.recoveryFor('2602');
  assert.equal(rep.transferredTo, '4504');
  const m = renderFixedRollingEmail({ ep: ep(), report: { ...rep, fixedAt: NOW - 3600000 }, item: null, etas: etas(NOW + 7200000), now: NOW });
  assert.match(m.text, /Trip 625878 moved to truck 4504\. No current load on this truck\./); assert.doesNotMatch(m.text, /Updated ETA/);
  assert.equal(currentAssignment({ trip: '1', transferredTo: '9' }, { trip: { tripNumber: '2' } }).kind, 'new');
  const nw = renderFixedRollingEmail({ ep: ep(), report: { ...rep, fixedAt: NOW - 3600000 }, item: { trip: { tripNumber: '777', powerUnit: '2602' }, _samsara: sam() }, etas: etas(NOW + 7200000), now: NOW });
  assert.match(nw.text, /Current load: trip 777/); assert.match(nw.text, /Updated ETA \(estimated\): .*ET/);
});
test('the email: repair facts, monitoring only from state, nothing invented, solo and team', () => {
  const report = { atMs: NOW - 6 * 3600000, fixedAt: NOW - 3600000, fixedBy: 'Gio', reason: 'truck air leak', trip: '625878', unit: '2602', before: { trailer: '7323' } };
  const item = { trip: { tripNumber: '625878', powerUnit: '2602', trailer: '7323', driver: 'A1', driver2: 'A2' }, _samsara: team() };
  const m = renderFixedRollingEmail({ ep: ep(), report, item, etas: etas(NOW + 3600000), now: NOW, mapCid: 'truckmap' });
  assert.match(m.html, /BREAKDOWN FIXED &amp; ROLLING/); assert.match(m.html, /Repair reported fixed · Movement confirmed/); assert.match(m.html, /Snapshot at email generation/);
  assert.match(m.html, /Team-truck alerts resumed\./); assert.match(m.html, /cid:truckmap/); assert.match(m.text, /Repair performed: Not provided/); assert.match(m.text, /Provider: Not provided/); assert.match(m.text, /Breakdown duration: 5h 0m/);
  assert.match(m.html, /Luis Vega/); assert.match(m.text, /CURRENT DRIVER CREW · Team/);
  const off = renderFixedRollingEmail({ ep: ep({ alertsOn: false, openAlerts: ['Reefer temp high'] }), report, item, now: NOW });
  assert.doesNotMatch(off.html, /alerts resumed/); assert.match(off.text, /Alert status not confirmed/); assert.match(off.text, /1 other open alert on this truck: Reefer temp high/);
  const solo = renderFixedRollingEmail({ ep: ep({ live: sam() }), report, item: { trip: { tripNumber: '625878', powerUnit: '2602', driver: 'A1' }, _samsara: sam() }, now: NOW });
  assert.match(solo.text, /CURRENT DRIVER CREW · Solo/); assert.match(solo.text, /Breakdown hold cleared/); assert.doesNotMatch(solo.text, /Team-truck alerts resumed/);
  const bare = renderFixedRollingEmail({ ep: ep({ live: { speedMph: 40 } , speedMph: null }), report: { trip: '1', unit: '2', reason: 'x', fixedBy: 'G', fixedAt: NOW, atMs: NOW - 60000 }, item: null, now: NOW });
  assert.match(bare.text, /Location not reported/); assert.match(bare.text, /GPS not reported/); assert.match(bare.text, /Crew not available/);
  assert.doesNotMatch(bare.html + bare.text, /undefined|null|NaN/);
});
test('stale GPS, a spike, or a stop start movement over', () => {
  const st = { unit: '2602', at: NOW, lat: null, lng: null };
  assert.equal(trackRolling(st, sam({ gpsAt: new Date(NOW - 20 * 60000).toISOString() }), NOW).confirmed, false, 'stale');
  let e = st; const read = (i, over) => { const r = trackRolling(e, sam({ gpsAt: new Date(NOW + i * 120000).toISOString(), ...over }), NOW + i * 120000); e = r.ep; return r.confirmed; };
  assert.equal(read(0), false); assert.equal(read(1, { speedMph: 0 }), false); assert.equal(e.readings, 0, 'a stop resets it');
  assert.equal(read(2), false); assert.equal(read(3), false); assert.equal(read(4), true, 'three good readings');
});
test('a rescue plan needs a real truck number', async () => {
  const b = bd(); await open(b);
  assert.equal((await b.r.rescuePlan('625878', { to: 'RESCUE TRUCK', by: 'Gio' })).ok, false);
});
test('the snapshots copy only what is on the load', () => {
  assert.deepEqual(snapshotLoad(load('2602'), etas(NOW), NOW).bills, ['M1']); assert.equal(snapshotLoad(load('2602'), null, NOW).pieces, 900);
  assert.equal(snapshotLoad({ trip: {}, freightBills: [{ billNumber: 'A' }] }, null, NOW).pieces, null, 'no count, no number');
  assert.equal(crewOf(load('2602'), NOW).live.driver1, 'Ana Ruiz');
});

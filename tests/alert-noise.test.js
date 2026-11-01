import test from 'node:test';
import assert from 'node:assert/strict';
import { faultSeverity, evaluateBoard, teamStopsDue } from '../watchtower.js';
import { renderTeamStopEmail, teamStopFacts, tripSheetIds, tripSheetFiles } from '../teamstopmail.js';
import { compareWithTruckMate } from '../manifest.js';

test('engine faults: network/sensor/manufacturer codes are quiet; protection and derate codes alert', () => {
  for (const code of ['SPN 639 FMI 2', 'SPN 2042 FMI 9', 'SPN 3216 FMI 5', 'SPN 523012 FMI 31', 'SPN 1590 FMI 19', 'SPN 811 FMI 2', 'P2002', 'SPN 2659 FMI 18']) assert.equal(faultSeverity({ code }), null, code);
  assert.equal(faultSeverity({ code: 'SPN 110 FMI 0' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 100 FMI 1' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 5246 FMI 15' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 4364 FMI 1' }), 'warning');
  assert.equal(faultSeverity({ code: 'SPN 412 FMI 0', meaning: 'Engine Exhaust Gas Recirculation 1 Temperature — High—most severe' }), 'warning');
  assert.equal(faultSeverity({ code: 'SPN 596 FMI 1', meaning: 'Cruise Control Enable Switch — Low—most severe' }), null);
  assert.equal(faultSeverity({ code: 'SPN 1487 FMI 0', meaning: 'Cab A/C Refrigerant Compressor Outlet Pressure — High—most severe' }), null);
  assert.equal(faultSeverity({ code: 'P0217' }), 'critical');
});

test('a truck with only minor codes raises no alert; a serious code does', () => {
  const now = Date.parse('2026-10-06T16:00:00Z');
  const item = (codes) => ({ trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '2403' }, freightBills: [], _samsara: { lat: 30, lng: -84, gpsAt: '2026-10-06T15:59:00Z', speedMph: 60, dtcCodes: codes } });
  const ctx = { now, geo: () => null, unitState: () => ({}) };
  const ce = (b) => evaluateBoard({ trips: [b] }, ctx).filter((a) => a.code === 'check-engine');
  assert.equal(ce(item([{ code: 'SPN 639 FMI 2', meaning: 'J1939 Network #1' }, { code: 'SPN 3216 FMI 5', meaning: 'NOx sensor' }])).length, 0);
  const a = ce(item([{ code: 'SPN 639 FMI 2', meaning: 'J1939 Network #1' }, { code: 'SPN 110 FMI 0', meaning: 'Engine Coolant Temperature — High—most severe' }]));
  assert.equal(a.length, 1); assert.equal(a[0].severity, 'critical');
  assert.match(a[0].title, /Engine fault — Engine Coolant Temperature/);
  assert.match(a[0].detail, /1 minor code on the truck card/);
});

test('outside-carrier loads: carrier truck/trailer vs OC code is not a mismatch', () => {
  const sheet = { tripNumber: '624257', truck: '176', trailer: 'RR53153', stops: [] };
  assert.deepEqual(compareWithTruckMate(sheet, { trip: { powerUnit: 'OC 978', trailer: 'OC27' }, freightBills: [] }), []);
  assert.deepEqual(compareWithTruckMate({ ...sheet, truck: '003', trailer: '14' }, { trip: { powerUnit: 'OC2', trailer: 'OC2' }, freightBills: [] }), []);
  const own = compareWithTruckMate({ tripNumber: '624218', truck: '2612', stops: [] }, { trip: { powerUnit: '2609' }, freightBills: [] });
  assert.match(own[0].msg, /Sheet says truck 2612, TruckMate has 2609/);
});

test('a team truck sitting: off duty is not a rest when a driver has hours; solo trucks keep the 11-hour rule', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const hos = (status, driveLeftMin) => ({ status, driveLeftMin, shiftLeftMin: driveLeftMin, at: '2026-11-01T11:59:00Z' });
  const item = (x = {}) => ({ trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '733', driver: '1', driver2: '2' }, freightBills: [], _samsara: { lat: 33.6, lng: -80.3, location: 'Summerton, SC', gpsAt: '2026-11-01T11:59:00Z', speedMph: 0, driver1: 'Chad', driver2: 'Jose', hos: hos('offDuty', 660), hos2: hos('sleeperBerth', 282), ...x } });
  const run = (it, mins) => evaluateBoard({ trips: [it] }, { now, geo: () => null, unitState: () => ({ stoppedSince: now - mins * 60000 }) }).filter((a) => a.code === 'stopped');
  assert.equal(run(item(), 45).length, 0, 'a short stop is fine');
  const warn = run(item(), 75)[0];
  assert.equal(warn.severity, 'warning'); assert.match(warn.title, /Team truck stopped 1h 15m/); assert.match(warn.detail, /Chad has 11h 0m/);
  assert.equal(run(item(), 130)[0].severity, 'critical');
  assert.equal(run(item({ dtcCodes: [{ code: 'P0217' }] }), 75)[0].severity, 'critical');
  // both out of hours: a real reset, the old rule
  assert.equal(run(item({ hos: hos('offDuty', 0), hos2: hos('sleeperBerth', 30) }), 300).length, 0);
  // solo: unchanged
  const solo = item({ driver2: undefined, hos2: undefined }); delete solo.trip.driver2;
  assert.equal(run(solo, 300).length, 0);
  assert.match(run(solo, 700)[0].title, /^Resting/);
});

test('team stop emails: one at 1 hour, one more when it turns red, none once someone owns it or for other stops', () => {
  const a = (severity, x = {}) => ({ id: 'stopped:1', teamStop: true, severity, ...x });
  assert.equal(teamStopsDue([a('warning')], { 'stopped:1': {} }).length, 1);
  assert.equal(teamStopsDue([a('warning')], { 'stopped:1': { mailLevel: 1 } }).length, 0, 'not every cycle');
  assert.equal(teamStopsDue([a('critical')], { 'stopped:1': { mailLevel: 1 } }).length, 1);
  assert.equal(teamStopsDue([a('critical')], { 'stopped:1': { mailLevel: 2 } }).length, 0);
  assert.equal(teamStopsDue([a('critical')], { 'stopped:1': { mailLevel: 1, ack: { by: 'Ana' } } }).length, 0, 'someone has it');
  assert.equal(teamStopsDue([a('warning', { teamStop: false })], { 'stopped:1': {} }).length, 0, 'solo stops never email');
});

const NOW2 = Date.parse('2026-11-01T12:00:00Z');
const fullItem = { trip: { tripNumber: '626258', powerUnit: '733', trailer: '262066', driver: '0182', driver2: '7914' }, _samsara: { location: '401 Buff <Blvd>, Summerton, SC', lat: 33.6, lng: -80.3, gpsAt: '2026-11-01T11:58:00Z', source: 'samsara', speedMph: 0, driver1: 'Chad Morgan', driver2: 'Jose L Gonzalez', driver1Info: { phone: '9542604450' }, hos: { status: 'offDuty', driveLeftMin: 660, shiftLeftMin: 840, cycleLeftMin: 2760, at: '2026-11-01T11:50:00Z' }, hos2: { status: 'sleeperBerth', driveLeftMin: 282, shiftLeftMin: 282, cycleLeftMin: null }, dtcCodes: [{ code: 'SPN 1', meaning: 'Sample' }] } };
const alert = { unit: '733', trip: '626258', severity: 'critical', title: 'Team truck stopped 3h 28m', detail: 'x', stoppedSinceMs: NOW2 - 208 * 60000 };

test('team stop email: every section from real data, phones only when allowed, text escaped', () => {
  const etas = { stops: [{ label: 'HYDE PARK, MA, 02136', miles: 892, etaMs: NOW2 + 3600000 * 11, apptMs: NOW2 + 3600000 * 10, apptFrom: 'handwritten' }] };
  const m = renderTeamStopEmail(teamStopFacts(alert, fullItem, { etas, now: NOW2, mapCid: 'truckmap' }));
  assert.equal(m.subject, 'Team truck 733 stopped: 3h 28m — trip 626258');
  assert.match(m.html, /jarvis:training-slot/); assert.match(m.html, /Buff &lt;Blvd&gt;/); assert.match(m.html, /cid:truckmap/);
  assert.match(m.html, /3h 28m/); assert.match(m.html, /Trailer 262066/); assert.match(m.html, /\(954\) 260-4450/); assert.match(m.html, /tel:\+19542604450/);
  assert.match(m.html, /Phone not available/, 'second driver has none'); assert.match(m.text, /1h 0m past the appointment/);
  assert.doesNotMatch(m.html, /could be a breakdown|should be rolling/, 'nothing inferred');
  assert.doesNotMatch(renderTeamStopEmail(teamStopFacts(alert, fullItem, { now: NOW2, showPhones: false })).html, /260-4450/);
});

test('team stop email: missing data says so and never invents anything', () => {
  const m = renderTeamStopEmail(teamStopFacts({ ...alert, stopStartUnknown: true }, { trip: { tripNumber: '626258' }, _samsara: { gpsAt: '2026-11-01T01:00:00Z', location: 'I-95', lat: null } }, { now: NOW2 }));
  assert.match(m.html, /At least 3h 28m/); assert.match(m.html, /Not confirmed/);
  assert.match(m.html, /may be out of date/); assert.match(m.html, /No driver reported/); assert.match(m.html, /No engine codes reported/);
  assert.doesNotMatch(m.html, /On time/); assert.doesNotMatch(m.html, /Open map/); assert.match(m.text, /Estimated arrival: Not available/);
});

test('training notice goes in the slot and the subject is untouched outside training', async () => {
  const { redirectEmail } = await import('../training.js');
  const m = renderTeamStopEmail(teamStopFacts(alert, fullItem, { now: NOW2 }));
  assert.match(redirectEmail({ ...m, to: ['a@b.com'] }, ['t@t.com']).html, /TRAINING/);
  assert.doesNotMatch(m.subject, /TRAINING/);
});

test('trip sheet on the team stop email: every page we can read goes, and the email says exactly what is attached', () => {
  assert.deepEqual(tripSheetIds({ _manifest: { docIds: [11, 12] } }), ['11', '12']);
  assert.deepEqual(tripSheetIds({ _packet: [{ type: 'bol', docId: 1 }, { type: 'manifest_continuation', docId: 3, file: 1, page: 2 }, { type: 'manifest', docId: 2, file: 1, page: 1 }] }), ['2', '3'], 'sheet pages only, in order');
  assert.deepEqual(tripSheetIds({ _manifest: { docIds: [] }, _docs: [{ id: 1, kind: 'tripsheet', version: 1, page: 1 }, { id: 3, kind: 'tripsheet', version: 2, page: 2 }, { id: 2, kind: 'tripsheet', version: 2, page: 1 }, { id: 4, kind: 'ratecon' }, { id: 5, kind: 'tripsheet', version: 2, restricted: true }] }), ['2', '3'], 'a stored sheet still counts: newest version, never restricted');
  assert.deepEqual(tripSheetIds({}), []);
  const pg = (id, n = 10) => ({ id, mediaType: 'application/pdf', data: Buffer.alloc(n) });
  const ok = tripSheetFiles([pg('1'), pg('2')], ['1', '2'], '626258');
  assert.equal(ok.note, 'Trip sheet attached'); assert.deepEqual(ok.attachments.map((x) => x.name), ['Trip sheet 626258 page 1.pdf', 'Trip sheet 626258 page 2.pdf']);
  assert.equal(tripSheetFiles([], [], '1').status, 'none');
  assert.equal(tripSheetFiles([], ['1'], '1').status, 'unavailable');
  const one = tripSheetFiles([pg('2')], ['1', '2'], '9');
  assert.equal(one.status, 'attached', 'one bad page never drops the good one'); assert.match(one.note, /1 of 2 pages/); assert.equal(one.attachments[0].name, 'Trip sheet 9 page 2.pdf');
  const big = tripSheetFiles([pg('1', 2 * 1024 * 1024), pg('2', 2 * 1024 * 1024)], ['1', '2'], '9');
  assert.equal(big.attachments.length, 1); assert.match(big.note, /1 of 2 pages/);
  assert.equal(tripSheetFiles([pg('1', 4 * 1024 * 1024)], ['1'], '1').status, 'too_large');
  const say = (sheet) => renderTeamStopEmail(teamStopFacts(alert, fullItem, { now: NOW2, sheet }));
  assert.match(say(ok).html, /Trip sheet attached/); assert.match(say(ok).text, /Trip sheet attached/);
  assert.match(say(one).html, /1 of 2 pages/);
  assert.doesNotMatch(say(null).html, /Trip sheet attached/); assert.match(say(null).html, /No trip sheet on file/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { faultSeverity, evaluateBoard, teamStopsDue } from '../watchtower.js';
import { renderTeamStopEmail } from '../teamstopmail.js';
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

test('team stop email: says what, keeps the training slot, escapes text', () => {
  const m = renderTeamStopEmail({ unit: '733', trip: '626258', severity: 'critical', title: 'Team truck stopped 2h 5m', detail: 'Summerton, SC · off duty. Chad <b> has 11h 0m of driving left.' });
  assert.equal(m.subject, 'Team truck 733 stopped: 2h 5m — trip 626258');
  assert.match(m.html, /jarvis:training-slot/); assert.match(m.html, /Chad &lt;b&gt;/); assert.match(m.text, /626258/);
});

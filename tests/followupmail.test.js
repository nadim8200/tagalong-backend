import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tripBlock, renderOutboundFollowUp, ackKey, validateZone, tempNote } from '../followupmail.js';
import { parseInstructions, expandInstructions } from '../inbox.js';

// what triage returns for Rosa's "OUTBOUND 8 TRIP SHEETS … FIVE LOADS OF FLOWERS TO BE FOLLOWED UP"
const TRIAGE = [
  { kind: 'pickup_followup', trip: '624626', event: 'pickup', date: '2026-10-08', time: '23:00', region: 'Florida', temp: '35 degrees', message: 'Confirm pickup' },
  { kind: 'pickup_followup', trip: '624625', event: 'pickup', date: '2026-10-08', time: '23:30', region: 'Florida', temp: '35 degrees', message: 'Confirm pickup' },
  { kind: 'pickup_followup', trip: '624620', event: 'meetup', date: '2026-10-08', time: null, place: 'Fort Pierce', region: 'Florida', message: 'Confirm the Fort Pierce meetup' },
  { kind: 'pickup_followup', trip: '624634', event: 'departure', date: '2026-10-09', time: '14:00', region: 'California', message: 'Confirm departure' },
  { kind: 'pickup_followup', trip: '624628', event: 'departure', date: '2026-10-09', time: null, timeText: 'afternoon', region: 'California', message: 'Confirm departure' },
];
const board = {
  624626: { trip: { tripNumber: '624626', status: 'DISP', origZoneDesc: 'MIAMI, FL 33166' } },
  624625: { trip: { tripNumber: '624625', status: 'DISP', origZoneDesc: 'MIAMI, FL 33166' } },
  624620: { trip: { tripNumber: '624620', status: 'DISP', origZoneDesc: 'MIAMI, FL 33166' } },
  624634: { trip: { tripNumber: '624634', status: 'DISP', origZoneDesc: 'OXNARD, CA 93030' } },
  624628: { trip: { tripNumber: '624628', status: 'DISP', origZoneDesc: 'MIAMI, FL 33166' } },   // email says California, board says FL
};
const NOW = Date.parse('2026-10-09T01:30:00Z');   // Thu Oct 8, 9:30 PM ET
const blocksFor = (reachable = () => true) => expandInstructions(parseInstructions(TRIAGE)).map((i) => tripBlock({ ...i, result: {} }, board[i.trip], { now: NOW, reachable }));

test('all five trips keep their own date / time / place', () => {
  const b = Object.fromEntries(blocksFor().map((x) => [x.trip, x]));
  assert.deepEqual(Object.keys(b).sort(), ['624620', '624625', '624626', '624628', '624634']);
  assert.equal(b['624626'].scheduled, 'Pickup · Thu, Oct 8, 11:00 PM ET');
  assert.equal(b['624625'].scheduled, 'Pickup · Thu, Oct 8, 11:30 PM ET');
  assert.equal(b['624620'].scheduled, 'Meetup · Fort Pierce · Thu, Oct 8, time not given');
  assert.equal(b['624634'].scheduled, 'Departure · Fri, Oct 9, 2:00 PM PT');
  assert.equal(b['624628'].scheduled, 'Departure · Fri, Oct 9, afternoon (exact time not given)');
  assert.equal(b['624626'].group, 'Florida · Thu, Oct 8');
  assert.equal(b['624634'].group, 'California · Fri, Oct 9');
});

test('missing exact time / time zone → ask only that, for that trip', () => {
  const b = Object.fromEntries(blocksFor().map((x) => [x.trip, x]));
  assert.equal(b['624620'].need, 'the exact meetup time for 624620 (Fort Pierce)');
  assert.equal(b['624628'].need, 'the exact departure time for 624628');
  assert.equal(b['624626'].need, null);
  assert.deepEqual(validateZone({ region: 'California' }, board['624628']), { tz: null, issue: 'the email says California but the load starts in FL' });
  assert.equal(validateZone({ tz: 'Pacific' }, board['624628']).tz, 'America/Los_Angeles');
  assert.equal(validateZone({}, { trip: {} }).tz, null);
});

test('status wording only claims what a system record supports', () => {
  const b = Object.fromEntries(blocksFor(() => false).map((x) => [x.trip, x]));
  assert.equal(b['624626'].status.label, 'Awaiting confirmation');
  assert.match(b['624626'].status.text, /^Confirmation pending/);
  assert.match(b['624626'].next, /Jarvis can't reach them/);
  const reach = Object.fromEntries(blocksFor(() => true).map((x) => [x.trip, x]));
  assert.equal(reach['624626'].next, 'Jarvis checks in with the driver at 10:00 PM and 10:30 PM ET, then replies here when it departs');
  const dep = tripBlock({ kind: 'pickup_followup', trip: '1', event: 'pickup', date: '2026-10-08', time: '23:00', result: {} }, { trip: { status: 'DEPSHIP', origZoneDesc: 'MIAMI, FL' } }, { now: NOW });
  assert.deepEqual([dep.status.label, dep.status.tone], ['Departed', 'green']);
  const late = tripBlock({ kind: 'pickup_followup', trip: '1', event: 'pickup', date: '2026-10-08', time: '20:00', result: {} }, { trip: { status: 'DISP', origZoneDesc: 'MIAMI, FL' } }, { now: NOW });
  assert.deepEqual([late.status.label, late.status.tone], ['Not departed', 'red']);
  assert.equal(tripBlock({ kind: 'pickup_followup', trip: '9', result: {} }, null, { now: NOW }).status.label, 'Not verified');
});

test('temperature unit is never assumed', () => {
  assert.equal(tempNote('35 degrees'), 'Temperature: 35 degrees — unit not stated, verify (°F?)');
  assert.equal(tempNote('35°F'), 'Temperature: 35°F');
});

test('the same acknowledgment is never sent twice; a real change is', () => {
  const a = ackKey('msg1', blocksFor());
  assert.equal(a, ackKey('msg1', blocksFor()));
  const moved = blocksFor(); moved[0] = { ...moved[0], status: { label: 'Departed', tone: 'green', text: 'TruckMate: DEPSHIP' } };
  assert.notEqual(a, ackKey('msg1', moved));
});

test('the email: heading, summary, a block per trip, no task dumps; written to disk for a look', () => {
  const out = renderOutboundFollowUp({ blocks: blocksFor(() => false) });
  assert.match(out.text, /^FLOWER OUTBOUND FOLLOW-UP\n5 trips · Florida · Thu, Oct 8 and California · Fri, Oct 9/);
  assert.equal((out.text.match(/^Trip 6246\d\d — /gm) || []).length, 5);
  assert.doesNotMatch(out.text + out.html, /Here is what I did|To-do|which load\?|blockquote/i);
  assert.match(out.text, /STILL NEEDED FROM DISPATCH/);
  if (process.env.RENDER_OUT) writeFileSync(process.env.RENDER_OUT, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">${out.html}</body>`);
});

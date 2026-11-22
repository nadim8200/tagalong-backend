import test from 'node:test';
import assert from 'node:assert/strict';
import { staffDelivery, staffPodReason, ownWords, signerOf } from '../staffpod.js';
import { finishReason, isSure } from '../finished.js';
import { evaluateBoard } from '../watchtower.js';

const ours = (a) => /@floridabeauty\.us$/.test(a);
const load = (bills = [{ billNumber: 'B181099', endZoneDescription: 'NEW STANTON, PA, 15672', temperature: 38 }]) => ({ trip: { tripNumber: '627668', status: 'DEPSHIP', powerUnit: '4564', trailer: '18096' }, freightBills: bills });
const mail = (text, extra = {}) => ({ at: '2026-11-21T15:21:24Z', from: { name: 'Diego Diaz', address: 'ddiaz@floridabeauty.us' }, subject: 'Re: MEGACORP Load 2821479 MD TO PA TR 4564 TL 18096', text, ...extra });
const POD = 'Load delivered\nNo lumper\nClean bills\nPlease see below POD:\nThanks,\nPriscyla Dominguez 🎅🏻 | Inbound Dispatcher 🎄\nFlorida Beauty Express';

test('627668: inbound dispatch\'s "Load delivered / Clean bills / POD" email finishes the load', () => {
  const p = staffDelivery([mail('Hi team,\nDriver still at receiver being unloaded, door# 130', { at: '2026-11-21T14:13:32Z' }), mail(POD)], load(), ours);
  assert.equal(p.whole, true); assert.equal(p.signer, 'Priscyla Dominguez'); assert.equal(p.by, 'Diego Diaz');
  const r = staffPodReason(p);
  assert.match(r, /^delivered — POD emailed by Priscyla Dominguez \(from Diego Diaz's email\), Sat, Nov 21, 10:21 AM ET \(staff email\)$/);
  assert.equal(isSure(r), true);
  assert.equal(finishReason({ ...load(), _staffPod: p }), r);
  assert.ok(staffDelivery([mail(POD, { auto: 'group' })], load(), ours), 'filed as a group email (Inbound - Dispatch)');
  assert.equal(staffDelivery([mail(POD, { auto: 'out-of-office' })], load(), ours), null);
});

test('a forwarded header on top is skipped; the "POD FOR B…" subject counts for that bill only', () => {
  const fwd = 'From: Diego Diaz <d@floridabeauty.us>\nSent: Saturday, November 21, 2026 10:21\nTo: Liz\nSubject: Re: MEGACORP\nLoad delivered\nThanks,\nPriscyla Dominguez';
  assert.match(ownWords(fwd), /^Load delivered/);
  assert.ok(staffDelivery([mail(fwd, { subject: 'POD FOR B181099' })], load(), ours));
  assert.ok(staffDelivery([mail('see attached', { subject: 'POD FOR B181099' })], load(), ours));
  assert.equal(staffDelivery([mail('Load delivered', { subject: 'BAY STATE FLORAL B181065 NC TO MA' })], load(), ours), null, 'another load\'s thread');
});

test('never: brokers / customers, not-yet wording, POD requests, quoted history', () => {
  assert.equal(staffDelivery([mail(POD, { from: { name: 'Jacob Hawkins', address: 'jh@megacorplogistics.com' } })], load(), ours), null);
  for (const t of ['Driver still at receiver being unloaded', 'At delivery\nWaiting for his appointment time', 'Please send the POD asap', 'Load not delivered yet', 'Load refused at the receiver', 'Rolling by\nETA 5AM'])
    assert.equal(staffDelivery([mail(t)], load(), ours), null, t);
  assert.equal(staffDelivery([mail('Any update?\n\nOn Sat, Nov 21 Diego wrote:\nLoad delivered')], load(), ours), null);
  assert.equal(signerOf('no sign-off here'), null);
});

test('multi-stop with stops open: only whole-load words close it; otherwise a "Probably finished" hint', () => {
  const two = load([{ billNumber: 'B1', endZoneDescription: 'MACON, GA', actualDelivery: 'x' }, { billNumber: 'B2', endZoneDescription: 'ROCK HILL, SC' }]);
  const p = staffDelivery([mail('Delivered\nPOD attached\nThanks,\nLiz Benitez')], two, ours);
  assert.equal(p.whole, false); assert.equal(finishReason({ ...two, _staffPod: p }), null);
  assert.equal(staffDelivery([mail('All delivered, truck empty')], two, ours).whole, true);
});

test('no reefer alerts on a load our staff said is delivered', () => {
  const now = Date.parse('2026-11-22T15:00:00Z');
  const it = { ...load(), _samsara: { lat: 36.5, lng: -80.6, gpsAt: '2026-11-22T14:59:00Z', speedMph: 0, reeferState: 'Off', tempF: 60, setpointF: 38 } };
  const reefer = (x) => evaluateBoard({ trips: [x] }, { now, geo: () => null, unitState: () => ({}) }).filter((a) => /^reefer-/.test(a.code)).map((a) => a.code);
  const before = reefer(it);
  assert.ok(before.length, `expected reefer alerts before, got ${before}`);
  assert.deepEqual(reefer({ ...it, _staffPod: { whole: true } }), []);
});

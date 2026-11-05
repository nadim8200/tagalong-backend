import test from 'node:test';
import assert from 'node:assert/strict';
import { initTrailerChange, trailerChange, changeEvidence, renderTrailerChange } from '../trailerchange.js';

const mem = () => { const s = {}; return { enabled: true, s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), update: async (k, f, d) => { s[k] = f(k in s ? JSON.parse(JSON.stringify(s[k])) : d); return s[k]; } }; };
// trip 626344: the axle broke on TL 7328, the load was cross-docked onto TL 7371; TruckMate has 7371, the sheet 7328
const load = (over = {}) => ({ trip: { tripNumber: '626344', powerUnit: '4550', trailer: '7371', status: 'ARRCONS' }, _samsara: { driver1: 'Moises Espinoza', driver2: 'Jose Angarita' },
  _manifest: { trailer: '7328', diffs: [{ kind: 'trailer', msg: 'Sheet says trailer 7328, TruckMate has 7371.' }, { kind: 'stop', msg: 'x' }] },
  _comms: [{ type: 'email', subject: 'FLOWERS BREAKDOWN TRAILER AXLE BROKE OFF - TK# 4550 TL# 7328 - TRIP# 626344', text: '' }], ...over });

test('a trailer change: TruckMate changes the trailer on a trip we follow; or the sheet\'s trailer broke down per the load\'s emails', () => {
  assert.deepEqual(trailerChange(load(), '7328'), { from: '7328', to: '7371', source: 'TruckMate', reason: 'FLOWERS BREAKDOWN TRAILER AXLE BROKE OFF - TK# 4550 TL# 7328 - TRIP# 626344' });
  assert.equal(trailerChange(load(), '7371'), null, 'same trailer');
  assert.equal(trailerChange(load(), null).source, 'trip sheet vs TruckMate', 'first look: the sheet trailer broke down per the emails');
  assert.equal(trailerChange(load({ _comms: [] }), null), null, 'a sheet that just differs is not a trailer change');
  assert.equal(trailerChange(load({ trip: { tripNumber: '1', trailer: 'OC2', powerUnit: 'OC2' } }), '7328'), null, 'outside carriers');
  assert.equal(changeEvidence(load({ _comms: [{ type: 'email', subject: 'TL 7328 temp check' }] }), '7328'), null, 'mentioning the trailer is not enough');
});

test('recorded once, emailed once to the Truck transfer list; on the board the old trailer is no longer a mismatch', async () => {
  const db = mem(); const sent = [];
  const tc = initTrailerChange({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['transfer@floridabeauty.us'] });
  assert.equal(await tc.process('florida-beauty', [load()]), 1);
  assert.equal(await tc.process('florida-beauty', [load()]), 0, 'not again');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Trailer change — Trip 626344 · TL 7328 → TL 7371 · Truck 4550');
  assert.deepEqual(sent[0].to, ['transfer@floridabeauty.us']);
  assert.match(sent[0].text, /Why: FLOWERS BREAKDOWN TRAILER AXLE BROKE OFF/); assert.match(sent[0].text, /Drivers: Moises Espinoza & Jose Angarita/);
  const board = [load()];
  await tc.overlay('florida-beauty', board);
  assert.equal(board[0]._trailerChanges[0].to, '7371');
  assert.deepEqual(board[0]._manifest.diffs.map((d) => d.kind), ['stop'], 'trailer diff gone, others stay');
  // later TruckMate swaps again: 7371 → 7400
  await tc.process('florida-beauty', [load({ trip: { tripNumber: '626344', powerUnit: '4550', trailer: '7400', status: 'DEPCONS' } })]);
  assert.equal(sent.length, 2); assert.match(sent[1].subject, /TL 7371 → TL 7400/);
});

test('a dispatcher reports it (Jarvis): from what TruckMate or the sheet had; nothing new is not reported', async () => {
  const db = mem(); const sent = [];
  const tc = initTrailerChange({ db, sendMail: async (m) => sent.push(m), recipients: async () => ['t@x.us'] });
  const before = load({ trip: { tripNumber: '626344', powerUnit: '4550', trailer: '7328', status: 'DEPSHIP' }, _comms: [] });
  const r = await tc.report('florida-beauty', before, { to: '7371', by: 'Giovanni Di Muro', reason: 'axle broke, cross-docked' });
  assert.equal(r.ok, true); assert.deepEqual([r.change.from, r.change.to, r.change.by], ['7328', '7371', 'Giovanni Di Muro']);
  assert.equal((await tc.report('florida-beauty', before, { to: '7328', by: 'G' })).ok, false);
  assert.match(renderTrailerChange(before, r.change).text, /Reported by: Giovanni Di Muro/);
});

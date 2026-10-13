import test from 'node:test';
import assert from 'node:assert/strict';
import { initStopTasks, applyTask, readAnswer, instructionText, verifyText, doneEmail, placeOf } from '../stoptasks.js';
import { parseInstructions } from '../inbox.js';

// Re: Flower Link Delivery (Oct 13): deliver all 88 boxes to 316 Bohn St, Biloxi MS 39530 instead of Pensacola — truck 2219;
// Giovanni: "The driver, Abner Bonilla, confirmed … He will drop off the 88 boxes in Biloxi."
const change = { kind: 'stop_change', trip: '624906', customer: 'Flower Link', fromPlace: 'Pensacola, FL', address: '316 Bohn St', city: 'Biloxi', state: 'MS', zip: '39530', boxes: 88, truck: '2219', driverConfirmed: true, driverName: 'Abner Bonilla', message: 'Deliver all 88 boxes to the Biloxi location (316 Bohn St) instead of Pensacola — no power at Pensacola.' };
const PENSACOLA = { lat: 30.4213, lng: -87.2169 }; const BILOXI = { lat: 30.3960, lng: -88.8853 };
const board = (pos, extra = {}) => ({ trips: [{ trip: { tripNumber: '624906', powerUnit: '2219', status: 'DEPCONS' }, _samsara: { ...pos, gpsAt: new Date(T).toISOString(), driver1: 'ABNER BONILLA' },
  freightBills: [{ billToName: 'FLOWER LINK', endZoneDescription: 'PENSACOLA, FL, 32501', pieces: 88, ...extra }, { billToName: 'OTHER FLORIST', endZoneDescription: 'MOBILE, AL, 36602', pieces: 20 }],
  _manifest: { stops: [{ action: 'DELIVER', customer: 'FLOWER LINK', city: 'PENSACOLA', state: 'FL', pieces: 88 }, { action: 'DELIVER', customer: 'OTHER FLORIST', city: 'MOBILE', state: 'AL', pieces: 20 }] } }] });
let T = Date.parse('2026-10-13T13:00:00Z');

test('the email instruction is read as a stop change (customer, from, new address, boxes, driver confirmed)', () => {
  const [x] = parseInstructions([change]);
  assert.equal(x.kind, 'stop_change'); assert.equal(x.customer, 'Flower Link'); assert.equal(x.zip, '39530'); assert.equal(x.boxes, 88); assert.equal(x.driverConfirmed, true); assert.equal(x.trip, '624906');
  assert.equal(placeOf(x), '316 Bohn St, Biloxi, MS 39530');
});

test('the trip changes: Flower Link\'s bills and stop go to Biloxi (ETA follows), other stops untouched, the instruction is on the stop', () => {
  const it = applyTask(board({ lat: 30.4, lng: -86.5, speedMph: 60 }).trips[0], { id: 'x', ...change, by: 'Giovanni Di Muro', status: 'open' });
  assert.equal(it.freightBills[0].endZoneDescription, 'BILOXI, MS, 39530'); assert.equal(it.freightBills[0]._origEnd, 'PENSACOLA, FL, 32501');
  assert.equal(it.freightBills[1].endZoneDescription, 'MOBILE, AL, 36602');
  const st = it._manifest.stops[0];
  assert.equal(st.city, 'BILOXI'); assert.equal(st.tmPlace, 'BILOXI, MS'); assert.deepEqual(st.was, { city: 'PENSACOLA', state: 'FL', zip: null });
  assert.match(st.instructions[0], /CHANGED \(Giovanni Di Muro\): deliver all 88 boxes to 316 Bohn St, Biloxi, MS 39530 instead of PENSACOLA/);
  assert.equal(it._manifest.stops[1].city, 'MOBILE');
});

test('driver answers', () => {
  for (const t of ['Ok', 'yes', 'Si', 'listo', 'Delivered', 'ya entregué']) assert.equal(readAnswer(t), 'yes', t);
  for (const t of ['no', 'not yet', 'todavía no']) assert.equal(readAnswer(t), 'no', t);
  assert.equal(readAnswer('where do I go?'), null);
  assert.match(instructionText({ ...change }, 'ABNER BONILLA'), /Hi ABNER.*deliver the 88 boxes for Flower Link to 316 Bohn St, Biloxi, MS 39530 \(not Pensacola, FL\).*reply OK/);
  assert.match(verifyText({ ...change }, 'Abner'), /did you deliver the 88 boxes for Flower Link at 316 Bohn St, Biloxi, MS 39530\? Reply YES or NO/);
});

function setup() {
  const store = {}; const db = { enabled: true, get: async (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), update: async (k, fn, d) => { store[k] = fn(k in store ? store[k] : d); return store[k]; } };
  const texts = []; const calls = []; const replies = [];
  const st = initStopTasks({ db, now: () => T, geocode: async (p) => (/Biloxi/.test(p) ? BILOXI : /Pensacola/.test(p) ? PENSACOLA : null),
    textDriver: async (site, trip, text) => { texts.push(text); return { sent: true }; },
    voice: { placeCall: async (trip, o) => { calls.push(o.purpose); return {}; }, callsFor: async () => [] },
    replyInThread: async (site, emailId, note) => { replies.push(note.text); return { sent: true }; } });
  const reply = (text) => { store['taTripComms:florida-beauty'] = { 624906: [...((store['taTripComms:florida-beauty'] || {})[624906] || []), { type: 'reply', text, at: new Date(T).toISOString() }] }; };
  return { st, store, texts, calls, replies, reply };
}

test('Flower Link: driver already confirmed → stopped at Pensacola is flagged; at Biloxi → left → driver YES → "done" on the chain', async () => {
  T = Date.parse('2026-10-13T13:00:00Z');
  const { st, texts, replies, reply } = setup();
  const added = await st.add({ ...change, emailId: 'AAMk-flowerlink', by: 'Giovanni Di Muro' }); assert.equal(added.ok, true); assert.equal(added.acked, true);
  await st.process('florida-beauty', board({ lat: 30.0, lng: -85.5, speedMph: 62 }));
  assert.equal(texts.length, 0);                                         // the email says he confirmed — no need to ask
  T += 3 * 3600000; await st.process('florida-beauty', board({ ...PENSACOLA, speedMph: 0 }));
  assert.match(replies[0], /⚠️ The truck is stopped at the OLD stop \(Pensacola, FL\).*truck 2219, Flower Link.*316 Bohn St, Biloxi/);
  T += 2 * 3600000; await st.process('florida-beauty', board({ ...BILOXI, speedMph: 0 }));
  T += 40 * 60000; await st.process('florida-beauty', board({ lat: 30.43, lng: -88.6, speedMph: 55 }));   // left Biloxi
  assert.match(texts[0], /did you deliver the 88 boxes for Flower Link at 316 Bohn St/);
  T += 5 * 60000; reply('Yes delivered all 88'); await st.process('florida-beauty', board({ lat: 30.43, lng: -88.4, speedMph: 60 }));
  const done = replies[replies.length - 1];
  assert.match(done, /✅ Done — Flower Link: 88 boxes delivered at 316 Bohn St, Biloxi, MS 39530 \(trip 624906, truck 2219\)/);
  assert.match(done, /GPS: arrived .*, left .* \(40 min on site\)/);
  assert.match(done, /Driver confirmed by text .*: “Yes delivered all 88”/);
});

test('driver not confirmed yet → Jarvis texts the instruction, calls after 20 min, reports the OK on the chain', async () => {
  T = Date.parse('2026-10-13T13:00:00Z');
  const { st, texts, calls, replies, reply } = setup();
  await st.add({ ...change, driverConfirmed: false, emailId: 'AAMk-2', by: 'Frank Ducassi' });
  await st.process('florida-beauty', board({ lat: 30.0, lng: -85.5, speedMph: 62 }));
  assert.match(texts[0], /change for Flower Link — deliver the 88 boxes for Flower Link to 316 Bohn St, Biloxi/);
  T += 21 * 60000; await st.process('florida-beauty', board({ lat: 30.0, lng: -85.6, speedMph: 62 }));
  assert.deepEqual(calls, ['stop-instruction']);
  T += 2 * 60000; reply('ok'); await st.process('florida-beauty', board({ lat: 30.0, lng: -85.7, speedMph: 62 }));
  assert.match(replies[0], /confirmed the change for Flower Link by text: “ok”/);
});

test('no answer to "did you deliver?" → a call; TruckMate delivered also starts the check', async () => {
  T = Date.parse('2026-10-13T13:00:00Z');
  const { st, texts, calls } = setup();
  await st.add({ ...change, emailId: 'AAMk-3' });
  await st.process('florida-beauty', board({ lat: 30.0, lng: -85.5, speedMph: 62 }, { actualDelivery: '2026-10-13T08:41:00' }));
  assert.match(texts[0], /did you deliver/);
  T += 21 * 60000; await st.process('florida-beauty', board({ lat: 30.0, lng: -85.5, speedMph: 62 }, { actualDelivery: '2026-10-13T08:41:00' }));
  assert.deepEqual(calls, ['stop-verify']);
  const mail = doneEmail({ ...change, tmDeliveredAt: '2026-10-13T08:41:00', answer: { yes: true, how: 'phone call', at: new Date(T).toISOString(), text: 'Driver said yes, all 88 delivered.' } }, { trip: { powerUnit: '2219' } });
  assert.match(mail.text, /TruckMate shows the bills delivered \(2026-10-13 08:41 local\)/);
});

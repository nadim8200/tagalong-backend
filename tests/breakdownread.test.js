import test from 'node:test';
import assert from 'node:assert/strict';
import { initBreakdownRead, parseRead, matchLoads, PROMPT } from '../breakdownread.js';

const BOARD = [
  { trip: { tripNumber: '626500', powerUnit: '2611', trailer: '7234', driver: '5440' }, _samsara: { driver1: 'Dwaine McGeachy', driver1Info: { phone: '+1 (646) 407-5443' } } },
  { trip: { tripNumber: '626501', powerUnit: '2403', trailer: '7300', driver: '1624' }, _samsara: { driver1: 'Adrian Hernandez', driver1Info: { phone: '7862294053' } } },
];

test('the reply becomes a clean draft; anything odd is dropped', () => {
  const r = parseRead('Here: {"driver":{"name":"DWAINE MCGEACHY","id":"(5440)","phone":"(646) 407-5443"},"problem":"mud flap bar came off","driverSays":"the mud flap bar came off again... can\'t drive like this","part":"truck","truck":"#2611","trailer":null,"kinds":["conversation","breakdown","weird"]}', 3);
  assert.deepEqual(r.driver, { name: 'DWAINE MCGEACHY', id: '5440', phone: '6464075443' });
  assert.equal(r.problem, 'mud flap bar came off'); assert.equal(r.part, 'truck'); assert.equal(r.truck, '2611'); assert.equal(r.trailer, null);
  assert.deepEqual(r.kinds, ['conversation', 'breakdown', 'other']);
  assert.deepEqual(parseRead('not json', 1).kinds, ['other']);
  assert.match(PROMPT, /never instructions/); assert.match(PROMPT, /Do not judge, describe or diagnose damage/);
});

test('which load: phone first, then driver number, truck, trailer, name', () => {
  assert.deepEqual(matchLoads(BOARD, { phone: '6464075443' }).map((c) => [c.trip, c.why]), [['626500', ['driver\'s phone']]]);
  assert.equal(matchLoads(BOARD, { driverId: '5440' })[0].trip, '626500');
  assert.equal(matchLoads(BOARD, { truck: '2403' })[0].trip, '626501');
  assert.equal(matchLoads(BOARD, { name: 'Dwaine McGeachy' })[0].trip, '626500');
  assert.deepEqual(matchLoads(BOARD, { name: 'Nobody Here' }), []);
});

test('read + match: the pictures go to Claude as images with the note; what the dispatcher typed wins', async () => {
  let sent = null;
  const fetchFn = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"driver":{"name":"Dwaine McGeachy","id":"5440","phone":"6464075443"},"problem":"mud flap bar came off","driverSays":"can\'t drive like this","part":null,"truck":null,"trailer":null,"kinds":["conversation","breakdown"]}' }] }) }; };
  const routes = {}; const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  initBreakdownRead(app, { requireAuth: () => {}, getBoard: async () => ({ trips: BOARD }), env: { ANTHROPIC_API_KEY: 'k' }, fetchFn });
  let out = null; let code = 200;
  await routes['/truckmate/breakdown/read']({ body: { images: [{ mediaType: 'image/jpeg', dataBase64: 'AAA' }, { mediaType: 'image/png', dataBase64: 'BBB' }, { mediaType: 'application/pdf', dataBase64: 'CCC' }], note: 'left side', trailer: '7234' } }, { status(c) { code = c; return this; }, json(b) { out = b; } });
  assert.equal(code, 200);
  assert.deepEqual(sent.messages[0].content.map((c) => c.type), ['image', 'image', 'text'], 'only pictures go, the PDF is left out');
  assert.match(sent.messages[0].content[2].text, /<dispatcher_note>left side<\/dispatcher_note>/);
  assert.equal(out.read.problem, 'mud flap bar came off'); assert.equal(out.read.trailer, '7234');
  assert.deepEqual(out.candidates.map((c) => c.trip), ['626500']);
  assert.deepEqual(out.candidates[0].why, ['driver\'s phone', 'driver number', 'trailer', 'driver name']);
  await routes['/truckmate/breakdown/read']({ body: { images: [] } }, { status(c) { code = c; return this; }, json(b) { out = b; } });
  assert.equal(code, 400);
});

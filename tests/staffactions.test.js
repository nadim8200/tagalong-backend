import test from 'node:test';
import assert from 'node:assert/strict';
import { findLoad, initStaffActions } from '../staffactions.js';
import { chatTools } from '../jarvischat.js';
import { initBreakdownReport } from '../breakdownreport.js';

const load = { trip: { tripNumber: '626143', powerUnit: '2008', trailer: '2029' }, freightBills: [{ billNumber: 'B1' }] };
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), set: async (k, v) => { s[k] = v; }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };

test('the load comes from a trip or a truck, and it asks when it cannot tell', () => {
  const two = [load, { trip: { tripNumber: '2', powerUnit: '2008' } }];
  assert.equal(findLoad([load], { truck: '#02008' }).trip, '626143');
  assert.equal(findLoad([load], { trip: '626143' }).trip, '626143');
  assert.match(findLoad(two, { truck: '2008' }).error, /2 trips/);
  assert.match(findLoad([load], { truck: '9' }).error, /not on the board/);
  assert.match(findLoad([load], {}).error, /Which truck/);
});

const setup = (files = []) => {
  const sent = []; const extra = [];
  const breakdown = initBreakdownReport(null, { db: mem(), secret: 's', getBoard: async () => ({ trips: [load] }), send: async (r) => sent.push(r), sendPhotos: async (r, i, fresh, by, message) => extra.push({ fresh, by, message }), now: () => 1000 });
  const stops = [];
  const a = initStaffActions({ breakdown, stopReview: { decide: async (x) => { stops.push(x); return { ok: true }; } }, docs: { readDocs: async () => files }, getBoard: async () => ({ trips: [load] }), now: () => 1000 });
  return { a, sent, extra, stops };
};

test('a report sends the email with only the pictures, and a second one goes out as an update', async () => {
  const { a, sent, extra } = setup([{ id: 7, mediaType: 'image/jpeg' }, { id: 8, mediaType: 'application/pdf' }]);
  assert.equal((await a.report({ truck: '2008', problem: ' ', by: 'Sara' })).ok, false);
  const r = await a.report({ truck: '2008', part: 'trailer', problem: 'light came off', driverSays: 'it fell off', by: 'Sara', uploaded: [{ docId: 7, name: 'a.jpg' }, { docId: 8, name: 'b.pdf' }] });
  assert.equal(r.ok, true); assert.match(r.subject, /TRAILER 2029/); assert.match(r.say, /Road service has not been called/);
  assert.equal(sent[0].by, 'Sara'); assert.deepEqual(sent[0].photos, [{ docId: '7', name: 'a.jpg' }]);
  const again = await a.report({ trip: '626143', problem: 'tech is there', driverSays: 'almost done', by: 'Ana' });
  assert.equal(again.updated, true); assert.equal(sent.length, 1);
  assert.equal(extra[0].message, 'tech is there Driver says: almost done'); assert.equal(extra[0].by, 'Ana');
});

test('updates and fixed need an open breakdown, and say so', async () => {
  const { a } = setup();
  assert.equal((await a.update({ truck: '2008', message: 'tech arrived', by: 'Sara' })).ok, false);
  assert.equal((await a.fixed({ truck: '2008', by: 'Sara' })).ok, false);
  await a.report({ truck: '2008', problem: 'flat tire', by: 'Sara' });
  assert.equal((await a.update({ truck: '2008', message: 'tech arrived', by: 'Sara' })).ok, true);
});

test('a stop answer says who and how', async () => {
  const { a, stops } = setup();
  assert.equal((await a.stop({ truck: '4560', authorized: true, reason: 'hotel approved', by: 'Sara', source: 'Text to Jarvis' })).ok, true);
  assert.deepEqual(stops[0], { unit: '4560', trip: null, status: 'authorized', reason: 'hotel approved', by: 'Sara', source: 'Text to Jarvis' });
  await a.stop({ trip: '1', authorized: false, by: 'Sara', source: 'Ask Jarvis' });
  assert.equal(stops[1].status, 'unauthorized');
});

test('customers and email replies never get these tools', () => {
  const names = (o) => chatTools(o).map((t) => t.name);
  const acts = ['report_breakdown', 'breakdown_update', 'breakdown_fixed', 'answer_stop'];
  for (const n of acts) {
    assert.ok(names({ canAct: true }).includes(n), `chat has ${n}`);
    assert.ok(!names({ email: true, canAct: false }).includes(n), `email reply has no ${n}`);
    assert.ok(!names({ customer: true, email: true, canAct: true }).includes(n), `customer has no ${n}`);
  }
});

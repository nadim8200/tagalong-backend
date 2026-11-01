import test from 'node:test';
import assert from 'node:assert/strict';
import { stopText, readStopReply, classifyStopReply, checkFacts, initStopCheck } from '../stopcheck.js';
import { renderTeamStopEmail, teamStopFacts } from '../teamstopmail.js';

const NOW = Date.parse('2026-11-01T16:00:00Z');
const mem = () => { const s = {}; return { get: async (k, d) => (k in s ? s[k] : d), update: async (k, fn, d) => { s[k] = fn(k in s ? s[k] : d); return s[k]; }, s }; };
const alert = { id: 'stopped:2617', unit: '2617', trip: '9', severity: 'warning', title: 'Team truck stopped 1h 10m', stoppedSinceMs: NOW - 70 * 60000 };
const item = { trip: { tripNumber: '9', powerUnit: '2617' }, _samsara: { driver1: 'ANA RUIZ', driver2: 'Luis Vega' } };
function rig({ text = async () => ({ sent: true, to: '305' }), replies = [] } = {}) {
  const updates = []; const chains = []; const texts = []; let t = NOW;
  const c = initStopCheck({ db: mem(), textDriver: async (s, trip, body, by, slot) => { texts.push({ body, slot }); return text(slot); }, getReplies: async () => replies, sendUpdate: async (a, it, f) => updates.push(f), startBreakdown: async (x) => chains.push(x), classify: async (x) => readStopReply(x), now: () => t });
  return { c, updates, chains, texts, tick: (m) => { t += m * 60000; } };
}

test('the text is polite, says how long, and asks once', () => {
  const m = stopText({ name: 'ANA RUIZ', unit: '2617', stoppedMin: 70 });
  assert.match(m, /^Hi Ana, this is Florida Beauty dispatch\./); assert.match(m, /truck 2617 has been stopped for about 1 hour 10 minutes/); assert.match(m, /Thank you\.$/); assert.match(m, /problem with the truck or trailer/);
  assert.match(stopText({ unit: '1' }), /^Hi, /); assert.doesNotMatch(stopText({ unit: '1' }), /for about/);
});
test('replies: reasons and problems, English and Spanish; no invented breakdowns', () => {
  for (const [t, k] of [['fueling', 'fueling'], ['Echando diesel', 'fueling'], ['delivering at customer', 'delivering'], ['descargando', 'delivering'], ['on my 10 hour break', 'rest'], ['at the scale', 'inspection'], ['stuck in traffic', 'traffic'], ['flat tire', 'truck_problem'], ['truck broke down', 'truck_problem'], ['llanta ponchada, necesito grua', 'truck_problem'], ['trailer has a flat', 'trailer_problem'], ['reefer not working', 'trailer_problem'], ['no problem, just fueling', 'fueling'], ['not broken, everything good', 'other'], ['ok', 'other'], ['', 'unclear']]) assert.equal(readStopReply(t).kind, k, t);
});
test('the AI read is used, and anything odd falls back to the quick read', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"kind":"trailer_problem","reason":"air line cut"}' }] }) });
  assert.deepEqual(await classifyStopReply('x', { env: { ANTHROPIC_API_KEY: 'k' }, fetchFn }), { kind: 'trailer_problem', reason: 'air line cut' });
  const junk = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"kind":"launch_missiles"}' }] }) });
  assert.equal((await classifyStopReply('fueling', { env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: junk })).kind, 'fueling');
  assert.equal((await classifyStopReply('fueling', { env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: async () => { throw new Error('down'); } })).kind, 'fueling');
  assert.equal((await classifyStopReply('fueling', { env: {} })).kind, 'fueling');
});
test('texting not live: nothing is sent, nothing is saved, the email says nothing', async () => {
  const r = rig({ text: async () => ({ skipped: 'texting not live yet (RingCentral approval)' }) });
  assert.equal(await r.c.forStop(alert, item), null);
  await r.c.process({ trips: [item] }); assert.equal(r.updates.length, 0);
  assert.equal(r.texts.length, 2, 'it tried, comms said no');
  const fresh = rig(); assert.equal((await fresh.c.forStop(alert, item)).state, 'waiting', 'the next stop after it goes live gets asked');
});
test('both drivers, once per stop; no consent is stated', async () => {
  const r = rig();
  await r.c.forStop(alert, item); await r.c.forStop(alert, item);
  assert.deepEqual(r.texts.map((t) => t.slot), [1, 2]); assert.match(r.texts[0].body, /Hi Ana/); assert.match(r.texts[1].body, /Hi Luis/);
  const n = rig({ text: async () => ({ skipped: 'driver has not agreed to texts' }) });
  const f = await n.c.forStop(alert, item); assert.equal(f.state, 'blocked'); assert.equal(f.why, 'driver has not agreed to texts');
  const one = rig({ text: async (slot) => (slot === 1 ? { sent: true, to: '1' } : { skipped: 'driver has not agreed to texts' }) });
  assert.equal((await one.c.forStop(alert, item)).state, 'waiting', 'one driver reached is enough');
});
test('no reply: the next email says so; no update email goes out', async () => {
  const r = rig(); await r.c.forStop(alert, item); r.tick(50);
  await r.c.process({ trips: [item] }); assert.equal(r.updates.length, 0);
  const f = await r.c.forStop(alert, item); assert.equal(f.state, 'waiting'); assert.equal(f.minutes, 50);
});
test('a reason: one updated email; the next stop email carries it too', async () => {
  const r = rig({ replies: [{ text: 'fueling, 20 minutes', at: new Date(NOW + 60000).toISOString() }] });
  await r.c.forStop(alert, item); await r.c.process({ trips: [item] }); await r.c.process({ trips: [item] });
  assert.equal(r.updates.length, 1); assert.equal(r.updates[0].reason, 'Fueling'); assert.equal(r.chains.length, 0);
  assert.equal((await r.c.forStop(alert, item)).state, 'replied');
});
test('a truck or trailer problem starts the breakdown chain, once, and no update email', async () => {
  const r = rig({ replies: [{ text: 'trailer flat tire', at: new Date(NOW + 60000).toISOString() }] });
  await r.c.forStop(alert, item); await r.c.process({ trips: [item] }); await r.c.process({ trips: [item] });
  assert.equal(r.chains.length, 1); assert.equal(r.updates.length, 0); assert.match(r.chains[0].reason, /^trailer /); assert.equal(r.chains[0].trip, '9'); assert.equal(r.chains[0].by, 'Driver (text)');
});
test('STOP and HELP are not answers, and a very late reply no longer counts', async () => {
  const r = rig({ replies: [{ text: 'STOP', at: new Date(NOW).toISOString() }] });
  await r.c.forStop(alert, item); await r.c.process({ trips: [item] }); assert.equal(r.updates.length, 0);
  const l = rig({ replies: [{ text: 'fueling', at: new Date(NOW).toISOString() }] });
  await l.c.forStop(alert, item); l.tick(9 * 60); await l.c.process({ trips: [item] }); assert.equal(l.updates.length, 0);
});
test('the stop email: same as today with nothing to say; states reply, no reply, or why not texted', () => {
  const render = (driverCheck) => renderTeamStopEmail(teamStopFacts(alert, item, { now: NOW, driverCheck }));
  const plain = render(null);
  assert.doesNotMatch(plain.html + plain.text, /Driver check/i); assert.match(plain.text, /Stop reason has not been confirmed\./);
  const wait = render(checkFacts({ sentTo: ['1'], askedAt: NOW - 50 * 60000 }, NOW));
  assert.match(wait.text, /No reply from the drivers yet/); assert.match(wait.text, /50m ago/);
  const done = render(checkFacts({ sentTo: ['1'], askedAt: NOW, reply: { kind: 'fueling', text: '<b>fueling</b>', atMs: NOW } }, NOW));
  assert.match(done.text, /Driver replied: Fueling/); assert.match(done.text, /not verified/); assert.match(done.text, /Reason from the driver: Fueling\./); assert.match(done.html, /&lt;b&gt;fueling/);
  assert.match(render(checkFacts({ sentTo: [], blocked: 'driver has not agreed to texts' }, NOW)).text, /Drivers not texted\ndriver has not agreed to texts/);
  assert.equal(checkFacts(null), null);
});

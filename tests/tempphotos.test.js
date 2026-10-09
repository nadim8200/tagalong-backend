import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTempPhotos, truckZone, currentSlot, decide, askText, photoEmail, initTempPhotos } from '../tempphotos.js';
import { outreachEmail } from '../outreach.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const ET = (s) => Date.parse(`${s}-04:00`);   // Oct 2026 = EDT

test('only rolling loads whose reefer temp we cannot read live', () => {
  assert.equal(needsTempPhotos({ trip: { status: 'DEPSHIP' }, _samsara: { tempF: 34 } }), false);
  assert.equal(needsTempPhotos({ trip: { status: 'DEPSHIP' }, _samsara: { tempF: 34, tempStale: true } }), true);
  assert.equal(needsTempPhotos({ trip: { status: 'DEPSHIP' }, _oc: {} }), true);
  assert.equal(needsTempPhotos({ trip: { status: 'DISP' } }), false, 'not loaded yet');
});

test('photo windows: 8 AM, 3 PM, 9:30 PM in the truck local time', () => {
  assert.equal(truckZone({ _samsara: { location: 'I-10, Tucson, AZ' } }), 'America/Phoenix');
  assert.equal(truckZone({ _samsara: { location: 'US 9, Sayreville, NJ' } }), 'America/New_York');
  assert.equal(truckZone({}), 'America/New_York');
  assert.equal(currentSlot(ET('2026-10-09T07:59:00'), 'America/New_York').key, '2026-10-08 night');
  assert.equal(currentSlot(ET('2026-10-09T08:00:00'), 'America/New_York').key, '2026-10-09 am');
  assert.equal(currentSlot(ET('2026-10-09T16:10:00'), 'America/New_York').key, '2026-10-09 pm');
  assert.equal(currentSlot(ET('2026-10-09T21:30:00'), 'America/New_York').key, '2026-10-09 night');
  // 9:00 AM ET is 6:00 AM in California → still last night's window there
  assert.equal(currentSlot(ET('2026-10-09T09:00:00'), 'America/Los_Angeles').key, '2026-10-08 night');
});

test('ask once per window, then a reminder every hour until the photo comes (paused while sleeping)', () => {
  const slot = currentSlot(ET('2026-10-09T08:05:00'), 'America/New_York');
  assert.equal(decide(null, slot, ET('2026-10-09T08:05:00')), 'ask');
  const st = { slot: slot.key, askedAt: new Date(ET('2026-10-09T08:05:00')).toISOString(), lastAt: new Date(ET('2026-10-09T08:05:00')).toISOString() };
  assert.equal(decide(st, slot, ET('2026-10-09T08:50:00')), null);
  assert.equal(decide(st, slot, ET('2026-10-09T09:05:00')), 'remind');
  assert.equal(decide(st, slot, ET('2026-10-09T09:05:00'), { sleeping: true }), null);
  assert.equal(decide({ ...st, gotAt: 'x' }, slot, ET('2026-10-09T10:00:00')), null);
  assert.match(askText('ask', { name: 'Frankie Patterson', trip: '624626', slot, link: 'https://x/l?photo=temp' }), /Hi Frankie.*photo of the reefer temperature display \(morning check, 8:00 AM\)\. Send it here: https:\/\/x\/l\?photo=temp/);
});

test('loop: app driver asked at 8 AM, reminded hourly, photo → email to dispatch only (no broker)', async () => {
  const db = memDb();
  await db.set('taFollowCfg', { to: ['dispatch@floridabeauty.us', 'ops@broker.com'] });
  const item = { trip: { tripNumber: '624626', status: 'DEPSHIP', powerUnit: '2403', trailer: 'R55' }, _oc: { driverName: 'Frankie' } };
  const sent = []; const mails = [];
  let clock = ET('2026-10-09T08:02:00');
  const t = initTempPhotos({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [item] }), driverLinks: { messageDriver: async (site, trip, text) => { sent.push(text); return { sent: true, via: 'app' }; } }, docs: { markDocs: async () => {}, readDocs: async () => [{ mediaType: 'image/jpeg', data: 'AA==' }] }, isInternal: (a) => a.endsWith('@floridabeauty.us'), env: { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' }, fetchFn: async (url, o) => { if (/token/.test(url)) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) }; mails.push(JSON.parse(o.body)); return { ok: true, status: 202, json: async () => ({}), text: async () => '' }; }, now: () => clock });
  await t.run(); assert.equal(sent.length, 1);
  clock = ET('2026-10-09T08:40:00'); await t.run(); assert.equal(sent.length, 1);
  clock = ET('2026-10-09T09:03:00'); await t.run(); assert.equal(sent.length, 2); assert.match(sent[1], /Reminder/);
  assert.deepEqual(await t.received('florida-beauty', '624626', { docIds: [] }), { counted: false });
  const r = await t.received('florida-beauty', '624626', { docIds: [7], via: 'TagAlong app', by: 'Frankie (app)' });
  assert.equal(r.counted, true);
  assert.equal(mails.length, 1);
  const to = mails[0].message.toRecipients.map((x) => x.emailAddress.address);
  assert.deepEqual(to, ['dispatch@floridabeauty.us']);
  assert.match(mails[0].message.subject, /Reefer temp photo — Trip 624626 · truck 2403 · trailer R55 · morning check/);
  assert.equal(mails[0].message.attachments.length, 1);
  clock = ET('2026-10-09T10:05:00'); await t.run(); assert.equal(sent.length, 2, 'no reminders once received');
  clock = ET('2026-10-09T15:01:00'); await t.run(); assert.equal(sent.length, 3, 'asks again at 3 PM');
});

test('a photo in the app chat with no open check is not counted', async () => {
  const db = memDb();
  const t = initTempPhotos({ get: () => {}, put: () => {} }, { requireAuth: () => {}, db, getBoard: async () => ({ trips: [] }), env: { NODE_ENV: 'test' } });
  assert.deepEqual(await t.received('florida-beauty', '1', { docIds: [1] }), { counted: false });
});

test('the driver-contact email says who, how and what was asked', () => {
  const m = outreachEmail({ trip: '624626', channel: 'text', to: '+13055551234', text: 'Florida Beauty Flora dispatch: Hi Frankie, this is Jarvis (automated). Load 624626: please send a photo of the reefer temperature display. Reply STOP to opt out.', by: 'Jarvis (reefer temp photos)' }, { trip: { powerUnit: '2403' }, _oc: { driverName: 'Frankie P' } }, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(m.subject, 'Jarvis → Frankie P · Trip 624626 · Text');
  assert.match(m.text, /What was asked: Load 624626: please send a photo of the reefer temperature display\./);
  assert.match(m.text, /Driver: Frankie P · \(305\) 555-1234/);
  assert.doesNotMatch(m.text, /Reply STOP/);
});

test('photo email carries the load facts', () => {
  const e = photoEmail({ item: { trip: { tripNumber: '1', powerUnit: '9', trailer: 'T' } }, slot: { label: 'night', hm: '21:30' }, at: '2026-10-09T01:40:00Z', by: 'D', count: 2, via: 'upload link' });
  assert.match(e.text, /Check: night \(9:30 PM local\)/);
  assert.match(e.text, /Photos: 2 attached/);
});

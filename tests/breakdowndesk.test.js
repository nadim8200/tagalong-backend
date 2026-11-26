import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initRoadCalls, deskOf, nextAction, updateEmail } from '../roadcall.js';

const kvDb = () => { const kv = new Map(); return { kv, enabled: true, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); }, update: async (k, fn, d) => { const v = fn(kv.has(k) ? kv.get(k) : d); kv.set(k, v); return v; } }; };
const setup = ({ fail = 0, to = ['inbound@floridabeauty.us', 'customerservice@floridabeauty.us'] } = {}) => {
  const db = kvDb(); const sent = []; let failsLeft = fail;
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; }, put() {} };
  const rcs = initRoadCalls(app, { requireAuth: (q, r, n) => n(), db, getBoard: async () => ({ trips: [] }), sendMail: null, recipients: async () => to,
    sendThread: async (m) => { if (failsLeft > 0) { failsLeft -= 1; throw new Error('Outlook 503'); } sent.push(m); return { ok: true }; } });
  const call = async (k, req) => { let out = null; let code = 200; await routes[k]({ params: {}, body: {}, user: { name: 'Nadim Tellez' }, ...req }, { status(c) { code = c; return this; }, json(b) { out = b; return this; } }); return { code, out }; };
  return { db, sent, rcs, call };
};

test('desk status comes from the road call lifecycle; unconfirmed stays visible; the dispatcher\'s pre-approval status is kept beside it', () => {
  assert.deepEqual(deskOf({ status: 'gathering', source: 'dispatch' }), { desk: 'Needs attention', label: 'Needs attention', unconfirmed: true });
  assert.equal(deskOf({ status: 'gathering', type: 'tire', check: { texted: true } }).desk, 'Waiting on driver');
  assert.equal(deskOf({ status: 'approved', deskStatus: 'Waiting on driver' }).desk, 'Finding service', 'a lifecycle status after approval always wins');
  assert.deepEqual(deskOf({ status: 'accepted' }), { desk: 'Service en route', label: 'Service accepted', unconfirmed: false });
  assert.equal(deskOf({ status: 'on site' }).desk, 'Repairing'); assert.equal(deskOf({ status: 'cancelled' }).label, 'Cancelled');
  assert.match(nextAction({ status: 'gathering', type: 'tire', location: { text: 'I-75' }, safe: true }), /^Get from the driver: which tire .* \+ tire size/);
});

test('internal note: saved, nobody emailed; author is the login, not the page', async () => {
  const { rcs, call, sent } = setup();
  const rc = await rcs.open({ trip: '627545', truck: '2220', source: 'console', by: 'Nadim Tellez', type: 'tire', details: 'flat', quiet: true });
  const r = await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'c1', text: 'Called the driver', email: false, status: 'Waiting on driver', by: 'Someone Else' } });
  assert.equal(r.code, 200); assert.equal(sent.length, 0);
  const n = r.out.notes.find((x) => x.clientId === 'c1');
  assert.deepEqual([n.by, n.kind, n.mail], ['Nadim Tellez', 'internal', null]);
  assert.equal(r.out.desk.desk, 'Waiting on driver'); assert.equal(r.out.owner.name, 'Nadim Tellez');
});

test('preview shows the exact recipients, subject and body; save & email sends once in the case\'s thread; a failure keeps the note and a retry sends it once', async () => {
  const { rcs, call, sent } = setup({ fail: 1 });
  const rc = await rcs.open({ trip: '627545', truck: '2220', source: 'console', by: 'x', type: 'tire', details: 'flat', location: { text: 'I-75 N, Ocala' }, quiet: true });
  const p = await call('POST /truckmate/roadcalls/:id/preview', { params: { id: rc.id }, body: { text: 'Vendor confirmed <b>ETA</b> 2:45', status: 'Service en route', followUp: '2026-11-26T19:45:00Z' } });
  assert.deepEqual(p.out.to, ['inbound@floridabeauty.us', 'customerservice@floridabeauty.us']);
  assert.equal(p.out.subject, `Breakdown ${rc.id} · Truck 2220 · trip 627545`);
  assert.equal(p.out.headline, `Breakdown update | Truck 2220 | ${rc.id} | Service en route`);
  assert.match(p.out.html, /Vendor confirmed &lt;b&gt;ETA&lt;\/b&gt; 2:45/); assert.match(p.out.html, /Update from Nadim Tellez/); assert.match(p.out.html, /Sent via Jarvis · Florida Beauty/);
  assert.match(p.out.html, /Thu, Nov 26, 2:45 PM ET/);
  const body = { clientId: 'c2', text: 'Vendor confirmed, ETA 2:45', email: true, status: 'Service en route', followUp: '2026-11-26T19:45:00Z' };
  const r1 = await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body });
  const n1 = r1.out.notes.find((n) => n.clientId === 'c2');
  assert.ok(r1.out.notes.some((n) => n.kind === 'status' && /Needs attention → Service en route/.test(n.text)), 'the status change is on the case');
  assert.equal(n1.mail.state, 'failed'); assert.equal(sent.length, 0); assert.equal(r1.out.status, 'tech en route');
  const r2 = await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body });   // the same clientId: a retry
  assert.equal(r2.out.notes.filter((n) => n.clientId === 'c2').length, 1, 'never a second note');
  assert.equal(sent.length, 1); assert.equal(r2.out.notes.find((n) => n.clientId === 'c2').mail.state, 'sent');
  await call('POST /truckmate/roadcalls/:id/notes/:noteId/retry', { params: { id: rc.id, noteId: n1.id } });
  assert.equal(sent.length, 1, 'already sent → not again');
  assert.equal(sent[0].headers['Message-ID'], `<breakdown-${rc.id.toLowerCase()}@floridabeauty.us>`);
  assert.deepEqual(r2.out.followUp.at, '2026-11-26T19:45:00.000Z');
});

test('Resolved from the desk completes the road call the same way the console does', async () => {
  const { rcs, call } = setup();
  const rc = await rcs.open({ trip: '1', truck: '9', source: 'console', by: 'x', type: 'tire', details: 'flat', quiet: true });
  const r = await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'c3', text: 'Fixed, rolling', status: 'Resolved' } });
  assert.equal(r.out.status, 'completed'); assert.equal(r.out.desk.desk, 'Resolved');
  assert.equal((await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'c4', text: 'x', status: 'Made up' } })).code, 400);
  assert.equal(updateEmail({ id: 'RC-1', truck: '9' }, { author: 'A', text: 'hi', status: 'Resolved' }).subject, 'Breakdown RC-1 · Truck 9');
});

test('every status change (Nov 26): on the case, to the driver (note hook), one email in the case\'s thread — never two for one step', async () => {
  const { rcs, call, sent } = setup();
  const { onRoadCallNote } = await import('../roadcall.js');
  const seen = []; let mine = null; onRoadCallNote((r, n) => { if (r && r.id === mine && n.kind === 'status') seen.push(n.text); });
  const rc = await rcs.open({ trip: '7', truck: '70', source: 'console', by: 'x', type: 'tire', details: 'flat', location: { text: 'I-95' }, safe: true, quiet: true });
  mine = rc.id;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  // an internal note that changes the status → the status email on its own (the note's words stay internal)
  await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'k1', text: 'secret internal words', status: 'Waiting on driver' } });
  await tick();
  assert.equal(sent.length, 1); assert.match(sent[0].html, /Status changed: Waiting on driver/); assert.doesNotMatch(sent[0].html, /secret internal words/);
  assert.deepEqual(seen, ['Status changed: Needs attention → Waiting on driver']);
  // an emailed update with a status change → ONE email that carries both
  await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'k2', text: 'Vendor on the way', email: true, status: 'Service en route' } });
  await tick();
  assert.equal(sent.length, 2); assert.match(sent[1].html, /Vendor on the way/); assert.equal(sent[1].subject, `RE: Breakdown ${rc.id} · Truck 70 · trip 7`);
  // the console's Mark completed (a lifecycle change) → its own completed email carries the status, no second one
  await call('POST /truckmate/roadcalls/:id', { params: { id: rc.id }, body: { status: 'completed' } });
  await tick();
  assert.equal(sent.length, 3, 'one email for completing it'); assert.match(sent[2].html, /Status: Service en route → <b>Resolved<\/b>/);
  assert.deepEqual(seen.slice(-2), ['Status changed: Waiting on driver → Service en route', 'Status changed: Service en route → Resolved']);
  const notes = (await rcs.list()).find((x) => x.id === rc.id).notes.filter((n) => n.kind === 'status');
  assert.equal(notes.length, 3);
});

test('pictures on an update (Nov 26): stored with the load\'s documents, on the case with a signed link, attached to the email; the vendor: saved, emailed once', async () => {
  const { initRoadCalls } = await import('../roadcall.js');
  const kv = new Map(); const db = { enabled: true, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); }, update: async (k, fn, d) => { const v = fn(kv.has(k) ? kv.get(k) : d); kv.set(k, v); return v; } };
  const stored = []; const docs = { storeDocs: async ({ files, kind }) => files.map((f, i) => { stored.push({ kind, ...f }); return { id: 100 + stored.length + i }; }), readDocs: async ({ ids }) => ids.map((id) => ({ id: String(id), mediaType: 'image/jpeg', data: Buffer.from('jpegbytes') })) };
  const sent = []; const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; }, put() {} };
  const rcs = initRoadCalls(app, { requireAuth: (q, r, n) => n(), db, docs, getBoard: async () => ({ trips: [] }), recipients: async () => ['inbound@floridabeauty.us'], env: { JWT_SECRET: 'k' }, sendThread: async (m) => { sent.push(m); return { ok: true }; } });
  const call = async (k, req) => { let out = null; let code = 200; await routes[k]({ params: {}, body: {}, user: { name: 'Mary Lopez' }, ...req }, { status(c) { code = c; return this; }, json(b) { out = b; return this; } }); return { code, out }; };
  const rc = await rcs.open({ trip: '627912', truck: '2611', source: 'console', by: 'x', type: 'tire', details: 'flat', location: { text: 'I-95' }, safe: false, quiet: true });
  const r = await call('POST /truckmate/roadcalls/:id/update', { params: { id: rc.id }, body: { clientId: 'p1', text: 'New tire on', email: true, photos: [{ filename: 'tire.jpg', mediaType: 'image/jpeg', dataBase64: Buffer.from('x').toString('base64') }, { filename: 'bad.exe', mediaType: 'application/x-msdownload', dataBase64: 'AA' }] } });
  assert.equal(stored.length, 1, 'only pictures are kept'); assert.equal(stored[0].kind, 'message');
  const n = r.out.notes.find((x) => x.clientId === 'p1');
  assert.equal(n.photos.length, 1); assert.match(n.photos[0].url, /^https:\/\/tagalong-backend-fdzx\.onrender\.com\/roadcall\/f\//);
  assert.equal(sent[0].attachments.length, 1); assert.equal(sent[0].headers['Message-ID'], `<breakdown-${rc.id.toLowerCase()}@floridabeauty.us>`);
  // the signed link opens the picture with no login
  let body = null; let type = null; const token = n.photos[0].url.split('/roadcall/f/')[1];
  await routes['GET /roadcall/f/:token']({ params: { token } }, { setHeader(k, v) { if (k === 'Content-Type') type = v; }, end(b) { body = b; }, status() { return this; }, send() {} });
  assert.equal(type, 'image/jpeg'); assert.equal(String(body), 'jpegbytes');
  // the vendor
  assert.equal((await call('POST /truckmate/roadcalls/:id/vendor', { params: { id: rc.id }, body: { name: 'TC Tire', phone: '772-555' } })).code, 400);
  const v = await call('POST /truckmate/roadcalls/:id/vendor', { params: { id: rc.id }, body: { name: 'TC Tire', phone: '(772) 555-0188', email: 'Dispatch@TCTire.example' } });
  assert.deepEqual([v.out.vendor.name, v.out.vendor.phone, v.out.vendor.email, v.out.vendor.by], ['TC Tire', '7725550188', 'dispatch@tctire.example', 'Mary Lopez']);
  const e1 = await call('POST /truckmate/roadcalls/:id/vendor/email', { params: { id: rc.id }, body: { text: 'ETA <please>?', clientId: 'e1' } });
  await call('POST /truckmate/roadcalls/:id/vendor/email', { params: { id: rc.id }, body: { text: 'ETA <please>?', clientId: 'e1' } });
  const toVendor = sent.filter((m) => m.to[0] === 'dispatch@tctire.example');
  assert.equal(toVendor.length, 1, 'once'); assert.match(toVendor[0].html, /ETA &lt;please&gt;\?/); assert.match(toVendor[0].html, /Mary Lopez · Florida Beauty dispatch/);
  assert.ok(e1.out.notes.some((x) => x.kind === 'vendor' && x.mail && x.mail.state === 'sent'));
});

test('driver steps (Nov 26): tech arrived → Repairing, one email with the status in it; tech left → dispatch confirms; pictures from the driver; a retry is once', async () => {
  const { initRoadCalls } = await import('../roadcall.js');
  const kv = new Map(); const db = { enabled: true, get: async (k, d) => (kv.has(k) ? kv.get(k) : d), set: async (k, v) => { kv.set(k, v); }, update: async (k, fn, d) => { const v = fn(kv.has(k) ? kv.get(k) : d); kv.set(k, v); return v; } };
  const docs = { storeDocs: async ({ files }) => files.map((f, i) => ({ id: 500 + i })), readDocs: async ({ ids }) => ids.map((id) => ({ id, mediaType: 'image/jpeg', data: Buffer.from('j') })) };
  const sent = [];
  const rcs = initRoadCalls(null, { db, docs, getBoard: async () => ({ trips: [] }), recipients: async () => ['inbound@floridabeauty.us'], sendThread: async (m) => { sent.push(m); return { ok: true }; } });
  const rc = await rcs.open({ trip: '8', truck: '80', source: 'app', by: 'driver', type: 'tire', details: 'flat', location: { text: 'I-75' }, safe: false, quiet: true });
  await rcs.update(rc.id, { status: 'tech en route' }, 'Mary'); await new Promise((r) => setTimeout(r, 5));
  const before = sent.length;
  const a = await rcs.addNote(rc.id, '', { by: 'Juan Avila', who: 'driver', step: 'arrived', clientId: 'd1' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(a.rc.status, 'on site'); assert.equal(a.note.text, 'Tech arrived');
  assert.equal(sent.length, before + 1, 'one email'); assert.match(sent[sent.length - 1].html, /Status: Service en route → <b>Repairing<\/b>/); assert.match(sent[sent.length - 1].html, /Update from the driver, Juan Avila/);
  assert.equal((await rcs.addNote(rc.id, '', { by: 'Juan Avila', who: 'driver', step: 'arrived', clientId: 'd1' })).rc.notes.filter((n) => n.clientId === 'd1').length, 1);
  const p = await rcs.addNote(rc.id, 'All done, new tire on', { by: 'Juan Avila', who: 'driver', step: 'left', photos: [{ filename: 't.jpg', mediaType: 'image/jpeg', dataBase64: 'AA==' }], clientId: 'd2' });
  assert.equal(p.note.text, 'Tech left: All done, new tire on'); assert.equal(p.note.photos.length, 1);
  assert.equal(sent[sent.length - 1].attachments.length, 1);
  const { nextAction } = await import('../roadcall.js');
  assert.match(nextAction(p.rc), /driver says the tech left — confirm it is fixed/);
});

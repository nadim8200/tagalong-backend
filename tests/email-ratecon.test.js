import test from 'node:test';
import assert from 'node:assert/strict';
import { initInbox } from '../inbox.js';
import { evaluateBoard } from '../watchtower.js';

function memDb() {
  const m = new Map();
  return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => { m.set(k, v); }, update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } };
}

test('a forwarded rate con email: rate con read + filed on its load, the email\'s asks become to-dos, urgent ones alert', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'x' };
  const fetchFn = async (url, opts = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('/attachments')) return ok({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'RedLab_RateCon.pdf', contentType: 'application/pdf', size: 10, contentBytes: Buffer.from('%PDF-1').toString('base64') }] });
    if (url.includes('/mailFolders/inbox/messages')) return ok({ value: [{ id: 'msg-1234567890', subject: 'FW: Red Lab load 131963433 rate con — B180354', from: { emailAddress: { name: 'Ana (dispatch)', address: 'ana@floridabeauty.us' } }, receivedDateTime: '2026-10-07T01:00:00Z', body: { contentType: 'text', content: 'Receiver moved the appt to 10/8 6:00 AM. Driver must accept the MacroPoint invite before pickup. Send POD within 24h.' }, conversationId: 'c1', hasAttachments: true }] });
    if (url.includes('api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      assert.ok(body.messages[0].content.some((c) => c.type === 'document'), 'the PDF goes to the reader');
      return ok({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Red Lab rate con with an appointment change.', attachments: [{ index: 1, type: 'rate_confirmation' }], refs: { bill: 'B180354', loadNumber: '131963433' }, actions: [
        { kind: 'appointment_change', title: 'Move delivery appointment to Oct 8, 6:00 AM', detail: 'Receiver moved the appt to 10/8 6:00 AM', urgency: 'urgent', due: null },
        { kind: 'tracking_required', title: 'Driver must accept the MacroPoint invite', detail: 'before pickup', urgency: 'urgent', due: 'before pickup' },
        { kind: 'documents_requested', title: 'Send the signed POD', detail: 'within 24h', urgency: 'normal', due: 'within 24h' },
      ] }) }] });
    }
    return ok({});
  };
  const filed = [];
  const rateCons = async (site, pages, opts) => { filed.push({ pages: pages.length, opts }); return { trip: '624335', matchedBy: 'bill B180354', record: { broker: 'Red Lab' } }; };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, put: () => {} };
  const db = memDb();
  const docs = { enabled: true, storeDocs: async () => [{ id: 77 }], linkDocs: async () => {} };
  const board = [{ trip: { tripNumber: '624335', powerUnit: '2212', status: 'ARRCONS' }, freightBills: [{ billNumber: 'B180354' }] }];
  const inbox = initInbox(app, { requireAuth: (q, r, n) => n(), db, docs, comms: { log: async () => {} }, rateCons, env, fetchFn, getBoard: async () => ({ trips: board }) });
  assert.equal(await inbox.poll(), 1);
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0].opts.labels, ['B180354']); assert.deepEqual(filed[0].opts.docIds, [77]); assert.equal(filed[0].opts.source, 'email');
  let out; const res = { json: (j) => { out = j; }, status() { return this; } };
  await routes['GET /truckmate/emails']({ query: { trip: '624335' } }, res);
  assert.equal(out[0].summary, 'Red Lab rate con with an appointment change.');
  assert.equal(out[0].rateCons[0].trip, '624335');
  assert.ok(!JSON.stringify(out).includes('contentBytes') && !JSON.stringify(out).includes('"bytes"'), 'no file bytes in the list');
  await routes['GET /truckmate/tasks/:trip']({ params: { trip: '624335' }, query: {} }, res);
  assert.deepEqual(out.map((t) => [t.kind, t.urgency]), [['appointment_change', 'urgent'], ['tracking_required', 'urgent'], ['documents_requested', 'normal']]);
  // urgent to-dos raise a Priority alert until someone checks them off
  const items = [{ ...board[0] }]; await inbox.overlay('florida-beauty', items);
  const ctx = { now: Date.parse('2026-10-07T02:00:00Z'), geo: () => null, unitState: () => ({}) };
  const alert = evaluateBoard({ trips: items }, ctx).find((a) => a.code === 'email-todo');
  assert.equal(alert.severity, 'critical'); assert.match(alert.title, /^📧 Move delivery appointment to Oct 8, 6:00 AM \(\+1 more\)/);
  await routes['POST /truckmate/tasks/:trip/:id']({ params: { trip: '624335', id: out[0].id }, body: { own: true }, query: {}, user: { name: 'Ana' } }, res);
  assert.equal(out[0].owner.by, 'Ana', 'I am on it keeps the to-do open and names who has it'); assert.ok(!out[0].done);
  await routes['POST /truckmate/tasks/:trip/:id']({ params: { trip: '624335', id: out[0].id }, body: { done: true }, query: {}, user: { name: 'Ana' } }, res);
  assert.equal(out[0].done.by, 'Ana');
});

test('Gus sends a rate con to the team: Jarvis reads it as a next load and says nothing', async () => {
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'x' };
  const sent = [];
  const fetchFn = async (url, opts = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('/attachments')) return ok({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'rate_confirmation.pdf', contentType: 'application/pdf', size: 10, contentBytes: Buffer.from('%PDF-1').toString('base64') }] });
    if (url.includes('/mailFolders/inbox/messages')) return ok({ value: [{ id: 'gus-1', subject: 'TRINITY LOAD 9953899 NC TO FL TR 2207 TL 3010', from: { emailAddress: { name: 'Gustavo Duarte', address: 'gus@floridabeauty.us' } }, toRecipients: [{ emailAddress: { address: 'dispatch@floridabeauty.us' } }], receivedDateTime: '2026-11-02T19:49:00Z', body: { contentType: 'text', content: 'Please follow up and add the broker on the tracking link' }, conversationId: 'c1', hasAttachments: true }] });
    if (url.includes('api.anthropic.com')) return ok({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Trinity rate con.', attachments: [{ index: 1, type: 'rate_confirmation' }], refs: {}, reply: { needed: true, kind: 'question', documents: [] }, instructions: [{ kind: 'email_group', group: 'Dispatch', message: 'Add your tracking team' }], actions: [{ kind: 'other', title: 'Add the broker', urgency: 'normal' }] }) }] });
    if (url.includes('sendMail') || url.includes('/createReply') || url.includes('/reply')) sent.push(url);
    return ok({});
  };
  const filed = []; const considered = []; const learned = [];
  const db = memDb();
  const inbox = initInbox({ get: () => {}, post: () => {}, put: () => {} }, { requireAuth: (q, r, n) => n(), db, docs: { enabled: true, storeDocs: async () => [{ id: 7 }], linkDocs: async () => {} }, comms: { log: async () => {} }, rateCons: async (site, pages, opts) => { filed.push(opts); return { trip: null, pendingId: 'p1', matchedBy: null, record: { broker: 'Trinity' } }; }, nextLoads: { consider: async (site, entries) => { considered.push(entries); return [{ id: 'n1', truck: '2207', rc: { loadNumber: '9953899', broker: 'Trinity' } }]; } }, dispatchLog: { learn: async (site, e) => { learned.push(e.subject); return { notes: 0 }; } }, env, fetchFn, getBoard: async () => ({ trips: [] }) });
  await inbox.poll();
  assert.equal(filed.length, 1, 'the rate con is read'); assert.equal(filed[0].exact, true, 'exact matching, it is a fresh load');
  assert.deepEqual(considered[0], [{ trip: null, pendingId: 'p1' }], 'and shown as a next load');
  assert.deepEqual(sent, [], 'no reply, no question');
  const e = (await db.get('taEmails:florida-beauty')).list[0];
  assert.equal(e.status, 'handled'); assert.deepEqual(e.instructions, []); assert.deepEqual(e.actions, []);
  assert.deepEqual(learned, [e.subject], 'still in the loop');
  assert.deepEqual((await db.get('taLoadTasks:florida-beauty', {})) || {}, {}, 'no to-dos');
});

test('one PDF of several pages from Gus is read as a batch, never as one rate con', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create(); doc.addPage(); doc.addPage();
  const b64 = Buffer.from(await doc.save()).toString('base64');
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'x' };
  const fetchFn = async (url) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('/attachments')) return ok({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: '4107_001.pdf', contentType: 'application/pdf', size: 10, contentBytes: b64 }] });
    if (url.includes('/mailFolders/inbox/messages')) return ok({ value: [{ id: 'gus-2', subject: 'last batch', from: { emailAddress: { name: 'Gustavo Duarte', address: 'gus@floridabeauty.us' } }, toRecipients: [{ emailAddress: { address: 'jarvis@floridabeauty.us' } }], receivedDateTime: '2026-11-02T23:39:00Z', body: { contentType: 'text', content: 'batch' }, conversationId: 'c2', hasAttachments: true }] });
    if (url.includes('api.anthropic.com')) return ok({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Rate cons.', attachments: [{ index: 1, type: 'rate_confirmation' }], refs: { bill: 'B180764' } }) }] });
    return ok({});
  };
  const single = []; const batch = [];
  const inbox = initInbox({ get: () => {}, post: () => {}, put: () => {} }, { requireAuth: (q, r, n) => n(), db: memDb(), docs: { enabled: true, storeDocs: async () => [{ id: 7 }], linkDocs: async () => {} }, comms: { log: async () => {} }, rateCons: async (...a) => { single.push(a); return null; }, packets: async (site, files, opts) => { batch.push(opts); return { trips: [], rateCons: [] }; }, env, fetchFn, getBoard: async () => ({ trips: [] }) });
  await inbox.poll();
  assert.equal(single.length, 0, 'not read as one'); assert.equal(batch.length, 1); assert.equal(batch[0].exact, true);
});

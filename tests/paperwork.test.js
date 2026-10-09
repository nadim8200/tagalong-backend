import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docKind, onFile, podText, initPaperwork } from '../paperwork.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
function mail() { const sent = []; const fetchFn = async (url, o) => { if (/oauth2/.test(url)) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) }; sent.push(o.body); return { ok: true, status: 202, json: async () => ({}) }; }; return { sent, fetchFn }; }
const decode = (b) => { try { return JSON.parse(b).message; } catch { const t = Buffer.from(b, 'base64').toString('utf8'); return { mime: t }; } };

test('which documents are on the load', () => {
  assert.equal(docKind({ docType: 'proof_of_delivery' }), 'pod');
  assert.equal(docKind({ docType: 'bill_of_lading' }), 'bol');
  assert.equal(docKind({ kind: 'ratecon' }), 'rate_confirmation');
  assert.deepEqual(onFile([{ id: '1', docType: 'proof_of_delivery', uploadedAt: '2026-10-09' }, { id: '2', kind: 'ratecon' }, { id: '3', docType: 'driver_id', restricted: true }]), { pod: ['1'], bol: [], rate_confirmation: ['2'] });
  assert.match(podText({ name: 'Frankie P', trip: '624318', link: 'https://x/t/1' }), /Hi Frankie.*load 624318: please send photos of the signed POD and BOL\. Upload them here: https:\/\/x\/t\/1/);
});

test('delivered → driver texted for POD/BOL; when they arrive → broker email, Billing cc, POD + BOL + rate con attached', async () => {
  const db = memDb(); const { sent, fetchFn } = mail();
  const docsOn = [];
  const docs = { listDocs: async () => docsOn, readDocs: async ({ ids }) => ids.map(() => ({ mediaType: 'application/pdf', data: 'JVBE' })) };
  const texts = [];
  const item = { trip: { tripNumber: '624318', status: 'DELVD' }, _ratecon: { data: { loadNumber: '8192162', brokerEmail: 'ana@rosebrokers.com', contacts: [{ role: 'tracking', email: 'tracking@rosebrokers.com' }] } } };
  let clock = Date.parse('2026-10-09T15:00:00Z');
  await db.set('taPaperwork:florida-beauty:adopted', 'x');
  const p = initPaperwork({}, { db, getBoard: async () => ({ trips: [item] }), docs, textDriver: async (s, t, text) => { texts.push(text); return { sent: true }; }, groupEmail: async (n) => (n === 'billing' ? 'billing@floridabeauty.us' : n === 'dispatch' ? 'dispatches@floridabeauty.us' : null), env, fetchFn, now: () => clock });
  await p.run();
  assert.equal(texts.length, 1);
  clock += 60 * 60000; await p.run();
  assert.equal(texts.length, 1, 'reminder only after 3 h');
  clock += 3 * 3600000; await p.run();
  assert.equal(texts.length, 2);
  docsOn.push({ id: '10', docType: 'proof_of_delivery', uploadedAt: '2026-10-09T20:00:00Z' }, { id: '11', docType: 'bill_of_lading' }, { id: '12', kind: 'ratecon' });
  clock += 10 * 60000; await p.run();
  assert.equal(sent.length, 1);
  const m = decode(sent[0]);
  assert.deepEqual(m.toRecipients.map((r) => r.emailAddress.address), ['ana@rosebrokers.com']);
  assert.deepEqual(m.ccRecipients.map((r) => r.emailAddress.address), ['tracking@rosebrokers.com', 'billing@floridabeauty.us']);
  assert.deepEqual(m.attachments.map((a) => a.name), ['POD-624318-1.pdf', 'BOL-624318-2.pdf', 'RateCon-624318-3.pdf']);
  assert.ok((await db.get('taFollow:florida-beauty', {}))['624318'].podSent, 'follow-through POD email won\'t send a second copy');
  clock += 3600000; await p.run();
  assert.equal(sent.length, 1, 'once');
});

test('Billing asks: on file → reply on their chain; missing → Gus + Dispatch asked, driver texted, sent to Billing when it arrives', async () => {
  const db = memDb(); const { sent, fetchFn } = mail();
  const docsOn = [{ id: '12', kind: 'ratecon' }];
  const docs = { listDocs: async () => docsOn, readDocs: async () => [] };
  const replies = []; const texts = [];
  const item = { trip: { tripNumber: '624318', status: 'DELVD' } };
  const p = initPaperwork({}, { db, getBoard: async () => ({ trips: [item] }), docs, textDriver: async (s, t, text) => { texts.push(text); return { sent: true }; }, groupEmail: async (n) => (n === 'dispatch' ? 'dispatches@floridabeauty.us' : null), replyWithDocs: async (id, o) => { replies.push({ id, ...o }); }, env, fetchFn });
  assert.deepEqual(await p.request({ trip: '624318', want: ['rate_confirmation'], emailId: 'b1', by: 'Ana (Billing)' }), { sent: true, missing: [] });
  assert.deepEqual(replies[0], { id: 'b1', ids: ['12'], text: 'Here is the rate con for trip 624318.' });
  const r = await p.request({ trip: '624318', want: ['pod', 'bol', 'rate_confirmation'], emailId: 'b2', by: 'Ana (Billing)' });
  assert.deepEqual(r.missing, ['pod', 'bol']);
  assert.match(decode(sent[0]).mime || JSON.stringify(decode(sent[0])), /gus@floridabeauty\.us, dispatches@floridabeauty\.us|gus@floridabeauty\.us/);
  assert.equal(texts.length, 1, 'driver asked for the POD / BOL');
  docsOn.push({ id: '10', docType: 'proof_of_delivery' }, { id: '11', docType: 'bill_of_lading' });
  await p.run();
  const last = replies[replies.length - 1];
  assert.equal(last.id, 'b2');
  assert.deepEqual(last.ids.sort(), ['10', '11', '12']);
});

test('first run after deploy: loads already delivered are not chased', async () => {
  const db = memDb(); const texts = [];
  const p = initPaperwork({}, { db, getBoard: async () => ({ trips: [{ trip: { tripNumber: '1', status: 'DELVD' } }] }), docs: { listDocs: async () => [] }, textDriver: async (s, t, x) => { texts.push(x); return { sent: true }; }, env: { NODE_ENV: 'test' } });
  await p.run(); await p.run();
  assert.equal(texts.length, 0);
});

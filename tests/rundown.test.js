import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildRundown, renderRundownPdf, pdfSafe, initRundowns } from '../rundown.js';
import { sendMail } from '../mailer.js';

const T = (iso) => Date.parse(iso);
const sample = () => ({
  trip: '624278',
  rec: {
    item: { trip: { tripNumber: '624278', powerUnit: '937', trailer: '2027', driver: '8020', status: 'DELVD', statusDesc: 'Delivered', origZoneDesc: 'VENTURA TERMINAL', destZoneDesc: 'SAN DIEGO, CA, 92102' },
      freightBills: [{ billNumber: 'B180101', billToName: 'ZENGISTICS', endZoneDescription: 'SAN DIEGO, CA, 92102', pieces: 120, actualDelivery: '2026-10-06T09:12:00', createdTime: '2026-09-17T15:17:00', createdBy: 'RROMERO' }] },
    firstSeenAt: T('2026-10-05T18:06:00Z'), addedBefore: true,
    statusHistory: [{ status: 'DEPSHP', at: T('2026-10-05T18:06:00Z'), first: true }, { status: 'DELVD', desc: 'Delivered', at: T('2026-10-06T13:15:00Z') }],
  },
  stores: {
    manifest: { version: 1, uploadedAt: '2026-10-05T12:00:00Z', uploadedBy: 'Rosa', stops: [{ stopNumber: 1, action: 'DELIVER', customer: 'ZENGISTICS', city: 'SAN DIEGO', state: 'CA', key: 'k1', apptDate: '2026-10-06', apptTime: '09:00', apptSource: 'handwritten', pieces: 120 }], diffs: [] },
    ratecon: { broker: 'Example Logistics', loadNumber: 'FX-77421', rate: 2150, uploadedAt: '2026-10-05T11:00:00Z', uploadedBy: 'Ana', specialInstructions: ['Driver must call 1hr before arrival', 'No pallet jacks'] },
    rcChecks: { 'Driver must call 1hr before arrival': { done: true, by: 'Ana', at: '2026-10-05T19:00:00Z' } },
    visits: { k1: { state: 'completed', enteredAt: '2026-10-06T12:40:00Z', exitedAt: '2026-10-06T13:20:00Z', dwellMin: 40 } },
    carriers: { carriers: {}, codes: {}, marks: {} },
    checkins: [{ at: '2026-10-06T10:00:00Z', source: 'driver text', text: 'on schedule → San Diego ✓', from: '+18058278024' }],
    comms: [{ type: 'call', to: '+18058278024', label: 'Mark Bodien', by: 'Rosa', at: '2026-10-05T20:00:00Z' }, { type: 'text', to: '+18058278024', text: 'Florida Beauty Flora dispatch: please send the signed POD. Reply STOP to opt out.', by: 'Rosa', at: '2026-10-06T13:30:00Z' }, { type: 'reply', from: '+18058278024', text: 'sent 📷', at: '2026-10-06T13:35:00Z' }],
    stopConfirm: { k1: { at: '2026-10-06T13:25:00Z', text: 'YES' } },
    watch: { alerts: { a1: { id: 'a1', trip: '624278', severity: 'critical', title: 'Will miss SAN DIEGO appointment by ~25h', openedAt: T('2026-10-05T19:00:00Z'), ack: { by: 'Rosa', at: T('2026-10-05T19:05:00Z') }, resolvedAt: T('2026-10-05T21:00:00Z'), resolvedBy: 'Rosa', note: 'Receiver moved appt to Oct 6 9 AM' } } },
    watchArchive: [], docs: [{ kind: 'driverdoc', docType: 'proof_of_delivery', filename: 'POD-624278-1.jpg', uploadedAt: '2026-10-06T13:34:00Z', uploadedBy: 'Mark Bodien (tracking link)' }],
  },
});

test('rundown gathers the whole load: timeline, stops, bills, rate con sign-offs, alerts, comms', () => {
  const s = sample();
  const r = buildRundown({ ...s, finishedAt: '2026-10-06T13:40:00Z', reason: 'delivered' });
  assert.equal(r.truck, '937'); assert.equal(r.bills[0].number, 'B180101');
  assert.equal(r.times.createdBy, 'RROMERO');
  assert.equal(r.alerts.length, 1); assert.equal(r.alerts[0].resolvedBy, 'Rosa');
  assert.deepEqual(r.comms.map((c) => c.type), ['call', 'text', 'reply']);
});

test('rundown PDF renders (unicode made safe) and appends the original pages', async () => {
  const s = sample();
  const r = buildRundown({ ...s, finishedAt: '2026-10-06T13:40:00Z', reason: 'delivered' });
  const orig = await PDFDocument.create(); orig.addPage([300, 400]); orig.addPage([300, 400]);
  const bytes = await renderRundownPdf(r, { originals: [{ mediaType: 'application/pdf', data: Buffer.from(await orig.save()) }] });
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 3);
  assert.equal(pdfSafe('a → b ✓ 📷 “q” —'), 'a -> b OK  “q” —');
  if (process.env.WRITE_SAMPLE) (await import('node:fs')).writeFileSync(process.env.WRITE_SAMPLE, bytes);
});

test('Outlook: clear error until connected; sends through Microsoft Graph with the PDF attached', async () => {
  await assert.rejects(sendMail({ to: ['a@b.com'], subject: 's', html: 'h' }, { env: {} }), /Outlook is not connected yet \(missing MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM/);
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }; };
  const env = { MS_TENANT_ID: 't1', MS_CLIENT_ID: 'c1', MS_CLIENT_SECRET: 'sec', MAIL_FROM: 'reports@floridabeauty.us' };
  const r = await sendMail({ to: 'ops@floridabeauty.us; owner@floridabeauty.us', subject: 'Load 1', html: '<p>x</p>', attachments: [{ name: 'Rundown 1.pdf', bytes: Buffer.from('%PDF') }] }, { env, fetchFn });
  assert.deepEqual(r.to, ['ops@floridabeauty.us', 'owner@floridabeauty.us']);
  assert.match(calls[0].url, /login\.microsoftonline\.com\/t1\/oauth2\/v2\.0\/token/);
  assert.match(calls[1].url, /graph\.microsoft\.com\/v1\.0\/users\/reports%40floridabeauty\.us\/sendMail/);
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.message.attachments[0].name, 'Rundown 1.pdf');
});

test('load finished → rundown made and saved on the load; without Outlook it says so', async () => {
  const m = new Map(); const clone = (v) => JSON.parse(JSON.stringify(v));
  const db = { enabled: true, get: async (k, fb) => (m.has(k) ? clone(m.get(k)) : fb), set: async (k, v) => m.set(k, clone(v)), update: async (k, fn, fb) => { const n = fn(m.has(k) ? clone(m.get(k)) : fb); m.set(k, clone(n)); return n; } };
  const stored = [];
  const docs = { enabled: true, listDocs: async () => [], readDocs: async () => [], storeDocs: async (a) => { stored.push(a); return [{ id: '501' }]; } };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; }, put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; } };
  const rd = initRundowns(app, { requireAuth: () => {}, db, docs, env: { NODE_ENV: 'test' } });
  await db.set('taRundownCfg', { to: ['ops@floridabeauty.us'], enabled: true });
  const s = sample();
  await rd.onFinished('florida-beauty', s.rec, 'delivered');
  await new Promise((r) => setTimeout(r, 50));
  const all = await db.get('taRundowns:florida-beauty', {});
  assert.equal(all['624278'].status, 'saved — Outlook not connected yet');
  assert.equal(all['624278'].docId, '501');
  assert.equal(stored[0].kind, 'rundown');
  await rd.onFinished('florida-beauty', s.rec, 'delivered');   // second delivery event: no duplicate
  assert.equal((await db.get('taRundowns:florida-beauty', {}))['624278'].attempts, 1);
});

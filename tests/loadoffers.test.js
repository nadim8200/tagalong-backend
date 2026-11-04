import test from 'node:test';
import assert from 'node:assert/strict';
import { initInbox, loadOfferOf } from '../inbox.js';

test('a broker offering loads is filed as a load offer, never a callback request, and needs no reply', async () => {
  assert.equal(loadOfferOf({ loadOffer: { is: false } }), null);
  assert.deepEqual(loadOfferOf({ loadOffer: { is: true, company: 'Allen Lund', lanes: 'reefer Miami → Atlanta Nov 5' } }), { company: 'Allen Lund', lanes: 'reefer Miami → Atlanta Nov 5' });
  const raised = [];
  const help = { raise: async (r) => { raised.push(r); return r; } };
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'k' };
  const msg = { id: 'e9', subject: 'Reefer loads available Miami', from: { emailAddress: { name: 'Peyton Sartin', address: 'peyton.sartin@example-broker.com' } }, receivedDateTime: '2026-11-02T19:00:00Z', body: { contentType: 'text', content: 'We have 3 reefer loads Miami to Atlanta on Nov 5. Call me to book!' }, conversationId: 'e9', hasAttachments: false };
  // the model even says "wants contact": the load offer wins
  const triage = { summary: 'Broker offering reefer loads', attachments: [], refs: {}, actions: [], help: { wantsContact: true, urgent: false, summary: 'Call Peyton to book loads' }, reply: { needed: true, kind: 'question', documents: [] }, loadOffer: { is: true, company: 'Example Broker', lanes: '3 reefer loads Miami → Atlanta, Nov 5' } };
  const fetchFn = async (url) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('anthropic.com')) return ok({ content: [{ type: 'text', text: JSON.stringify(triage) }] });
    if (url.includes('/mailFolders/inbox/messages')) return ok({ value: [msg] });
    return ok({});
  };
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const inbox = initInbox({ get: () => {}, post: () => {}, put: () => {} }, { requireAuth: () => {}, db, env, fetchFn, getBoard: async () => ({ trips: [] }), help });
  await inbox.poll();
  assert.equal(raised.length, 0, 'no callback request');
  const offers = m.get('taLoadOffers:florida-beauty');
  assert.equal(offers.length, 1);
  assert.deepEqual([offers[0].company, offers[0].lanes, offers[0].email], ['Example Broker', '3 reefer loads Miami → Atlanta, Nov 5', 'peyton.sartin@example-broker.com']);
});

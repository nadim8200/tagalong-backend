import test from 'node:test';
import assert from 'node:assert/strict';
import { initHelpdesk, routeTo, wantsContact, helpEmail } from '../helpdesk.js';

function memDb() { const m = new Map(); return { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const CFG = { customerService: { emails: ['cs@floridabeauty.us'], phones: ['3055551000'] }, dispatch: { emails: ['dispatch@floridabeauty.us'], phones: ['3055552000'] }, urgent: { emails: ['ronen@floridabeauty.us'], phones: ['3055553000'] } };

test('who asks for help → who hears about it', () => {
  assert.deepEqual(routeTo({ role: 'customer' }, CFG), { groups: ['customerService'], emails: ['cs@floridabeauty.us'], phones: ['3055551000'] });
  assert.deepEqual(routeTo({ role: 'driver', urgent: true }, CFG).groups, ['dispatch', 'urgent']);
  assert.deepEqual(routeTo({ role: 'driver', urgent: true }, CFG).emails, ['dispatch@floridabeauty.us', 'ronen@floridabeauty.us']);
  assert.equal(wantsContact('Please call me back about my order'), true);
  assert.equal(wantsContact('Llámame cuando puedas'), true);
  assert.equal(wantsContact('ok thanks'), false);
  const m = helpEmail({ source: 'call', role: 'customer', from: { name: 'Bokhary Farms', phone: '7815550123' }, trip: '624481', need: 'Wants to know if they can receive early', urgent: false }, { trip: '624481', truck: '2606', location: 'I 95, Robeson County, NC', motion: 'rolling 64 mph', next: 'Kinston, NC — ETA Wed 1:00 PM Eastern' });
  assert.equal(m.subject, 'Call back Bokhary Farms (customer) · load 624481: Wants to know if they can receive early');
  assert.match(m.html, /call \(781\) 555-0123/); assert.match(m.html, /rolling 64 mph/);
  assert.match(m.text, /^Call back Bokhary Farms \(781\) 555-0123 \(load 624481\)/);
});

test('a request is emailed, texted and pushed once; waits when Outlook / texting are not connected yet', async () => {
  const db = memDb(); await db.set('taHelpCfg', CFG);
  const mails = []; const texts = []; const pushes = [];
  let outlook = true; let texting = false;
  const h = initHelpdesk({ get: () => {}, post: () => {}, put: () => {} }, { requireAuth: () => {}, db, env: { NODE_ENV: 'test' },
    mail: { ready: () => outlook, send: async (m) => mails.push(m) }, sms: { live: async () => texting, send: async (to, t) => texts.push({ to, t }) }, push: { sendToEmails: async (emails, m) => { pushes.push({ emails, m }); return 1; } } });
  const r = await h.raise({ source: 'call', ref: 'call1:need', role: 'driver', from: { name: 'Luis', phone: '3055550117' }, trip: '624268', need: 'Truck broke down on I-75 mile 210' });
  assert.equal(r.urgent, true, 'a breakdown is urgent');
  assert.deepEqual(mails[0].to, ['dispatch@floridabeauty.us', 'ronen@floridabeauty.us']); assert.match(mails[0].subject, /^URGENT — Call back Luis \(driver\) · load 624268/);
  assert.equal(r.sent.text, 'waiting for texting approval');
  assert.equal(pushes[0].m.title, '🚨 Call back — urgent');
  assert.equal(await h.raise({ source: 'call', ref: 'call1:need', role: 'driver', need: 'same again' }), null, 'never twice');
  texting = true; outlook = false;
  const r2 = await h.raise({ source: 'text', ref: 'sms9', role: 'unknown', from: { phone: '+17865550000' }, need: 'call me about the delivery' });
  assert.equal(r2.sent.email, 'waiting for Outlook'); assert.deepEqual(texts.map((x) => x.to), ['3055551000']);
});

import { initInbox } from '../inbox.js';
test('an email asking to be called raises a request (our own staff\'s emails never do)', async () => {
  const raised = [];
  const help = { raise: async (r) => { raised.push(r); return r; } };
  const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', ANTHROPIC_API_KEY: 'k' };
  const msg = (id, address) => ({ id, subject: 'Load RXO 24261611', from: { emailAddress: { name: 'Kim', address } }, receivedDateTime: '2026-10-08T12:00:00Z', body: { contentType: 'text', content: 'Please call me ASAP, the receiver says the truck is not there. 312-555-0101' }, conversationId: id, hasAttachments: false });
  const fetchFn = async (url, opts = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('oauth2')) return ok({ access_token: 'x', expires_in: 3600 });
    if (url.includes('anthropic.com')) return ok({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Broker needs a call: receiver says truck not there', attachments: [], refs: {}, actions: [], help: { wantsContact: true, urgent: true, summary: 'Receiver says the truck is not there — call Kim', callbackPhone: '312-555-0101' }, reply: { needed: false } }) }] });
    if (url.includes('/mailFolders/inbox/messages')) return ok({ value: [msg('e1', 'ops@rxo.com'), msg('e2', 'rosa@floridabeauty.us')] });
    return ok({});
  };
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? m.get(k) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const board = [{ trip: { tripNumber: '623869', status: 'DEPSHIP' }, freightBills: [{ billNumber: 'B1', endZoneDescription: 'BLOOMFIELD, CT, 06002' }], _ratecon: { data: { broker: 'RXO', loadNumber: 'RXO 24261611', brokerEmail: 'ops@rxo.com' } } }];
  const inbox = initInbox({ get: () => {}, post: () => {}, put: () => {} }, { requireAuth: () => {}, db, env, fetchFn, getBoard: async () => ({ trips: board }), help });
  await inbox.poll();
  assert.equal(raised.length, 1, 'staff email ignored');
  assert.deepEqual({ source: raised[0].source, role: raised[0].role, trip: raised[0].trip, urgent: raised[0].urgent, phone: raised[0].from.phone }, { source: 'email', role: 'broker', trip: '623869', urgent: true, phone: '312-555-0101' });
});

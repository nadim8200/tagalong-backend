import test from 'node:test';
import assert from 'node:assert/strict';
import { mayTeach, aiMessages, requestFiles, initJarvisRequests, TEACHERS } from '../jarvisrequests.js';
import { renderRequestEmail } from '../handoffmail.js';

const mem = () => { const s = {}; return { s, get: async (k, d) => (k in s ? s[k] : d), update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };
const gus = { name: 'Gustavo', email: 'gus@floridabeauty.us', role: 'dispatcher' };
const setup = ({ fail = false, mailFail = false } = {}) => {
  const db = mem(); const mails = []; const stored = []; const bodies = [];
  const docs = { storeDocs: async ({ files }) => { stored.push(files[0]); return [{ id: stored.length }]; }, readDocs: async ({ ids }) => ids.map((id) => ({ id, mediaType: 'image/png', data: Buffer.from('x') })) };
  const r = initJarvisRequests(null, { db, docs, sendMail: async (m) => { if (mailFail) throw new Error('no'); mails.push(m); }, phoneOf: async () => '305-555-0100', env: { ANTHROPIC_API_KEY: 'k' }, fetchFn: async (u, o) => { bodies.push(JSON.parse(o.body)); if (fail) return { ok: false, status: 500 }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'What should happen when the truck is late?' }] }) }; }, now: () => 1000 });
  return { r, db, mails, stored, bodies };
};

test('only Gus, Ronen, Luis and the platform admin', () => {
  assert.deepEqual(TEACHERS, ['gus@floridabeauty.us', 'ronen@floridabeauty.us', 'ljimenez@floridabeauty.us']);
  for (const email of TEACHERS) assert.equal(mayTeach({ email, role: 'dispatcher' }), true);
  assert.equal(mayTeach({ email: 'GUS@floridabeauty.us' }), true);
  assert.equal(mayTeach({ admin: true }), true);
  assert.equal(mayTeach({ email: 'sara@floridabeauty.us', role: 'dispatcher', companyAdmin: true }), false);
  assert.equal(mayTeach(null), false);
});

test('files reach the AI only on the newest message', () => {
  const m = aiMessages([{ from: 'person', text: 'a' }, { from: 'jarvis', text: 'b' }, { from: 'person', text: 'c' }], [{ mediaType: 'image/png', data: Buffer.from('x') }, { mediaType: 'application/pdf', data: Buffer.from('y') }]);
  assert.equal(m[0].content, 'a'); assert.equal(m[1].role, 'assistant');
  assert.deepEqual(m[2].content.map((c) => c.type), ['image', 'document', 'text']);
});

test('a conversation: Jarvis asks, files are kept, and only real attachments count', async () => {
  const s = setup();
  assert.equal((await s.r.message(null, gus, { text: ' ' })).code, 400);
  const first = await s.r.message(null, gus, { text: 'I want Jarvis to warn me about late trucks', files: [{ dataBase64: 'eA==', mediaType: 'image/png', filename: 'a.png' }, { dataBase64: 'eA==', mediaType: 'application/x-msdownload', filename: 'bad.exe' }] });
  assert.equal(s.stored.length, 1, 'no programs');
  assert.equal(first.request.messages[1].from, 'jarvis'); assert.match(first.request.messages[1].text, /truck is late/);
  assert.match(s.bodies[0].system, /cannot do the task/);
  const again = await s.r.message(first.request.id, gus, { text: 'Call me first' });
  assert.equal(again.request.messages.length, 4);
});

test('someone else cannot read or add to it, and the owner can', async () => {
  const s = setup();
  const { request } = await s.r.message(null, gus, { text: 'hello there' });
  assert.equal((await s.r.message(request.id, { name: 'Ronen', email: 'ronen@floridabeauty.us' }, { text: 'x' })).code, 404);
  assert.equal((await s.r.finish(request.id, { email: 'ronen@floridabeauty.us' })).code, 404);
  assert.equal((await s.r.message(request.id, { admin: true, name: 'Nadim' }, { text: 'what about nights?' })).ok, true);
});

test('done: lesson learned, one email to the owner with everything, and it closes', async () => {
  const s = setup();
  const { request } = await s.r.message(null, gus, { text: 'Warn me about late trucks', files: [{ dataBase64: 'eA==', mediaType: 'image/png', filename: 'a.png' }] });
  const d = await s.r.finish(request.id, gus);
  assert.equal(d.emailed, true);
  assert.match(d.request.messages[d.request.messages.length - 1].text, /OK, lesson learned/);
  assert.equal(s.mails.length, 1); assert.deepEqual(s.mails[0].to, ['ntellez@floridabeauty.us']);
  assert.equal(s.mails[0].attachments.length, 1);
  assert.match(s.mails[0].text, /Warn me about late trucks/); assert.match(s.mails[0].html, /tel:\+13055550100/);
  await s.r.finish(request.id, gus);
  assert.equal(s.mails.length, 1, 'once');
  assert.equal((await s.r.message(request.id, gus, { text: 'more' })).code, 409);
});

test('a failed AI or email never loses the conversation', async () => {
  const s = setup({ fail: true });
  const r = await s.r.message(null, gus, { text: 'hello there' });
  assert.match(r.request.messages[1].text, /I saved that/);
  const m = setup({ mailFail: true });
  const { request } = await m.r.message(null, gus, { text: 'hello there' });
  assert.equal((await m.r.finish(request.id, gus)).emailed, false);
});

test('files too big for one email are counted', () => {
  const r = requestFiles([{ mediaType: 'application/pdf', data: Buffer.alloc(100) }, { mediaType: 'application/pdf', data: Buffer.alloc(100) }], 150);
  assert.equal(r.attachments.length, 1); assert.equal(r.skipped, 1); assert.equal(r.attachments[0].name, 'Attachment 1.pdf');
});

test('the email escapes what people typed', () => {
  const m = renderRequestEmail({ request: { by: 'Gus', email: 'g@x', at: 1, title: 't', messages: [{ from: 'person', by: 'Gus', at: 1, text: '<script>x' }] } });
  assert.doesNotMatch(m.html, /<script>x/);
});

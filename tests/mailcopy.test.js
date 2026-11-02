import test from 'node:test';
import assert from 'node:assert/strict';
import { mailCopy, sendMail, sendInThread } from '../mailer.js';

const env = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us' };
const capture = () => { const calls = []; return { calls, fetchFn: async (url, o = {}) => { calls.push({ url, body: o.body }); const ok = (j, status = 200) => ({ ok: true, status, json: async () => j }); if (/token/.test(url)) return ok({ access_token: 'x', expires_in: 3600 }); if (/sentitems/.test(url)) return ok({ value: [{ id: 'm1' }] }); if (/createReply/.test(url)) return ok({ id: 'd1' }); return ok({}, 202); } }; };
const sentBody = (c) => JSON.parse(c.calls.find((x) => /\/sendMail$/.test(x.url)).body);

test('the owner is copied, hidden, and only once', () => {
  assert.deepEqual(mailCopy({}), [{ emailAddress: { address: 'ntellez@floridabeauty.us' } }]);
  assert.deepEqual(mailCopy({}, ['NTELLEZ@floridabeauty.us']), [], 'already on it');
  assert.deepEqual(mailCopy({ MAIL_COPY_TO: '' }), [], 'can be turned off');
});

test('a normal email has the hidden copy, and the address is not visible', async () => {
  const c = capture();
  await sendMail({ to: ['a@floridabeauty.us'], subject: 'S', html: '<b>x</b>', attachments: [{ name: 'a.pdf', bytes: Buffer.from('x') }] }, { env, fetchFn: c.fetchFn, direct: true });
  const m = sentBody(c).message;
  assert.equal(m.bccRecipients[0].emailAddress.address, 'ntellez@floridabeauty.us');
  assert.equal(JSON.stringify(m.toRecipients).includes('ntellez'), false); assert.equal(JSON.stringify(m.ccRecipients).includes('ntellez'), false);
});

test('a text-and-html email keeps its format and carries the copy in Bcc', async () => {
  const c = capture();
  await sendMail({ to: ['a@floridabeauty.us'], subject: 'S', html: '<b>x</b>', text: 'x' }, { env, fetchFn: c.fetchFn, direct: true });
  const mime = Buffer.from(c.calls.find((x) => /\/sendMail$/.test(x.url)).body, 'base64').toString();
  assert.match(mime, /^Bcc: ntellez@floridabeauty\.us\r$/m); assert.match(mime, /multipart\/alternative/);
});

test('password and login emails are never copied', async () => {
  const c = capture();
  await sendMail({ to: ['a@floridabeauty.us'], subject: 'S', html: 'x', attachments: [{ name: 'a.pdf', bytes: Buffer.from('x') }] }, { env, fetchFn: c.fetchFn, direct: true, noCopy: true });
  assert.deepEqual(sentBody(c).message.bccRecipients, []);
});

test('a reply on a thread is copied too', async () => {
  const c = capture();
  await sendInThread({ to: ['a@floridabeauty.us'], subject: 'Re: X', html: 'x' }, 'X', { env, fetchFn: c.fetchFn, direct: true });
  const patch = c.calls.find((x) => /messages\/d1$/.test(x.url));
  assert.equal(JSON.parse(patch.body).bccRecipients[0].emailAddress.address, 'ntellez@floridabeauty.us');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, sendInThread, uniqueCids } from '../mailer.js';

const env = { NODE_ENV: 'test', MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'jarvis@floridabeauty.us', MAIL_COPY_TO: '' };
const outlook = () => {
  const sent = [];
  const fetchFn = async (url, opts = {}) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    if (url.includes('/sentitems/messages')) return { ok: true, status: 200, json: async () => ({ value: [{ id: 'first' }] }) };
    if (url.endsWith('/createReply')) return { ok: true, status: 201, json: async () => ({ id: 'draft' }) };
    sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 202, json: async () => ({}) };
  };
  return { sent, fetchFn };
};
const photoMail = (bytes) => ({ to: ['dispatches@floridabeauty.us'], subject: 'x', html: '<p>Update</p><img src="cid:bkphoto1"><img src="cid:truckmap">', attachments: [{ name: 'Breakdown photo 1.jpg', contentType: 'image/jpeg', bytes: Buffer.from(bytes), cid: 'bkphoto1' }, { name: 'truck-location.jpg', contentType: 'image/jpeg', bytes: Buffer.from('map'), cid: 'truckmap' }] });

test('pictures never share a name across emails on one chain (Outlook showed the first email\'s photo in a later update)', async () => {
  const a = outlook();
  await sendMail(photoMail('tire'), { env, fetchFn: a.fetchFn, direct: true });
  await sendInThread(photoMail('axle'), 'FLOWERS BREAKDOWN TRAILER 7328', { env, fetchFn: a.fetchFn, direct: true });
  const first = a.sent.find((x) => x.url.endsWith('/sendMail')).body.message;
  const firstIds = first.attachments.map((x) => x.contentId);
  const replyIds = a.sent.filter((x) => x.url.endsWith('/draft/attachments')).map((x) => x.body.contentId);
  const replyHtml = a.sent.find((x) => x.url.endsWith('/messages/draft') && x.method === 'PATCH').body.body.content;
  assert.equal(firstIds.length, 2); assert.equal(replyIds.length, 2);
  assert.ok(firstIds.every((id) => !replyIds.includes(id)), `${firstIds} vs ${replyIds}`);
  for (const id of firstIds) assert.ok(first.body.content.includes(`cid:${id}`), 'the body points at its own pictures');
  for (const id of replyIds) assert.ok(replyHtml.includes(`cid:${id}`));
  assert.ok(!/cid:bkphoto1"/.test(replyHtml), 'no bare shared name left');
});

test('only whole names are renamed: bkphoto1 never touches bkphoto10', () => {
  const r = uniqueCids({ html: '<img src="cid:bkphoto1"><img src="cid:bkphoto10">', attachments: [{ cid: 'bkphoto1' }, { cid: 'bkphoto10' }] }, 'T');
  assert.equal(r.html, '<img src="cid:bkphoto1.T"><img src="cid:bkphoto10.T">');
});

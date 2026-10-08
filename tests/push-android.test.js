import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initPush } from '../push.js';

test('Android phones get notifications through Firebase; dead Android tokens are reported', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'push@tagalong.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'tagalong-app' };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, body: opts.body });
    if (url.includes('oauth2.googleapis.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.x' }) };
    if (String(opts.body).includes('dead-token')) return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) };
    return { ok: true, status: 200, json: async () => ({ name: 'projects/tagalong-app/messages/1' }) };
  };
  try {
    const app = { get: () => {}, post: () => {}, put: () => {} };
    const push = initPush(app, { TRACCAR_URL: 'http://x', traccarHeaders: {}, requireAuth: () => {}, env: { FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(sa)).toString('base64') }, db: { enabled: false } });
    assert.equal(push.enabled, true); assert.equal(push.android, true); assert.equal(push.apns, false);
    const androidTok = `fGx1:APA91b${'x'.repeat(140)}`;
    const dead = await push.sendToTokens([{ token: androidTok, platform: 'android' }, { token: 'dead-token:APA91b', platform: 'android' }, { token: 'a'.repeat(64), env: 'production' }], { title: 'Florida Beauty Flora dispatch · load 624268', body: 'Call the receiver', data: { path: '/t/abc', kind: 'oc-message' } });
    const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com/v1/projects/tagalong-app/messages:send'));
    assert.equal(sends.length, 2, 'only the two Android phones go to Firebase');
    const msg = JSON.parse(sends[0].body).message;
    assert.equal(msg.token, androidTok); assert.equal(msg.notification.title, 'Florida Beauty Flora dispatch · load 624268'); assert.equal(msg.data.path, '/t/abc');
    assert.deepEqual(dead, ['dead-token:APA91b']);
  } finally { globalThis.fetch = realFetch; }
});

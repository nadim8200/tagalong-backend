import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReport, dvrEmail, initDvr } from '../dvr.js';

test('DVIR: a part, a category, and words or a photo / video are needed', () => {
  assert.match(cleanReport({}).error, /truck, trailer or reefer/);
  assert.match(cleanReport({ part: 'truck' }).error, /what the problem is/);
  assert.match(cleanReport({ part: 'truck', category: 'tires' }).error, /Write what is wrong/);
  const r = cleanReport({ part: 'trailer', category: 'lights', urgent: true, text: 'Left marker light out', truck: '4551', trailer: '7282' }).report;
  assert.deepEqual([r.part, r.category, r.trailer], ['trailer', 'lights', '7282']);
  assert.equal(r.urgent, undefined, 'no "can\'t drive" on a DVIR: that is a breakdown');
  assert.ok(cleanReport({ part: 'truck', category: 'engine', videos: 1 }).report, 'a video alone is enough');
});

test('DVIR email: needs attention when it comes back, the driver\'s words escaped, files as links (photos marked attached)', () => {
  const r = { part: 'trailer', category: 'lights', urgent: false, text: 'Marker <light> out', truck: '4551', trailer: '7282', trip: '627080', by: 'Frank U', driverCode: '0986', at: '2026-11-13T21:00:00Z' };
  const m = dvrEmail(r, [{ id: 'p1', kind: 'photo', n: 1, size: 1000, url: 'https://x/dvr/f/a' }, { id: 'v1', kind: 'video', n: 1, size: 20 * 1048576, url: 'https://x/dvr/f/b' }], ['p1']);
  assert.equal(m.subject, 'DVIR // TRAILER 7282 // LIGHTS // TRIP 627080');
  assert.match(m.html, /NEEDS ATTENTION WHEN IT COMES BACK/); assert.match(m.html, /Marker &lt;light&gt; out/);
  assert.match(m.html, /Photo 1<\/a> <span[^>]*>· attached/); assert.match(m.html, /Video 1<\/a> <span[^>]*>\(20 MB\)/);
  assert.match(m.text, /Video 1: https:\/\/x\/dvr\/f\/b/);
  assert.equal(dvrEmail({ ...r, part: 'truck', trip: null }, []).subject, 'DVIR // TRUCK 4551 // LIGHTS');
});

test('DVIR from the app: photos with the report, a video on its own, then one email; the email\'s links open the files', async () => {
  const kv = {}; const files = [];
  const pool = { query: async (sql, args = []) => {
    if (/^INSERT INTO ta_dvr_files/.test(sql)) { files.push({ id: args[0], dvr_id: args[2], kind: args[3], filename: args[4], media_type: args[5], data: args[7] }); return { rows: [] }; }
    if (/WHERE id = ANY/.test(sql)) return { rows: files.filter((f) => args[0].includes(f.id)) };
    if (/WHERE id = \$1/.test(sql)) return { rows: files.filter((f) => f.id === args[0]) };
    return { rows: [] };
  } };
  const db = { enabled: true, pool, get: async (k, d) => (k in kv ? JSON.parse(JSON.stringify(kv[k])) : d), set: async (k, v) => { kv[k] = v; }, update: async (k, f, d) => { kv[k] = f(k in kv ? JSON.parse(JSON.stringify(kv[k])) : d); return kv[k]; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const mails = []; const logged = [];
  const requireDriver = (req, res, next) => { req.driver = { code: req.headers.drv || '0986', name: 'Frank U' }; return next(); };
  initDvr(app, { db, secret: 's', requireDriver, requireAuth: (q, r, n) => n(), sendMail: async (m) => mails.push(m), recipients: async () => ['carlos@floridabeauty.us', 'dispatches@floridabeauty.us'], log: async (...a) => logged.push(a), now: () => Date.parse('2026-11-13T21:00:00Z') });
  const call = async (key, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; }, send(t) { out.body = t; return this; }, setHeader(k, v) { out[k] = v; }, end(b) { out.raw = b; } };
    const req = { body, params, query, headers, _body: true };
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next(); return out;
  };
  const jpg = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64');
  const made = await call('POST /driver/me/dvr', { body: { part: 'truck', category: 'tires', text: 'Steer tire low, losing air', truck: '4551', trailer: '7282', trip: '627080', photos: [{ filename: 'tire.jpg', mediaType: 'image/jpeg', dataBase64: jpg }] } });
  assert.equal(made.status, 200); const id = made.body.id;
  assert.equal((await call('POST /driver/me/dvr/:id/video', { params: { id }, query: { name: 'tire.mov' }, headers: { 'content-type': 'video/quicktime' }, body: Buffer.alloc(2048) })).status, 200);
  assert.equal((await call('POST /driver/me/dvr/:id/video', { params: { id }, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(10) })).status, 400, 'only videos here');
  assert.equal((await call('POST /driver/me/dvr/:id/video', { params: { id }, headers: { 'content-type': 'video/mp4', drv: '9999' }, body: Buffer.alloc(10) })).status, 404, 'not their report');
  const sent = await call('POST /driver/me/dvr/:id/send', { params: { id } });
  assert.equal(sent.status, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'DVIR // TRUCK 4551 // TIRES // TRIP 627080');
  assert.match(mails[0].html, /NEEDS ATTENTION WHEN IT COMES BACK/); assert.doesNotMatch(mails[0].html, /CAN'T DRIVE/);
  assert.deepEqual(mails[0].to, ['carlos@floridabeauty.us', 'dispatches@floridabeauty.us']);
  assert.equal(mails[0].attachments.length, 1, 'the photo attached; the video stays a link');
  assert.equal((await call('POST /driver/me/dvr/:id/send', { params: { id } })).body.already, true, 'once');
  assert.match(logged[0][2].text, /DVIR from Frank U/);
  const link = mails[0].text.match(/Video 1: \S+\/dvr\/f\/(\S+)/)[1];
  const got = await call('GET /dvr/f/:token', { params: { token: link } });
  assert.equal(got['Content-Type'], 'video/quicktime'); assert.equal(got.raw.length, 2048);
  assert.equal((await call('GET /dvr/f/:token', { params: { token: 'bad.token' } })).status, 404);
  const mine = await call('GET /driver/me/dvr');
  assert.deepEqual([mine.body.reports[0].photos, mine.body.reports[0].videos, !!mine.body.reports[0].sentAt], [1, 1, true]);
});

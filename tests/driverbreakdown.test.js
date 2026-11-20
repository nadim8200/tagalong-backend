import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReport, tireLabel, breakdownEmail, timeline, sendsTo, initDriverBreakdowns } from '../driverbreakdown.js';

const base = { status: 'stopped', part: 'trailer', category: 'tire', truck: '4504', trailer: '18094', trip: '627549' };

test('breakdown: vehicle state, equipment and problem are needed; reefer problems only on a reefer; accident on anything', () => {
  assert.match(cleanReport({}).error, /stopped, moving/);
  assert.match(cleanReport({ status: 'stopped' }).error, /truck, trailer or reefer/);
  assert.match(cleanReport({ status: 'moving', part: 'truck', category: 'temp' }).error, /kind of problem/);
  assert.ok(cleanReport({ status: 'unsure', part: 'reefer', category: 'temp' }).report);
  assert.ok(cleanReport({ status: 'stopped', part: 'truck', category: 'accident' }).report);
  assert.equal(cleanReport({ ...base, status: 'safe' }).error.length > 0, true, 'no "safe to drive" state');
});

test('breakdown: tires are kept only when they exist on the axles given; the steer axle has no inner / outer', () => {
  const r = cleanReport({ ...base, axles: 2, tires: [{ axle: 2, side: 'right', pos: 'outer' }, { axle: 3, side: 'left', pos: 'inner' }, { axle: 1, side: 'up' }] }).report;
  assert.deepEqual(r.tires, [{ axle: 2, side: 'right', pos: 'outer' }]);
  assert.equal(tireLabel(r.tires[0], 'trailer'), 'Axle 2 · Right · Outer');
  const t = cleanReport({ ...base, part: 'truck', tires: [{ axle: 1, side: 'left', pos: 'inner' }, { axle: 1, side: 'left' }] }).report;
  assert.deepEqual(t.tires, [{ axle: 1, side: 'left', pos: null }]);
  assert.equal(tireLabel(t.tires[0], 'truck'), 'Steer · Left');
  assert.equal(cleanReport({ ...base, tireUnsure: true }).report.tireUnsure, true);
});

test('breakdown: location keeps its source and time; 0,0 is not a location; typed location works without GPS', () => {
  const g = cleanReport({ ...base, location: { source: 'truck', lat: 27.4, lng: -80.3, address: 'I-95 N, Fort Pierce, FL', at: '2026-11-19T21:41:00Z' } }).report.location;
  assert.deepEqual([g.source, g.lat, g.at], ['truck', 27.4, '2026-11-19T21:41:00.000Z']);
  const z = cleanReport({ ...base, location: { lat: 0, lng: 0 } }).report.location;
  assert.equal(z.lat, null);
  const m = cleanReport({ ...base, location: { source: 'manual', text: 'I-95 N near Fort Pierce', ref: 'exit 129, right shoulder' } }).report.location;
  assert.deepEqual([m.source, m.text, m.ref], ['manual', 'I-95 N near Fort Pierce', 'exit 129, right shoulder']);
});

test('breakdown email: stopped banner, tires and size, driver words escaped, files as links, road call', () => {
  const r = { ...cleanReport({ ...base, tires: [{ axle: 2, side: 'right', pos: 'outer' }], tireSize: '295/75r22.5', text: 'Lost air <fast>', callback: '786-314-2671', location: { source: 'truck', lat: 27.4, lng: -80.3, address: 'I-95 N, Fort Pierce, FL', at: '2026-11-19T21:41:00Z' } }).report,
    id: 'BK-1119-123', by: 'Ferney Urrego', driverCode: '986', at: '2026-11-19T21:43:00Z', roadCall: 'RC-1119-555' };
  const m = breakdownEmail(r, [{ id: 'p1', kind: 'photo', n: 1, size: 1000, url: 'https://x/bk/f/a' }], ['p1']);
  assert.equal(m.subject, 'BREAKDOWN // TRAILER 18094 // TIRE // TRIP 627549 // BK-1119-123');
  assert.match(m.html, /DRIVER IS STOPPED/); assert.match(m.html, /Axle 2 · Right · Outer/); assert.match(m.html, /295\/75R22\.5/);
  assert.match(m.html, /Lost air &lt;fast&gt;/); assert.match(m.html, /\(786\) 314-2671/); assert.match(m.html, /truck GPS, as of/);
  assert.match(m.html, /Photo 1<\/a> <span[^>]*>· attached/); assert.match(m.text, /Road call RC-1119-555/);
  const u = breakdownEmail(r, [], [], { text: 'Tow truck needed', at: '2026-11-19T22:00:00Z' });
  assert.match(u.subject, /^UPDATE \/\/ BREAKDOWN/); assert.match(u.html, /Tow truck needed/);
  const reefer = { ...cleanReport({ status: 'unsure', part: 'reefer', category: 'temp', trailer: '18094', reefer: { current: 41.2, set: 34, source: 'telemetry', at: '2026-11-19T21:30:00Z', power: 'on' } }).report, id: 'BK-1', at: '2026-11-19T21:43:00Z' };
  const rm = breakdownEmail(reefer, []);
  assert.match(rm.html, /now 41\.2°F · set 34°F · unit on/); assert.match(rm.html, /Samsara/); assert.match(rm.html, /NOT SURE/);
});

test('breakdown status: only real events move it — waiting until the provider is en route, resolved when completed or closed', () => {
  const r = { at: '2026-11-19T21:43:00Z' };
  assert.equal(timeline(r, null).state, 'waiting');
  assert.equal(timeline(r, { status: 'ready', log: [] }).state, 'waiting');
  const sent = timeline(r, { status: 'sent', provider: { name: 'Michelin ONCall', eta: null }, log: [] });
  assert.equal(sent.state, 'waiting'); assert.equal(sent.provider.name, 'Michelin ONCall');
  assert.equal(timeline(r, { status: 'gathering', provider: { name: 'Michelin ONCall' }, log: [] }).provider, null, 'no provider shown before it was sent');
  const en = timeline(r, { status: 'tech en route', provider: { name: 'Michelin ONCall', tech: 'Road Tire Co', eta: '10:30 PM', at: '2026-11-19T22:05:00Z' }, log: [] });
  assert.deepEqual([en.state, en.provider.name, en.provider.eta, en.updatedAt], ['enroute', 'Road Tire Co', '10:30 PM', '2026-11-19T22:05:00Z']);
  assert.equal(timeline(r, { status: 'completed', log: [] }).state, 'resolved');
  assert.equal(timeline({ ...r, closed: 'resolved', closedAt: '2026-11-20T01:00:00Z' }, null).state, 'resolved');
  assert.equal(timeline({ ...r, closed: 'cancelled' }, null).state, 'cancelled');
});

test('breakdown: who it reaches comes from the real list', () => {
  assert.deepEqual(sendsTo(['Dispatch', 'Carlos Vega']), { dispatch: true, maintenance: true, any: true, training: false });
  assert.deepEqual(sendsTo(['Dispatch'], true), { dispatch: true, maintenance: false, any: true, training: true });
});

function harness({ mailFails = false } = {}) {
  const kv = {}; const files = [];
  const pool = { query: async (sql, args = []) => {
    if (/^INSERT INTO ta_breakdown_files/.test(sql)) { files.push({ id: args[0], report_id: args[2], note_id: args[3], kind: args[5], filename: args[6], media_type: args[7], data: args[9] }); return { rows: [] }; }
    if (/WHERE id = ANY/.test(sql)) return { rows: files.filter((f) => args[0].includes(f.id)) };
    if (/WHERE id = \$1/.test(sql)) return { rows: files.filter((f) => f.id === args[0]) };
    return { rows: [] };
  } };
  const db = { enabled: true, pool, get: async (k, d) => (k in kv ? JSON.parse(JSON.stringify(kv[k])) : d), set: async (k, v) => { kv[k] = v; }, update: async (k, f, d) => { kv[k] = f(k in kv ? JSON.parse(JSON.stringify(kv[k])) : d); return kv[k]; } };
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const mails = []; const opened = []; const rcs = []; const pushes = [];
  const roadCalls = { open: async (o) => { opened.push(o); const rc = { id: 'RC-1119-555', status: 'gathering', log: [] }; rcs.push(rc); return rc; }, update: async () => null, list: async () => rcs };
  const requireDriver = (req, res, next) => { req.driver = { code: req.headers.drv || '986', name: 'Ferney Urrego', phone: '7863142671' }; req.user = { phone: '7863142671' }; return next(); };
  const board = { trips: [{ trip: { tripNumber: '627549', driver: '986', status: 'DEPSHIP', powerUnit: '4504', trailer: '18094' }, _samsara: { lat: 27.4, lng: -80.3, location: 'I-95 N, Fort Pierce, FL', gpsAt: '2026-11-19T21:41:00Z', source: 'Samsara', tempF: 41.2, setpointF: 34, reeferState: 'On', tempAt: '2026-11-19T21:30:00Z' } }] };
  initDriverBreakdowns(app, { db, secret: 's', requireDriver, requireAuth: (q, r, n) => n(), getBoard: async () => board, roadCalls: () => roadCalls,
    sendMail: async (m) => { if (mailFails) throw new Error('down'); mails.push(m); }, recipients: async () => ['dispatches@floridabeauty.us', 'carlos@floridabeauty.us'], entries: async () => ['Dispatch', 'Carlos Vega'],
    training: { active: async () => null }, push: { sendToEmails: async (to, m) => { pushes.push({ to, ...m }); return []; } }, pushTo: async () => ['rosa@floridabeauty.us'], env: {}, now: () => Date.parse('2026-11-19T21:43:00Z') });
  const call = async (key, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; }, send(t) { out.body = t; return this; }, setHeader(k, v) { out[k] = v; }, end(b) { out.raw = b; } };
    const req = { body, params, query, headers, _body: true };
    const hs = routes[key]; let i = 0; let done; const fin = new Promise((ok) => { done = ok; });
    const send = res.json; res.json = function j(x) { send.call(this, x); done(); return this; };
    const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
    await Promise.race([fin, new Promise((ok) => { setTimeout(ok, 200); })]); return out;
  };
  return { call, mails, opened, rcs, files, pushes };
}

test('breakdown from the app: context, one report per key, files once per key, one email, an update with its own photo, status on the list', async () => {
  const h = harness();
  const ctx = await h.call('GET /driver/me/breakdowns/context');
  assert.deepEqual([ctx.body.loads[0].truck, ctx.body.loads[0].trailer, ctx.body.loads[0].gps.source, ctx.body.loads[0].gps.at], ['4504', '18094', 'truck', '2026-11-19T21:41:00Z']);
  assert.deepEqual([ctx.body.loads[0].reefer.current, ctx.body.loads[0].reefer.power], [41.2, 'on']);
  assert.equal(ctx.body.driver.phone, '7863142671');
  assert.equal(ctx.body.dispatch.kind, 'office', 'no dispatch number set → the office line, labelled as such');
  assert.deepEqual([ctx.body.sendsTo.dispatch, ctx.body.sendsTo.maintenance], [true, true]);

  const body = { clientId: 'c1', ...base, tires: [{ axle: 2, side: 'right', pos: 'outer' }], tireSize: '295/75R22.5', text: 'Lost air', callback: '7863142671', location: { source: 'truck', lat: 27.4, lng: -80.3, at: '2026-11-19T21:41:00Z' } };
  assert.equal((await h.call('POST /driver/me/breakdowns', { body: { clientId: 'c0' } })).status, 400);
  const made = await h.call('POST /driver/me/breakdowns', { body });
  assert.equal(made.status, 200); const { id } = made.body;
  assert.match(id, /^BK-1119-\d{3}$/);
  assert.equal((await h.call('POST /driver/me/breakdowns', { body })).body.id, id, 'a retry is the same report');
  assert.equal(h.pushes.length, 1, 'one alarm, not one per retry');
  assert.deepEqual(h.pushes[0].to, ['rosa@floridabeauty.us']);
  assert.equal(h.pushes[0].title, '🚨 Breakdown reported — truck 4504');
  assert.match(h.pushes[0].body, /^Trailer 18094 Tire · Stopped · Ferney Urrego/);
  assert.deepEqual([h.pushes[0].data.type, h.pushes[0].data.path], ['breakdown', '/truckmate?tab=roadcalls']);
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].quiet, true); assert.equal(h.opened[0].report, id, 'the road call knows its report'); assert.equal(h.opened[0].type, 'tire'); assert.equal(h.opened[0].tire.position.axle, 'trailer');

  const jpg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const up = (q = {}, hd = {}, b = jpg) => h.call('POST /driver/me/breakdowns/:id/files', { params: { id }, query: { name: 'tire.jpg', ...q }, headers: { 'content-type': 'image/jpeg', ...hd }, body: b });
  assert.equal((await up({ key: 'f1' })).status, 200);
  assert.equal((await up({ key: 'f1' })).body.already, true); assert.equal(h.files.length, 1, 'stored once');
  assert.equal((await up({ key: 'f2' }, { 'content-type': 'application/pdf' })).status, 400);
  assert.equal((await up({ key: 'f3' }, { drv: '2473' })).status, 404, 'not their report');

  const sent = await h.call('POST /driver/me/breakdowns/:id/send', { params: { id } });
  assert.equal(sent.status, 200); assert.equal(h.mails.length, 1);
  assert.match(h.mails[0].subject, /^BREAKDOWN \/\/ TRAILER 18094 \/\/ TIRE/); assert.equal(h.mails[0].attachments.length, 1);
  assert.equal((await h.call('POST /driver/me/breakdowns/:id/send', { params: { id } })).body.already, true); assert.equal(h.mails.length, 1, 'once');

  const n = await h.call('POST /driver/me/breakdowns/:id/notes', { params: { id }, body: { clientId: 'n1', text: 'Shoulder is narrow' } });
  assert.equal((await h.call('POST /driver/me/breakdowns/:id/notes', { params: { id }, body: { clientId: 'n1', text: 'x' } })).body.noteId, n.body.noteId);
  await up({ key: 'f4', note: n.body.noteId });
  await h.call('POST /driver/me/breakdowns/:id/send', { params: { id }, query: { note: n.body.noteId } });
  assert.equal(h.mails.length, 2); assert.match(h.mails[1].subject, /^UPDATE/); assert.equal(h.mails[1].attachments.length, 1, 'only the update\'s photo');

  const con = await h.call('GET /truckmate/breakdowns');
  assert.equal(con.body.reports[0].links.length, 2); assert.match(con.body.reports[0].links[0].url, /\/bk\/f\/.+/); assert.equal(con.body.reports[0].links[1].note, n.body.noteId);
  let list = await h.call('GET /driver/me/breakdowns');
  assert.deepEqual([list.body.reports[0].id, list.body.reports[0].state, list.body.reports[0].photos], [id, 'waiting', 2]);
  h.rcs[0].status = 'tech en route'; h.rcs[0].provider = { name: 'Michelin ONCall', eta: '10:30 PM', at: '2026-11-19T22:05:00Z' };
  list = await h.call('GET /driver/me/breakdowns/:id', { params: { id } });
  assert.deepEqual([list.body.report.state, list.body.report.provider.eta], ['enroute', '10:30 PM']);
  await h.call('POST /truckmate/breakdowns/:id/status', { params: { id }, body: { status: 'resolved' } });
  h.rcs[0].status = 'on site';
  assert.equal((await h.call('GET /driver/me/breakdowns/:id', { params: { id } })).body.report.state, 'resolved');
});

test('breakdown: the email failing still leaves the report received, and says so', async () => {
  const h = harness({ mailFails: true });
  const made = await h.call('POST /driver/me/breakdowns', { body: { clientId: 'c9', ...base } });
  const s = await h.call('POST /driver/me/breakdowns/:id/send', { params: { id: made.body.id } });
  assert.equal(s.status, 502); assert.equal(s.body.received, true);
  assert.equal((await h.call('GET /driver/me/breakdowns')).body.reports.length, 1);
});

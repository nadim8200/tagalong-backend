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

test('breakdown email (Jarvis layout): title, equipment, report and time, road-call next step, driver words escaped, tire, GPS + map, tel link, files with their real status', () => {
  const r = { ...cleanReport({ ...base, tires: [{ axle: 2, side: 'right', pos: 'outer' }], tireSize: '295/75r22.5', text: 'Lost air <fast>', callback: '786-314-2671', location: { source: 'truck', lat: 27.4, lng: -80.3, address: 'I-95 N, Fort Pierce, FL', at: '2026-11-19T21:41:00Z' } }).report,
    id: 'BK-1119-123', by: 'Ferney Urrego', driverCode: '986', at: '2026-11-19T21:43:00Z', roadCall: 'RC-1119-555' };
  const m = breakdownEmail(r, [{ id: 'p1', kind: 'photo', n: 1, size: 1000, url: 'https://x/bk/f/a' }, { id: 'v1', kind: 'video', n: 1, size: 9e6, url: 'https://x/bk/f/b' }], ['p1']);
  assert.equal(m.subject, 'Tire breakdown | Trailer 18094 | Trip 627549 | BK-1119-123');
  assert.match(m.html, /VEHICLE STOPPED/); assert.match(m.html, />Tire breakdown<\/h1>/); assert.match(m.html, /Trailer 18094 · Tire/);
  assert.match(m.html, /Review road call RC-1119-555 in the console\. Approval is required to send road service\./);
  assert.match(m.html, /Lost air &lt;fast&gt;/); assert.doesNotMatch(m.html, /<fast>/);
  assert.match(m.html, /href="tel:\+17863142671"/); assert.match(m.html, /Axle 2 · Right · Outer/); assert.match(m.html, /295\/75R22\.5/);
  assert.match(m.html, /27\.40000, -80\.30000 \(truck GPS, as of Nov 19, 4:41 PM ET\)/); assert.match(m.html, /href="https:\/\/maps\.google\.com\/\?q=27\.40000,-80\.30000"/);
  assert.match(m.html, /Photo 1<\/a><\/b><br><span[^>]*>Attached to this email · link works 30 days/); assert.match(m.html, /Video 1<\/a><\/b><br><span[^>]*>Not attached · link works 30 days/);
  assert.doesNotMatch(m.html, /TEST · SAMPLE DATA/, 'no test notice on a real report');
  assert.match(m.text, /Photo 1 \(attached\): https:\/\/x\/bk\/f\/a/); assert.match(m.text, /Callback: \(786\) 314-2671/);
  assert.match(m.html, /href="https:\/\/mytagalong\.app\/truckmate\?trip=627549&amp;bk=BK-1119-123"[^>]*>Open in the console/);
  assert.match(m.text, /Open in the console: https:\/\/mytagalong\.app\/truckmate\?trip=627549&bk=BK-1119-123/);
  const done = breakdownEmail(r, [], [], null, { rcStatus: 'sent' });
  assert.match(done.html, /Road call RC-1119-555 is sent in the console\./); assert.doesNotMatch(done.html, /Approval is required/);
});

test('breakdown update: the latest words first; "status needs reconciliation" only when the road call still waits and the driver says service is there', () => {
  const r = { ...cleanReport({ ...base, tires: [{ axle: 2, side: 'right', pos: 'outer' }] }).report, id: 'BK-1', by: 'Ferney Urrego', at: '2026-11-19T21:43:00Z', roadCall: 'RC-1' };
  const u = breakdownEmail(r, [], [], { text: 'Ya llegó la grúa de servicio, están cambiando la llanta.', at: '2026-11-19T22:00:00Z' }, { rcStatus: 'gathering' });
  assert.equal(u.subject, 'Breakdown update | BK-1 | Trip 627549');
  assert.ok(u.html.indexOf('Latest driver update') < u.html.indexOf('Driver &amp; equipment'), 'the update comes before the details');
  assert.match(u.html, /Original message · Spanish · Nov 19, 5:00 PM ET/); assert.match(u.html, /Status needs reconciliation/);
  assert.doesNotMatch(u.html, /Approval is required to send road service/, 'no second "send service" instruction on an update');
  assert.doesNotMatch(breakdownEmail(r, [], [], { text: 'Sigo esperando.', at: '2026-11-19T22:00:00Z' }, { rcStatus: 'gathering' }).html, /Status needs reconciliation/);
  assert.doesNotMatch(breakdownEmail(r, [], [], { text: 'Ya llegó la grúa.', at: '2026-11-19T22:00:00Z' }, { rcStatus: 'tech en route' }).html, /Status needs reconciliation/);
});

test('accident: driver-reported answers; a missing answer stays "Not answered", never "No"', () => {
  const a = { ...cleanReport({ status: 'stopped', part: 'truck', category: 'accident', truck: '4504', trip: '627549', answers: { hurt: 'no', policeHere: 'yes' } }).report, id: 'BK-2', at: '2026-11-19T21:43:00Z', roadCall: 'RC-2' };
  const m = breakdownEmail(a, []);
  assert.equal(m.subject, 'Accident reported | Truck 4504 | Trip 627549 | BK-2');
  assert.match(m.html, /Accident details · driver reported/i);
  assert.match(m.html, /Anyone hurt<\/td><td[^>]*>No</); assert.match(m.html, /Police on the scene<\/td><td[^>]*>Yes</);
  assert.match(m.html, /Other vehicles involved<\/td><td[^>]*>Not answered</); assert.match(m.html, /Police report<\/td><td[^>]*>Not given</);
  assert.match(m.html, /Review accident details and road call RC-2/);
  const reefer = breakdownEmail({ ...cleanReport({ status: 'unsure', part: 'reefer', category: 'temp', trailer: '18094', reefer: { current: 41.2, set: 34, source: 'telemetry', at: '2026-11-19T21:30:00Z', power: 'on' } }).report, id: 'BK-3', at: '2026-11-19T21:43:00Z' }, []);
  assert.match(reefer.html, /Reefer readings/i); assert.match(reefer.html, /41\.2°F/); assert.match(reefer.html, /No road call is open/); assert.match(reefer.html, /No location was sent/);
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
  assert.deepEqual(ctx.body.dispatch, { phone: '305-395-5415', kind: 'dispatch' }, 'RingCentral not reachable → the main number as we know it');
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
  assert.deepEqual([h.pushes[0].data.type, h.pushes[0].data.path], ['breakdown', `/truckmate?trip=627549&bk=${id}`], 'the push opens the load with the form filled in');
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].quiet, true); assert.equal(h.opened[0].report, id, 'the road call knows its report'); assert.equal(h.opened[0].type, 'tire'); assert.equal(h.opened[0].tire.position.axle, 'trailer');

  const jpg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const up = (q = {}, hd = {}, b = jpg) => h.call('POST /driver/me/breakdowns/:id/files', { params: { id }, query: { name: 'tire.jpg', ...q }, headers: { 'content-type': 'image/jpeg', ...hd }, body: b });
  assert.equal((await up({ key: 'f1' })).status, 200);
  assert.equal((await up({ key: 'f1' })).body.already, true); assert.equal(h.files.length, 1, 'stored once');
  assert.equal((await up({ key: 'f2' }, { 'content-type': 'application/pdf' })).status, 400);
  assert.equal((await up({ key: 'f3' }, { drv: '2473' })).status, 404, 'not their report');

  const sent = await h.call('POST /driver/me/breakdowns/:id/send', { params: { id } });
  assert.equal(sent.status, 200); assert.equal(h.mails.length, 1);
  assert.match(h.mails[0].subject, /^Tire breakdown \| Trailer 18094 \| Trip 627549 \| BK-/); assert.equal(h.mails[0].attachments.length, 1);
  assert.equal((await h.call('POST /driver/me/breakdowns/:id/send', { params: { id } })).body.already, true); assert.equal(h.mails.length, 1, 'once');

  const n = await h.call('POST /driver/me/breakdowns/:id/notes', { params: { id }, body: { clientId: 'n1', text: 'Shoulder is narrow' } });
  assert.equal((await h.call('POST /driver/me/breakdowns/:id/notes', { params: { id }, body: { clientId: 'n1', text: 'x' } })).body.noteId, n.body.noteId);
  await up({ key: 'f4', note: n.body.noteId });
  await h.call('POST /driver/me/breakdowns/:id/send', { params: { id }, query: { note: n.body.noteId } });
  assert.equal(h.mails.length, 2); assert.match(h.mails[1].subject, /^Breakdown update \| BK-/); assert.equal(h.mails[1].attachments.length, 1, 'only the update\'s photo');

  const con = await h.call('GET /truckmate/breakdowns');
  assert.equal(con.body.reports[0].links.length, 2); assert.match(con.body.reports[0].links[0].url, /\/bk\/f\/.+/); assert.equal(con.body.reports[0].links[1].note, n.body.noteId);
  let list = await h.call('GET /driver/me/breakdowns');
  assert.deepEqual([list.body.reports[0].id, list.body.reports[0].state, list.body.reports[0].photos], [id, 'waiting', 2]);
  h.rcs[0].status = 'tech en route'; h.rcs[0].provider = { name: 'Michelin ONCall', eta: '10:30 PM', at: '2026-11-19T22:05:00Z' };
  list = await h.call('GET /driver/me/breakdowns/:id', { params: { id } });
  assert.deepEqual([list.body.report.state, list.body.report.provider.eta], ['enroute', '10:30 PM']);
  await h.call('POST /truckmate/breakdowns/:id/forwarded', { params: { id }, body: { subject: 'TRAILER 18094 BREAKDOWN' } });
  assert.ok((await h.call('GET /truckmate/breakdowns')).body.reports[0].forwardedAt, 'the card stops asking once dispatch sent it');
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

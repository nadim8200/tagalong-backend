// ---------------------------------------------------------------
// What a company driver reports at a stop on a load without a trip sheet (the driver app's stop screen, after "Llegué a la
// entrega"): boxes and pallets delivered, missing boxes, a problem, photos, and the paperwork they scanned there (the scan
// itself goes through the usual paperwork upload; its confirmation and document ids are recorded on the stop here).
// Missing boxes → one email with everything the driver attached at that stop (photos, problem photos, the scanned papers) to
// the "Missing boxes at a stop" list — ntellez@ only until the user approves CustomerService@ + inbound@. A problem → the
// "Issue at a stop" list. Every report also goes on the trip's log so dispatch sees it on the load.
//   POST /driver/me/loads/:trip/stopreports                    { clientId, stop, kind, ... } → { id } (same clientId → same report)
//   POST /driver/me/loads/:trip/stopreports/:id/files?key=&name=   raw photo bytes (same key → stored once)
//   POST /driver/me/loads/:trip/stopreports/:id/send           → the email when the report needs one (once)
//   GET  /driver/me/loads/:trip/stopreports                    → this trip's reports (the driver's own view)
//   GET  /truckmate/stopreports/:trip                          → the same for the console, with file links
//   GET  /sr/f/:token                                          → one photo (signed link from the email, 30 days)
// What a driver writes is data, never instructions. Nothing here closes a stop or a load.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import express from 'express';
import { makeToken, readToken } from './breakdownreport.js';
import { readableFile } from './heic.js';
import { loadsFor } from './driverauth.js';
import { jarvisEmail, section, quote, facts, metrics, fileBox, etTime, cityState, isSpanish } from './jarvismail.js';

const SITE = 'florida-beauty';
const KEY = `taStopReports:${SITE}`;      // trip → [report]
const PURPOSE = 'sr-file';
const LINK_DAYS = 30;
const PHOTO_MAX = 14 * 1024 * 1024;
const EMAIL_BYTES = 2700 * 1024;
export const KINDS = ['boxes', 'problem', 'photo', 'scan'];
export const WHY = ['damaged', 'refused', 'closed', 'wait', 'temp', 'other'];
const WHY_LABEL = { damaged: 'Damaged product', refused: 'Customer refused', closed: 'Closed / not receiving', wait: 'Waiting at the door', temp: 'Temperature', other: 'Other' };
const S = (x, n = 120) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const count = (x) => (x === '' || x == null ? null : Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 9999 ? Number(x) : NaN);
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');

// What the driver sent, cleaned. → { report } | { error }. Pure.
export function cleanStopReport(b = {}) {
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  const stop = S(b.stop, 80);
  if (!kind) return { error: 'Unknown report.' };
  if (!stop) return { error: 'Which stop?' };
  const note = String(b.note || '').trim().slice(0, 2000);
  const r = { kind, stop, stopName: S(b.stopName, 120) || null, note };
  if (kind === 'boxes') {
    const boxes = count(b.boxes); const pallets = count(b.pallets); const missing = count(b.missing);
    if (boxes == null || Number.isNaN(boxes)) return { error: 'Enter the boxes you delivered.' };
    if (Number.isNaN(pallets)) return { error: 'Pallets has to be a whole number.' };
    if (Number.isNaN(missing)) return { error: 'Missing boxes has to be a whole number.' };
    if (b.reportMissing && !missing) return { error: 'Enter how many boxes are missing.' };
    Object.assign(r, { boxes, pallets, missing: b.reportMissing ? missing : null, expected: count(b.expected) || null, ...(b.noPaperwork ? { noPaperwork: true } : {}) });   // "No paperwork at this stop" when finishing it
  }
  if (kind === 'problem') {
    if (!WHY.includes(b.why)) return { error: 'Pick what happened.' };
    r.why = b.why;
  }
  if (kind === 'scan') {
    r.confirmation = S(b.confirmation, 30) || null; r.paper = S(b.paper, 20) || null; r.bill = S(b.bill, 14) || null;
    r.docIds = (Array.isArray(b.docIds) ? b.docIds : []).map((x) => String(x)).filter((x) => /^\d{1,18}$/.test(x)).slice(0, 20);
  }
  return { report: r };
}

// The email: missing boxes, or a problem, at one stop — in the Jarvis layout (jarvismail.js), customer first. Pure. → { subject, html, text }
const PROBLEM_TITLE = { damaged: 'Damaged product', refused: 'Customer refusal', closed: 'Closed / not receiving', wait: 'Waiting at the door', temp: 'Temperature problem', other: 'Problem at a stop' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : (w === 'box' ? 'es' : 's')}`;
export function stopEmail(r, { trip, driver, driverCode = null, truck, trailer, others = [], links = [], attached = [], scans = [], test = false }) {
  const shortage = r.kind === 'boxes';
  const customer = r.stopName || r.stop;
  const place = cityState(r.stop);
  const title = shortage ? 'Delivery shortage' : PROBLEM_TITLE[r.why] || 'Problem at a stop';
  const subject = shortage ? [`${plural(r.missing, 'box')} missing`, place, `Trip ${trip}`].join(' | ') : [title, place, `Trip ${trip}`].join(' | ');
  const when = etTime(Date.parse(r.at));
  const tone = shortage ? 'amber' : ['refused', 'damaged'].includes(r.why) ? 'red' : 'amber';
  const earlier = others.length > 0;
  const lead = shortage ? (r.expected ? `${r.boxes} of ${r.expected} expected boxes delivered.` : `${plural(r.boxes, 'box')} delivered; ${plural(r.missing, 'box')} missing.`)
    : `Reported by the driver at this stop.${earlier ? ' The earlier delivery count is shown separately below.' : ''}`;
  const metricsStrip = shortage ? metrics([['EXPECTED', r.expected != null ? r.expected : '—'], ['DELIVERED', r.boxes], ['MISSING', r.missing, '#b45309'], ['PALLETS', r.pallets != null ? r.pallets : '—']]) : '';
  const msg = r.note ? section("Driver's message", quote(r.note, `Original message${isSpanish(r.note) ? ' · Spanish' : ''}`)) : '';
  const driverRows = facts([['Driver', `${driver || 'Driver'}${driverCode ? ` (ID ${driverCode})` : ''}`], ['Truck / trailer', `${truck || '—'} / ${trailer || '—'}`], ['Trip', trip]]);
  const details = shortage ? facts([['Boxes delivered', r.expected ? `${r.boxes} of ${r.expected} in TruckMate` : String(r.boxes)], ['Pallets delivered', r.pallets != null ? String(r.pallets) : 'Not given'], ['Missing', plural(r.missing, 'box')], ...others.map((o) => [o.label, o.text])])
    : facts([['What happened', PROBLEM_TITLE[r.why] || r.why], ...others.map((o) => [o.label, o.text])]);
  const paper = scans.length ? section('Scanned paperwork', scans.map((s) => fileBox([s.paper, s.bill].filter(Boolean).join(' · ') || 'Paperwork', [s.confirmation ? `Confirmation ${s.confirmation}` : null, s.attached ? 'Attached to this email' : 'In the trip documents (not attached)'].filter(Boolean).join(' · '))).join('')) : '';
  const photos = section('Photos & videos', links.length ? links.map((l) => fileBox(l.label, attached.includes(l.id) ? `Attached to this email${l.url ? ` · link works ${LINK_DAYS} days` : ''}` : `Not attached (too big for one email) · link works ${LINK_DAYS} days`, l.url)).join('')
    : '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#65778c">No photos.</p>');
  const body = [metricsStrip, msg, section('Driver & equipment', driverRows), section('Delivery details', details), paper, photos].join('');
  const html = jarvisEmail({ test, preheader: [customer, place, shortage ? `${plural(r.missing, 'box')} missing` : title].filter(Boolean).join(' · '), eyebrow: shortage ? `${plural(r.missing, 'box')} missing` : (PROBLEM_TITLE[r.why] || 'Problem').toUpperCase(),
    tone, title, subtitle: customer, place, meta: [`Trip ${trip}`, when], lead, body });
  const text = [test ? 'TEST · SAMPLE DATA · NOT A REAL REPORT\n' : null, `${title.toUpperCase()} — ${customer}, ${place}`, `Trip ${trip} · ${when}`, '', lead,
    shortage ? `Expected ${r.expected != null ? r.expected : '—'} · Delivered ${r.boxes} · Missing ${r.missing} · Pallets ${r.pallets != null ? r.pallets : '—'}` : `What happened: ${PROBLEM_TITLE[r.why] || r.why}`, ...others.map((o) => `${o.label}: ${o.text}`), '',
    `Driver's message: ${r.note || '(nothing written)'}`, '', `Driver: ${driver || 'Driver'}${driverCode ? ` (ID ${driverCode})` : ''}`, `Truck / trailer: ${truck || '—'} / ${trailer || '—'}`, `Trip: ${trip}`,
    ...(scans.length ? ['', 'Scanned paperwork:', ...scans.map((s) => `${[s.paper, s.bill, s.confirmation ? `confirmation ${s.confirmation}` : null].filter(Boolean).join(' · ')}${s.attached ? ' (attached)' : ''}`)] : []),
    '', ...links.map((l) => `${l.label}${attached.includes(l.id) ? ' (attached)' : ''}: ${l.url}`), '', 'Jarvis · AI Dispatcher · Florida Beauty Flora'].filter((x) => x != null).join('\n');
  return { subject, html, text };
}

// One line for the trip's log (dispatch sees it on the load). Pure.
export function logLine(r, by) {
  const at = r.stopName || r.stop;
  if (r.kind === 'boxes') return `${by || 'Driver'} at ${at}: delivered ${r.boxes} box${r.boxes === 1 ? '' : 'es'}${r.expected ? ` of ${r.expected}` : ''}${r.pallets != null ? `, ${r.pallets} pallet${r.pallets === 1 ? '' : 's'}` : ''}${r.missing ? ` — ${r.missing} MISSING` : ''}${r.note ? ` · "${r.note.slice(0, 160)}"` : ''}`;
  if (r.kind === 'problem') return `${by || 'Driver'} reported a problem at ${at}: ${WHY_LABEL[r.why]}${r.note ? ` · "${r.note.slice(0, 160)}"` : ''}`;
  if (r.kind === 'scan') return `${by || 'Driver'} scanned paperwork at ${at}${r.paper ? ` (${r.paper.toUpperCase()}${r.bill ? ` ${r.bill}` : ''})` : ''}${r.confirmation ? ` · confirmation ${r.confirmation}` : ''}`;
  return `${by || 'Driver'} sent photos at ${at}${r.note ? ` · "${r.note.slice(0, 160)}"` : ''}`;
}

export function initStopReports(app, { db, secret, requireDriver, requireAuth = null, getBoard = null, docs = null, sendMail = null, recipients = {}, log = null, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled && db.pool);
  let ready = null;
  const table = () => {
    if (!ready) ready = db.pool.query(`CREATE TABLE IF NOT EXISTS ta_stop_files (id TEXT PRIMARY KEY, site TEXT NOT NULL, trip TEXT NOT NULL, report_id TEXT NOT NULL, file_key TEXT, filename TEXT, media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data BYTEA NOT NULL)`).then(() => db.pool.query('CREATE INDEX IF NOT EXISTS ta_stop_files_trip ON ta_stop_files (trip)')).catch((e) => { ready = null; throw e; });
    return ready;
  };
  const listOf = async (trip) => (((await db.get(KEY, {})) || {})[String(trip)] || []);
  const patch = (trip, id, fn) => db.update(KEY, (cur) => { const c = { ...(cur || {}) }; c[trip] = (c[trip] || []).map((x) => (x.id === id ? fn(x) : x)); return c; }, {});
  const items = async () => (getBoard ? (((await getBoard(SITE).catch(() => null)) || {}).trips || []) : []);
  // the trip has to be one of the driver's loads
  const mine = async (req, res) => {
    const trip = String(req.params.trip);
    const all = await items();
    const l = loadsFor(req.driver.code, all);
    const load = [...l.current, ...l.next].find((x) => x.trip === trip);
    if (!load) { res.status(404).json({ error: 'That load is not yours.' }); return null; }
    return { trip, load };
  };
  const link = (f) => `${baseUrl}/sr/f/${makeToken({ f: f.id }, secret, now(), PURPOSE, LINK_DAYS)}`;

  if (app && requireDriver) {
    app.post('/driver/me/loads/:trip/stopreports', requireDriver, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Not available right now. Call dispatch.' });
      const m = await mine(req, res); if (!m) return null;
      const b = req.body || {};
      const clientId = S(b.clientId, 60);
      if (!clientId) return res.status(400).json({ error: 'Missing report key.' });
      const c = cleanStopReport(b);
      if (c.error) return res.status(400).json({ error: c.error });
      const had = (await listOf(m.trip)).find((x) => x.clientId === clientId);
      if (had) return res.json({ ok: true, id: had.id, already: true });
      const r = { id: `sr${now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, clientId, ...c.report, by: req.driver.name || null, driverCode: String(req.driver.code), at: new Date(now()).toISOString(), files: [], sentAt: null };
      await db.update(KEY, (cur) => ({ ...(cur || {}), [m.trip]: [...((cur || {})[m.trip] || []), r].slice(-200) }), {});
      if (log) await log(SITE, m.trip, { type: 'note', kind: 'stopreport', text: logLine(r, r.by), by: r.by || 'driver app' }).catch(() => {});
      return res.json({ ok: true, id: r.id, needsSend: (r.kind === 'boxes' && !!r.missing) || r.kind === 'problem' });
    });
    app.post('/driver/me/loads/:trip/stopreports/:id/files', requireDriver, express.raw({ type: () => true, limit: PHOTO_MAX }), async (req, res) => {
      const m = await mine(req, res); if (!m) return null;
      const r = (await listOf(m.trip)).find((x) => x.id === String(req.params.id));
      if (!r) return res.status(404).json({ error: 'Report not found.' });
      const fileKey = S(req.query.key, 60) || null;
      if (fileKey && (r.files || []).some((f) => f.key === fileKey)) return res.json({ ok: true, already: true });
      let buf = Buffer.isBuffer(req.body) ? req.body : null;
      let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let name = S(req.query.name || 'photo.jpg', 80).replace(/[^\w.\- ]+/g, '') || 'photo.jpg';
      if (!buf || !buf.length) return res.status(400).json({ error: 'No photo came through.' });
      if (!/^image\//.test(type)) return res.status(400).json({ error: 'Only photos.' });
      const f = await readableFile({ filename: name, mediaType: type, dataBase64: buf.toString('base64') });
      buf = Buffer.from(String(f.dataBase64 || ''), 'base64'); type = f.mediaType || type; name = f.filename || name;
      try {
        await table();
        const fid = crypto.randomBytes(9).toString('hex');
        await db.pool.query('INSERT INTO ta_stop_files (id, site, trip, report_id, file_key, filename, media_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [fid, SITE, m.trip, r.id, fileKey, name, type, buf.length, buf]);
        await patch(m.trip, r.id, (x) => ({ ...x, files: [...(x.files || []), { id: fid, key: fileKey, name, type, size: buf.length }] }));
      } catch { return res.status(500).json({ error: 'Could not save the photo. Try again.' }); }
      return res.json({ ok: true });
    });
    app.post('/driver/me/loads/:trip/stopreports/:id/send', requireDriver, async (req, res) => {
      const m = await mine(req, res); if (!m) return null;
      const all = await listOf(m.trip);
      const r = all.find((x) => x.id === String(req.params.id));
      if (!r) return res.status(404).json({ error: 'Report not found.' });
      if (r.sentAt) return res.json({ ok: true, already: true, sentAt: r.sentAt });
      if (!((r.kind === 'boxes' && r.missing) || r.kind === 'problem')) return res.json({ ok: true, noEmail: true });
      const out = await send(m, r, all).catch((e) => ({ error: e.message }));
      if (out.error) return res.status(502).json({ error: 'Saved, but the email did not go out. Call dispatch.', saved: true });
      return res.json({ ok: true, sentAt: out.sentAt });
    });
    app.get('/driver/me/loads/:trip/stopreports', requireDriver, async (req, res) => {
      const m = await mine(req, res); if (!m) return null;
      return res.json({ reports: (await listOf(m.trip)).map(({ clientId, driverCode, ...r }) => ({ ...r, photos: (r.files || []).length, files: undefined })) });
    });
  }
  // paperwork the driver sent from the Paperwork tab (bill, boxes, scan) goes on its bill's stop too — as a scan line (Nov 21)
  async function paperworkAsReports(trip) {
    const list = ((await db.get(`taDriverPaperwork:${SITE}`, [])) || []).filter((p) => String(p.trip) === trip);
    if (!list.length) return [];
    const it = getBoard ? (((await getBoard(SITE).catch(() => ({}))) || {}).trips || []).find((x) => String(((x && x.trip) || x || {}).tripNumber || '') === trip) : null;
    const bills = (it && (it.freightBills || it.orders)) || [];
    return list.map((p, i) => {
      const b = bills.find((x) => String(x.billNumber || '') === String(p.bill || ''));
      const stop = b ? String(b.endZoneDescription || '').replace(/,\s*\d{5}(-\d{4})?\s*$/, '') : null;
      return stop ? { id: `pw-${trip}-${i}`, kind: 'scan', stop, stopName: b.billToName || null, paper: p.kind || null, bill: p.bill || null, boxes: p.boxes != null ? p.boxes : null, confirmation: p.confirmation || null, docIds: (p.docIds || []).map(String), at: p.at, by: p.by || null, from: 'Paperwork tab' } : null;
    }).filter(Boolean);
  }
  if (app && requireAuth) app.get('/truckmate/stopreports/:trip', requireAuth, async (req, res) => { const trip = String(req.params.trip); const own = (await listOf(trip)).map((r) => ({ ...r, links: (r.files || []).map((f) => ({ name: f.name, url: link(f) })) })); const pw = await paperworkAsReports(trip).catch(() => []); res.json({ reports: [...own, ...pw.filter((p) => !own.some((r) => r.kind === 'scan' && r.confirmation && r.confirmation === p.confirmation))] }); });
  if (app) {
    app.get('/sr/f/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p || !p.f) return res.status(404).send('This link has expired or is not valid.');
      try {
        await table();
        const { rows } = await db.pool.query('SELECT filename, media_type, data FROM ta_stop_files WHERE id = $1 AND site = $2', [p.f, SITE]);
        if (!rows[0]) return res.status(404).send('Not found.');
        res.setHeader('Content-Type', rows[0].media_type);
        res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].filename || 'photo').replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.end(rows[0].data);
      } catch { return res.status(500).send('Could not open it.'); }
    });
  }

  // the email carries everything the driver attached at that stop: every photo, and the paperwork scanned there
  async function send(m, r, all) {
    const list = r.kind === 'boxes' ? recipients.shortage : recipients.issue;
    const to = list ? await list() : [];
    if (!to.length) throw new Error('No one is on the list.');
    if (!sendMail) throw new Error('Email is not set up.');
    const here = all.filter((x) => x.stop === r.stop);
    const photos = here.flatMap((x) => (x.files || []).map((f) => ({ ...f, from: x })));
    const links = photos.map((f, i) => ({ id: f.id, label: `Photo ${i + 1}${f.from.kind === 'problem' ? ' (problem)' : f.from.id === r.id ? '' : f.from.kind === 'boxes' ? ' (boxes)' : ''}`, url: link(f) }));
    const attachments = []; const attached = []; let room = EMAIL_BYTES;
    const scans = here.filter((x) => x.kind === 'scan').map((x) => ({ paper: x.paper ? x.paper.toUpperCase() : null, bill: x.bill, confirmation: x.confirmation, docIds: x.docIds || [], attached: false }));
    // the scanned papers first (they are the proof), then the photos, as far as they fit
    if (docs && docs.readDocs) {
      for (const s of scans) {
        const got = s.docIds.length ? await docs.readDocs({ site: SITE, ids: s.docIds }).catch(() => []) : []; // eslint-disable-line no-await-in-loop
        for (const d of got) if (d.data.length <= room) { room -= d.data.length; s.attached = true; attachments.push({ name: `${s.paper || 'paperwork'}-${s.bill || r.stop}.pdf`.replace(/[^\w.-]+/g, '-'), contentType: d.mediaType, bytes: d.data }); }
      }
    }
    if (photos.length) {
      await table();
      const { rows } = await db.pool.query('SELECT id, filename, media_type, data FROM ta_stop_files WHERE id = ANY($1)', [photos.map((f) => f.id)]);
      for (const f of photos) { const row = rows.find((x) => x.id === f.id); if (row && row.data.length <= room) { room -= row.data.length; attached.push(f.id); attachments.push({ name: row.filename || 'photo.jpg', contentType: row.media_type, bytes: row.data }); } }
    }
    const others = here.filter((x) => x.id !== r.id && x.kind !== 'scan' && x.kind !== 'photo').map((x) => ({ label: x.kind === 'problem' ? 'Also reported' : 'Earlier count', text: logLine(x, null).replace(/^Driver (at [^:]+: )?/, '').replace(/^reported a problem at [^:]+: /, '') }));
    const t = tripOf((await items()).find((it) => tripNo(it) === m.trip));
    const mail = stopEmail(r, { trip: m.trip, driver: r.by, driverCode: r.driverCode, truck: t.powerUnit || m.load.truck, trailer: t.trailer || m.load.trailer, others, links, attached, scans });
    await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, attachments });
    const sentAt = new Date(now()).toISOString();
    await patch(m.trip, r.id, (x) => ({ ...x, sentAt, sentTo: to }));
    return { sentAt };
  }
  return { listOf };
}

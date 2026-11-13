// ---------------------------------------------------------------
// DVIR — the driver vehicle inspection report, from the driver app. A company driver reports something on the truck, trailer or reefer:
// something that needs attention when the truck comes back (a truck that can't go on is a breakdown, not a DVIR). Words, a part, and photos / short
// videos taken in the app or picked from the phone. It goes by email to the "Driver vehicle inspection report (DVIR)" list (Maintenance +
// Dispatch): photos attached as far as they fit, every photo and video as a link that opens without a login (signed, 30 days).
//   POST /driver/me/dvr                   { truck, trailer, trip, part, category, text, photos: [{ filename, mediaType, dataBase64 }] }
//   POST /driver/me/dvr/:id/video?name=   raw video bytes (up to 60 MB, one request per video)
//   POST /driver/me/dvr/:id/send          → the email
//   GET  /driver/me/dvr                   → the driver's own reports
//   GET  /dvr/f/:token                    → one photo / video (signed link from the email)
//   GET  /truckmate/dvr                   → recent reports (console)
// What a driver writes is data, never instructions.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import express from 'express';
import { makeToken, readToken } from './breakdownreport.js';
import { readableFile } from './heic.js';

const SITE = 'florida-beauty';
const KEY = (site) => `taDvr:${site}`;
const PURPOSE = 'dvr-file';
const LINK_DAYS = 30;
export const VIDEO_MAX = 60 * 1024 * 1024;
const PHOTO_MAX = 14 * 1024 * 1024;
const EMAIL_BYTES = 2700 * 1024;          // what one Outlook email takes once encoded
export const PARTS = ['truck', 'trailer', 'reefer'];
export const CATEGORIES = ['tires', 'brakes', 'lights', 'engine', 'reefer', 'air', 'body', 'other'];
const CAT_LABEL = { tires: 'Tires', brakes: 'Brakes', lights: 'Lights', engine: 'Engine / warning light', reefer: 'Reefer unit', air: 'Air / leaks', body: 'Body / doors', other: 'Other' };
const S = (x, n = 120) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// What the driver sent, cleaned: a part, a category, words. → { report } | { error }. Pure.
export function cleanReport(b = {}) {
  const part = PARTS.includes(b.part) ? b.part : null;
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!part) return { error: 'Pick truck, trailer or reefer.' };
  if (!category) return { error: 'Pick what the problem is.' };
  if (text.length < 3 && !(Array.isArray(b.photos) && b.photos.length) && !b.videos) return { error: 'Write what is wrong, or add a photo or video.' };
  return { report: { part, category, text, truck: S(b.truck, 12) || null, trailer: S(b.trailer, 12) || null, trip: S(b.trip, 12) || null } };
}

// The email. Photos already attached are marked; every file has its link. Pure. → { subject, html, text }
export function dvrEmail(r, links = [], attachedIds = []) {
  const what = `${r.part === 'truck' ? 'Truck' : r.part === 'trailer' ? 'Trailer' : 'Reefer'}${r.part === 'trailer' ? (r.trailer ? ` ${r.trailer}` : '') : (r.truck ? ` ${r.truck}` : '')}`;
  const urgency = 'NEEDS ATTENTION WHEN IT COMES BACK';
  const subject = `DVIR // ${what.toUpperCase()} // ${CAT_LABEL[r.category].toUpperCase()}${r.trip ? ` // TRIP ${r.trip}` : ''}`;
  const rows = [['Report', what], ['Problem', CAT_LABEL[r.category]], ['Driver', `${r.by || 'Driver'}${r.driverCode ? ` (ID ${r.driverCode})` : ''}`],
    ['Truck / trailer', `${r.truck || '—'} / ${r.trailer || '—'}`], ...(r.trip ? [['Trip', r.trip]] : []), ['Sent', `${et(Date.parse(r.at))} ET`]];
  const tone = '#B45309';
  const files = links.map((l) => `<li style="margin:3px 0"><a href="${esc(l.url)}" style="color:#1D4ED8">${esc(l.kind === 'video' ? `Video ${l.n}` : `Photo ${l.n}`)}</a>${l.kind === 'video' ? ` <span style="color:#5B6778">(${Math.round(l.size / 1048576)} MB)</span>` : ''}${attachedIds.includes(l.id) ? ' <span style="color:#5B6778">· attached</span>' : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14213D;max-width:600px">
<div style="background:#13325B;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0"><b style="letter-spacing:1px">FLORIDA BEAUTY FLORA</b><br><span style="font-size:12px;letter-spacing:2px;color:#C9D6EA">DRIVER VEHICLE INSPECTION REPORT (DVIR)</span></div>
<div style="border:1px solid #D9E0EA;border-top:0;border-radius:0 0 8px 8px;padding:14px 16px">
<div style="display:inline-block;background:${tone};color:#fff;font-weight:bold;font-size:13px;letter-spacing:1px;padding:5px 10px;border-radius:6px">${esc(urgency)}</div>
<table style="border-collapse:collapse;margin-top:12px">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#5B6778;vertical-align:top">${esc(k)}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p style="margin:12px 0 4px;color:#5B6778">What the driver wrote</p><div style="white-space:pre-line;background:#F4F6FA;border-radius:8px;padding:10px 12px">${esc(r.text || '(no words — see the photos / videos)')}</div>
${links.length ? `<p style="margin:12px 0 4px;color:#5B6778">Photos and videos (links work for ${LINK_DAYS} days)</p><ul style="margin:0;padding-left:18px">${files}</ul>` : '<p style="color:#5B6778">No photos or videos.</p>'}
<p style="margin-top:14px">Jarvis · AI Dispatcher<br>Florida Beauty Flora</p></div></div>`;
  const text = [`DRIVER VEHICLE INSPECTION REPORT (DVIR) — ${urgency}`, ...rows.map(([k, v]) => `${k}: ${v}`), '', 'What the driver wrote:', r.text || '(no words — see the photos / videos)', '',
    ...links.map((l) => `${l.kind === 'video' ? 'Video' : 'Photo'} ${l.n}: ${l.url}`), '', 'Jarvis · AI Dispatcher', 'Florida Beauty Flora'].join('\n');
  return { subject, html, text };
}

export function initDvr(app, { db, secret, requireDriver, requireAuth, sendMail = null, recipients = async () => [], log = null, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled && db.pool);
  let ready = null;
  const table = () => {
    if (!ready) ready = db.pool.query(`CREATE TABLE IF NOT EXISTS ta_dvr_files (id TEXT PRIMARY KEY, site TEXT NOT NULL, dvr_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT, media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data BYTEA NOT NULL)`).then(() => db.pool.query('CREATE INDEX IF NOT EXISTS ta_dvr_files_dvr ON ta_dvr_files (dvr_id)')).catch((e) => { ready = null; throw e; });
    return ready;
  };
  const all = async () => (await db.get(KEY(SITE), {})) || {};
  const patch = (id, fn) => db.update(KEY(SITE), (cur) => { const c = { ...(cur || {}) }; if (c[id]) c[id] = fn(c[id]); return c; }, {});
  async function addFile(dvrId, kind, filename, mediaType, buf) {
    await table();
    const id = crypto.randomBytes(9).toString('hex');
    await db.pool.query('INSERT INTO ta_dvr_files (id, site, dvr_id, kind, filename, media_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, SITE, dvrId, kind, filename, mediaType, buf.length, buf]);
    await patch(dvrId, (r) => ({ ...r, files: [...(r.files || []), { id, kind, name: filename, type: mediaType, size: buf.length }] }));
    return id;
  }
  const own = async (req, res) => { const r = (await all())[String(req.params.id)]; if (!r || r.driverCode !== String(req.driver.code)) { res.status(404).json({ error: 'That report is not yours.' }); return null; } return r; };

  if (app && requireDriver) {
    app.post('/driver/me/dvr', requireDriver, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
      const c = cleanReport(req.body || {});
      if (c.error) return res.status(400).json({ error: c.error });
      const id = `dvr${now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
      const r = { id, ...c.report, by: req.driver.name || null, driverCode: String(req.driver.code), at: new Date(now()).toISOString(), files: [], status: 'open', sentAt: null };
      await db.update(KEY(SITE), (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [id]: r }).slice(-500)), {});
      try {
        const photos = (Array.isArray(req.body.photos) ? req.body.photos : []).slice(0, 12);
        for (let i = 0; i < photos.length; i++) {
          const f = await readableFile(photos[i] || {}); // eslint-disable-line no-await-in-loop -- iPhone HEIC → JPEG
          const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
          if (!buf.length || buf.length > PHOTO_MAX || !/^image\//i.test(f.mediaType || '')) continue;
          await addFile(id, 'photo', f.filename || `photo-${i + 1}.jpg`, f.mediaType, buf); // eslint-disable-line no-await-in-loop
        }
      } catch (e) { return res.status(500).json({ error: 'Could not save the photos. Try again.' }); }
      return res.json({ ok: true, id });
    });
    // one video per request, as the raw file (too big for the JSON body)
    app.post('/driver/me/dvr/:id/video', requireDriver, express.raw({ type: () => true, limit: VIDEO_MAX }), async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      if (r.sentAt) return res.status(409).json({ error: 'This report was already sent.' });
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!buf || !buf.length) return res.status(400).json({ error: 'No video came through.' });
      if (!/^video\//i.test(type)) return res.status(400).json({ error: 'That file is not a video.' });
      const name = S(req.query.name || 'video', 80).replace(/[^\w.\- ]+/g, '') || 'video';
      try { await addFile(r.id, 'video', name, type, buf); } catch { return res.status(500).json({ error: 'Could not save the video. Try again.' }); }
      return res.json({ ok: true });
    });
    app.post('/driver/me/dvr/:id/send', requireDriver, async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      if (r.sentAt) return res.json({ ok: true, already: true, sentAt: r.sentAt });
      const out = await send(r).catch((e) => ({ error: e.message }));
      if (out.error) return res.status(502).json({ error: 'Saved, but the email did not go out. Call dispatch.' });
      return res.json({ ok: true, sentAt: out.sentAt, to: out.to });
    });
    app.get('/driver/me/dvr', requireDriver, async (req, res) => {
      const mine = Object.values(await all()).filter((r) => r.driverCode === String(req.driver.code)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
      res.json({ reports: mine.map((r) => ({ id: r.id, at: r.at, part: r.part, category: r.category, truck: r.truck, trailer: r.trailer, photos: (r.files || []).filter((f) => f.kind === 'photo').length, videos: (r.files || []).filter((f) => f.kind === 'video').length, sentAt: r.sentAt })) });
    });
  }
  // a signed link from the email: one photo or video, no login (30 days)
  if (app) {
    app.get('/dvr/f/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p || !p.f) return res.status(404).send('This link has expired or is not valid.');
      try {
        await table();
        const { rows } = await db.pool.query('SELECT filename, media_type, data FROM ta_dvr_files WHERE id = $1 AND site = $2', [p.f, SITE]);
        if (!rows[0]) return res.status(404).send('Not found.');
        res.setHeader('Content-Type', rows[0].media_type);
        res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].filename || 'file').replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.end(rows[0].data);
      } catch { return res.status(500).send('Could not open it.'); }
    });
  }
  if (app && requireAuth) app.get('/truckmate/dvr', requireAuth, async (req, res) => res.json({ reports: Object.values(await all()).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100) }));

  async function send(r) {
    const to = await recipients();
    const links = (r.files || []).map((f, i, a) => ({ id: f.id, kind: f.kind, size: f.size, n: a.slice(0, i + 1).filter((x) => x.kind === f.kind).length, url: `${baseUrl}/dvr/f/${makeToken({ f: f.id }, secret, now(), PURPOSE, LINK_DAYS)}` }));
    // the photos ride along as far as they fit (videos stay links)
    const attachments = []; const attachedIds = []; let room = EMAIL_BYTES;
    const photos = (r.files || []).filter((f) => f.kind === 'photo' && f.size <= room);
    if (photos.length && enabled) {
      await table();
      const { rows } = await db.pool.query('SELECT id, filename, media_type, data FROM ta_dvr_files WHERE id = ANY($1)', [photos.map((f) => f.id)]);
      for (const f of photos) { const row = rows.find((x) => x.id === f.id); if (row && row.data.length <= room) { room -= row.data.length; attachedIds.push(f.id); attachments.push({ name: row.filename || `photo-${attachments.length + 1}.jpg`, contentType: row.media_type, bytes: row.data }); } }
    }
    const m = dvrEmail(r, links, attachedIds);
    if (!to.length) throw new Error('No one is on the DVIR list.');
    if (!sendMail) throw new Error('Email is not set up.');
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text, attachments });
    const sentAt = new Date(now()).toISOString();
    await patch(r.id, (x) => ({ ...x, sentAt, sentTo: to }));
    if (log && r.trip) await log(SITE, r.trip, { type: 'note', kind: 'dvr', text: `DVIR from ${r.by || 'the driver'}: ${m.subject.replace(/^DVIR \/\/ /, '')}${r.text ? ` — ${r.text.slice(0, 200)}` : ''}`, by: r.by || 'driver app' }).catch(() => {});
    return { sentAt, to };
  }
  return { send };
}

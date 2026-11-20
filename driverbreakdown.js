// ---------------------------------------------------------------
// Breakdown reports from the company driver app (the Avería / Breakdown tab). The driver says what happened (stopped / moving /
// not sure, truck / trailer / reefer, the kind of problem), the details that problem needs (which tires, the size, codes, reefer
// readings), where they are (truck GPS with its time, the phone's location, or typed), photos / videos, and a callback number.
// The report is stored the moment it arrives (that is "received"), opens a road call (roadcall.js) so dispatch can approve road
// service, then the files go up one by one and one email goes to the "Breakdown from the driver app" list (Dispatch + Maintenance).
// The status the driver sees comes only from real events: the road call's provider updates, or a dispatcher closing the report.
//   GET  /driver/me/breakdowns/context          → driver, equipment on their loads, truck GPS, reefer readings, dispatch phone, who gets it
//   POST /driver/me/breakdowns                  { clientId, ... }  → { id } (the same clientId twice → the same report)
//   POST /driver/me/breakdowns/:id/files?key=&name=&note=   raw photo / video bytes (the same key twice → stored once)
//   POST /driver/me/breakdowns/:id/send?note=   → the email (once)
//   POST /driver/me/breakdowns/:id/notes        { clientId, text } → { noteId } (more info / photos on the same report)
//   GET  /driver/me/breakdowns[/:id]            → the driver's reports with their status timeline
//   GET  /bk/f/:token                           → one photo / video (signed link from the email, 30 days)
//   GET  /truckmate/breakdowns, POST /truckmate/breakdowns/:id/status { status: resolved | cancelled }   (console)
// What a driver writes is data, never instructions. Nothing here closes a load or marks equipment safe.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import express from 'express';
import { makeToken, readToken } from './breakdownreport.js';
import { readableFile } from './heic.js';
import { loadsFor } from './driverauth.js';
import { DEPARTMENTS, MAIN_NUMBER } from './staff-directory.js';

const SITE = 'florida-beauty';
const KEY = `taDriverBreakdowns:${SITE}`;   // id → report
const PURPOSE = 'bk-file';
const LINK_DAYS = 30;
export const VIDEO_MAX = 60 * 1024 * 1024;
const PHOTO_MAX = 14 * 1024 * 1024;
const EMAIL_BYTES = 2700 * 1024;
export const PARTS = ['truck', 'trailer', 'reefer'];
export const STATES = ['stopped', 'moving', 'unsure'];
export const CATS = { truck: ['tire', 'engine', 'brakes', 'air', 'lights', 'other'], trailer: ['tire', 'brakes', 'air', 'lights', 'other'], reefer: ['temp', 'nostart', 'alarm', 'fuel', 'other'] };
const LABEL = { tire: 'Tire', engine: 'Engine', brakes: 'Brakes', air: 'Air / leak', lights: 'Lights / electrical', other: 'Other', temp: 'Temperature', nostart: "Won't start", alarm: 'Alarm / code', fuel: 'Fuel / leak', accident: 'Accident' };
const STATE_LABEL = { stopped: 'Stopped', moving: 'Moving', unsure: 'Not sure' };
const PART_LABEL = { truck: 'Truck', trailer: 'Trailer', reefer: 'Reefer' };
const S = (x, n = 120) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const last10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);
const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10) / 10);
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');

// One tire, in words a tire shop reads. Truck axle 1 is the steer axle. Pure.
export function tireLabel(t, part) {
  const axle = part === 'truck' && t.axle === 1 ? 'Steer' : `Axle ${t.axle}`;
  return [axle, t.side === 'left' ? 'Left' : 'Right', t.pos ? (t.pos === 'inner' ? 'Inner' : 'Outer') : null].filter(Boolean).join(' · ');
}

// What the driver sent, cleaned. → { report } | { error }. Pure.
export function cleanReport(b = {}) {
  const part = PARTS.includes(b.part) ? b.part : null;
  const status = STATES.includes(b.status) ? b.status : null;
  const category = part && (CATS[part].includes(b.category) || b.category === 'accident') ? b.category : null;
  if (!status) return { error: 'Say if the vehicle is stopped, moving, or you are not sure.' };
  if (!part) return { error: 'Pick truck, trailer or reefer.' };
  if (!category) return { error: 'Pick the kind of problem.' };
  const axles = Math.min(5, Math.max(1, Math.round(Number(b.axles) || (part === 'truck' ? 3 : 2))));
  const tires = category === 'tire' && Array.isArray(b.tires) ? b.tires.slice(0, 20).map((t) => ({ axle: Math.round(Number(t && t.axle)), side: t && t.side === 'left' ? 'left' : t && t.side === 'right' ? 'right' : null, pos: t && ['inner', 'outer'].includes(t.pos) ? t.pos : null }))
    .filter((t) => t.axle >= 1 && t.axle <= axles && t.side && !(part === 'truck' && t.axle === 1 && t.pos)) : [];
  const answers = {};
  if (b.answers && typeof b.answers === 'object') for (const [k, v] of Object.entries(b.answers).slice(0, 24)) if (/^[a-zA-Z]{1,24}$/.test(k) && v != null && S(v, 200)) answers[k] = S(v, 200);
  const L = b.location && typeof b.location === 'object' ? b.location : {};
  const lat = Number(L.lat); const lng = Number(L.lng);
  const gps = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const location = { source: ['truck', 'phone', 'manual'].includes(L.source) ? L.source : (gps ? 'phone' : 'manual'), lat: gps ? lat : null, lng: gps ? lng : null,
    address: S(L.address, 200) || null, at: L.at && !Number.isNaN(Date.parse(L.at)) ? new Date(L.at).toISOString() : null, text: S(L.text, 200) || null, ref: S(L.ref, 120) || null };
  const R = b.reefer && typeof b.reefer === 'object' ? b.reefer : null;
  const reefer = part === 'reefer' && R ? { current: num(R.current), set: num(R.set), ret: num(R.ret), discharge: num(R.discharge), unit: 'F', at: R.at && !Number.isNaN(Date.parse(R.at)) ? new Date(R.at).toISOString() : null,
    source: R.source === 'telemetry' ? 'telemetry' : 'driver', power: ['on', 'off', 'unknown'].includes(R.power) ? R.power : null, mode: S(R.mode, 40) || null, alarm: S(R.alarm, 60) || null, fuel: num(R.fuel) } : null;
  return { report: { part, status, category, axles, tires, tireUnsure: !!b.tireUnsure && !tires.length, tireSize: S(b.tireSize, 20).toUpperCase() || null, sizeUnknown: !!b.sizeUnknown,
    answers, text: String(b.text || '').trim().slice(0, 2000), more: String(b.more || '').trim().slice(0, 1000), location, reefer,
    truck: S(b.truck, 12) || null, trailer: S(b.trailer, 12) || null, trip: S(b.trip, 12) || null, callback: last10(b.callback).length === 10 ? last10(b.callback) : null } };
}

const ANSWER_LABEL = { code: 'Warning light / code', starts: 'Engine starts', symptoms: 'What the driver notices', warning: 'Warning / symptom', pressure: 'Air pressure', leak: 'Hears an air leak', leakWhere: 'Leak location',
  component: 'Light / part', pattern: 'Happens', area: 'Area', hurt: 'Anyone hurt', others: 'Other vehicles involved', police: 'Police report' };
const where = (r) => { const L = r.location || {}; return [L.address || L.text, L.ref].filter(Boolean).join(' · ') || null; };
const fmtPhone = (d) => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || null);

// The rows the email (and the console) show. Pure.
export function reportRows(r) {
  const L = r.location || {};
  const gps = L.lat != null ? `${L.lat.toFixed(5)}, ${L.lng.toFixed(5)} (${L.source === 'truck' ? 'truck GPS' : "driver's phone"}${L.at ? `, as of ${et(Date.parse(L.at))} ET` : ''})` : null;
  const rf = r.reefer;
  return [
    ['Report', r.id], ['Vehicle', STATE_LABEL[r.status]], ['Problem', `${PART_LABEL[r.part]} · ${LABEL[r.category]}`],
    ['Driver', `${r.by || 'Driver'}${r.driverCode ? ` (ID ${r.driverCode})` : ''}`], ['Callback', fmtPhone(r.callback) || '—'],
    ['Truck / trailer', `${r.truck || '—'} / ${r.trailer || '—'}`], ...(r.trip ? [['Trip', r.trip]] : []),
    ['Location', where(r) || (gps ? '' : 'Not given')], ...(gps ? [['GPS', gps]] : []), ...(gps ? [['Map', `https://maps.google.com/?q=${L.lat},${L.lng}`]] : []),
    ...(r.category === 'tire' ? [['Tires', r.tires.length ? r.tires.map((t) => tireLabel(t, r.part)).join('; ') : r.tireUnsure ? 'Driver is not sure which tire' : '—'], ['Tire size', r.tireSize || (r.sizeUnknown ? "Driver doesn't know" : '—')]] : []),
    ...Object.entries(r.answers || {}).map(([k, v]) => [ANSWER_LABEL[k] || k, v]),
    ...(rf ? [['Reefer', [rf.current != null ? `now ${rf.current}°F` : null, rf.set != null ? `set ${rf.set}°F` : null, rf.ret != null ? `return ${rf.ret}°F` : null, rf.discharge != null ? `discharge ${rf.discharge}°F` : null,
      rf.power ? `unit ${rf.power}` : null, rf.mode ? `mode ${rf.mode}` : null, rf.alarm ? `alarm ${rf.alarm}` : null, rf.fuel != null ? `fuel ${rf.fuel}%` : null].filter(Boolean).join(' · ') || '—'],
    ['Reefer readings from', `${rf.source === 'telemetry' ? 'Samsara' : 'the driver'}${rf.at ? ` (${et(Date.parse(rf.at))} ET)` : ''}`]] : []),
    ['Sent', `${et(Date.parse(r.at))} ET`],
  ];
}

// The email: the first report, or an update (more info / photos) on it. Pure. → { subject, html, text }
export function breakdownEmail(r, links = [], attachedIds = [], note = null) {
  const unit = r.part === 'truck' ? `TRUCK ${r.truck || ''}` : r.part === 'trailer' ? `TRAILER ${r.trailer || ''}` : `REEFER ${r.trailer || ''}`;
  const subject = `${note ? 'UPDATE // ' : ''}BREAKDOWN // ${unit.trim()} // ${LABEL[r.category].toUpperCase()}${r.trip ? ` // TRIP ${r.trip}` : ''} // ${r.id}`;
  const banner = r.status === 'stopped' ? ['DRIVER IS STOPPED', '#B91C1C'] : r.status === 'moving' ? ['REPORTED WHILE MOVING', '#B45309'] : ['DRIVER IS NOT SURE IF THE VEHICLE CAN MOVE', '#B45309'];
  const rows = reportRows(r);
  const words = note ? note.text : [r.text, r.more ? `More: ${r.more}` : null].filter(Boolean).join('\n\n');
  const files = links.map((l) => `<li style="margin:3px 0"><a href="${esc(l.url)}" style="color:#1D4ED8">${esc(l.kind === 'video' ? `Video ${l.n}` : `Photo ${l.n}`)}</a>${l.kind === 'video' ? ` <span style="color:#5B6778">(${Math.max(1, Math.round(l.size / 1048576))} MB)</span>` : ''}${attachedIds.includes(l.id) ? ' <span style="color:#5B6778">· attached</span>' : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14213D;max-width:600px">
<div style="background:#142F54;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0"><b style="letter-spacing:1px">FLORIDA BEAUTY FLORA</b><br><span style="font-size:12px;letter-spacing:2px;color:#C9D6EA">${note ? 'BREAKDOWN UPDATE FROM THE DRIVER' : 'BREAKDOWN REPORTED IN THE DRIVER APP'}</span></div>
<div style="border:1px solid #D9E0EA;border-top:0;border-radius:0 0 8px 8px;padding:14px 16px">
<div style="display:inline-block;background:${banner[1]};color:#fff;font-weight:bold;font-size:13px;letter-spacing:1px;padding:5px 10px;border-radius:6px">${esc(banner[0])}</div>
<table style="border-collapse:collapse;margin-top:12px">${rows.filter(([, v]) => v !== '').map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#5B6778;vertical-align:top">${esc(k)}</td><td style="padding:3px 0"><b>${/^https:\/\//.test(v) ? `<a href="${esc(v)}" style="color:#1D4ED8">Open map</a>` : esc(v)}</b></td></tr>`).join('')}</table>
<p style="margin:12px 0 4px;color:#5B6778">${note ? `What the driver added (${esc(et(Date.parse(note.at)))} ET)` : 'What the driver wrote'}</p><div style="white-space:pre-line;background:#F4F6FA;border-radius:8px;padding:10px 12px">${esc(words || '(no words — see the photos / videos)')}</div>
${links.length ? `<p style="margin:12px 0 4px;color:#5B6778">Photos and videos (links work for ${LINK_DAYS} days)</p><ul style="margin:0;padding-left:18px">${files}</ul>` : '<p style="color:#5B6778">No photos or videos.</p>'}
${r.roadCall ? `<p style="margin-top:12px">Road call <b>${esc(r.roadCall)}</b> is open in the console (Road calls): approve it there to send road service.</p>` : ''}
<p style="margin-top:14px">Jarvis · AI Dispatcher<br>Florida Beauty Flora</p></div></div>`;
  const text = [`BREAKDOWN — ${banner[0]}${note ? ' (update)' : ''}`, ...rows.filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`), '', note ? 'What the driver added:' : 'What the driver wrote:', words || '(no words — see the photos / videos)', '',
    ...links.map((l) => `${l.kind === 'video' ? 'Video' : 'Photo'} ${l.n}: ${l.url}`), ...(r.roadCall ? ['', `Road call ${r.roadCall} is open in the console.`] : []), '', 'Jarvis · AI Dispatcher', 'Florida Beauty Flora'].join('\n');
  return { subject, html, text };
}

// The steps the driver sees, from real events only: the road call's status / provider, or a dispatcher closing it. Pure.
export function timeline(r, rc = null) {
  const s = rc ? rc.status : null;
  const enroute = ['tech en route', 'on site'].includes(s);
  const resolved = s === 'completed' || r.closed === 'resolved';
  const cancelled = !resolved && (s === 'cancelled' || r.closed === 'cancelled');
  const prov = rc && rc.provider && rc.provider.name && ['sent', 'accepted', 'tech en route', 'on site', 'completed'].includes(s) ? rc.provider : null;
  const stamps = [r.at, r.updatedAt, r.closedAt, ...((rc && rc.log) || []).map((l) => l.at), rc && rc.provider ? rc.provider.at : null].filter(Boolean).sort();
  return {
    state: cancelled ? 'cancelled' : resolved ? 'resolved' : enroute ? 'enroute' : 'waiting',
    steps: [
      { key: 'received', done: true, at: r.at },
      { key: 'waiting', done: true, current: !resolved && !cancelled && !enroute },
      { key: 'enroute', done: enroute || (resolved && s === 'completed'), current: enroute, at: enroute && rc.provider ? rc.provider.at || null : null },
      { key: 'resolved', done: resolved, current: resolved, at: resolved ? (r.closedAt || (rc && rc.provider && rc.provider.at) || null) : null },
    ],
    provider: prov ? { name: prov.tech || prov.name, eta: prov.eta || null } : null,
    updatedAt: stamps[stamps.length - 1] || r.at,
  };
}

// What the driver sees about one report. Pure.
const view = (r, rc) => ({ id: r.id, at: r.at, part: r.part, category: r.category, status: r.status, truck: r.truck, trailer: r.trailer, trip: r.trip, tires: r.tires, location: r.location,
  photos: (r.files || []).filter((f) => f.kind === 'photo').length, videos: (r.files || []).filter((f) => f.kind === 'video').length, sentAt: r.sentAt || null, notes: (r.notes || []).map((n) => ({ id: n.id, at: n.at, text: n.text, sentAt: n.sentAt || null })),
  ...timeline(r, rc) });

// Who the email reaches, in words the driver understands (only what is really on the list). Pure.
const MAINT = new Set(((DEPARTMENTS.find((d) => /maintenance/i.test(d[0])) || [])[2] || []).map((p) => String(p[0]).toLowerCase()));
export function sendsTo(entries = [], training = false) {
  const e = entries.map((x) => String(x).toLowerCase());
  return { dispatch: e.some((x) => /dispatch/.test(x)), maintenance: e.some((x) => MAINT.has(x) || /maint/.test(x)), any: e.length > 0, training: !!training };
}

const id4 = (now) => `BK-${new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).replace('/', '')}-${String(crypto.randomInt(100, 1000))}`;

export function initDriverBreakdowns(app, { db, secret, requireDriver, requireAuth, getBoard = null, roadCalls = () => null, sendMail = null, recipients = async () => [], entries = async () => [], training = null,
  log = null, env = process.env, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled && db.pool);
  let ready = null;
  const table = () => {
    if (!ready) ready = db.pool.query(`CREATE TABLE IF NOT EXISTS ta_breakdown_files (id TEXT PRIMARY KEY, site TEXT NOT NULL, report_id TEXT NOT NULL, note_id TEXT, file_key TEXT, kind TEXT NOT NULL, filename TEXT, media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data BYTEA NOT NULL)`).then(() => db.pool.query('CREATE INDEX IF NOT EXISTS ta_breakdown_files_report ON ta_breakdown_files (report_id)')).catch((e) => { ready = null; throw e; });
    return ready;
  };
  const all = async () => (await db.get(KEY, {})) || {};
  const patch = (id, fn) => db.update(KEY, (cur) => { const c = { ...(cur || {}) }; if (c[id]) c[id] = fn(c[id]); return c; }, {});
  const rcOf = async (r) => { const rcs = roadCalls(); if (!r.roadCall || !rcs || !rcs.list) return null; return ((await rcs.list().catch(() => [])) || []).find((x) => x.id === r.roadCall) || null; };
  const own = async (req, res) => { const r = (await all())[String(req.params.id)]; if (!r || r.driverCode !== String(req.driver.code)) { res.status(404).json({ error: 'That report is not yours.' }); return null; } return r; };
  const board = async () => (getBoard ? (((await getBoard(SITE).catch(() => null)) || {}).trips || []) : []);

  if (app && requireDriver) {
    app.get('/driver/me/breakdowns/context', requireDriver, async (req, res) => {
      const items = await board();
      const mine = loadsFor(req.driver.code, items);
      const loads = [...mine.current.map((l) => ({ ...l, current: true })), ...mine.next.map((l) => ({ ...l, current: false }))].map((l) => {
        const s = (items.find((it) => tripNo(it) === l.trip) || {})._samsara || {};
        return { trip: l.trip, truck: l.truck, trailer: l.trailer, current: l.current,
          gps: s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng, address: s.location || null, at: s.gpsAt || null, source: s.source === 'driver app' ? 'phone' : 'truck' } : null,
          reefer: s.tempF != null || s.setpointF != null ? { current: num(s.tempF), set: num(s.setpointF), discharge: num(s.supplyF), power: s.reeferState ? (/on/i.test(s.reeferState) ? 'on' : /off/i.test(s.reeferState) ? 'off' : 'unknown') : null, mode: s.reeferRunMode || null, fuel: num(s.reeferFuel), at: s.tempAt || null, stale: !!s.tempStale } : null };
      });
      const t = training && training.active ? await training.active().catch(() => null) : null;
      res.json({ driver: { name: req.driver.name || null, code: String(req.driver.code), phone: last10(req.user && req.user.phone) || last10(req.driver.phone) || null },
        loads, dispatch: env.DRIVER_DISPATCH_PHONE ? { phone: last10(env.DRIVER_DISPATCH_PHONE) || env.DRIVER_DISPATCH_PHONE, kind: 'dispatch' } : { phone: MAIN_NUMBER, kind: 'office' },
        sendsTo: sendsTo(await entries().catch(() => []), !!t), ready: enabled });
    });
    app.post('/driver/me/breakdowns', requireDriver, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Not available right now. Call dispatch.' });
      const b = req.body || {};
      const clientId = S(b.clientId, 60);
      if (!clientId) return res.status(400).json({ error: 'Missing report key.' });
      const c = cleanReport(b);
      if (c.error) return res.status(400).json({ error: c.error });
      const had = Object.values(await all()).find((x) => x.driverCode === String(req.driver.code) && x.clientId === clientId);
      if (had) return res.json({ ok: true, id: had.id, already: true });
      const taken = new Set(Object.keys(await all()));
      let id = id4(now()); for (let i = 0; taken.has(id) && i < 20; i += 1) id = id4(now());
      const at = new Date(now()).toISOString();
      const r = { id, clientId, ...c.report, by: req.driver.name || null, driverCode: String(req.driver.code), at, updatedAt: at, files: [], notes: [], sentAt: null };
      await db.update(KEY, (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [id]: r }).slice(-500)), {});
      // the road call: dispatch approves road service there (nothing goes to a provider without that)
      const rcs = roadCalls();
      if (rcs && rcs.open) {
        try {
          const L = r.location;
          const t0 = r.tires[0];
          const rc = await rcs.open({ trip: r.trip, truck: r.truck, source: 'app', by: `driver app ${r.by || r.driverCode}`, quiet: true,
            type: r.category === 'tire' ? 'tire' : 'mechanical',
            details: `${PART_LABEL[r.part]} · ${LABEL[r.category]} (${STATE_LABEL[r.status]})${r.text ? `: ${r.text}` : ''}`.slice(0, 300),
            tire: r.category === 'tire' ? { ...(r.tireSize ? { size: r.tireSize } : {}), qty: Math.max(1, r.tires.length), ...(t0 ? { position: { axle: r.part === 'truck' ? (t0.axle === 1 ? 'steer' : 'drive') : 'trailer', side: t0.side, pos: t0.pos, label: r.tires.map((t) => tireLabel(t, r.part)).join('; ') } } : {}) } : null,
            location: { ...(L.lat != null ? { lat: L.lat, lng: L.lng, gpsAt: L.at, source: L.source === 'truck' ? 'truck ELD' : "driver's phone" } : {}), ...(L.address ? { address: L.address } : {}), ...(L.text || L.ref ? { text: [L.text, L.ref].filter(Boolean).join(' · ') } : {}) },
            driver: { name: r.by, ...(r.callback ? { phone: r.callback } : {}) } });
          if (rc && rc.id) { await patch(id, (x) => ({ ...x, roadCall: rc.id })); r.roadCall = rc.id; }
        } catch (e) { console.warn('[breakdown] road call:', e.message); }
      }
      if (log && r.trip) await log(SITE, r.trip, { type: 'note', kind: 'breakdown', text: `Breakdown ${id} from ${r.by || 'the driver'} in the app: ${PART_LABEL[r.part]} · ${LABEL[r.category]} (${STATE_LABEL[r.status]})${r.text ? ` — ${r.text.slice(0, 200)}` : ''}`, by: r.by || 'driver app' }).catch(() => {});
      return res.json({ ok: true, id, roadCall: r.roadCall || null });
    });
    // one photo or video per request, as the raw file; the same key twice is stored once (a retry after a dropped connection)
    app.post('/driver/me/breakdowns/:id/files', requireDriver, express.raw({ type: () => true, limit: VIDEO_MAX }), async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      const noteId = req.query.note ? S(req.query.note, 40) : null;
      if (noteId && !(r.notes || []).some((n) => n.id === noteId)) return res.status(404).json({ error: 'That update is not on this report.' });
      const fileKey = S(req.query.key, 60) || null;
      if (fileKey && (r.files || []).some((f) => f.key === fileKey)) return res.json({ ok: true, already: true });
      let buf = Buffer.isBuffer(req.body) ? req.body : null;
      let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let name = S(req.query.name || 'file', 80).replace(/[^\w.\- ]+/g, '') || 'file';
      if (!buf || !buf.length) return res.status(400).json({ error: 'No file came through.' });
      const video = /^video\//.test(type);
      if (!video && !/^image\//.test(type)) return res.status(400).json({ error: 'Only photos and videos.' });
      if (!video && buf.length > PHOTO_MAX) return res.status(413).json({ error: 'That photo is too big.' });
      if (!video) { const f = await readableFile({ filename: name, mediaType: type, dataBase64: buf.toString('base64') }); buf = Buffer.from(String(f.dataBase64 || ''), 'base64'); type = f.mediaType || type; name = f.filename || name; } // iPhone HEIC → JPEG
      try {
        await table();
        const fid = crypto.randomBytes(9).toString('hex');
        await db.pool.query('INSERT INTO ta_breakdown_files (id, site, report_id, note_id, file_key, kind, filename, media_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [fid, SITE, r.id, noteId, fileKey, video ? 'video' : 'photo', name, type, buf.length, buf]);
        await patch(r.id, (x) => ({ ...x, updatedAt: new Date(now()).toISOString(), files: [...(x.files || []), { id: fid, key: fileKey, note: noteId, kind: video ? 'video' : 'photo', name, type, size: buf.length }] }));
      } catch { return res.status(500).json({ error: 'Could not save the file. Try again.' }); }
      return res.json({ ok: true });
    });
    app.post('/driver/me/breakdowns/:id/notes', requireDriver, async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      const clientId = S((req.body || {}).clientId, 60); const text = String((req.body || {}).text || '').trim().slice(0, 2000);
      if (!clientId) return res.status(400).json({ error: 'Missing update key.' });
      const had = (r.notes || []).find((n) => n.clientId === clientId);
      if (had) return res.json({ ok: true, noteId: had.id, already: true });
      const n = { id: `n${now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, clientId, text, at: new Date(now()).toISOString(), sentAt: null };
      await patch(r.id, (x) => ({ ...x, updatedAt: n.at, notes: [...(x.notes || []), n].slice(-30) }));
      const rcs = roadCalls();
      if (text && r.roadCall && rcs && rcs.update) await rcs.update(r.roadCall, { details: text.slice(0, 300) }, 'driver app').catch(() => {});
      return res.json({ ok: true, noteId: n.id });
    });
    app.post('/driver/me/breakdowns/:id/send', requireDriver, async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      const noteId = req.query.note ? S(req.query.note, 40) : null;
      const note = noteId ? (r.notes || []).find((n) => n.id === noteId) : null;
      if (noteId && !note) return res.status(404).json({ error: 'That update is not on this report.' });
      if ((note ? note.sentAt : r.sentAt)) return res.json({ ok: true, already: true, sentAt: note ? note.sentAt : r.sentAt });
      const out = await send(r, note).catch((e) => ({ error: e.message }));
      if (out.error) return res.status(502).json({ error: 'Your report was received, but the email did not go out. Call dispatch.', received: true });
      return res.json({ ok: true, sentAt: out.sentAt });
    });
    app.get('/driver/me/breakdowns', requireDriver, async (req, res) => {
      const mine = Object.values(await all()).filter((r) => r.driverCode === String(req.driver.code)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
      const rcs = roadCalls(); const list = rcs && rcs.list ? await rcs.list().catch(() => []) : [];
      res.json({ reports: mine.map((r) => view(r, list.find((x) => x.id === r.roadCall) || null)) });
    });
    app.get('/driver/me/breakdowns/:id', requireDriver, async (req, res) => {
      const r = await own(req, res); if (!r) return null;
      return res.json({ report: view(r, await rcOf(r)) });
    });
  }
  if (app) {
    app.get('/bk/f/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p || !p.f) return res.status(404).send('This link has expired or is not valid.');
      try {
        await table();
        const { rows } = await db.pool.query('SELECT filename, media_type, data FROM ta_breakdown_files WHERE id = $1 AND site = $2', [p.f, SITE]);
        if (!rows[0]) return res.status(404).send('Not found.');
        res.setHeader('Content-Type', rows[0].media_type);
        res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].filename || 'file').replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.end(rows[0].data);
      } catch { return res.status(500).send('Could not open it.'); }
    });
  }
  if (app && requireAuth) {
    app.get('/truckmate/breakdowns', requireAuth, async (req, res) => {
      const rcs = roadCalls(); const list = rcs && rcs.list ? await rcs.list().catch(() => []) : [];
      res.json({ reports: Object.values(await all()).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100).map((r) => ({ ...r, ...timeline(r, list.find((x) => x.id === r.roadCall) || null), rows: reportRows(r) })) });
    });
    // a dispatcher closes the report (the road call, when there is one, keeps its own status)
    app.post('/truckmate/breakdowns/:id/status', requireAuth, async (req, res) => {
      const st = (req.body || {}).status;
      if (!['resolved', 'cancelled'].includes(st)) return res.status(400).json({ error: 'resolved or cancelled' });
      const r = (await all())[String(req.params.id)];
      if (!r) return res.status(404).json({ error: 'Not found' });
      const by = (req.user && (req.user.name || req.user.email)) || 'dispatcher';
      const at = new Date(now()).toISOString();
      await patch(r.id, (x) => ({ ...x, closed: st, closedAt: at, closedBy: by, updatedAt: at }));
      return res.json({ ok: true });
    });
  }

  async function send(r, note = null) {
    const to = await recipients();
    const mine = (r.files || []).filter((f) => (note ? f.note === note.id : !f.note));
    const links = mine.map((f, i, a) => ({ id: f.id, kind: f.kind, size: f.size, n: a.slice(0, i + 1).filter((x) => x.kind === f.kind).length, url: `${baseUrl}/bk/f/${makeToken({ f: f.id }, secret, now(), PURPOSE, LINK_DAYS)}` }));
    const attachments = []; const attachedIds = []; let room = EMAIL_BYTES;
    const photos = mine.filter((f) => f.kind === 'photo' && f.size <= room);
    if (photos.length && enabled) {
      await table();
      const { rows } = await db.pool.query('SELECT id, filename, media_type, data FROM ta_breakdown_files WHERE id = ANY($1)', [photos.map((f) => f.id)]);
      for (const f of photos) { const row = rows.find((x) => x.id === f.id); if (row && row.data.length <= room) { room -= row.data.length; attachedIds.push(f.id); attachments.push({ name: row.filename || `photo-${attachments.length + 1}.jpg`, contentType: row.media_type, bytes: row.data }); } }
    }
    const m = breakdownEmail(r, links, attachedIds, note);
    if (!to.length) throw new Error('No one is on the breakdown list.');
    if (!sendMail) throw new Error('Email is not set up.');
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text, attachments });
    const sentAt = new Date(now()).toISOString();
    await patch(r.id, (x) => (note ? { ...x, notes: (x.notes || []).map((n) => (n.id === note.id ? { ...n, sentAt } : n)) } : { ...x, sentAt, sentTo: to }));
    return { sentAt, to };
  }
  return { send, all };
}

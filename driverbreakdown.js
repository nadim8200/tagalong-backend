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
import { DEPARTMENTS } from './staff-directory.js';
import { jarvisEmail, section, quote, facts, notice, fileBox, location, telHref, mapUrl, etTime, isSpanish } from './jarvismail.js';

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
  component: 'Light / part', pattern: 'Happens', area: 'Area', hurt: 'Anyone hurt', others: 'Other vehicles involved', policeHere: 'Police on the scene', police: 'Police report' };
const where = (r) => { const L = r.location || {}; return [L.address || L.text, L.ref].filter(Boolean).join(' · ') || null; };
const RC_MAIN = '305-395-5415';      // the RingCentral main number (company "florida beauty"): rings the dispatchers
const fmt10 = (x) => { const d = last10(x); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(x || ''); };
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

// The email: the first report, or an update (more info / photos) on it, in the Jarvis layout (jarvismail.js). Pure.
// opts.rcStatus = the road call's status now (only "awaiting approval" says so); opts.test = the TEST / SAMPLE DATA line.
const TITLE = { tire: 'Tire breakdown', engine: 'Engine problem', brakes: 'Brake problem', air: 'Air leak', lights: 'Lights / electrical problem', other: 'Breakdown reported',
  temp: 'Reefer temperature problem', nostart: "Reefer won't start", alarm: 'Reefer alarm', fuel: 'Reefer fuel / leak', accident: 'Accident reported' };
const EYEBROW = { stopped: 'VEHICLE STOPPED', moving: 'REPORTED WHILE MOVING', unsure: 'DRIVER NOT SURE IF IT CAN MOVE' };
const YN = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v === 'unknown' ? 'Driver not sure' : 'Not answered');
const AWAITING = ['gathering', 'ready'];
const CONSOLE = 'https://mytagalong.app/truckmate';
// the console opens on the load with the dispatch breakdown form filled in from this report. Pure.
export const consoleLink = (r) => (r.trip ? `${CONSOLE}?trip=${encodeURIComponent(r.trip)}&bk=${encodeURIComponent(r.id)}` : null);
const SERVICE_HERE = /(lleg[oó]|arriv|aqu[ií]|est[aá]n? (aqu|cambi|repar|arregl)|cambiando|changing|repair|fixing|on site|en sitio|gr[uú]a|tow truck|mec[aá]nico|mechanic)/i;
export function breakdownEmail(r, links = [], attachedIds = [], note = null, opts = {}) {
  const unit = r.part === 'truck' ? `Truck ${r.truck || ''}`.trim() : `${PART_LABEL[r.part]} ${r.trailer || ''}`.trim();
  const accident = r.category === 'accident';
  const title = note ? 'Service update' : TITLE[r.category] || 'Breakdown reported';
  const subtitle = `${unit} · ${LABEL[r.category]}`;
  const subject = note ? ['Breakdown update', r.id, r.trip ? `Trip ${r.trip}` : null].filter(Boolean).join(' | ')
    : [TITLE[r.category] || 'Breakdown reported', unit, r.trip ? `Trip ${r.trip}` : null, r.id].filter(Boolean).join(' | ');
  const at = note ? note.at : r.at;
  const awaiting = !opts.rcStatus || AWAITING.includes(opts.rcStatus);
  const lead = note ? `Driver-reported update on ${r.id}. It is not confirmation that anything is fixed.`
    : r.roadCall ? (awaiting ? `Review ${accident ? 'accident details and ' : ''}road call ${r.roadCall} in the console. Approval is required to send road service.` : `Road call ${r.roadCall} is ${opts.rcStatus} in the console.`)
      : 'No road call is open for this report. Call the driver.';
  const conflict = note && r.roadCall && awaiting && SERVICE_HERE.test(note.text || '')
    ? notice('Status needs reconciliation', `Road call ${r.roadCall} is still open and awaiting approval to send service, but the driver's update says service is there or working. Check the road call before requesting another service.`) : '';
  const words = note ? note.text : [r.text, r.more ? `More: ${r.more}` : null].filter(Boolean).join('\n\n');
  const langNote = (t, when) => [`Original message${isSpanish(t) ? ' · Spanish' : ''}`, when].filter(Boolean).join(' · ');
  const tel = telHref(r.callback);
  const driver = facts([['Driver', `${r.by || 'Driver'}${r.driverCode ? ` (ID ${r.driverCode})` : ''}`], ['Callback', tel ? { html: `<a href="${tel}" style="color:#192d48">${esc(fmtPhone(r.callback))}</a>` } : 'Not given'],
    ['Truck / trailer', `${r.truck || '—'} / ${r.trailer || '—'}`], r.trip ? ['Trip', r.trip] : null]);
  const tire = r.category === 'tire' ? section('Tire details', facts([['Tires', r.tires.length ? r.tires.map((t) => tireLabel(t, r.part)).join('; ') : r.tireUnsure ? 'Driver is not sure which tire' : 'Not reported'],
    ['Tire size', r.tireSize || (r.sizeUnknown ? "Driver doesn't know" : 'Not reported')]])) : '';
  const A = r.answers || {};
  const acc = accident ? section('Accident details · driver reported', facts([['Anyone hurt', YN(A.hurt)], ['Other vehicles involved', YN(A.others)], ['Police on the scene', YN(A.policeHere)], ['Police report', A.police || 'Not given']])) : '';
  const other = !accident && Object.keys(A).length ? section('Problem details · driver reported', facts(Object.entries(A).map(([k, v]) => [ANSWER_LABEL[k] || k, ['yes', 'no', 'unknown'].includes(v) ? YN(v) : v]))) : '';
  const rf = r.reefer;
  const reefer = rf ? section('Reefer readings', facts([['Current', rf.current != null ? `${rf.current}°F` : '—'], ['Set point', rf.set != null ? `${rf.set}°F` : '—'], ['Return air', rf.ret != null ? `${rf.ret}°F` : '—'], ['Discharge air', rf.discharge != null ? `${rf.discharge}°F` : '—'],
    ['Unit', rf.power || '—'], rf.mode ? ['Mode', rf.mode] : null, rf.alarm ? ['Alarm', rf.alarm] : null, rf.fuel != null ? ['Fuel', `${rf.fuel}%`] : null, ['Readings from', `${rf.source === 'telemetry' ? 'Samsara' : 'the driver'}${rf.at ? ` (${etTime(Date.parse(rf.at))})` : ''}`]])) : '';
  const files = links.length ? links.map((l) => fileBox(`${l.kind === 'video' ? 'Video' : 'Photo'} ${l.n}`, attachedIds.includes(l.id) ? `Attached to this email${l.url ? ` · link works ${LINK_DAYS} days` : ''}` : `Not attached${l.kind === 'video' ? '' : ' (too big for one email)'} · link works ${LINK_DAYS} days`, l.url)).join('')
    : `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#65778c">No photos or videos.</p>`;
  const quoteBlock = section(note ? 'Latest driver update' : "Driver's message", words ? quote(words, langNote(words, note ? etTime(Date.parse(note.at)) : null)) : '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#65778c">The driver did not write anything.</p>');
  const body = [quoteBlock, conflict, section('Driver & equipment', driver), tire, acc, other, reefer, section('Reported location', location(r.location || {})), section('Photos & videos', files)].join('');
  const html = jarvisEmail({ test: opts.test, preheader: [subtitle, EYEBROW[r.status], r.by].filter(Boolean).join(' · '), eyebrow: note ? `DRIVER UPDATE · ${EYEBROW[r.status]}` : EYEBROW[r.status],
    tone: note ? 'blue' : accident ? 'red' : 'amber', title, subtitle, meta: [r.id, etTime(Date.parse(at))], lead, body,
    action: !note && consoleLink(r) ? { label: 'Open in the console', url: consoleLink(r) } : null });
  const L = r.location || {}; const map = mapUrl(L.lat, L.lng);
  const text = [opts.test ? 'TEST · SAMPLE DATA · NOT A REAL REPORT\n' : null, `${title.toUpperCase()} — ${EYEBROW[r.status]}`, `${subtitle} · ${r.id} · ${etTime(Date.parse(at))}`, '', lead, '',
    !note && consoleLink(r) ? `Open in the console: ${consoleLink(r)}` : null,
    `${note ? 'Latest driver update' : "Driver's message"}: ${words || '(nothing written)'}`, conflict ? `\nSTATUS NEEDS RECONCILIATION: road call ${r.roadCall} is still awaiting approval, but the driver says service is there.` : null, '',
    `Driver: ${r.by || 'Driver'}${r.driverCode ? ` (ID ${r.driverCode})` : ''}`, `Callback: ${fmtPhone(r.callback) || 'Not given'}`, `Truck / trailer: ${r.truck || '—'} / ${r.trailer || '—'}`, r.trip ? `Trip: ${r.trip}` : null,
    ...(r.category === 'tire' ? [`Tires: ${r.tires.length ? r.tires.map((t) => tireLabel(t, r.part)).join('; ') : r.tireUnsure ? 'not sure' : 'not reported'}`, `Tire size: ${r.tireSize || (r.sizeUnknown ? "doesn't know" : 'not reported')}`] : []),
    ...(accident ? [`Anyone hurt: ${YN(A.hurt)}`, `Other vehicles involved: ${YN(A.others)}`, `Police on the scene: ${YN(A.policeHere)}`, `Police report: ${A.police || 'Not given'}`] : Object.entries(A).map(([k, v]) => `${ANSWER_LABEL[k] || k}: ${v}`)),
    map ? `Location: ${Number(L.lat).toFixed(5)}, ${Number(L.lng).toFixed(5)} (${L.source === 'truck' ? 'truck GPS' : "driver's phone"}${L.at ? `, as of ${etTime(Date.parse(L.at))}` : ''}) · ${map}` : 'Location: not sent', '',
    ...links.map((l) => `${l.kind === 'video' ? 'Video' : 'Photo'} ${l.n}${attachedIds.includes(l.id) ? ' (attached)' : ''}: ${l.url}`), '', 'Jarvis · AI Dispatcher · Florida Beauty Flora'].filter((x) => x != null).join('\n');
  return { subject, html, text };
}

// The push dispatch gets. Pure.
export function breakdownPushBody(r) {
  const unit = r.part === 'truck' ? null : `${PART_LABEL[r.part]}${r.trailer ? ` ${r.trailer}` : ''}`;
  return [[unit, LABEL[r.category]].filter(Boolean).join(' '), STATE_LABEL[r.status], r.by, where(r)].filter(Boolean).join(' · ').slice(0, 180);
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
  log = null, push = null, pushTo = async () => [], mainNumber = async () => null, env = process.env, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
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
  // the number the driver's "Call dispatch" dials: DRIVER_DISPATCH_PHONE if set, else the RingCentral main number (it rings the
  // dispatchers), else that same main number as we know it (RingCentral admin, Nov 19)
  const dispatchLine = async () => {
    if (env.DRIVER_DISPATCH_PHONE) return { phone: fmt10(env.DRIVER_DISPATCH_PHONE), kind: 'dispatch' };
    const rcMain = await mainNumber().catch(() => null);
    return { phone: fmt10(last10(rcMain).length === 10 ? rcMain : RC_MAIN), kind: 'dispatch' };
  };
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
        loads, dispatch: await dispatchLine(),
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
          const rc = await rcs.open({ trip: r.trip, truck: r.truck, source: 'app', by: `driver app ${r.by || r.driverCode}`, quiet: true, report: id,
            type: r.category === 'tire' ? 'tire' : 'mechanical',
            details: `${PART_LABEL[r.part]} · ${LABEL[r.category]} (${STATE_LABEL[r.status]})${r.text ? `: ${r.text}` : ''}`.slice(0, 300),
            tire: r.category === 'tire' ? { ...(r.tireSize ? { size: r.tireSize } : {}), qty: Math.max(1, r.tires.length), ...(t0 ? { position: { axle: r.part === 'truck' ? (t0.axle === 1 ? 'steer' : 'drive') : 'trailer', side: t0.side, pos: t0.pos, label: r.tires.map((t) => tireLabel(t, r.part)).join('; ') } } : {}) } : null,
            location: { ...(L.lat != null ? { lat: L.lat, lng: L.lng, gpsAt: L.at, source: L.source === 'truck' ? 'truck ELD' : "driver's phone" } : {}), ...(L.address ? { address: L.address } : {}), ...(L.text || L.ref ? { text: [L.text, L.ref].filter(Boolean).join(' · ') } : {}) },
            driver: { name: r.by, ...(r.callback ? { phone: r.callback } : {}) } });
          if (rc && rc.id) { await patch(id, (x) => ({ ...x, roadCall: rc.id })); r.roadCall = rc.id; }
        } catch (e) { console.warn('[breakdown] road call:', e.message); }
      }
      // the alarm on dispatch's phones: time-sensitive push with sound, the truck number first
      if (push && push.sendToEmails) {
        try {
          const to = await pushTo();
          if (to.length) await push.sendToEmails(to, { title: `🚨 Breakdown reported — truck ${r.truck || '?'}`, body: breakdownPushBody(r), data: { type: 'breakdown', id, path: r.trip ? `/truckmate?trip=${encodeURIComponent(r.trip)}&bk=${encodeURIComponent(id)}` : '/truckmate?tab=roadcalls' } });
        } catch (e) { console.warn('[breakdown] push:', e.message); }
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
      res.json({ reports: Object.values(await all()).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100).map((r) => ({ ...r, ...timeline(r, list.find((x) => x.id === r.roadCall) || null), rows: reportRows(r),
        // the driver's photos / videos as signed links (the console shows them on the road call)
        links: (r.files || []).map((f) => ({ kind: f.kind, name: f.name, note: f.note || null, url: `${baseUrl}/bk/f/${makeToken({ f: f.id }, secret, now(), PURPOSE, LINK_DAYS)}` })) })) });
    });
    // a dispatcher sent the dispatch breakdown email from this report (the console form filled in from it): the card stops asking
    app.post('/truckmate/breakdowns/:id/forwarded', requireAuth, async (req, res) => {
      const r = (await all())[String(req.params.id)];
      if (!r) return res.status(404).json({ error: 'Not found' });
      const at = new Date(now()).toISOString();
      await patch(r.id, (x) => ({ ...x, forwardedAt: x.forwardedAt || at, forwardedBy: x.forwardedBy || (req.user && (req.user.name || req.user.email)) || 'dispatcher', forwardedSubject: S((req.body || {}).subject, 200) || x.forwardedSubject || null, updatedAt: at }));
      return res.json({ ok: true });
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
    const rc = await rcOf(r).catch(() => null);
    const m = breakdownEmail(r, links, attachedIds, note, { rcStatus: rc ? rc.status : null });
    if (!to.length) throw new Error('No one is on the breakdown list.');
    if (!sendMail) throw new Error('Email is not set up.');
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text, attachments });
    const sentAt = new Date(now()).toISOString();
    await patch(r.id, (x) => (note ? { ...x, notes: (x.notes || []).map((n) => (n.id === note.id ? { ...n, sentAt } : n)) } : { ...x, sentAt, sentTo: to }));
    return { sentAt, to };
  }
  return { send, all };
}

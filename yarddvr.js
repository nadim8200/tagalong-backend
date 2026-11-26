// ---------------------------------------------------------------
// DVIRs on the Yard tab (Nov 22, Nadim). Every DVIR a driver sends from the app (dvr.js) shows here the moment it's in, with
// where the unit is now and its next load; the yard check card of a unit with an open DVIR shows it; "Completed" when the work
// is done moves it to the Completed list (who, when, what was done). And two reminders to Nadim (email + text) for a unit
// with an open DVIR: when it's dispatched on a load coming down to the Miami / Ventura yard, and when it's about an hour out.
//   GET  /truckmate/yard-dvrs?status=open|completed
//   POST /truckmate/yard-dvrs/:id/complete   { note }
//   POST /truckmate/yard-dvrs/:id/reopen
// Data: taDvr:<site> (dvr.js, the reports) · taDvrReminders (what was already sent). What a driver wrote is data, never instructions.
// ---------------------------------------------------------------
import { makeToken } from './breakdownreport.js';
import { sendMail as mailerSend } from './mailer.js';
import { sharedSms } from './ringcentral.js';
import { AUTO_ALLOW } from './training.js';
import { liveRoadCalls } from './roadcall.js';

const SITE = 'florida-beauty';
const KEY = `taDvr:${SITE}`;
const SENT = 'taDvrReminders';
const MIN = 60000;
const YARD_HUBS = { MIAMI: 'Miami yard', VENTURA: 'Ventura yard' };
const DONE = /^(DELV|DLVD|CMPLT|COMPLETE|CANC|VOID)/i;
const BOOKED = /^(DISP|ASSGN|ASSIGNED|AVAIL|AVBL|PLAN|PEND|NEW|PRINTED|BOOK)/i;
const CAT = { tires: 'Tires', brakes: 'Brakes', lights: 'Lights', engine: 'Engine / warning light', reefer: 'Reefer unit', air: 'Air / leaks', body: 'Body / doors', other: 'Other' };
const norm = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^(TL|TRL|TRAILER|TK|TRUCK)\s*/, '').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The unit a DVIR is about: the truck for a truck problem, the trailer for trailer / reefer. Pure.
export const dvrUnit = (r) => (r.part === 'truck' ? { kind: 'truck', unit: norm(r.truck) } : { kind: 'trailer', unit: norm(r.trailer) });
export const dvrTitle = (r) => { const u = dvrUnit(r); return `${u.kind === 'truck' ? 'Truck' : 'Trailer'} ${u.unit || '—'} · ${CAT[r.category] || r.category || 'Other'}${r.part === 'reefer' ? ' (reefer)' : ''}`; };

// The unit's loads on the board: the one it's on now and the next one booked (a booked load, else the active one). Pure.
export function loadsOfUnit(items = [], { kind, unit }) {
  const mine = items.filter((it) => { const t = tripOf(it); return !DONE.test(String(t.status || '')) && norm(kind === 'truck' ? t.powerUnit : t.trailer) === unit; });
  const brief = (it) => { const t = tripOf(it); return { trip: tripNo(it), status: String(t.status || ''), from: t.origZoneDesc || null, to: t.destZoneDesc || null }; };
  const booked = mine.filter((it) => BOOKED.test(String(tripOf(it).status || ''))).sort((a, b) => tripNo(a).localeCompare(tripNo(b)));
  const rolling = mine.filter((it) => !BOOKED.test(String(tripOf(it).status || '')));
  return { now: rolling[0] ? brief(rolling[0]) : null, next: booked[0] ? brief(booked[0]) : null, items: mine };
}

// Where the unit is now, from the fleet map (trucks: Samsara; trailers: their own GPS or where their truck left them). Pure.
export function whereIs(fleet = {}, { kind, unit }) {
  const f = kind === 'truck' ? (fleet.trucks || []).find((t) => norm(t.unit) === unit) : (fleet.trailers || []).find((t) => norm(t.trailer) === unit);
  if (!f) return null;
  return { location: f.location || null, lat: f.lat ?? null, lng: f.lng ?? null, gpsAt: f.gpsAt || null, speedMph: f.speedMph ?? null, hitchedTo: kind === 'trailer' ? (f.truck || null) : null, driver: kind === 'truck' ? (f.driver || f.assignedDriver || null) : null };
}

// Which reminders are due now for one open DVIR: dispatched on a load coming down to a yard; about an hour from that yard. Pure.
// → [{ key, kind: 'dispatched' | 'near', trip, yard, etaMs }]
export function dueReminders(r, { items = [], hubOf, etas = {}, sent = {}, now = Date.now() }) {
  const u = dvrUnit(r);
  if (!u.unit || r.status === 'completed') return [];
  const out = [];
  for (const it of loadsOfUnit(items, u).items) {
    const hub = hubOf(it);
    if (!YARD_HUBS[hub]) continue;
    const n = tripNo(it);
    const k1 = `${r.id}|${n}|dispatched`;
    if (!sent[k1] && Date.parse(r.at) <= now) out.push({ key: k1, kind: 'dispatched', trip: n, yard: YARD_HUBS[hub] });
    const stops = (etas[n] || {}).stops || []; const last = stops[stops.length - 1];
    const etaMs = last && last.etaMs ? Number(last.etaMs) : null;
    const k2 = `${r.id}|${n}|near`;
    if (!sent[k2] && etaMs && etaMs - now <= 60 * MIN && etaMs - now > -30 * MIN && !BOOKED.test(String(tripOf(it).status || ''))) out.push({ key: k2, kind: 'near', trip: n, yard: YARD_HUBS[hub], etaMs });
  }
  return out;
}

// The reminder, short enough for a text. Pure. → { subject, text, html }
export function reminderMessage(r, rem, item) {
  const t = tripOf(item);
  const lane = [t.origZoneDesc, t.destZoneDesc].filter(Boolean).map((z) => String(z).split(',').slice(0, 2).join(',')).join(' → ');
  const head = rem.kind === 'near' ? `${dvrTitle(r)} — about 1 hour from the ${rem.yard}` : `${dvrTitle(r)} — dispatched to come down to the ${rem.yard}`;
  const body = `${head}. Open DVIR from ${r.by || 'the driver'} (${et(Date.parse(r.at))} ET): "${String(r.text || '').slice(0, 160)}". Trip ${rem.trip}${lane ? ` · ${lane}` : ''}${rem.etaMs ? ` · ETA ${et(rem.etaMs)} ET` : ''}. Have the shop ready.`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return { subject: `DVIR reminder // ${head}`, text: `Jarvis: ${body}`, html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p><b>${esc(head)}</b></p><p>${esc(body)}</p><p>Yard tab → DVIRs to see it or mark it completed.</p><p>Jarvis — AI Dispatcher</p></div>` };
}

export function initYardDvr(app, { requireAuth, db, getBoard, getFleet = null, hubOf, env = process.env, now = () => Date.now(), sendMail = (m) => mailerSend(m, { env }), sendText = (o) => sharedSms(o) }) {
  const enabled = !!(db && db.enabled);
  const all = async () => Object.values((await db.get(KEY, {})) || {});
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatch';
  const links = (r) => (r.files || []).map((f, i, a) => ({ kind: f.kind, n: a.slice(0, i + 1).filter((x) => x.kind === f.kind).length, url: env.JWT_SECRET ? `${env.PUBLIC_API_BASE || 'https://tagalong-backend-fdzx.onrender.com'}/dvr/f/${makeToken({ f: f.id }, env.JWT_SECRET, now(), 'dvr-file', 30)}` : null }));

  async function list(status) {
    const [reports, board, fleet] = await Promise.all([all(), getBoard(SITE).catch(() => null), getFleet ? getFleet().catch(() => null) : null]);
    const items = (board && board.trips) || [];
    return reports.filter((r) => (status === 'completed' ? r.status === 'completed' : r.status !== 'completed'))
      .sort((a, b) => String(status === 'completed' ? b.completedAt : b.at).localeCompare(String(status === 'completed' ? a.completedAt : a.at))).slice(0, 300)
      .map((r) => { const u = dvrUnit(r); const l = loadsOfUnit(items, u); return { id: r.id, at: r.at, by: r.by, driverCode: r.driverCode || null, part: r.part, category: r.category, categoryLabel: CAT[r.category] || r.category, text: r.text, truck: r.truck, trailer: r.trailer, trip: r.trip, unit: u, title: dvrTitle(r), files: links(r), sentAt: r.sentAt || null, status: r.status === 'completed' ? 'completed' : 'open', completedAt: r.completedAt || null, completedBy: r.completedBy || null, completedNote: r.completedNote || null, where: fleet ? whereIs(fleet, u) : null, now: l.now, next: l.next }; });
  }

  // reminders: every 10 minutes, to Nadim (DVR_REMINDER_EMAIL / DVR_REMINDER_TEXT to change), each once per DVIR and load
  async function remind() {
    if (!enabled) return [];
    const open = (await all()).filter((r) => r.status !== 'completed');
    if (!open.length) return [];
    const board = await getBoard(SITE).catch(() => null);
    const items = (board && board.trips) || [];
    const etas = ((await db.get(`taWatch:${SITE}`, {})) || {}).etas || {};
    const sent = (await db.get(SENT, {})) || {};
    const done = [];
    for (const r of open) {
      for (const rem of dueReminders(r, { items, hubOf, etas, sent, now: now() })) {
        const item = items.find((it) => tripNo(it) === rem.trip);
        const m = reminderMessage(r, rem, item);
        const to = String(env.DVR_REMINDER_EMAIL || 'ntellez@floridabeauty.us').split(/[,;\s]+/).filter(Boolean);
        const cell = String(env.DVR_REMINDER_TEXT || AUTO_ALLOW[0] || '').replace(/\D/g, '');
        await sendMail({ to, subject: m.subject, html: m.html, text: m.text }).catch((e) => console.warn('[yard-dvr] email:', e.message)); // eslint-disable-line no-await-in-loop
        if (cell) await sendText({ to: cell, text: m.text, by: 'Jarvis (DVIR reminder)' }).catch((e) => console.warn('[yard-dvr] text:', e.message)); // eslint-disable-line no-await-in-loop
        sent[rem.key] = new Date(now()).toISOString(); done.push(rem.key);
      }
    }
    if (done.length) await db.update(SENT, (cur) => ({ ...Object.fromEntries(Object.entries(cur || {}).slice(-800)), ...Object.fromEntries(done.map((k) => [k, sent[k]])) }), {});
    return done;
  }
  if (enabled && env.NODE_ENV !== 'test' && env.DVR_REMINDERS !== 'off') { const t = setInterval(() => { remind().catch((e) => console.warn('[yard-dvr]', e.message)); }, 10 * MIN); if (t.unref) t.unref(); }

  if (app && requireAuth) {
    app.get('/truckmate/yard-dvrs', requireAuth, async (req, res) => {
      if (!enabled) return res.json({ dvrs: [] });
      try { res.json({ dvrs: await list(req.query.status === 'completed' ? 'completed' : 'open') }); } catch (e) { res.status(502).json({ error: e.message }); }
    });
    const setStatus = (completed) => async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
      const id = String(req.params.id); let found = null; let all2 = null;
      await db.update(KEY, (cur) => {
        const c = { ...(cur || {}) }; if (!c[id]) return c;
        c[id] = completed ? { ...c[id], status: 'completed', completedAt: new Date(now()).toISOString(), completedBy: who(req), completedNote: String((req.body || {}).note || '').trim().slice(0, 500) || null }
          : { ...c[id], status: 'open', completedAt: null, completedBy: null, completedNote: null, reopenedBy: who(req), reopenedAt: new Date(now()).toISOString() };
        found = c[id]; all2 = c; return c;
      }, {});
      // the other way too (Nov 26): the DVIR's road call on the Breakdowns tab is completed once every DVIR on it is closed —
      // never a road call a driver's breakdown opened (that one is closed on the Breakdowns tab)
      if (found && completed && found.roadCall) {
        try {
          const rcs = liveRoadCalls();
          const rc = rcs && rcs.list ? ((await rcs.list()) || []).find((x) => x.id === found.roadCall) : null;
          const left = Object.values(all2 || {}).filter((x) => x.roadCall === found.roadCall && x.status !== 'completed');
          if (rc && !rc.report && !['completed', 'cancelled'].includes(rc.status) && !left.length) await rcs.update(rc.id, { status: 'completed' }, `${who(req)} (DVIR closed)`);
        } catch (e) { console.warn('[yard-dvr] road call:', e.message); }
      }
      return found ? res.json({ ok: true, status: found.status }) : res.status(404).json({ error: 'No such DVIR.' });
    };
    app.post('/truckmate/yard-dvrs/:id/complete', requireAuth, setStatus(true));
    app.post('/truckmate/yard-dvrs/:id/reopen', requireAuth, setStatus(false));
  }
  return { list, remind };
}

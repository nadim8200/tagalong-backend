// Morning outbound report — the email a dispatcher writes every morning about
// last night's loads out of the Miami yard ("OUTBOUND 2 TRIP SHEETS - TUE 10/06/26"):
// trip, truck, trailer, drivers, where the truck is now, destination, pickup appt
// (the sheet's "drivers will leave at 20:30"), DISPATCH time (handwritten on the
// trip sheet) and DEPARTURE time (Samsara GPS leaving the yard). Rows that took
// more than 30 minutes from dispatch to departure are highlighted yellow.
// It also lists unscheduled stops on the way out of Florida — any stop of 10+
// minutes that isn't the yard or a stop on the trip sheet.
//
// Built from the board + Samsara GPS history. A draft is made every morning; a
// dispatcher reviews it and clicks Send (or auto-send when turned on). It goes
// out from the Jarvis mailbox once Outlook is connected.
import { sendMail, mailConfig } from './mailer.js';
import { samsaraTokenFrom, getLiveIndex, vehicleForUnit, vehicleGpsHistory } from './samsara.js';
import { haversineMi, MIAMI_TERMINAL, inFlorida } from './watchtower.js';

const MIN = 60000;
const TZ = 'America/New_York';
const SLOW_MIN = 30;           // dispatch → departure longer than this = yellow
const STOP_MIN = 10;           // a stop this long on the way out of Florida gets listed
const ALERT_STOP_MIN = 20;     // …and this long raises a live alert
const YARD_MI = 0.6;

const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || tripOf(it).trip || '');
const manifestOf = (it) => (it && it._manifest) || null;

// Miami wall clock → epoch ms (handles EST/EDT).
export function miamiMs(date, hh, mm) {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const shown = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute);
  return guess + (guess - shown);
}
// "19:00", "7:00 PM", "1900", "8:30p" on the loading date → ms. Loads leave in the
// evening/night, so a morning time (before noon) means the next day.
export function parseSheetTime(dateLoaded, raw) {
  if (!dateLoaded || !raw) return null;
  const m = String(raw).toUpperCase().replace(/\./g, '').match(/(\d{1,2})(?::?(\d{2}))?\s*(AM|PM|A|P)?/);
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3] || '';
  if (h > 23 || min > 59) return null;
  let nextDay = false;
  if (/^P/.test(ap)) { if (h < 12) h += 12; }
  else if (/^A/.test(ap)) { if (h === 12) h = 0; nextDay = true; }           // "6:00 AM" = the next morning
  else if (h >= 1 && h <= 3) nextDay = true;                                 // "2:00" = after midnight
  else if (h >= 4 && h <= 11) h += 12;                                       // "8:30" = evening
  return miamiMs(dateLoaded, h, min) + (nextDay ? 24 * 60 * MIN : 0);
}
export const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', ' ') : null);
const dayName = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const dayShort = (date) => dayName(date).slice(0, 3).toUpperCase();
const mmddyy = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(2, 4)}`;

// Loaded at the Miami yard (trip sheet LOAD stop or TruckMate origin).
export function fromMiamiYard(it) {
  const m = manifestOf(it);
  const load = ((m && m.stops) || []).find((x) => /^LOAD/i.test(x.action || ''));
  if (load) return /MIAMI/i.test(`${load.customer || ''} ${load.city || ''}`);
  return /MIAMI/i.test(String(tripOf(it).origZoneDesc || ''));
}

export { inFlorida };

// From the truck's GPS history: when it left the yard, unscheduled stops before
// it left Florida, when it crossed out of Florida. Pure.
// points: [{t, lat, lng, mph, place}] sorted; stopPts: [{lat, lng}] trip stops in Florida.
export function trackAnalysis(points, { yard = MIAMI_TERMINAL, stopPts = [], stopCities = [], from = null } = {}) {
  const pts = (points || []).filter((p) => p && p.lat != null && p.t && (!from || Date.parse(p.t) >= from));
  const out = { departedMs: null, seenInYard: false, inYardNow: false, leftFloridaMs: null, stops: [], points: pts.length };
  if (!pts.length) return out;
  const d = (p, q) => haversineMi(p.lat, p.lng, q.lat, q.lng);
  let i = 0;
  // departure: last yard point, then the truck is 1+ mile out
  let lastYard = -1;
  for (; i < pts.length; i++) {
    if (d(pts[i], yard) <= YARD_MI) { lastYard = i; out.seenInYard = true; continue; }
    if (lastYard >= 0 && d(pts[i], yard) > 1) break;
  }
  if (lastYard >= 0 && i < pts.length) out.departedMs = Date.parse(pts[lastYard + 1].t);
  out.inYardNow = d(pts[pts.length - 1], yard) <= YARD_MI;
  if (out.departedMs == null) return out;
  // stops between departure and leaving Florida: the truck stays within ~0.25 mi for 10+ minutes
  let j = lastYard + 1;
  while (j < pts.length) {
    const p = pts[j];
    if (!inFlorida(p)) { out.leftFloridaMs = Date.parse(p.t); break; }
    let k = j;
    while (k + 1 < pts.length && d(pts[k + 1], p) <= 0.25) k++;
    const end = k + 1 < pts.length ? Date.parse(pts[k + 1].t) : Date.parse(pts[k].t);
    const minutes = Math.round((end - Date.parse(p.t)) / MIN);
    const atYard = d(p, yard) <= 1;
    const atStop = stopPts.some((s) => s && s.lat != null && d(p, s) <= 1.5)
      || (p.place && stopCities.some((c) => c && new RegExp(`\\b${String(c).replace(/[^A-Za-z ]/g, '')}\\b`, 'i').test(p.place)));
    // a lone breadcrumb before a GPS gap only counts if the truck was actually standing still
    const still = k > j || (p.mph != null && p.mph <= 3);
    if (still && minutes >= STOP_MIN && !atYard && !atStop) out.stops.push({ fromMs: Date.parse(p.t), toMs: end, minutes, lat: p.lat, lng: p.lng, place: p.place || null, ongoing: k === pts.length - 1 });
    j = k + 1;
  }
  return out;
}

const cityState = (loc) => {
  const parts = String(loc || '').split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/^\d{5}/.test(x));
  return parts.slice(-2).join(', ') || null;
};
const titleCity = (x) => String(x || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Ny|Nj|Fl|Ma|Ca|Nh|Ct|Ri|Nc|Sc|Ga|Il|Mi|Oh|Mn|Tn|Pa|Va|Md)\b/g, (s) => s.toUpperCase());

// One report row. Pure.
export function reportRow(it, track = null) {
  const t = tripOf(it); const m = manifestOf(it) || {};
  const drivers = (m.drivers && m.drivers.length ? m.drivers : []).map((x) => `${String(x.name || '').toUpperCase()}${x.id ? ` (${x.id})` : ''}`).filter((x) => x.trim());
  const live = it._samsara || {};
  const dels = (m.stops || []).filter((x) => /DELIVER/i.test(x.action || ''));
  const last = dels[dels.length - 1];
  const dest = last ? `${String(last.city || '').toUpperCase()} ${String(last.state || '').toUpperCase()}`.trim() : String(t.destZoneDesc || '').replace(/,\s*\d{5}.*$/, '').replace(',', '');
  const dispatchMs = parseSheetTime(m.dateLoaded, m.dispatchTime);
  const apptMs = m.pickupAt ? miamiMs(String(m.pickupAt).slice(0, 10), +String(m.pickupAt).slice(11, 13), +String(m.pickupAt).slice(14, 16)) : null;
  const departedMs = track ? track.departedMs : null;
  const slowMin = dispatchMs && departedMs ? Math.round((departedMs - dispatchMs) / MIN) : null;
  return {
    trip: tripNo(it), truck: String(m.truck || t.powerUnit || ''), trailer: String(m.trailer || t.trailer || ''),
    drivers: drivers.length ? drivers.join(' ') : [live.driver1, live.driver2].filter(Boolean).join(' ').toUpperCase(),
    location: titleCity(cityState(live.location)) || '—', destination: dest || '—',
    puAppt: apptMs ? clock(apptMs) : '****',
    dispatch: dispatchMs ? clock(dispatchMs) : (m.dispatchTime || '****'),
    departure: departedMs ? clock(departedMs) : (track && track.inYardNow ? 'IN YARD' : 'NOT TRACKING'),
    slow: slowMin != null && slowMin > SLOW_MIN, slowMin,
    notLeft: !!(track && !departedMs && track.inYardNow),
    stops: (track && track.stops) || [],
    leftFlorida: track && track.leftFloridaMs ? clock(track.leftFloridaMs) : null,
  };
}

// The whole email. Pure.
export function buildReport(rows, date, { note = '' } = {}) {
  const n = rows.length;
  const notLeft = rows.filter((r) => r.notLeft).map((r) => r.truck);
  const subject = `OUTBOUND ${n} TRIP SHEETS - ${dayShort(date)} ${mmddyy(date)}`;
  const left = notLeft.length ? `All loads left the yard except truck${notLeft.length > 1 ? 's' : ''} ${notLeft.join(' and ')}.` : 'All loads left the yard.';
  const withStops = rows.filter((r) => r.stops.length);
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const th = (x) => `<th style="padding:4px 8px;border-bottom:1px solid #999;font-size:11px;text-align:left">${x}</th>`;
  const td = (x) => `<td style="padding:3px 8px;font-size:11px;white-space:nowrap">${esc(x)}</td>`;
  const table = `<table cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif">
<tr><td colspan="10" style="text-align:center;font-size:11px;padding:4px">OUTBOUND ${n} TRIP SHEETS ${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}</td></tr>
<tr>${['TRIP', 'TRUCKS', 'TRAILERS', 'DRIVERS', 'LOCATION', 'DESTINATION', 'PU APPT', 'TIME OF DISPATCH', 'TIME OF DEPARTURE', 'UNSCHEDULED STOPS'].map(th).join('')}</tr>
<tr><td colspan="10" style="text-align:center;font-size:11px;background:#ddd;padding:2px">FLOWERS (FLORIDA)</td></tr>
${rows.map((r) => `<tr style="${r.slow ? 'background:#ffff66' : ''}">${[r.trip, r.truck, r.trailer, r.drivers, r.location, r.destination, r.puAppt, r.dispatch, r.departure, r.stops.length ? `${r.stops.length} (${r.stops.reduce((a, s) => a + s.minutes, 0)} min)` : ''].map(td).join('')}</tr>`).join('\n')}
</table>`;
  const stopsHtml = withStops.length ? `<p><b>Unscheduled stops leaving Florida</b> (${STOP_MIN}+ minutes, not the yard or a trip stop):</p><ul>${withStops.map((r) => `<li>Trip ${esc(r.trip)} · truck ${esc(r.truck)}: ${r.stops.map((s) => `${esc(clock(s.fromMs))}${s.ongoing ? ' (still stopped)' : `–${esc(clock(s.toMs))}`} ${s.minutes} min${s.place ? ` at ${esc(s.place)}` : ''}`).join('; ')}</li>`).join('')}</ul>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>Good day,</p>
<p>Please be advised.<br>${dayName(date)} Trip sheets.</p>
<p>${esc(left)}${note ? ` ${esc(note)}` : ''}</p>
<p>The loads highlighted in yellow took more than ${SLOW_MIN} minutes to leave the yard after being dispatched.</p>
${table}
${stopsHtml}
<p>Thanks,<br>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>`;
  return { date, subject, rows, html, left, note };
}

const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

export function initOutbound(app, { requireAuth, db, getBoard, env = process.env, fetchFn = globalThis.fetch, geo = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const site = 'florida-beauty';
  const cfgKey = 'taOutboundCfg';
  const draftKey = (date) => `taOutbound:${site}:${date}`;
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const DEFAULTS = { to: [], time: '06:00', auto: false };
  const settings = async () => ({ ...DEFAULTS, ...((enabled && (await db.get(cfgKey, {}))) || {}) });

  // GPS history for one truck from 3h before dispatch (or 4 PM) to now.
  async function trackFor(it, startMs) {
    const token = samsaraTokenFrom(env);
    if (!token) return null;
    try {
      const idx = await getLiveIndex(token);
      const veh = vehicleForUnit(idx, tripOf(it).powerUnit);
      if (!veh || veh.id == null) return null;
      const pts = await vehicleGpsHistory(token, veh.id, new Date(startMs).toISOString(), new Date(now()).toISOString());
      const flStops = ((manifestOf(it) && manifestOf(it).stops) || []).filter((x) => /DELIVER/i.test(x.action || '') && /^FL$/i.test(x.state || ''));
      const stopPts = geo ? flStops.map((x) => geo(x.zip)).filter(Boolean) : [];
      return trackAnalysis(pts, { stopPts, stopCities: flStops.map((x) => x.city) });
    } catch (e) { console.warn('[outbound] gps:', e.message); return null; }
  }

  // Last night's loads: trip sheets loaded on `date` at the Miami yard.
  async function make(date) {
    const board = await getBoard(site);
    const items = ((board && board.trips) || []).filter((it) => manifestOf(it) && manifestOf(it).dateLoaded === date && fromMiamiYard(it));
    const rows = [];
    for (const it of items) {
      const m = manifestOf(it);
      const start = (parseSheetTime(date, m.dispatchTime) || miamiMs(date, 16, 0)) - 3 * 60 * MIN;
      rows.push(reportRow(it, await trackFor(it, start)));
    }
    rows.sort((a, b) => a.trip.localeCompare(b.trip));
    return rows;
  }
  async function draft(date, by) {
    const rows = await make(date);
    const prev = (await db.get(draftKey(date), null)) || {};
    const rep = { ...buildReport(rows, date, { note: prev.note || '' }), madeAt: new Date(now()).toISOString(), madeBy: by, sentAt: prev.sentAt || null, sentTo: prev.sentTo || null };
    await db.set(draftKey(date), rep);
    return rep;
  }
  async function send(date, by) {
    const cfg = await settings();
    const rep = await db.get(draftKey(date), null) || await draft(date, by);
    const r = await sendMail({ to: cfg.to, subject: rep.subject, html: rep.html }, { env, fetchFn });
    const next = { ...rep, sentAt: new Date(now()).toISOString(), sentBy: by, sentTo: cfg.to };
    await db.set(draftKey(date), next);
    return { ...r, sentTo: cfg.to, subject: rep.subject };
  }
  const yesterday = () => ymd(now() - 24 * 60 * MIN);

  app.get('/truckmate/outbound', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : yesterday();
      const rep = req.query.refresh ? await draft(date, who(req)) : ((await db.get(draftKey(date), null)) || await draft(date, who(req)));
      const c = mailConfig(env);
      res.json({ ...rep, settings: await settings(), outlook: { connected: c.ready, from: c.from || null } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/truckmate/outbound/note', requireAuth, async (req, res) => {
    const date = String((req.body && req.body.date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date YYYY-MM-DD' });
    const cur = await db.get(draftKey(date), null);
    if (!cur) return res.status(404).json({ error: 'Make the report first.' });
    const note = String(req.body.note || '').slice(0, 600);
    const rep = { ...cur, ...buildReport(cur.rows, date, { note }) };
    await db.set(draftKey(date), rep);
    res.json(rep);
  });
  app.post('/truckmate/outbound/send', requireAuth, async (req, res) => {
    try {
      const date = String((req.body && req.body.date) || yesterday());
      res.json(await send(date, who(req)));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/truckmate/outbound/settings', requireAuth, async (req, res) => res.json(await settings()));
  app.put('/truckmate/outbound/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 30);
    const time = /^\d{2}:\d{2}$/.test(String(b.time || '')) ? b.time : DEFAULTS.time;
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, time, auto: !!b.auto, updatedBy: who(req), updatedAt: new Date().toISOString() }), {}));
  });

  // Every morning at the set time: make the draft (and send it when auto-send is on).
  if (enabled && env.OUTBOUND_REPORT !== 'off') {
    const timer = setInterval(async () => {
      try {
        const cfg = await settings();
        const hm = new Date(now()).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
        if (hm < cfg.time) return;
        const date = yesterday();
        let cur = await db.get(draftKey(date), null);
        if (!cur || !cur.morning) { cur = await draft(date, 'Jarvis (morning)'); cur.morning = true; await db.set(draftKey(date), cur); }
        if (cfg.auto && !cur.sentAt && cfg.to.length && mailConfig(env).ready) await send(date, 'Jarvis (auto)');
      } catch (e) { console.warn('[outbound] morning report:', e.message); }
    }, 5 * MIN);
    if (timer.unref) timer.unref();
  }
  console.log(`[outbound] morning outbound report ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { make, draft, send };
}

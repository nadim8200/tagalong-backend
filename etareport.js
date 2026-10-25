// ---------------------------------------------------------------
// ETA report: the ETAs we gave along the way vs when the truck actually got to each customer — emailed when the
// trip finishes (delivered / closed / left the board).
//  • every Watchtower cycle: each open stop's ETA is logged when first seen, when it moves 20+ min, or every 3 h
//    (our projection — what Jarvis tells callers / emails); ARTIS's own ETA (read twice a day) is logged beside it.
//  • actual arrival: the truck entering the customer's geofence (stop visit), else TruckMate's delivered time,
//    else ARTIS's delivered time.
// Internal only (alert list "ETA report").
// ---------------------------------------------------------------
import { localToUtcMs } from './watchtower.js';
import { STATE_TZ, fmtLocalShort } from './localtime.js';

const SITE = 'florida-beauty';
const LOG = (site) => `taEtaLog:${site}`;
const SENT = (site) => `taEtaReportSent:${site}`;
const TIMES = (site) => `taStopTimes:${site}`;    // every finished stop visit, kept 30 days (the stop-times report)
const MIN = 60000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
// "MOUNT RAINIER, MD, 20712" → "MOUNT RAINIER|MD". Pure.
export const placeKey = (label) => { const p = String(label || '').split(',').map((x) => x.trim().toUpperCase()); return p[0] && p[1] ? `${p[0].replace(/[^A-Z ]/g, '').replace(/^MT /, 'MOUNT ')}|${p[1].slice(0, 2)}` : null; };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// one more ETA for a stop's log? first one, moved 20+ min, or 3 h since the last. Pure.
export function shouldLog(prev, etaMs, at) {
  if (!etaMs) return false;
  if (!prev || !prev.length) return true;
  const last = prev[prev.length - 1];
  return Math.abs(etaMs - last.etaMs) >= 20 * MIN || at - last.at >= 3 * 60 * MIN;
}
// fold this cycle's ETAs (ours + ARTIS) into the log. Pure.
export function foldLog(log = {}, items = [], etas = {}, at = Date.now()) {
  const out = { ...log };
  for (const it of items) {
    const n = tripNo(it); if (!n) continue;
    const t = { ...(out[n] || {}) };
    for (const s of ((etas[n] && etas[n].stops) || [])) {
      const k = placeKey(s.label); if (!k || !s.etaMs) continue;
      const cur = (t[k] && t[k].ours) || [];
      // a parked truck: one line for the whole time it sits there (its ETA only slides with the clock)
      const last = cur[cur.length - 1];
      if (s.parkedSinceMs && last && last.parkedSince === s.parkedSinceMs) continue;
      if (s.parkedSinceMs || shouldLog(cur, s.etaMs, at)) t[k] = { ...(t[k] || {}), label: s.label, ours: [...cur, { at, etaMs: s.etaMs, miles: s.miles ?? null, ...(s.parkedSinceMs ? { parkedSince: s.parkedSinceMs } : {}), ...(s.waitingForAppt ? { appt: true } : {}) }].slice(-40) };
    }
    for (const a of ((it._artisEta && it._artisEta.stops) || [])) {
      if (a.delivered || !a.etaMs || !a.city || !a.state) continue;
      const k = placeKey(`${a.city}, ${a.state}`);
      const cur = (t[k] && t[k].artis) || [];
      if (!cur.length || cur[cur.length - 1].etaMs !== a.etaMs) t[k] = { ...(t[k] || {}), label: (t[k] && t[k].label) || `${a.city}, ${a.state}`, artis: [...cur, { at, etaMs: a.etaMs, customer: a.name || null }].slice(-20) };
    }
    if (Object.keys(t).length) out[n] = t;
  }
  return out;
}

// the trip's stops (from its bills), each with the customers, the ETA history and the actual arrival. Pure.
export function reportRows(item, log = {}, visits = {}) {
  const bills = item.freightBills || item.orders || tripOf(item).freightBills || [];
  const stops = new Map();
  for (const b of bills) {
    const k = placeKey(b.endZoneDescription); if (!k) continue;
    const s = stops.get(k) || { key: k, label: b.endZoneDescription, customers: new Set(), delivered: [] };
    if (b.billToName) s.customers.add(String(b.billToName).replace(/\s*\*$/, '').trim());
    if (b.actualDelivery) s.delivered.push(String(b.actualDelivery));
    stops.set(k, s);
  }
  const sheet = (item._manifest && item._manifest.stops) || [];
  return [...stops.values()].map((s) => {
    const st = String(s.label).split(',')[1] ? String(s.label).split(',')[1].trim().slice(0, 2) : '';
    const tz = STATE_TZ[st] || 'America/New_York';
    // actual: geofence entry, else TruckMate delivered (wall time at the stop), else ARTIS delivered
    const sheetStops = sheet.filter((x) => x.city && placeKey(`${x.city}, ${x.state}`) === s.key).map((x) => x.key);
    const visit = Object.values(visits || {}).find((v) => sheetStops.includes(v.stopKey) && v.enteredAt);
    const tm = s.delivered.sort().pop();
    const tmMs = tm && !/T00:00:0\d/.test(tm) ? localToUtcMs(tm.slice(0, 16), tz) : null;
    const art = ((item._artisEta && item._artisEta.stops) || []).find((a) => a.delivered && placeKey(`${a.city}, ${a.state}`) === s.key);
    const actual = visit ? { ms: visit.enteredAt, from: 'arrived (geofence)' } : tmMs ? { ms: tmMs, from: 'delivered (TruckMate)' } : art && art.arrivedAt ? { text: art.arrivedAt, from: 'delivered (ARTIS)' } : null;
    const h = log[s.key] || {};
    const stay = visit ? { arrivedMs: visit.enteredAt || null, leftMs: visit.exitedAt || null, minutes: visit.dwellMin != null ? visit.dwellMin : (visit.enteredAt && visit.exitedAt ? Math.round((visit.exitedAt - visit.enteredAt) / MIN) : null) } : null;
    return { label: s.label, customers: [...s.customers], ours: h.ours || [], artis: h.artis || [], actual, stay };
  });
}

// the ETAs worth showing: the first, every real change (moved an hour+ from the last one shown) and the last —
// at most 6. A truck sitting still re-logs every 20 min with the ETA sliding 20 min; that's one line, not forty. Pure.
export function keyEtas(ours = []) {
  if (ours.length <= 2) return ours;
  const kept = [ours[0]];
  for (const e of ours.slice(1, -1)) if (Math.abs(e.etaMs - kept[kept.length - 1].etaMs) >= 60 * MIN) kept.push(e);
  kept.push(ours[ours.length - 1]);
  if (kept.length <= 6) return kept;
  const mid = kept.slice(1, -1); const step = mid.length / 4;
  return [kept[0], ...[0, 1, 2, 3].map((i) => mid[Math.floor(i * step)]), kept[kept.length - 1]];
}
// send the report only when it says something: a truck, an actual arrival at EVERY stop, and ETAs we gave. Pure.
export function worthSending(item, rows) {
  const t = tripOf(item);
  if (!String(t.powerUnit || '').trim()) return { ok: false, why: 'no truck on the trip' };
  if (!rows.length) return { ok: false, why: 'no stops' };
  if (rows.some((r) => !r.actual)) return { ok: false, why: 'a stop has no arrival / delivery time' };
  if (!rows.some((r) => r.ours.length)) return { ok: false, why: 'no ETAs were given on this trip' };
  return { ok: true };
}

// "1 h 25 min" / "40 min". Pure.
export const hm = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const off = (etaMs, actualMs) => {
  if (!etaMs || !actualMs) return '';
  const d = Math.round((actualMs - etaMs) / MIN); const a = Math.abs(d);
  const t = a >= 60 ? `${Math.floor(a / 60)} h ${a % 60 ? `${a % 60} min` : ''}`.trim() : `${a} min`;
  return d === 0 ? 'on time' : d > 0 ? `${t} later` : `${t} earlier`;
};
// the email. Pure.
export function renderReport(item, rows, reason = 'finished') {
  const t = tripOf(item); const n = tripNo(item);
  const subject = `Trip report: ETAs and time at each stop — trip ${n}${t.powerUnit ? ` · truck ${t.powerUnit}` : ''} (${reason === 'delivered' ? 'delivered' : 'finished'})`;
  const when = (ms, place) => (ms ? fmtLocalShort(ms, place) : '—');
  const cell = 'padding:6px 8px;border-top:1px solid #E2E8F0;vertical-align:top;font-size:13px;color:#172538;';
  const body = rows.map((r) => {
    const first = r.ours[0]; const last = r.ours[r.ours.length - 1];
    const act = r.actual ? (r.actual.ms ? when(r.actual.ms, r.label) : esc(r.actual.text)) : 'not recorded';
    const shown = keyEtas(r.ours); const hidden = r.ours.length - shown.length;
    const hist = shown.map((e) => `${when(e.at, 'FL')} → <b>${when(e.etaMs, r.label)}</b>${e.miles != null ? ` (${e.miles} mi out)` : ''}${e.parkedSince ? ` — parked since ${when(e.parkedSince, 'FL')}${e.appt ? ', waiting for the appointment' : ''}` : ''}`).join('<br>') + (hidden > 0 ? `<br><i>(${hidden} more updates with small changes not shown)</i>` : '');
    const art = r.artis.map((e) => `${when(e.at, 'FL')} → ${when(e.etaMs, r.label)}`).join('<br>');
    return `<tr><td style="${cell}"><b>${esc(r.customers.join(', ') || r.label)}</b><br><span style="color:#596A7F">${esc(r.label)}</span></td>
<td style="${cell}">${first ? `${when(first.etaMs, r.label)}<br><span style="color:#596A7F">given ${when(first.at, 'FL')}</span>` : '—'}</td>
<td style="${cell}">${last ? `${when(last.etaMs, r.label)}<br><span style="color:#596A7F">given ${when(last.at, 'FL')}</span>` : '—'}</td>
<td style="${cell}"><b>${act}</b>${r.actual ? `<br><span style="color:#596A7F">${esc(r.actual.from)}</span>` : ''}</td>
<td style="${cell}">${r.actual && r.actual.ms ? `first: ${off(first && first.etaMs, r.actual.ms) || '—'}<br>last: ${off(last && last.etaMs, r.actual.ms) || '—'}` : '—'}</td>
<td style="${cell}">${r.stay && r.stay.minutes != null ? `<b>${hm(r.stay.minutes)}</b><br><span style="color:#596A7F">${when(r.stay.arrivedMs, r.label)} → ${r.stay.leftMs ? when(r.stay.leftMs, r.label) : 'still there'}</span>` : r.stay && r.stay.arrivedMs ? `arrived ${when(r.stay.arrivedMs, r.label)}<br><span style="color:#596A7F">no exit recorded</span>` : '—'}</td></tr>
${hist || art ? `<tr><td colspan="6" style="padding:0 8px 8px;font-size:12px;color:#596A7F;">${hist ? `<b>Our ETAs along the way</b> (when given → the ETA):<br>${hist}` : ''}${art ? `<br><b>ARTIS ETA</b> (read → ETA):<br>${art}` : ''}</td></tr>` : ''}`;
  }).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#172538;max-width:760px">
<h2 style="font-size:20px;margin:0 0 4px">Trip report — trip ${esc(n)}</h2>
<div style="color:#596A7F;font-size:13px;margin-bottom:12px">Truck ${esc(t.powerUnit || '—')} · trailer ${esc(t.trailer || '—')} · ${esc(t.origZoneDesc || '')} → ${esc(t.destZoneDesc || '')}. The ETAs we gave along the way vs when the truck actually got to each customer, and how long it took at each stop.</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">
<tr style="background:#F4F6F9"><th align="left" style="padding:6px 8px;font-size:12px">Customer · stop</th><th align="left" style="padding:6px 8px;font-size:12px">First ETA</th><th align="left" style="padding:6px 8px;font-size:12px">Last ETA</th><th align="left" style="padding:6px 8px;font-size:12px">Actual</th><th align="left" style="padding:6px 8px;font-size:12px">Off by</th><th align="left" style="padding:6px 8px;font-size:12px">Time at stop</th></tr>
${body || `<tr><td colspan="6" style="${cell}">No stops on this trip.</td></tr>`}
</table>
<p style="color:#596A7F;font-size:12px">Times in ET (stop's local time in parentheses when it isn't Eastern). Our ETA = 55 mph, driving hours and 1 h per stop. Actual = the truck entering the customer's geofence, else the delivered time in TruckMate / ARTIS. Time at stop = from entering to leaving the customer's geofence.</p>
<p style="font-size:13px">— Jarvis, AI Dispatcher</p></div>`;
  return { subject, html };
}

// finished stop visits (geofence in → out) with the trip, truck, customer and place → the stop-times log. Pure.
export function stopTimesFrom(visitsByTrip = {}, items = [], have = {}) {
  const out = { ...have };
  const byTrip = new Map(items.map((it) => [tripNo(it), it]));
  for (const [trip, vs] of Object.entries(visitsByTrip || {})) {
    const it = byTrip.get(String(trip));
    for (const v of Object.values(vs || {})) {
      if (!v || !v.enteredAt || !v.exitedAt) continue;
      const k = `${trip}|${v.stopKey}`;
      if (out[k]) continue;
      const st = it && ((it._manifest && it._manifest.stops) || []).find((x) => x.key === v.stopKey);
      out[k] = { trip: String(trip), truck: v.unit || (it ? String(tripOf(it).powerUnit || '') || null : null), customer: (st && st.customer) || (v.geofence && v.geofence.name) || null,
        place: st && st.city ? `${st.city}, ${st.state || ''}`.trim() : null, arrivedMs: v.enteredAt, leftMs: v.exitedAt, minutes: v.dwellMin != null ? v.dwellMin : Math.round((v.exitedAt - v.enteredAt) / MIN), source: (v.geofence && v.geofence.source) || null };
    }
  }
  return out;
}

const MAIL_ON = (site) => `taEtaReportMail:${site}`;
export function initEtaReport({ app = null, requireAuth = null, db, sendMail = null, recipients = async () => [], now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  // after each Watchtower cycle: log this cycle's ETAs
  async function process(site, board) {
    if (!enabled) return;
    const etas = ((await db.get(`taWatch:${site}`, {})) || {}).etas || {};
    const items = (board && board.trips) || [];
    const at = now();
    await db.update(LOG(site), (cur) => {
      const next = foldLog(cur || {}, items, etas, at);
      // forget trips not touched for 10 days
      for (const [k, v] of Object.entries(next)) { const last = Math.max(0, ...Object.values(v).flatMap((s) => [...(s.ours || []), ...(s.artis || [])].map((e) => e.at))); if (at - last > 10 * 24 * 60 * MIN) delete next[k]; }
      return next;
    }, {});
    // finished stop visits → the stop-times log (30 days)
    const visits = (await db.get(`taStopVisits:${site}`, {})) || {};
    await db.update(TIMES(site), (cur) => {
      const next = stopTimesFrom(visits, items, cur || {});
      for (const [k, v] of Object.entries(next)) if (at - (v.leftMs || 0) > 30 * 24 * 60 * MIN) delete next[k];
      return next;
    }, {});
  }
  // the trip-report email: off by default; dispatch turns it on (or off) here
  if (app && requireAuth) {
    app.get('/truckmate/eta-report/mail', requireAuth, async (req, res) => res.json(enabled ? ((await db.get(MAIL_ON(String(req.query.site || SITE)), {})) || {}) : {}));
    app.post('/truckmate/eta-report/mail', requireAuth, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'no database' });
      const v = { on: !!(req.body && req.body.on), by: (req.user && (req.user.name || req.user.email)) || null, at: new Date(now()).toISOString() };
      await db.set(MAIL_ON(String(req.query.site || SITE)), v);
      res.json(v);
    });
  }
  // the console's "Stop times" report: every stop, how long the truck was there (newest first)
  if (app && requireAuth) {
    app.get('/truckmate/stop-times', requireAuth, async (req, res) => {
      if (!enabled) return res.json({ rows: [] });
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
      const since = now() - days * 24 * 60 * MIN;
      const rows = Object.values((await db.get(TIMES(String(req.query.site || SITE)), {})) || {}).filter((r) => r.leftMs >= since).sort((a, b) => b.arrivedMs - a.arrivedMs);
      const mins = rows.map((r) => r.minutes).filter((m) => m != null);
      res.json({ days, count: rows.length, avgMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null, rows: rows.slice(0, 1000) });
    });
  }
  // the trip finished → the report (once per trip)
  async function onFinished(site, rec, reason) {
    if (!enabled || !rec || !rec.item || !sendMail) return null;
    const n = tripNo(rec.item); if (!n) return null;
    const sent = (await db.get(SENT(site), {})) || {};
    if (sent[n]) return null;
    if (!((await db.get(MAIL_ON(site), {})) || {}).on) return null;   // off until turned on from the console
    const to = await recipients();
    if (!to.length) return null;
    const log = ((await db.get(LOG(site), {})) || {})[n] || {};
    const visits = ((await db.get(`taStopVisits:${site}`, {})) || {})[n] || {};
    const rows = reportRows(rec.item, log, visits);
    if (!worthSending(rec.item, rows).ok) return null;
    const m = renderReport(rec.item, rows, reason);
    await sendMail({ to, subject: m.subject, html: m.html });
    await db.update(SENT(site), (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [n]: new Date(now()).toISOString() }).slice(-1000)), {});
    return m;
  }
  // for Jarvis (chat, phone, email answers) and the read-only API: finished stops + a truck at a stop right now
  async function query({ trip = null, truck = null, customer = null, days = 7, site = SITE, fits = null } = {}) {
    if (!enabled) return { stops: [], atStopNow: [] };
    const since = now() - Math.min(30, Math.max(1, Number(days) || 7)) * 24 * 60 * MIN;
    const n = trip ? String(trip).replace(/\D/g, '') : null; const u = truck ? String(truck).replace(/^0+/, '').toUpperCase() : null;
    const want = (r) => (!n || r.trip === n) && (!u || String(r.truck || '').replace(/^0+/, '').toUpperCase() === u) && (!customer || (fits ? fits(customer, r.customer || '') : String(r.customer || '').toUpperCase().includes(String(customer).toUpperCase())));
    const say = (r) => ({ trip: r.trip, truck: r.truck, customer: r.customer, place: r.place, arrived: fmtLocalShort(r.arrivedMs, r.place || 'FL'), left: r.leftMs ? fmtLocalShort(r.leftMs, r.place || 'FL') : null, time_there: hm(r.minutes) });
    const done = Object.values((await db.get(TIMES(site), {})) || {}).filter((r) => r.leftMs >= since && want(r)).sort((a, b) => b.arrivedMs - a.arrivedMs);
    const visits = (await db.get(`taStopVisits:${site}`, {})) || {};
    const live = [];
    for (const [t, vs] of Object.entries(visits)) for (const v of Object.values(vs || {})) {
      if (!v || !v.enteredAt || v.exitedAt || !/at_stop|departing/.test(String(v.state || ''))) continue;
      const r = { trip: String(t), truck: v.unit || null, customer: (v.geofence && v.geofence.name) || null, place: null, arrivedMs: v.enteredAt, minutes: Math.round((now() - v.enteredAt) / MIN) };
      if (want(r)) live.push({ trip: r.trip, truck: r.truck, customer: r.customer, arrived: fmtLocalShort(r.arrivedMs, 'FL'), there_so_far: hm(r.minutes) });
    }
    const mins = done.map((r) => r.minutes).filter((m) => m != null);
    return { stops: done.slice(0, 40).map(say), count: done.length, average: mins.length ? hm(Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)) : null, atStopNow: live.slice(0, 20) };
  }
  // the ETAs we gave vs when the truck got there, per stop — for a trip on the board or already finished
  async function etaVsActual(item, site = SITE) {
    if (!enabled || !item) return [];
    const n = tripNo(item);
    const log = ((await db.get(LOG(site), {})) || {})[n] || {};
    const visits = ((await db.get(`taStopVisits:${site}`, {})) || {})[n] || {};
    const times = Object.values((await db.get(TIMES(site), {})) || {}).filter((r) => r.trip === n);
    return reportRows(item, log, visits).map((r) => {
      const first = r.ours[0]; const last = r.ours[r.ours.length - 1];
      // arrival: geofence (live visit, else the stop-times log for this place), else TruckMate / ARTIS delivered
      const t = times.find((x) => x.place && placeKey(x.place) === placeKey(r.label));
      const arrived = r.actual && r.actual.from.startsWith('arrived') ? r.actual : t ? { ms: t.arrivedMs, from: 'arrived (geofence)' } : r.actual;
      const at = (ms) => (ms ? fmtLocalShort(ms, r.label) : null);
      return {
        customer: r.customers.join(', ') || null, stop: r.label,
        eta_we_gave_first: first ? `${at(first.etaMs)} (given ${fmtLocalShort(first.at, 'FL')})` : null,
        eta_we_gave_last: last && last !== first ? `${at(last.etaMs)} (given ${fmtLocalShort(last.at, 'FL')})` : null,
        artis_eta: r.artis.length ? at(r.artis[r.artis.length - 1].etaMs) : null,
        actual_arrival: arrived ? (arrived.ms ? at(arrived.ms) : arrived.text) : null, arrival_from: arrived ? arrived.from : null,
        off_by_last_eta: arrived && arrived.ms && last ? off(last.etaMs, arrived.ms) : null,
        off_by_first_eta: arrived && arrived.ms && first ? off(first.etaMs, arrived.ms) : null,
        time_at_stop: r.stay && r.stay.minutes != null ? hm(r.stay.minutes) : (t ? hm(t.minutes) : null),
      };
    });
  }
  return { process, onFinished, query, etaVsActual, site: SITE };
}

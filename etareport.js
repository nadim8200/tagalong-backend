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
      if (shouldLog(cur, s.etaMs, at)) t[k] = { ...(t[k] || {}), label: s.label, ours: [...cur, { at, etaMs: s.etaMs, miles: s.miles ?? null }].slice(-40) };
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
    return { label: s.label, customers: [...s.customers], ours: h.ours || [], artis: h.artis || [], actual };
  });
}

const off = (etaMs, actualMs) => {
  if (!etaMs || !actualMs) return '';
  const d = Math.round((actualMs - etaMs) / MIN); const a = Math.abs(d);
  const t = a >= 60 ? `${Math.floor(a / 60)} h ${a % 60 ? `${a % 60} min` : ''}`.trim() : `${a} min`;
  return d === 0 ? 'on time' : d > 0 ? `${t} later` : `${t} earlier`;
};
// the email. Pure.
export function renderReport(item, rows, reason = 'finished') {
  const t = tripOf(item); const n = tripNo(item);
  const subject = `ETA report — trip ${n}${t.powerUnit ? ` · truck ${t.powerUnit}` : ''} (${reason === 'delivered' ? 'delivered' : 'finished'})`;
  const when = (ms, place) => (ms ? fmtLocalShort(ms, place) : '—');
  const cell = 'padding:6px 8px;border-top:1px solid #E2E8F0;vertical-align:top;font-size:13px;color:#172538;';
  const body = rows.map((r) => {
    const first = r.ours[0]; const last = r.ours[r.ours.length - 1];
    const act = r.actual ? (r.actual.ms ? when(r.actual.ms, r.label) : esc(r.actual.text)) : 'not recorded';
    const hist = r.ours.map((e) => `${when(e.at, 'FL')} → <b>${when(e.etaMs, r.label)}</b>${e.miles != null ? ` (${e.miles} mi out)` : ''}`).join('<br>');
    const art = r.artis.map((e) => `${when(e.at, 'FL')} → ${when(e.etaMs, r.label)}`).join('<br>');
    return `<tr><td style="${cell}"><b>${esc(r.customers.join(', ') || r.label)}</b><br><span style="color:#596A7F">${esc(r.label)}</span></td>
<td style="${cell}">${first ? `${when(first.etaMs, r.label)}<br><span style="color:#596A7F">given ${when(first.at, 'FL')}</span>` : '—'}</td>
<td style="${cell}">${last ? `${when(last.etaMs, r.label)}<br><span style="color:#596A7F">given ${when(last.at, 'FL')}</span>` : '—'}</td>
<td style="${cell}"><b>${act}</b>${r.actual ? `<br><span style="color:#596A7F">${esc(r.actual.from)}</span>` : ''}</td>
<td style="${cell}">${r.actual && r.actual.ms ? `first: ${off(first && first.etaMs, r.actual.ms) || '—'}<br>last: ${off(last && last.etaMs, r.actual.ms) || '—'}` : '—'}</td></tr>
${hist || art ? `<tr><td colspan="5" style="padding:0 8px 8px;font-size:12px;color:#596A7F;">${hist ? `<b>Our ETAs along the way</b> (given → ETA):<br>${hist}` : ''}${art ? `<br><b>ARTIS ETA</b> (read → ETA):<br>${art}` : ''}</td></tr>` : ''}`;
  }).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#172538;max-width:760px">
<h2 style="font-size:20px;margin:0 0 4px">ETA report — trip ${esc(n)}</h2>
<div style="color:#596A7F;font-size:13px;margin-bottom:12px">Truck ${esc(t.powerUnit || '—')} · trailer ${esc(t.trailer || '—')} · ${esc(t.origZoneDesc || '')} → ${esc(t.destZoneDesc || '')}. The ETAs we gave along the way vs when the truck actually got to each customer.</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">
<tr style="background:#F4F6F9"><th align="left" style="padding:6px 8px;font-size:12px">Customer · stop</th><th align="left" style="padding:6px 8px;font-size:12px">First ETA</th><th align="left" style="padding:6px 8px;font-size:12px">Last ETA</th><th align="left" style="padding:6px 8px;font-size:12px">Actual</th><th align="left" style="padding:6px 8px;font-size:12px">Off by</th></tr>
${body || `<tr><td colspan="5" style="${cell}">No stops on this trip.</td></tr>`}
</table>
<p style="color:#596A7F;font-size:12px">Times in ET (stop's local time in parentheses when it isn't Eastern). Our ETA = 55 mph, driving hours and 1 h per stop. Actual = the truck entering the customer's geofence, else the delivered time in TruckMate / ARTIS.</p>
<p style="font-size:13px">— Jarvis, AI Dispatcher</p></div>`;
  return { subject, html };
}

export function initEtaReport({ db, sendMail = null, recipients = async () => [], now = () => Date.now() }) {
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
  }
  // the trip finished → the report (once per trip)
  async function onFinished(site, rec, reason) {
    if (!enabled || !rec || !rec.item || !sendMail) return null;
    const n = tripNo(rec.item); if (!n) return null;
    const sent = (await db.get(SENT(site), {})) || {};
    if (sent[n]) return null;
    const to = await recipients();
    if (!to.length) return null;
    const log = ((await db.get(LOG(site), {})) || {})[n] || {};
    const visits = ((await db.get(`taStopVisits:${site}`, {})) || {})[n] || {};
    const rows = reportRows(rec.item, log, visits);
    if (!rows.length) return null;
    const m = renderReport(rec.item, rows, reason);
    await sendMail({ to, subject: m.subject, html: m.html });
    await db.update(SENT(site), (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [n]: new Date(now()).toISOString() }).slice(-1000)), {});
    return m;
  }
  return { process, onFinished, site: SITE };
}

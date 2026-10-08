// Flower loads update — an email for the owners and customer service on how every
// flower load is running: where the truck is, next stop and ETA, the last stop and
// ETA, what's running late and why, and anything else open on the load (reefer,
// breakdown, stopped, no GPS). Late loads first. Sent at set times each day.
//
// Built from the board + the Watchtower's stored ETAs and open alerts — the same
// numbers the console cards and Jarvis use.
import { sendMail, mailConfig } from './mailer.js';
import { originOf } from './voice.js';
import { fmtLocal } from './localtime.js';

const MIN = 60000;
const TZ = 'America/New_York';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const town = (x) => String(x || '').split(',')[0].trim().toUpperCase();
const cityOf = (s) => String(s || '').replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim();
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (ms, now) => { const m = Math.round((now - ms) / MIN); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

// A flower load: from the Miami / Ventura terminal, a FLOWERS trip sheet, or flower bills (not only broker B/R bills).
export function isFlowerLoad(it) {
  const t = tripOf(it); const m = it && it._manifest;
  if (/TERMINAL/i.test(String(t.origZoneDesc || ''))) return true;
  if (m && /FLOWER/i.test(String(m.commodity || ''))) return true;
  if (m && ((m.stops || []).some((x) => /^LOAD/i.test(x.action || '') && /TERMINAL/i.test(String(x.customer || ''))))) return true;
  const bills = billsOf(it);
  return bills.length > 0 && bills.some((b) => /^[MGHP]/i.test(String(b.billNumber || '')));
}

const STATUS = { DISP: 'Not picked up yet', ASSGN: 'Not picked up yet', ARRSHIP: 'Loading', DEPSHIP: 'On the road', ARRCONS: 'At a delivery', DEPCONS: 'On the road (delivering)' };
const RANK = { BREAKDOWN: 0, LATE: 1, 'AT RISK': 2, 'NO GPS': 3, 'ON TIME': 4, 'NOT LEFT': 5 };
const COLOR = { BREAKDOWN: '#b91c1c', LATE: '#dc2626', 'AT RISK': '#d97706', 'NO GPS': '#6b7280', 'ON TIME': '#15803d', 'NOT LEFT': '#2563eb' };

// One load. Pure. eta = Watchtower's stored route for the trip; alerts = its open alerts.
export function flowerRow(it, eta, alerts = [], now = Date.now()) {
  const t = tripOf(it); const live = it._samsara || {}; const m = it._manifest || {};
  const sheet = (m.stops || []).filter((x) => /DELIVER/i.test(x.action || ''));
  const nameAt = (label) => { const h = sheet.find((x) => town(x.tmPlace || x.city) === town(cityOf(label)) || town(x.city) === town(cityOf(label))); return h ? h.customer : null; };
  const stops = (eta && eta.stops) || [];
  const next = stops[0] || null; const last = stops[stops.length - 1] || null;
  const total = new Set(billsOf(it).map((b) => town(b.endZoneDescription)).filter(Boolean)).size || sheet.length;
  const done = new Set(billsOf(it).filter((b) => b.actualDelivery).map((b) => town(b.endZoneDescription))).size + ((eta && eta.passed) || []).length;
  const late = alerts.find((a) => a.code === 'late-risk');
  const passedAppt = alerts.find((a) => a.code === 'appt-passed');
  const gpsAge = live.gpsAt ? (now - Date.parse(live.gpsAt)) / MIN : null;
  const code = String(t.status || '').toUpperCase();
  let state = 'ON TIME';
  if (it._breakdown && it._breakdown.on) state = 'BREAKDOWN';
  else if ((late && late.severity === 'critical') || passedAppt) state = 'LATE';
  else if (late) state = 'AT RISK';
  else if (/^(DISP|ASSGN)/.test(code)) state = 'NOT LEFT';
  else if (!stops.length && (gpsAge == null || gpsAge > 60)) state = 'NO GPS';
  const hold = it._hold && /^(pickup_delayed|driver_changed|truck_changed)$/.test(it._hold.kind) ? it._hold : null;
  if (hold && state === 'ON TIME') state = 'AT RISK';
  if (hold && state === 'NOT LEFT') state = 'AT RISK';
  const holdAlert = alerts.find((a) => a.code === 'pickup-hold');
  if (holdAlert && holdAlert.severity === 'critical' && state !== 'BREAKDOWN') state = 'LATE';
  const why = [hold && `${{ pickup_delayed: 'Pickup on hold', driver_changed: 'Driver changed', truck_changed: 'Truck changed' }[hold.kind]}: ${hold.note}`, late && late.title, passedAppt && passedAppt.title].filter(Boolean).join(' · ');
  const other = alerts.filter((a) => !['late-risk', 'appt-passed', 'pickup-hold', 'sheet-mismatch', 'appt-missing', 'email-todo', 'call-ahead'].includes(a.code)).map((a) => a.title).slice(0, 3);
  const drivers = [live.driver1, live.driver2].filter(Boolean).join(' & ') || (m.drivers || []).map((d) => d.name).filter(Boolean).join(' & ');
  const where = live.location ? String(live.location).split(',').map((x) => x.trim()).filter((x) => !/^\d{5}/.test(x)).slice(-2).join(', ') : null;
  return {
    trip: tripNo(it), truck: String(t.powerUnit || ''), trailer: String(t.trailer || ''), drivers, from: originOf(it) || '',
    state, status: STATUS[code] || String(t.statusDesc || code || '').toLowerCase(),
    now: where ? `${where}${live.gpsAt ? ` (${ago(Date.parse(live.gpsAt), now)})` : ''}${live.speedMph != null ? (live.speedMph > 5 ? ` · ${Math.round(live.speedMph)} mph` : ' · stopped') : ''}` : 'No GPS',
    next: next ? `${nameAt(next.label) ? `${nameAt(next.label)}, ` : ''}${cityOf(next.label)}` : '—',
    nextEta: next ? fmtLocal(next.etaMs, next.label, { local: false }) : (state === 'NOT LEFT' ? 'not left yet' : '—'),   // the stop's local time
    nextAppt: next && next.apptMs ? fmtLocal(next.apptMs, next.label, { local: false }) : '',
    final: last ? cityOf(last.label) : cityOf(t.destZoneDesc),
    finalEta: last && last !== next ? fmtLocal(last.etaMs, last.label, { local: false }) : '',
    progress: total ? `${Math.min(done, total)} of ${total} stops done` : '',
    why, other,
  };
}

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The whole email. Pure.
export function buildFlowerReport(rows, now = Date.now()) {
  const sorted = [...rows].sort((a, b) => (RANK[a.state] - RANK[b.state]) || a.trip.localeCompare(b.trip));
  const count = (s) => rows.filter((r) => r.state === s).length;
  const n = { late: count('LATE'), risk: count('AT RISK'), ok: count('ON TIME'), nogps: count('NO GPS'), notleft: count('NOT LEFT'), bd: count('BREAKDOWN') };
  const when = new Date(now).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit' });
  const subject = `Flower loads update — ${when} · ${n.late + n.bd ? `${n.late + n.bd} late` : 'none late'}, ${n.risk} at risk, ${n.ok} on time`;
  const chip = (s) => `<span style="display:inline-block;padding:1px 7px;border-radius:9px;background:${COLOR[s]};color:#fff;font-size:11px;font-weight:bold">${s}</span>`;
  const th = (x) => `<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #ccc;font-size:12px">${x}</th>`;
  const td = (x, extra = '') => `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top;${extra}">${x}</td>`;
  const row = (r) => `<tr>${[
    chip(r.state),
    `<b>${esc(r.trip)}</b><br><span style="color:#666">Truck ${esc(r.truck)}${r.trailer ? ` · Trl ${esc(r.trailer)}` : ''}</span>`,
    `${esc(r.from)}${r.drivers ? `<br><span style="color:#666">${esc(r.drivers)}</span>` : ''}`,
    `${esc(r.now)}<br><span style="color:#666">${esc(r.status)}</span>`,
    `${esc(r.next)}<br><b>${esc(r.nextEta)}</b>${r.nextAppt ? `<br><span style="color:#666">appt ${esc(r.nextAppt)}</span>` : ''}`,
    `${esc(r.final)}${r.finalEta ? `<br>${esc(r.finalEta)}` : ''}<br><span style="color:#666">${esc(r.progress)}</span>`,
    `${r.why ? `<span style="color:#b91c1c">${esc(r.why)}</span>` : ''}${r.other.length ? `${r.why ? '<br>' : ''}${r.other.map(esc).join('<br>')}` : ''}`,
  ].map((x, i) => td(x, i === 6 ? 'max-width:320px;white-space:normal' : 'white-space:nowrap')).join('')}</tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>Good day,</p>
<p>Here is how the flower loads are running as of ${esc(when)} (Eastern):</p>
<p><b>${rows.length} loads</b> · ${chip('LATE')} ${n.late + n.bd}${n.bd ? ` (${n.bd} breakdown)` : ''} &nbsp; ${chip('AT RISK')} ${n.risk} &nbsp; ${chip('ON TIME')} ${n.ok}${n.notleft ? ` &nbsp; ${chip('NOT LEFT')} ${n.notleft}` : ''}${n.nogps ? ` &nbsp; ${chip('NO GPS')} ${n.nogps}` : ''}</p>
<table cellspacing="0" style="border-collapse:collapse">
<tr>${['', 'Trip', 'From / drivers', 'Truck now', 'Next stop · ETA', 'Last stop', 'Late / issues'].map(th).join('')}</tr>
${sorted.map(row).join('\n')}
</table>
<p style="color:#666;font-size:12px">ETAs and appointments are in each delivery's local time. They are estimates (55 mph, drivers' hours, time at each stop) and may change with traffic, weather or road conditions. LATE = will miss or already missed an appointment; AT RISK = may miss a due time.</p>
<p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>`;
  return { subject, html, rows: sorted, counts: n, at: now };
}

export function initFlowerReport(app, { requireAuth, db, getBoard, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const site = 'florida-beauty';
  const cfgKey = 'taFlowerReportCfg';
  const DEFAULTS = { to: [], times: ['07:00', '15:00'], auto: true };
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const settings = async () => ({ ...DEFAULTS, ...((enabled && (await db.get(cfgKey, {}))) || {}) });

  async function make() {
    const [board, watch] = await Promise.all([getBoard(site), db.get(`taWatch:${site}`, { alerts: {} })]);
    const open = Object.values((watch && watch.alerts) || {}).filter((a) => !a.resolvedAt);
    const etas = (watch && watch.etas) || {};
    const rows = ((board && board.trips) || []).filter(isFlowerLoad).map((it) => flowerRow(it, etas[tripNo(it)], open.filter((a) => a.trip === tripNo(it)), now()));
    return buildFlowerReport(rows, now());
  }
  async function send(by) {
    const cfg = await settings();
    const rep = await make();
    const r = await sendMail({ to: cfg.to, subject: rep.subject, html: rep.html }, { env, fetchFn });
    await db.update(cfgKey, (cur) => ({ ...(cur || {}), lastSentAt: new Date(now()).toISOString(), lastSentBy: by, lastSubject: rep.subject }), {});
    return { ...r, sentTo: cfg.to, subject: rep.subject };
  }

  app.get('/truckmate/flower-report', requireAuth, async (req, res) => {
    try { const c = mailConfig(env); res.json({ ...(await make()), settings: await settings(), outlook: { connected: c.ready, from: c.from || null } }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/truckmate/flower-report/send', requireAuth, async (req, res) => {
    try { res.json(await send(who(req))); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/truckmate/flower-report/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 30);
    const times = [...new Set(String(Array.isArray(b.times) ? b.times.join(',') : b.times || '').split(/[,;\s]+/).filter((x) => /^\d{2}:\d{2}$/.test(x)))].sort().slice(0, 8);
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, times: times.length ? times : DEFAULTS.times, auto: b.auto !== false, updatedBy: who(req), updatedAt: new Date().toISOString() }), {}));
  });

  // At each set time (Eastern), once a day per time — only when there are recipients and Outlook is connected.
  if (enabled && env.FLOWER_REPORT !== 'off') {
    const timer = setInterval(async () => {
      try {
        const cfg = await settings();
        if (!cfg.auto || !cfg.to.length || !mailConfig(env).ready) return;
        const hm = new Date(now()).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
        const today = new Date(now()).toLocaleDateString('en-CA', { timeZone: TZ });
        const due = cfg.times.filter((x) => x <= hm).pop();
        if (!due) return;
        const slot = `${today} ${due}`;
        if (cfg.lastSlot === slot) return;
        await db.update(cfgKey, (cur) => ({ ...(cur || {}), lastSlot: slot }), {});
        await send(`Jarvis (${due})`);
      } catch (e) { console.warn('[flower-report]', e.message); }
    }, 5 * MIN);
    if (timer.unref) timer.unref();
  }
  console.log(`[flower-report] flower loads update ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { make, send };
}

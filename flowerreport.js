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
  // Phone-first: one card per load, grouped by what needs attention. Email-safe (tables + inline styles).
  const chip = (st, big = false) => `<span style="display:inline-block;padding:${big ? '3px 10px' : '2px 8px'};border-radius:10px;background:${COLOR[st]};color:#ffffff;font-size:${big ? 12 : 11}px;font-weight:bold;letter-spacing:.3px">${st}</span>`;
  const GROUPS = [
    ['Late', ['BREAKDOWN', 'LATE'], 'Will miss or already missed an appointment.'],
    ['At risk', ['AT RISK'], 'May miss a due time, or the pickup is on hold.'],
    ['Not left yet', ['NOT LEFT'], ''],
    ['No GPS', ['NO GPS'], 'No live position — mostly outside carriers without a check-in yet.'],
    ['On time', ['ON TIME'], ''],
  ];
  const line = (icon, label, value) => (value ? `<tr><td style="padding:3px 0;width:22px;vertical-align:top;font-size:14px">${icon}</td><td style="padding:3px 0;font-size:14px;color:#1f2937;line-height:1.35"><span style="color:#6b7280">${label}</span> ${value}</td></tr>` : '');
  const card = (r) => {
    const issues = [r.why, ...r.other].filter(Boolean).slice(0, 3);
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;margin:0 0 10px;background:#ffffff;border:1px solid #e5e7eb;border-left:5px solid ${COLOR[r.state]};border-radius:8px">
<tr><td style="padding:10px 12px">
  <div style="font-size:16px;color:#111827;margin-bottom:2px">${chip(r.state)} &nbsp;<b>Trip ${esc(r.trip)}</b></div>
  <div style="font-size:13px;color:#6b7280;margin-bottom:6px">Truck ${esc(r.truck || '—')}${r.trailer ? ` · Trailer ${esc(r.trailer)}` : ''}${r.drivers ? ` · ${esc(r.drivers)}` : ''}</div>
  <table role="presentation" cellspacing="0" cellpadding="0" width="100%">
    ${line('📍', 'Now:', `<b>${esc(r.now)}</b>${r.status ? ` <span style="color:#6b7280">· ${esc(r.status)}</span>` : ''}`)}
    ${line('➡️', 'Next:', r.next && r.next !== '—' && `${esc(r.next)}${r.nextEta && r.nextEta !== '—' ? ` — ETA <b>${esc(r.nextEta)}</b>` : ''}${r.nextAppt ? `<br><span style="color:#6b7280">appointment ${esc(r.nextAppt)}</span>` : ''}`)}
    ${line('🏁', 'Final:', r.final && r.final !== cityOf(r.next) ? `${esc(r.final)}${r.finalEta ? ` — ${esc(r.finalEta)}` : ''}` : '')}
    ${line('🚚', 'From:', `${esc(r.from)}${r.progress ? ` <span style="color:#6b7280">· ${esc(r.progress)}</span>` : ''}`)}
  </table>
  ${issues.length ? `<div style="margin-top:8px;padding:7px 9px;background:#fef2f2;border-radius:6px;font-size:13px;color:#991b1b;line-height:1.35">${issues.map((x) => `• ${esc(x)}`).join('<br>')}</div>` : ''}
</td></tr></table>`;
  };
  // on-time loads: one compact line each
  const okLine = (r) => `<tr><td style="padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1f2937;line-height:1.35"><b>Trip ${esc(r.trip)}</b> <span style="color:#6b7280">· Truck ${esc(r.truck || '—')}</span><br>📍 ${esc(r.now)}${r.next && r.next !== '—' ? `<br>➡️ ${esc(r.next)}${r.nextEta && r.nextEta !== '—' ? ` — <b>${esc(r.nextEta)}</b>` : ''}` : ''}</td></tr>`;
  const section = ([title, states, note]) => {
    const list = sorted.filter((r) => states.includes(r.state));
    if (!list.length) return '';
    const head = `<div style="margin:18px 0 8px;font-size:15px;font-weight:bold;color:#111827">${chip(states[states.length - 1], true)} &nbsp;${esc(title)} (${list.length})</div>${note ? `<div style="margin:-4px 0 8px;font-size:12px;color:#6b7280">${esc(note)}</div>` : ''}`;
    return states.includes('ON TIME') ? `${head}<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${list.map(okLine).join('')}</table>` : head + list.map(card).join('');
  };
  const pill = (label, value, color) => `<td style="padding:4px"><div style="background:${color};color:#ffffff;border-radius:8px;padding:8px 4px;text-align:center"><div style="font-size:20px;font-weight:bold;line-height:1">${value}</div><div style="font-size:11px;margin-top:3px">${label}</div></div></td>`;
  const html = `<div style="background:#f3f4f6;padding:12px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px"><tr><td style="padding:16px 14px">
  <div style="font-size:20px;font-weight:bold;color:#111827">🌸 Flower loads update</div>
  <div style="font-size:13px;color:#6b7280;margin:2px 0 12px">${esc(when)} (Eastern) · ${rows.length} loads</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    ${pill('Late', n.late + n.bd, COLOR.LATE)}${pill('At risk', n.risk, COLOR['AT RISK'])}${pill('On time', n.ok, COLOR['ON TIME'])}${n.notleft ? pill('Not left', n.notleft, COLOR['NOT LEFT']) : ''}${n.nogps ? pill('No GPS', n.nogps, COLOR['NO GPS']) : ''}
  </tr></table>
  ${GROUPS.map(section).join('\n')}
  <div style="margin-top:16px;font-size:12px;color:#6b7280;line-height:1.4">ETAs and appointments are in each delivery's local time. They are estimates (55 mph, drivers' hours, time at each stop) and may change with traffic, weather or road conditions.</div>
  <div style="margin-top:10px;font-size:13px;color:#374151">Jarvis — AI Dispatcher · Florida Beauty Flora</div>
</td></tr></table></div>`;
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

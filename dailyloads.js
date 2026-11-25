// ---------------------------------------------------------------
// The 8 AM loads summary (Nov 25, Nadim): every load with a delivery appointment today — late, issues, on time — checked
// against the appointment we have (TruckMate's, else the rate con's, else the trip sheet's or the time dispatch committed),
// LTL loads apart from broker loads. Sent to Luis Jimenez every morning at 8 AM ET, straight through (not held by training).
// Recipients are the "daily_loads" list (Employees → Alert emails).
// ---------------------------------------------------------------
import { tripFacts, brokerLoad, localToUtcMs } from './watchtower.js';
import { hubOf } from './usualarrival.js';
import { jarvisEmail, esc, C, section, metrics } from './jarvismail.js';

const MIN = 60000;
const GRACE_MIN = 15;   // within 15 min of the appointment counts as on time
const KEY = 'taAlertRecipients';
export const DAILY_DEFAULTS = ['ljimenez@floridabeauty.us'];
const FROM = { 'truckmate-appt': 'TruckMate', 'truckmate-due': 'TruckMate', ratecon: 'Rate con', handwritten: 'Trip sheet', printed: 'Trip sheet', sheet: 'Trip sheet', committed: 'Committed time' };
const SKIP_ALERTS = /^(late-risk|appt-passed)/;   // judged here from the appointment itself

const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHour = (ms) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
const clock = (ms, tz) => new Date(ms).toLocaleString('en-US', { timeZone: tz || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export const hm = (min) => { const m = Math.max(0, Math.round(min)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
const title = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (x) => x.toUpperCase()).replace(/,\s*([a-z]{2})\b/i, (x, st) => `, ${st.toUpperCase()}`);

// when each stop (TruckMate's destination zone) was delivered, from its bills. Pure.
function deliveredAt(item, stop) {
  const bills = (item.freightBills || item.orders || (item.trip && item.trip.freightBills) || []).filter((b) => String(b.endZone || b.endZoneDescription || '') === stop.key);
  const ms = bills.map((b) => (b.actualDelivery ? localToUtcMs(String(b.actualDelivery).slice(0, 16), stop.tz) : NaN)).filter((x) => !Number.isNaN(x));
  return ms.length ? Math.max(...ms) : null;
}

// One stop judged against its appointment. Pure.
export function judgeStop(stop, { now, etaMs = null, doneMs = null }) {
  const appt = stop.apptMs;
  if (stop.delivered) {
    if (doneMs == null) return { status: 'ontime', text: 'Delivered' };
    const late = (doneMs - appt) / MIN;
    return late > GRACE_MIN ? { status: 'late', lateMin: late, text: `Delivered ${hm(late)} late` } : { status: 'ontime', text: 'Delivered on time' };
  }
  if (now > appt + GRACE_MIN * MIN) return { status: 'late', lateMin: (now - appt) / MIN, text: `Missed — appointment passed ${hm((now - appt) / MIN)} ago, not delivered` };
  if (etaMs == null) return { status: 'check', text: 'No ETA (no fresh GPS) — check with the driver' };
  const late = (etaMs - appt) / MIN;
  return late > GRACE_MIN ? { status: 'late', lateMin: late, text: `Running late ~${hm(late)} (ETA ${clock(etaMs, stop.tz)})` } : { status: 'ontime', text: `On time (ETA ${clock(etaMs, stop.tz)})` };
}

const RANK = { late: 3, issue: 2, check: 1, ontime: 0 };
// Today's loads: every load with a delivery appointment today (or one missed before today and still not delivered). Pure.
export function dailyLoads(items = [], { now = Date.now(), etas = {}, alerts = [] } = {}) {
  const today = etDay(now);
  const openAlerts = new Map();
  for (const a of alerts) if (a && !a.resolvedAt && a.trip && !SKIP_ALERTS.test(String(a.code || ''))) (openAlerts.get(String(a.trip)) || openAlerts.set(String(a.trip), []).get(String(a.trip))).push(a);
  const loads = [];
  for (const item of items) {
    let f; try { f = tripFacts(item, now); } catch { continue; }
    if (!f || !f.trip) continue;
    const eta = etas[f.trip] || {};
    const stops = [];
    for (const st of f.stops || []) {
      if (st.apptMs == null) continue;
      const doneMs = st.delivered ? deliveredAt(item, st) : null;
      const isToday = etDay(st.apptMs) === today;
      const missedBefore = !st.delivered && st.apptMs < now && etDay(st.apptMs) < today && now - st.apptMs < 3 * 24 * 60 * MIN;
      const deliveredToday = st.delivered && doneMs != null && etDay(doneMs) === today && isToday;
      if (!(isToday || missedBefore) || (st.delivered && !deliveredToday && !isToday)) continue;
      const e = (eta.stops || []).find((x) => x.key === st.key);
      const j = judgeStop(st, { now, etaMs: e && e.etaMs != null ? e.etaMs : null, doneMs });
      stops.push({ place: title(st.label), customers: st.customers || st.consignees || [], appt: clock(st.apptMs, st.tz), apptMs: st.apptMs, from: FROM[st.apptFrom] || 'TruckMate', ...j });
    }
    if (!stops.length) continue;
    const issues = (openAlerts.get(f.trip) || []).sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1)).map((a) => ({ title: a.title, critical: a.severity === 'critical' }));
    let status = stops.reduce((w, s) => (RANK[s.status] > RANK[w] ? s.status : w), 'ontime');
    if (status !== 'late' && issues.length) status = 'issue';
    const broker = brokerLoad(item);
    let hub = null; try { hub = broker ? null : hubOf(item); } catch { hub = null; }
    const bills = (item.freightBills || item.orders || []).map((b) => b.billNumber).filter(Boolean);
    loads.push({ trip: f.trip, truck: f.unit, trailer: f.trailer, driver: f.driver, broker, hub, load: broker ? ((item._ratecon && (item._ratecon.loadNumber || item._ratecon.broker)) || bills[0] || null) : null, brokerName: broker && item._ratecon ? item._ratecon.broker || null : null, lane: `${title(f.origin)} → ${title(f.dest)}`, status, stops: stops.sort((a, b) => a.apptMs - b.apptMs), issues });
  }
  const order = (a, b) => RANK[b.status] - RANK[a.status] || a.stops[0].apptMs - b.stops[0].apptMs;
  const ltl = loads.filter((l) => !l.broker).sort(order); const broker = loads.filter((l) => l.broker).sort(order);
  const count = (list, s) => list.filter((l) => l.status === s).length;
  const counts = Object.fromEntries(['late', 'issue', 'ontime', 'check'].map((s) => [s, count(loads, s)]));
  return { day: today, ltl, broker, counts, total: loads.length };
}

const PILL = { late: ['LATE', '#b42318', '#fdecea'], issue: ['ISSUE', '#9a6700', '#fff6e0'], check: ['CHECK', '#475467', '#eef2f6'], ontime: ['ON TIME', '#067647', '#e7f6ec'] };
const pill = (s) => { const [t, fg, bg] = PILL[s]; return `<span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:bold;letter-spacing:.04em;white-space:nowrap">${t}</span>`; };
const FONT = 'Arial,Helvetica,sans-serif';
function loadCard(l) {
  const head = [`Trip ${l.trip}`, l.truck ? `Truck ${l.truck}` : null, l.driver ? title(l.driver) : null, l.trailer ? `Trailer ${l.trailer}` : null].filter(Boolean).map(esc).join(' &middot; ');
  const sub = [l.broker ? [l.brokerName, l.load ? `Load ${l.load}` : null].filter(Boolean).join(' · ') : l.hub ? `${title(l.hub)} hub` : null, l.lane].filter(Boolean).map(esc).join(' &middot; ');
  const stops = l.stops.map((s) => `<tr><td style="padding:8px 0 0;font-family:${FONT};font-size:13px;line-height:1.45;color:${C.ink}"><b>${esc(s.customers.length ? `${s.customers.slice(0, 2).map(title).join(', ')} — ${s.place}` : s.place)}</b><br><span style="color:${C.muted}">Appointment ${esc(s.appt)} · ${esc(s.from)}</span><br><span style="color:${s.status === 'late' ? '#b42318' : s.status === 'check' ? '#475467' : '#067647'};font-weight:bold">${esc(s.text)}</span></td></tr>`).join('');
  const issues = l.issues.length ? `<tr><td style="padding:8px 0 0;font-family:${FONT};font-size:13px;line-height:1.45;color:#9a6700">${l.issues.slice(0, 4).map((i) => `&#9888; ${esc(i.title)}`).join('<br>')}</td></tr>` : '';
  return `<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};border-left:4px solid ${PILL[l.status][1]};border-radius:10px;border-collapse:separate"><tr><td style="padding:12px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-family:${FONT};font-size:14px;color:${C.ink}"><b>${head}</b></td><td align="right" valign="top" style="padding-left:8px">${pill(l.status)}</td></tr>
<tr><td colspan="2" style="padding-top:3px;font-family:${FONT};font-size:12px;color:${C.muted}">${sub}</td></tr>${stops}${issues}</table></td></tr></table></td></tr>`;
}
function group(name, list) {
  if (!list.length) return section(name, `<p style="margin:6px 0 0;font-family:${FONT};font-size:13px;color:${C.muted}">No ${name.toLowerCase()} with an appointment today.</p>`);
  const c = (s) => list.filter((l) => l.status === s).length;
  const line = [['late', 'late'], ['issue', 'with issues'], ['ontime', 'on time'], ['check', 'to check']].filter(([s]) => c(s)).map(([s, w]) => `${c(s)} ${w}`).join(' · ');
  return section(`${name} · ${list.length}`, `<p style="margin:4px 0 10px;font-family:${FONT};font-size:13px;color:${C.muted}">${esc(line)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${list.map(loadCard).join('')}</table>`);
}

// The email. Pure.
export function dailyLoadsEmail(d, { test = false, now = Date.now() } = {}) {
  const dayText = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  const k = d.counts;
  const subject = `${test ? 'TEST — ' : ''}Today's loads · ${dayText} · ${k.late} late · ${k.issue} issues · ${k.ontime} on time`;
  const body = `${metrics([['LATE', String(k.late), k.late ? '#b42318' : null], ['ISSUES', String(k.issue), k.issue ? '#9a6700' : null], ['ON TIME', String(k.ontime), '#067647'], ['NO ETA', String(k.check), null]])}
${group('LTL loads', d.ltl)}${group('Broker loads', d.broker)}`;
  const html = jarvisEmail({ test, preheader: `${k.late} late, ${k.issue} with issues, ${k.ontime} on time`, eyebrow: `Loads summary · 8 AM`, tone: k.late ? 'red' : 'blue', title: `Today's loads`, subtitle: dayText,
    meta: [`${d.total} load${d.total === 1 ? '' : 's'} with a delivery appointment today`, 'Appointments: TruckMate, else rate con, else trip sheet'],
    lead: d.total ? `Late = delivered or expected more than ${GRACE_MIN} min after the appointment, or the appointment passed and it isn't delivered. Issues = an open Priority alert on the load (stopped, hours, reefer…).` : 'No load has a delivery appointment today.', body });
  const text = [subject, '', ...[['LTL loads', d.ltl], ['Broker loads', d.broker]].flatMap(([n, list]) => [n.toUpperCase(), ...(list.length ? list.flatMap((l) => [`- ${PILL[l.status][0]} · Trip ${l.trip} · Truck ${l.truck || '—'} · ${title(l.driver || '')}`, ...l.stops.map((s) => `    ${s.place} · appt ${s.appt} (${s.from}) · ${s.text}`), ...l.issues.map((i) => `    ! ${i.title}`)]) : ['  none']), ''])].join('\n');
  return { subject, html, text };
}

// sends at 8 AM ET once a day; also the test email. Wired from etareport.process (every minute with the board).
export function initDailyLoads({ app = null, requireAuth = null, db, send = null, now = () => Date.now(), site = 'florida-beauty' }) {
  const enabled = !!(db && db.enabled);
  const SENT = `taDailyLoadsDay:${site}`;
  let last = { items: [], at: 0 };
  async function recipients() {
    const saved = enabled ? ((await db.get(KEY, {})) || {}) : {};
    const list = Array.isArray(saved.daily_loads) ? saved.daily_loads : DAILY_DEFAULTS;
    return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
  }
  async function build(items) {
    const st = (await db.get(`taWatch:${site}`, {})) || {};
    return dailyLoads(items, { now: now(), etas: st.etas || {}, alerts: Object.values(st.alerts || {}) });
  }
  async function tick(items) {
    if (!enabled || !send) return;
    last = { items: items || [], at: now() };
    const h = etHour(now()); const day = etDay(now());
    if (h < 8 || h > 11) return;   // 8 AM; a restart that morning still sends it by noon
    if ((await db.get(SENT, null)) === day) return;
    await db.set(SENT, day);   // once, even if the email fails (no repeats every minute)
    const to = await recipients(); if (!to.length) return;
    const m = dailyLoadsEmail(await build(last.items), { now: now() });
    try { await send({ to, subject: m.subject, html: m.html, text: m.text }); console.log(`[daily-loads] sent to ${to.join(', ')}`); } catch (e) { console.warn('[daily-loads] email:', e.message); }
  }
  if (app && requireAuth) {
    app.post('/truckmate/daily-loads/test-email', requireAuth, async (req, res) => {
      try {
        if (!enabled || !send) return res.status(503).json({ error: 'Needs the database and Outlook.' });
        if (!last.items.length) return res.status(409).json({ error: 'The board hasn\'t loaded yet — try again in a minute.' });
        const d = await build(last.items); const m = dailyLoadsEmail(d, { test: true, now: now() });
        const to = [String((req.body || {}).to || 'ntellez@floridabeauty.us').trim().toLowerCase()].filter((x) => /@floridabeauty\.us$/.test(x));
        if (!to.length) return res.status(400).json({ error: 'Test emails go to a @floridabeauty.us address.' });
        await send({ to, subject: m.subject, html: m.html, text: m.text });
        res.json({ ok: true, to, counts: d.counts, total: d.total, ltl: d.ltl.length, broker: d.broker.length });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  return { tick, recipients, build };
}

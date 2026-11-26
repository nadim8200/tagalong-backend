// ---------------------------------------------------------------
// The 8 AM broker-loads summary (Nov 25, Nadim): BROKER loads only (Luis doesn't want the flower / LTL loads) — the ones
// running late against the delivery appointment (TruckMate's, else the rate con's) and the ones with an issue: broker emails
// still waiting on us, problems dispatch reported, open to-dos from the load's emails, Priority alerts. Sent to Luis Jimenez every morning at 8 AM ET, straight through (not held by training).
// Recipients are the "daily_loads" list (Employees → Alert emails).
// ---------------------------------------------------------------
import { tripFacts, brokerLoad, localToUtcMs } from './watchtower.js';
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

// TruckMate's due time on these bills is a leftover timestamp (seconds on it, e.g. 13:35:41), not an appointment someone set. Pure.
function timestampOnly(item, stop) {
  const bills = (item.freightBills || item.orders || (item.trip && item.trip.freightBills) || []).filter((b) => String(b.endZone || b.endZoneDescription || '') === stop.key);
  return bills.length > 0 && bills.every((b) => /T\d{2}:\d{2}:(?!00)\d{2}/.test(String(b.deliverBy || '')));
}

// When the truck got to this stop: TruckMate's ARRIVE CONSIGNEE times. A delivered stop → the arrival just before its delivery;
// the stop the truck is at now (ARRCONS / DEPCONS at that zone) → the latest arrival. Pure.
export function arrivedAt(item, stop, doneMs = null) {
  const t = (item && item.trip) || {};
  const arr = (((item && item._times && item._times.statusHistory) || [])).filter((x) => /^ARRCONS/i.test(String(x.status || ''))).map((x) => Date.parse(x.at)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (doneMs != null) { const before = arr.filter((x) => x <= doneMs + MIN && doneMs - x < 18 * 60 * MIN); return before.length ? before[before.length - 1] : null; }
  const here = String(t.currentZone || '') && String(stop.key).startsWith(String(t.currentZone)) && /^(ARRCONS|DEPCONS)/i.test(String(t.status || ''));
  return here ? arr[arr.length - 1] : null;
}
// Staff emailed the POD / delivered, or GPS saw it leave the last delivery (finished.js / inbox.js) — not closed in TruckMate yet. Pure.
const finishedBy = (item) => (item && item._staffPod ? 'POD / delivered email from staff' : item && /^(delivered|left the last delivery|left every)/i.test(String(item._finishGuess || '')) ? String(item._finishGuess).split(' — ')[0] : null);

// One stop judged against its appointment. Pure.
export function judgeStop(stop, { now, etaMs = null, doneMs = null, arriveMs = null }) {
  const appt = stop.apptMs;
  // the truck's arrival is what counts against an appointment (unloading after it isn't late — 627726 arrived 7:15 for 7:00)
  if (arriveMs != null) {
    const late = Math.floor((arriveMs - appt) / MIN);   // whole minutes: 7:15:44 for 7:00 is within the 15
    const when = clock(arriveMs, stop.tz);
    return late > GRACE_MIN ? { status: 'late', lateMin: late, text: `Arrived ${hm(late)} late (${when}, TruckMate)` } : { status: 'ontime', text: `Arrived on time (${when}, TruckMate)${stop.delivered ? '' : ' — not closed yet'}` };
  }
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
const HOUR = 60 * MIN;
const WAIT_MIN = 60;   // a broker email unanswered for an hour+ is an issue
const LOOKBACK = 3 * 24 * HOUR;
const PROBLEM = /^(breakdown|delay|pickup_delayed)$/;
export const isStaff = (address) => /@floridabeauty\.us$/i.test(String(address || '').trim());
const who = (f) => (f && (f.name || f.address)) || 'someone';
const ago = (ms) => hm(ms / MIN);

// Everything open on one broker load: Priority alerts, broker emails still waiting on us, problems staff reported by email,
// open to-dos from the load's emails. Pure.
export function brokerIssues(trip, { now = Date.now(), alerts = [], emails = [], tasks = {}, holds = {} } = {}) {
  const out = []; const seenEmail = new Set();
  for (const a of alerts) if (a && !a.resolvedAt && String(a.trip) === trip && !SKIP_ALERTS.test(String(a.code || ''))) out.push({ kind: 'alert', title: a.title, critical: a.severity === 'critical' });
  for (const e of emails) {
    if (!e || e.auto || !(e.trips || []).map(String).includes(trip)) continue;
    const at = Date.parse(e.at); if (!(now - at < LOOKBACK)) continue;
    const staff = isStaff(e.from && e.from.address);
    const what = e.summary || e.subject || '';
    const u = e.loadUpdate || {};
    if (staff && PROBLEM.test(String(u.kind || ''))) { seenEmail.add(e.id); out.push({ kind: 'reported', title: `Reported by ${who(e.from)} (${ago(now - at)} ago): ${u.note || what}`, critical: u.kind === 'breakdown' }); continue; }
    if (!staff && e.status === 'new' && ((e.reply && e.reply.needed) || e.help) && now - at > WAIT_MIN * MIN) { seenEmail.add(e.id); out.push({ kind: 'unanswered', title: `Not answered — ${who(e.from)} asked ${ago(now - at)} ago: ${what}`, critical: !!(e.help && e.help.urgent) }); }
  }
  const h = holds[trip];
  if (h && PROBLEM.test(String(h.kind || '')) && !seenEmail.has(h.emailId) && now - Date.parse(h.since) < LOOKBACK) out.push({ kind: 'reported', title: `Reported by ${h.from || 'email'}: ${h.note || h.subject || h.kind}`, critical: h.kind === 'breakdown' });
  for (const t of tasks[trip] || []) if (t && !t.done && !(now - Date.parse(t.at) > LOOKBACK)) out.push({ kind: 'todo', title: `To do${t.from ? ` (from ${t.from})` : ''}: ${t.title}`, critical: t.urgency === 'urgent' });
  return out.sort((x, y) => (y.critical ? 1 : 0) - (x.critical ? 1 : 0));
}

// Luis's summary (Nov 25): BROKER loads only — the ones running late (appointment today, or missed and still not delivered)
// and the ones with an issue (any day). Flower / LTL loads are left out. Pure.
export function dailyLoads(items = [], { now = Date.now(), etas = {}, alerts = [], emails = [], tasks = {}, holds = {} } = {}) {
  const today = etDay(now);
  const loads = []; let ontime = 0; let check = 0;
  for (const item of items) {
    if (!brokerLoad(item)) continue;
    let f; try { f = tripFacts(item, now); } catch { continue; }
    if (!f || !f.trip) continue;
    const trip = String(f.trip);
    const eta = etas[trip] || {};
    const done = finishedBy(item);
    const passed = new Set((eta.passed || []).map((x) => x.key));   // GPS: stops behind the truck (watchtower passedCount)
    const stops = [];
    for (const st of f.stops || []) {
      if (st.apptMs == null) continue;
      const doneMs = st.delivered ? deliveredAt(item, st) : null;
      const isToday = etDay(st.apptMs) === today;
      const missedBefore = !st.delivered && st.apptMs < now && etDay(st.apptMs) < today && now - st.apptMs < LOOKBACK;
      if (!(isToday || missedBefore)) continue;
      if (!st.delivered && st.apptFrom && st.apptFrom.startsWith('truckmate') && timestampOnly(item, st)) continue;   // a leftover timestamp, not an appointment
      const e = (eta.stops || []).find((x) => x.key === st.key);
      const arriveMs = arrivedAt(item, st, doneMs);
      const j = !st.delivered && passed.has(st.key) ? { status: 'ontime', text: 'Truck already drove past this stop (GPS) — delivered, not closed in TruckMate yet' }
        : !st.delivered && arriveMs == null && done && st.apptMs < now ? { status: 'check', text: `Delivered (${done}) — not closed in TruckMate; arrival time unknown` }
          : judgeStop(st, { now, etaMs: e && e.etaMs != null ? e.etaMs : null, doneMs, arriveMs });
      stops.push({ place: title(st.label), customers: st.customers || st.consignees || [], appt: clock(st.apptMs, st.tz), apptMs: st.apptMs, from: FROM[st.apptFrom] || 'TruckMate', ...j });
    }
    const issues = brokerIssues(trip, { now, alerts, emails, tasks, holds });
    const worst = stops.reduce((w, s) => (RANK[s.status] > RANK[w] ? s.status : w), 'ontime');
    if (worst !== 'late' && !issues.length) { if (stops.length) { if (worst === 'check') check += 1; else ontime += 1; } continue; }
    const bills = (item.freightBills || item.orders || []).map((b) => b.billNumber).filter(Boolean);
    const rc = item._ratecon || {};
    loads.push({ trip, truck: f.unit, trailer: f.trailer, driver: f.driver, broker: true, load: rc.loadNumber || bills[0] || null, brokerName: rc.broker || null,
      lane: `${title(f.origin)} → ${title(f.dest)}`, status: worst === 'late' ? 'late' : 'issue', stops: (worst === 'late' ? stops.filter((s) => s.status === 'late') : stops).sort((a, b) => a.apptMs - b.apptMs), issues });
  }
  const late = loads.filter((l) => l.status === 'late').sort((a, b) => (b.stops[0].lateMin || 0) - (a.stops[0].lateMin || 0));
  const withIssues = loads.filter((l) => l.status === 'issue').sort((a, b) => b.issues.filter((i) => i.critical).length - a.issues.filter((i) => i.critical).length);
  return { day: today, late, issues: withIssues, counts: { late: late.length, issue: withIssues.length, ontime, check }, total: loads.length };
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
function group(name, list, empty) {
  if (!list.length) return section(name, `<p style="margin:6px 0 0;font-family:${FONT};font-size:13px;color:${C.muted}">${esc(empty)}</p>`);
  return section(`${name} · ${list.length}`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px">${list.map(loadCard).join('')}</table>`);
}

// The email. Pure.
export function dailyLoadsEmail(d, { test = false, now = Date.now() } = {}) {
  const dayText = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  const k = d.counts;
  const subject = `${test ? 'TEST — ' : ''}Broker loads · ${dayText} · ${k.late} running late · ${k.issue} with issues`;
  const body = `${metrics([['RUNNING LATE', String(k.late), k.late ? '#b42318' : null], ['ISSUES', String(k.issue), k.issue ? '#9a6700' : null], ['ON TIME TODAY', String(k.ontime), '#067647']])}
${group('Running late', d.late, 'No broker load is running late today.')}${group('Issues', d.issues, 'No open issues on broker loads.')}`;
  const html = jarvisEmail({ test, preheader: `${k.late} broker load${k.late === 1 ? '' : 's'} running late, ${k.issue} with issues`, eyebrow: 'Broker loads · 8 AM', tone: k.late ? 'red' : 'blue', title: 'Broker loads', subtitle: dayText,
    meta: ['Broker loads only — flower / LTL loads are not in this email', 'Appointments: TruckMate, else the rate con'],
    lead: `Running late = delivered or expected more than ${GRACE_MIN} min after the delivery appointment, or the appointment passed and it isn't delivered. Issues = broker emails still waiting on us, problems dispatch reported, open to-dos from the load's emails, and Priority alerts.`, body });
  const card = (l) => [`- ${PILL[l.status][0]} · Trip ${l.trip} · ${[l.brokerName, l.load ? `Load ${l.load}` : null].filter(Boolean).join(' ')} · Truck ${l.truck || '—'} · ${title(l.driver || '')}`, ...l.stops.map((s) => `    ${s.place} · appt ${s.appt} (${s.from}) · ${s.text}`), ...l.issues.map((i) => `    ! ${i.title}`)];
  const text = [subject, '', 'RUNNING LATE', ...(d.late.length ? d.late.flatMap(card) : ['  none']), '', 'ISSUES', ...(d.issues.length ? d.issues.flatMap(card) : ['  none'])].join('\n');
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
    const [st, mail, tasks, holds] = await Promise.all([db.get(`taWatch:${site}`, {}), db.get(`taEmails:${site}`, { list: [] }), db.get(`taLoadTasks:${site}`, {}), db.get(`taLoadHold:${site}`, {})]);
    return dailyLoads(items, { now: now(), etas: (st || {}).etas || {}, alerts: Object.values((st || {}).alerts || {}), emails: (mail && mail.list) || [], tasks: tasks || {}, holds: holds || {} });
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
        res.json({ ok: true, to, counts: d.counts, total: d.total });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  return { tick, recipients, build };
}

// ---------------------------------------------------------------
// Committed delivery times — the date + time dispatch promised a customer for a stop (📅 on each stop in
// the console). Once the truck leaves, that time is a commitment: Jarvis uses it as the stop's appointment
// (late-risk alerts, ETAs on calls), and from the morning after the truck left (or 6 h before the
// committed time, whichever is first) it compares the live ETA with it. Projected more than an hour late →
// one email + one text to the people set in Employees → Alert emails ("Late for a committed time").
// Internal only — the customer is never contacted automatically.
// ---------------------------------------------------------------
import { localToUtcMs, brokerLoad } from './watchtower.js';
import { STATE_TZ, fmtLocalShort } from './localtime.js';

const MIN = 60000;
const KEY = (site) => `taCommit:${site}`;
const SENT = (site) => `taCommitSent:${site}`;
const LEFT = (site) => `taCommitLeft:${site}`;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
export const LATE_MIN = 60;
// rolling, at or past a receiver → the truck has left the shipper
const leftShipper = (code) => /^(depship|depshp|intran|enroute|arrcons|depcons)/i.test(String(code || ''));

// "BROUSSARD, LA, 70518" / ("Broussard", "LA") → "BROUSSARD|LA". Pure.
export function stopKey(city, state) {
  const c = String(city || '').split(',')[0].toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
  const s = String(state || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  return c && s ? `${c}|${s}` : null;
}
export const keyOfLabel = (label) => { const p = String(label || '').split(',').map((x) => x.trim()); return stopKey(p[0], p[1]); };

// "2026-10-23T08:00" in the stop's state → epoch ms (null when not a real date/time). Pure.
export function commitMs(local, state) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(local || ''))) return null;
  const ms = localToUtcMs(local, STATE_TZ[String(state || '').toUpperCase()] || 'America/New_York');
  return Number.isNaN(ms) ? null : ms;
}

// ---- remembered for next time: per customer + location ----
// Set once, it carries to the next outbound for the same customer + location: a load on the SAME weekday as
// before gets the same weekday + time (Wed load → Fri 8 AM); a load on another day gets the same number of
// days after loading, at the same time. Filled in automatically ("saved from a previous load"), still editable.
const STAND = (site) => `taCommitStanding:${site}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const isYmd = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
export const weekday = (ymd) => DAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()];
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
export const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// "ZOOM BLOOM - RFW", "Glenside", "PA" → "ZOOM BLOOM RFW|GLENSIDE|PA". Pure.
export function custKey(customer, city, state) {
  const n = String(customer || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const k = stopKey(city, state);
  return n && k ? `${n}|${k}` : null;
}
// What to remember from a committed time on a load. Pure. → { day, offsetDays, time } | null
export function toStanding(local, loadDate) {
  if (!isYmd(loadDate) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(local || ''))) return null;
  const offsetDays = daysBetween(loadDate, local.slice(0, 10));
  if (offsetDays < 0 || offsetDays > 10) return null;                    // not a believable delivery day
  return { day: weekday(loadDate), offsetDays, time: local.slice(11, 16) };
}
// The remembered time → this load's committed local time. Pure. → { local, rule } | null
export function fromStanding(mem, loadDate) {
  if (!mem || !isYmd(loadDate)) return null;
  const day = weekday(loadDate);
  const same = mem.byLoadDay && mem.byLoadDay[day];
  const r = same || mem.last;
  if (!r || r.offsetDays == null || !r.time) return null;
  const local = `${addDays(loadDate, r.offsetDays)}T${r.time}`;
  const when = new Date(`${local}:00Z`).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return { local, rule: same ? `same as the last ${DAY_NAME[day]} load: ${when}` : `${r.offsetDays} day${r.offsetDays === 1 ? '' : 's'} after loading, ${when.replace(/^\w+,? /, '')}` };
}

// 6 AM Miami time on the day after `ms`. Pure.
export function nextMorning(ms) {
  const d = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const next = new Date(`${d}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return localToUtcMs(`${next.toISOString().slice(0, 10)}T06:00`, 'America/New_York');
}

// Which committed stops are projected late right now. Pure.
//   commits: { key: { local, state, atMs, customer, place } }   etas: taWatch etas[trip]   leftAt: when the truck left
export function lateStops({ commits = {}, etas = null, leftAt = null, now = Date.now(), lateMin = LATE_MIN }) {
  if (!leftAt || !etas || !Array.isArray(etas.stops)) return [];
  const out = [];
  for (const [k, c] of Object.entries(commits)) {
    if (!c || !c.atMs) continue;
    const opens = Math.min(nextMorning(leftAt), c.atMs - 6 * 60 * MIN);   // the morning after it left, or 6 h before
    if (now < opens) continue;
    // TruckMate's town, or (when the sheet names the town differently) the stop that carries this commitment
    const leg = etas.stops.find((s) => keyOfLabel(s.label) === k) || etas.stops.find((s) => s.apptFrom === 'committed' && s.apptMs === c.atMs);
    if (!leg || !leg.etaMs) continue;                                     // delivered / passed / no ETA → nothing to say
    const late = Math.round((leg.etaMs - c.atMs) / MIN);
    if (late > lateMin) out.push({ key: k, ...c, etaMs: leg.etaMs, lateMin: late, miles: leg.miles });
  }
  return out;
}

const hm = (m) => { const h = Math.floor(m / 60); const r = m % 60; return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`; };
// The email + the text. Pure.
export function lateMessage(item, s) {
  const t = tripOf(item); const live = item._samsara || {};
  const where = `${s.customer ? `${s.customer}, ` : ''}${s.place}`;
  const subject = `Late for a committed time — trip ${tripNo(item)} · ${where}`;
  const lines = [
    `Trip ${tripNo(item)} · truck ${t.powerUnit || '—'} · trailer ${t.trailer || '—'}`,
    `Stop: ${where}`,
    `Committed: ${fmtLocalShort(s.atMs, s.place)} (set by ${s.by || 'dispatch'})`,
    `Projected: ${fmtLocalShort(s.etaMs, s.place)} — about ${hm(s.lateMin)} late (${s.miles != null ? `${s.miles} mi to go, ` : ''}55 mph, driving hours, 1 h per stop)`,
    live.location ? `Truck now: ${live.location}${live.gpsAt ? ` (as of ${fmtLocalShort(Date.parse(live.gpsAt), 'FL')})` : ''}` : null,
    'Decide who tells the customer — Jarvis has not contacted them.',
  ].filter(Boolean);
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return {
    subject,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}<p>— Jarvis, AI Dispatcher</p></div>`,
    text: lines.join('\n'),
    sms: `Jarvis: trip ${tripNo(item)} will be ~${hm(s.lateMin)} late to ${where} — committed ${fmtLocalShort(s.atMs, s.place)}, ETA ${fmtLocalShort(s.etaMs, s.place)}.`,
  };
}

// A rate con stop's date + time as written ("10/27/2026" + "0700", "Oct 27" + "7:00 AM", "2026-10-27" + "07:00-15:00")
// → 'YYYY-MM-DDTHH:MM' (the window's start), or null when there's no clear date AND clock time. Pure.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function rcLocal(stop = {}, now = Date.now()) {
  const all = [stop.date, stop.time, stop.appointment].filter(Boolean).join(' ');
  const two = (n) => String(n).padStart(2, '0');
  let y; let mo; let d; let rest = all;
  let m = all.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; }
  else if ((m = all.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) { mo = Number(m[1]); d = Number(m[2]); y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null; }
  else if ((m = all.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i))) { mo = MONTHS[m[1].toLowerCase()]; d = Number(m[2]); y = m[3] ? Number(m[3]) : null; }
  if (!m || !(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  rest = all.replace(m[0], ' ');
  if (!y) {
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    y = Number(today.slice(0, 4));
    if (Date.parse(`${y}-${two(mo)}-${two(d)}T12:00:00Z`) < Date.parse(`${today}T12:00:00Z`) - 60 * 86400000) y += 1;
  }
  let h = null; let mi = 0;
  let t = rest.match(/\b(\d{1,2}):(\d{2})\s*([ap])?\.?m?\b/i);
  if (t) { h = Number(t[1]); mi = Number(t[2]); }
  else if ((t = rest.match(/\b(\d{1,2})\s*([ap])\.?m\b/i))) h = Number(t[1]);
  else if ((t = rest.match(/\b([01]\d|2[0-3])([0-5]\d)\s*(?:hrs?|h)?\b/i))) { h = Number(t[1]); mi = Number(t[2]); }
  if (h == null) return null;
  const ap = t[3] || t[2];
  if (ap && /[ap]/i.test(ap) && h <= 12) { if (/p/i.test(ap) && h < 12) h += 12; if (/a/i.test(ap) && h === 12) h = 0; }
  if (h > 23 || mi > 59) return null;
  return `${y}-${two(mo)}-${two(d)}T${two(h)}:${two(mi)}`;
}

// "FCFS" / "first come, first served" on a rate con stop: no appointment needed — but say so. With receiving hours
// ("FCFS 0700-1500") the truck has to get there before they close. → { day, hours, closeLocal } | null. Pure.
export function rcFcfs(stop = {}, now = Date.now()) {
  const all = [stop.date, stop.time, stop.appointment].filter(Boolean).join(' ');
  if (!/\bFCFS\b|first[\s-]*come/i.test(all)) return null;
  const day = (rcLocal({ date: stop.date || '', time: '12:00' }, now) || '').slice(0, 10) || null;
  const hrsText = [stop.time, stop.appointment].filter(Boolean).join(' ').replace(/\bFCFS\b|first[\s-]*come,?\s*first[\s-]*serve[d]?/gi, ' ');
  const w = hrsText.match(/(\d{1,2}(?::?\d{2})?\s*(?:[ap]\.?m\.?)?)\s*(?:-|–|to)\s*(\d{1,2}(?::?\d{2})?\s*(?:[ap]\.?m\.?)?)/i);
  const closeLocal = w && stop.date ? rcLocal({ date: stop.date, time: w[2] }, now) : null;
  return { day, hours: w ? `${w[1].trim()}–${w[2].trim()}` : null, closeLocal };
}

// A broker load's delivery appointments in TruckMate (per stop, from the bills): an exact clock time
// (deliverBy = deliverByEnd) or one TruckMate flags as an appointment — never a multi-day window or a bare
// midnight date. → [{ city, state, customer, local: 'YYYY-MM-DDTHH:MM' }]. Pure.
export function tmAppointments(item, now = Date.now()) {
  if (!brokerLoad(item)) return [];
  const yes = (v) => v === true || v === 'True' || v === 'true' || v === 'Y';
  const out = new Map();
  for (const b of (item.freightBills || item.orders || tripOf(item).freightBills || [])) {
    if (b.actualDelivery) continue;
    const by = String(b.deliverBy || '').slice(0, 16); const end = String(b.deliverByEnd || '').slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(by) || /T00:00$/.test(by)) continue;
    if (!(end === by || !end || yes(b.deliveryApptReq) || yes(b.deliveryApptMade))) continue;
    const p = String(b.endZoneDescription || '').split(',').map((x) => x.trim());
    const city = p[0]; const state = (p[1] || '').slice(0, 2).toUpperCase();
    if (!city || !/^[A-Z]{2}$/.test(state)) continue;
    const ms = localToUtcMs(by, STATE_TZ[state] || 'America/New_York');
    if (Number.isNaN(ms) || ms < now - 24 * 60 * MIN) continue;
    const k = stopKey(city, state);
    if (!out.has(k) || by < out.get(k).local) out.set(k, { city, state, customer: b.billToName || null, local: by });
  }
  return [...out.values()];
}

export function initCommitments(app, { requireAuth, db, getBoard = null, sendMail = null, emails = async () => [], phones = async () => [], sendSms = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const site = 'florida-beauty';
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const all = async () => (enabled ? (await db.get(KEY(site), {})) || {} : {});

  app.get('/truckmate/commitments/:trip', requireAuth, async (req, res) => res.json((await all())[String(req.params.trip)] || {}));
  // set (local "YYYY-MM-DDTHH:MM" in the stop's time zone) or clear (local: null) one stop's committed time
  app.put('/truckmate/commitments/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const trip = String(req.params.trip || '').replace(/[^\w-]/g, '').slice(0, 20);
    const b = req.body || {};
    const k = stopKey(b.city, b.state);
    if (!trip || !k) return res.status(400).json({ error: 'Which stop? (city and state)' });
    const local = b.local ? String(b.local).slice(0, 16) : null;
    const atMs = local ? commitMs(local, b.state) : null;
    if (local && !atMs) return res.status(400).json({ error: 'Pick a date and time.' });
    const ck = custKey(b.customer, b.city, b.state);
    const next = await db.update(KEY(site), (cur) => {
      const c = { ...(cur || {}) }; const t = { ...(c[trip] || {}) };
      if (atMs) t[k] = { local, state: String(b.state).toUpperCase().slice(0, 2), atMs, customer: String(b.customer || '').slice(0, 120) || null, place: String(b.place || `${b.city}, ${b.state}`).slice(0, 120), by: who(req), setAt: new Date(now()).toISOString() };
      else t[k] = { cleared: true, by: who(req), setAt: new Date(now()).toISOString() };   // stays cleared — a saved time isn't filled back in
      c[trip] = t;
      return c;
    }, {});
    // remember it for this customer + location's next loads (or forget it)
    if (ck && (b.forget || atMs)) {
      const st = atMs ? toStanding(local, b.loadDate) : null;
      await db.update(STAND(site), (cur) => {
        const m = { ...(cur || {}) };
        if (b.forget) { delete m[ck]; return m; }
        if (!st) return m;
        const prev = m[ck] || {};
        const rec = { offsetDays: st.offsetDays, time: st.time, by: who(req), at: new Date(now()).toISOString() };
        m[ck] = { customer: String(b.customer).slice(0, 120), place: `${b.city}, ${b.state}`, byLoadDay: { ...(prev.byLoadDay || {}), [st.day]: rec }, last: { ...rec, day: st.day } };
        return m;
      }, {});
    }
    return res.json(next[trip] || {});
  });

  // on the board: item._commit (the stop's appointment for watchtower, the card, Jarvis)
  async function overlay(s, trips) {
    if (!enabled) return;
    const c = await all();
    const mem = (await db.get(STAND(site), {})) || {};
    const fill = {};
    for (const it of trips) {
      const trip = tripNo(it); const m = it._manifest || {};
      if (!trip) continue;
      // 0. the rate con's delivery appointments (broker loads) — over the trip sheet / TruckMate / a saved time,
      //    never over a time dispatch set or cleared; follows a new rate con version
      const rc = it._ratecon && (it._ratecon.data || it._ratecon);
      for (const dl of (rc && Array.isArray(rc.deliveries) ? rc.deliveries : [])) {
        const st = String(dl.state || '').toUpperCase().slice(0, 2);
        const k = stopKey(dl.city, st);
        // FCFS: no appointment — shown as such (and "before they close" when the rate con gives receiving hours)
        const fc = rcFcfs(dl, now());
        if (fc && k && !(fill[trip] && fill[trip][k])) {
          const have = c[trip] && c[trip][k];
          const closeMs = fc.closeLocal ? commitMs(fc.closeLocal, st) : null;
          const sig = `fcfs|${fc.day || ''}|${fc.hours || ''}`;
          if (!(have && (!have.auto || (have.fromRC && have.sig === sig)))) {
            fill[trip] = { ...(fill[trip] || {}), [k]: { state: st, customer: dl.name || null, place: `${String(dl.city).toUpperCase()}, ${st}`, auto: true, setAt: new Date(now()).toISOString(), fcfs: true, day: fc.day, hours: fc.hours, sig, local: closeMs ? fc.closeLocal : null, atMs: closeMs, by: 'Rate con (FCFS)', fromRC: true, rule: fc.hours ? `first come, first served · receiving ${fc.hours} — arrive before they close` : 'first come, first served — no appointment needed' } };
          }
          continue;
        }
        const local = rcLocal(dl, now());
        const atMs = local ? commitMs(local, st) : null;
        if (!k || !atMs || atMs < now() - 24 * 60 * MIN || (fill[trip] && fill[trip][k])) continue;
        const have = c[trip] && c[trip][k];
        if (have && (!have.auto || (have.fromRC && have.local === local))) continue;
        fill[trip] = { ...(fill[trip] || {}), [k]: { state: st, customer: dl.name || null, place: `${String(dl.city).toUpperCase()}, ${st}`, auto: true, setAt: new Date(now()).toISOString(), local, atMs, by: 'Rate con (delivery appointment)', fromRC: true, rule: [dl.appointment, dl.refs ? `ref ${dl.refs}` : null].filter(Boolean).join(' · ') || 'the delivery appointment on the rate con' } };
      }
      for (const st of m.stops || []) {
        if (!/DELIVER/i.test(st.action || '')) continue;
        const k = stopKey(st.city, st.state);
        if (!k || (fill[trip] && fill[trip][k])) continue;
        const have = c[trip] && c[trip][k];
        const base = { state: String(st.state).toUpperCase().slice(0, 2), customer: st.customer || null, place: `${String(st.city).toUpperCase()}, ${String(st.state).toUpperCase()}`, auto: true, setAt: new Date(now()).toISOString() };
        // 1. an appointment written on the trip sheet (printed or handwritten) is this load's committed time —
        //    same late check, email and text. Kept up to date if the sheet is read again; never over a dispatcher's.
        const sheetLocal = isYmd(st.apptDate) && /^\d{2}:\d{2}$/.test(String(st.apptTime || '')) ? `${st.apptDate}T${st.apptTime}` : null;
        const sheetMs = sheetLocal ? commitMs(sheetLocal, st.state) : null;
        if (sheetMs && (!have || (have.fromSheet && have.local !== sheetLocal))) {
          const hand = st.apptSource === 'handwritten';
          fill[trip] = { ...(fill[trip] || {}), [k]: { ...base, local: sheetLocal, atMs: sheetMs, by: `Trip sheet (${hand ? 'handwritten' : 'printed'})`, fromSheet: true, rule: hand ? 'handwritten on the trip sheet — verify with the customer' : 'printed on the trip sheet' } };
          continue;
        }
        if (have) continue;
        // 2. a new outbound for a customer + location with a saved time → fill it in (once; dispatch can change or clear it)
        if (!isYmd(m.dateLoaded)) continue;
        const f = fromStanding(mem[custKey(st.customer, st.city, st.state)], m.dateLoaded);
        const atMs = f ? commitMs(f.local, st.state) : null;
        if (!atMs) continue;
        fill[trip] = { ...(fill[trip] || {}), [k]: { ...base, local: f.local, atMs, by: 'Jarvis (saved from a previous load)', rule: f.rule } };
      }
      // broker loads: TruckMate's delivery appointment is the committed time (kept up to date if TruckMate changes it;
      // never over a dispatcher's time or a trip-sheet appointment)
      for (const a of tmAppointments(it, now())) {
        const k = stopKey(a.city, a.state);
        if (!k || (fill[trip] && fill[trip][k])) continue;
        const have = c[trip] && c[trip][k];
        if (have && !(have.fromTM && have.local !== a.local)) continue;
        const atMs = commitMs(a.local, a.state);
        if (!atMs) continue;
        fill[trip] = { ...(fill[trip] || {}), [k]: { state: a.state, customer: a.customer, place: `${String(a.city).toUpperCase()}, ${a.state}`, auto: true, setAt: new Date(now()).toISOString(), local: a.local, atMs, by: 'TruckMate (delivery appointment)', fromTM: true, rule: 'the delivery appointment in TruckMate' } };
      }
    }
    if (Object.keys(fill).length) {
      const saved = await db.update(KEY(site), (cur) => {
        const x = { ...(cur || {}) };
        for (const [trip, stops] of Object.entries(fill)) {
          const t = { ...(x[trip] || {}) };
          // never over a dispatcher's time or a cleared stop; a trip-sheet time only replaces an older trip-sheet time
          for (const [k, v] of Object.entries(stops)) if (!t[k] || (v.fromSheet && t[k].fromSheet) || (v.fromTM && t[k].fromTM) || (v.fromRC && t[k].auto)) t[k] = v;
          x[trip] = t;
        }
        return x;
      }, {});
      Object.assign(c, saved);
    }
    for (const it of trips) { const x = c[tripNo(it)]; if (x) it._commit = x; }
  }

  // after each board refresh: the truck left? projected late for a commitment? → email + text, once per stop + time
  async function process(s, board) {
    if (!enabled) return { sent: 0 };
    const c = await all();
    const trips = Object.keys(c);
    if (!trips.length) return { sent: 0 };
    const items = (board && board.trips) || [];
    const etas = ((await db.get(`taWatch:${site}`, {})) || {}).etas || {};
    const left = (await db.get(LEFT(site), {})) || {};
    const sent = (await db.get(SENT(site), {})) || {};
    let changed = false; let n = 0;
    for (const trip of trips) {
      const it = items.find((x) => tripNo(x) === trip);
      if (!it) continue;
      if (!left[trip] && leftShipper(tripOf(it).status)) { left[trip] = now(); changed = true; }
      for (const st of lateStops({ commits: c[trip], etas: etas[trip], leftAt: left[trip], now: now() })) {
        const id = `${trip}|${st.key}|${st.local}`;
        if (sent[id]) continue;
        const m = lateMessage(it, st);
        try {
          const to = await emails();
          if (to.length && sendMail) await sendMail({ to, subject: m.subject, html: m.html, text: m.text });
          if (sendSms) for (const p of await phones()) await sendSms(p, m.sms).catch((e) => console.warn('[commit] text:', e.message)); // eslint-disable-line no-await-in-loop
          sent[id] = { at: new Date(now()).toISOString(), lateMin: st.lateMin }; n += 1; changed = true;
        } catch (e) { console.warn('[commit] alert:', e.message); }
      }
    }
    if (changed) {
      for (const k of Object.keys(left)) if (!c[k]) delete left[k];                 // forget trips with no commitments left
      for (const [k, v] of Object.entries(sent)) if (Date.parse(v.at) < now() - 30 * 24 * 60 * MIN) delete sent[k];
      await db.set(LEFT(site), left); await db.set(SENT(site), sent);
    }
    return { sent: n };
  }
  return { overlay, process, all };
}

// ---------------------------------------------------------------
// Usual arrival times (LTL / flower runs only — never broker loads). Jarvis learns when our trucks usually get to each
// customer from the geofence arrivals (the stop-times log): how many days after the outbound day, and at what local time
// ("Boston market: 2 days after outbound, about 4:00 AM"). Every Watchtower cycle each open stop's ETA is checked against
// that; when it runs 1 h 30 min (setting) past the usual time, an email goes out right away (alert list "Running late vs
// usual"), and again only if it gets an hour worse. Jarvis tells callers the usual time and whether the load is late.
// ---------------------------------------------------------------
import { outboundDate } from './voice.js';
import { isFlowerLoad } from './flowerreport.js';
import { loadLabel } from './breakdownreport.js';
import { tzOf, fmtLocal, fmtLocalShort } from './localtime.js';
import { localToUtcMs } from './watchtower.js';

const MIN = 60000; const DAY = 24 * 60 * MIN;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const town = (x) => String(x || '').split(',')[0].trim().toUpperCase().replace(/[^A-Z ]/g, '').replace(/^MT /, 'MOUNT ');
const stateOf = (x) => (String(x || '').split(',')[1] || '').trim().toUpperCase().slice(0, 2);
// "DIRECT FLOWERS OF BOSTON INC" → "DIRECT FLOWERS OF BOSTON" (key part). Pure.
export const custKey = (x) => String(x || '').toUpperCase().replace(/[*>]+/g, ' ').replace(/\b(INC|LLC|LTD|CORP|CO)\b\.?/g, ' ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const stopKey = (customer, place) => `${custKey(customer)}|${town(place)}|${stateOf(place)}`;
const ymdIn = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
const minOfDay = (ms, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return (Number(p.hour) % 24) * 60 + Number(p.minute); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const dowOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const clock = (m) => { const h = Math.floor(m / 60); const mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// one arrival from the stop-times log → what we learn from it (needs the trip's outbound day). Pure.
export function arrivalFact(row, outbound) {
  if (!row || !row.arrivedMs || !row.customer || !row.place || !/^\d{4}-\d{2}-\d{2}$/.test(String(outbound || ''))) return null;
  const tz = tzOf(row.place);
  const days = daysBetween(outbound, ymdIn(row.arrivedMs, tz));
  if (days < 0 || days > 8) return null;
  return { trip: String(row.trip), ms: row.arrivedMs, outbound, dow: dowOf(outbound), days, min: minOfDay(row.arrivedMs, tz) };
}

// the middle arrival time — minutes counted from noon so a 11:50 PM / 12:10 AM pair doesn't average to noon. Pure.
const medianMin = (mins) => {
  const s = mins.map((m) => (m + 720) % 1440).sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  return (mid + 720) % 1440;
};
// When this customer usually gets the truck, for a load with this outbound day: the outbound weekday's own arrivals when
// there are 3+, else all of them. Needs 3+ arrivals that agree on the day (60%+). → { days, min, n, text } | null. Pure.
export function usualFor(rec, outbound) {
  const all = (rec && rec.arrivals) || [];
  if (all.length < 3) return null;
  const dow = outbound ? dowOf(outbound) : null;
  const same = dow != null ? all.filter((a) => a.dow === dow) : [];
  const pool = same.length >= 3 ? same : all;
  const count = {}; pool.forEach((a) => { count[a.days] = (count[a.days] || 0) + 1; });
  const [days, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  if (n / pool.length < 0.6) return null;
  const hits = pool.filter((a) => String(a.days) === days);
  const min = medianMin(hits.map((a) => a.min));
  const d = Number(days);
  return { days: d, min, n: hits.length, of: pool.length, byWeekday: pool === same,
    text: `${d === 0 ? 'the outbound day' : d === 1 ? '1 day after the outbound day' : `${d} days after the outbound day`} at about ${clock(min)} local${pool === same && dow != null ? ` (${DOW[dow]} outbounds)` : ''}` };
}
// that usual time as a moment, for this load. Pure.
export function usualMs(u, outbound, place) {
  if (!u || !outbound) return null;
  const day = new Date(Date.parse(`${outbound}T12:00:00Z`) + u.days * DAY).toISOString().slice(0, 10);
  return localToUtcMs(`${day}T${String(Math.floor(u.min / 60)).padStart(2, '0')}:${String(u.min % 60).padStart(2, '0')}`, tzOf(place));
}

// fold new arrivals into the learned store (each trip|stop once; last 40 per customer stop). Pure.
export function learn(store = {}, rows = [], outboundOf = () => null) {
  const out = { ...store };
  for (const r of rows) {
    const k = stopKey(r.customer, r.place);
    const have = (out[k] && out[k].arrivals) || [];
    if (have.some((a) => a.trip === String(r.trip))) continue;
    const f = arrivalFact(r, outboundOf(String(r.trip)));
    if (!f) continue;
    out[k] = { customer: r.customer, place: r.place, arrivals: [...have, f].sort((a, b) => a.ms - b.ms).slice(-40) };
  }
  return out;
}

// LTL only: flower runs out of our hubs, never a broker load. Pure.
export const isLtl = (it) => !!it && isFlowerLoad(it) && loadLabel(it) !== 'BROKER';

// Each open stop on the LTL loads: its ETA vs the customers' usual time there. → [{ trip, label, customers, etaMs, usual,
// usualMs, lateMin }] (lateMin > 0 = later than usual). Pure.
export function lateCheck(items = [], etas = {}, learned = {}) {
  const out = [];
  for (const it of items) {
    if (!isLtl(it)) continue;
    const n = tripNo(it); const od = outboundDate(it);
    if (!n || !od) continue;
    const sheet = ((it._manifest && it._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || ''));
    for (const s of ((etas[n] && etas[n].stops) || [])) {
      if (!s.etaMs || !s.label) continue;
      const names = new Set([
        ...sheet.filter((x) => town(x.city) === town(s.label) || town(x.tmPlace) === town(s.label)).map((x) => x.customer),
        ...billsOf(it).filter((b) => town(b.endZoneDescription) === town(s.label) && !b.actualDelivery).map((b) => String(b.billToName || '').replace(/\s*\*$/, '')),
      ].filter(Boolean));
      // the strictest customer at that stop (the one we usually reach earliest)
      let best = null;
      for (const c of names) {
        const rec = learned[stopKey(c, s.label)] || Object.values(learned).find((r) => custKey(r.customer) === custKey(c) && town(r.place) === town(s.label));
        const u = usualFor(rec, od); const ms = usualMs(u, od, s.label);
        if (u && ms && (!best || ms < best.usualMs)) best = { customer: c, usual: u, usualMs: ms };
      }
      if (!best) continue;
      out.push({ trip: n, truck: String(tripOf(it).powerUnit || '').trim() || null, trailer: String(tripOf(it).trailer || '').trim() || null, outbound: od,
        label: s.label, customers: [...names], customer: best.customer, etaMs: s.etaMs, usual: best.usual, usualMs: best.usualMs, lateMin: Math.round((s.etaMs - best.usualMs) / MIN) });
    }
  }
  return out;
}

// alert now? first time it's past the limit, or an hour worse than the last alert. Pure.
export function shouldAlert(prev, lateMin, limit = 90) {
  if (lateMin < limit) return false;
  return !prev || lateMin - prev.lateMin >= 60;
}

const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function lateEmail(x, item, { worse = false } = {}) {
  const live = (item && item._samsara) || {};
  const where = live.location ? `${live.location}${live.gpsAt ? ` (as of ${fmtLocalShort(Date.parse(live.gpsAt), 'FL')})` : ''}` : null;
  const subject = `${worse ? 'Later still' : 'Running late'}: trip ${x.trip} — ${x.customer} (${x.label.replace(/,?\s*\d{5}.*$/, '')}) ETA ${hm(x.lateMin)} past usual`;
  const rows = [
    ['Trip', `${x.trip}${x.truck ? ` · truck ${x.truck}` : ''}${x.trailer ? ` · trailer ${x.trailer}` : ''}`],
    ['Outbound', `${DOW[dowOf(x.outbound)]}, ${x.outbound}`],
    ['Stop', `${x.customers.join(', ')} — ${x.label}`],
    ['ETA now', fmtLocal(x.etaMs, x.label)],
    ['Usually there', `${fmtLocal(x.usualMs, x.label)} — ${x.usual.text}, from ${x.usual.n} of the last ${x.usual.of} arrivals`],
    ['Late by', hm(x.lateMin)],
    ...(where ? [['Truck now', where]] : []),
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>Trip ${esc(x.trip)} is running ${worse ? 'even ' : ''}later than usual for ${esc(x.customer)}.</p>`
    + `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#555"><b>${esc(k)}</b></td><td style="padding:3px 0">${esc(v)}</td></tr>`).join('')}</table>`
    + '<p style="color:#666;font-size:12px">The usual time is learned from our trucks\' geofence arrivals at this customer. LTL runs only.</p><p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>';
  return { subject, html };
}

// For Jarvis: the usual time + how late, for one trip's open stops (from the last cycle). Pure.
export function usualView(list = []) {
  return list.map((x) => ({ stop: x.label, customer: x.customer, usually_there: `${fmtLocal(x.usualMs, x.label)} (${x.usual.text})`, eta: fmtLocal(x.etaMs, x.label),
    vs_usual: x.lateMin >= 15 ? `${hm(x.lateMin)} later than usual` : x.lateMin <= -15 ? `${hm(-x.lateMin)} earlier than usual` : 'about the usual time' }));
}

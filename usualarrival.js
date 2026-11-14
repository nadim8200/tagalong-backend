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
import { readFileSync } from 'node:fs';
import { tzOf, zoneName, fmtLocal, fmtLocalShort } from './localtime.js';
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

// Which hub a load left from / a person said: MIAMI or VENTURA | null. Pure.
export const hubKey = (x) => { const u = String(x || '').toUpperCase(); return /VENTUR|OXNARD|CALIF|,\s*CA\b/.test(u) ? 'VENTURA' : /MIAMI|MIA\b|FLORIDA|,\s*FL\b|TERMINAL/.test(u) ? 'MIAMI' : null; };
// The hub a load left from: the Truck Builder's hub, the trip sheet's load stop ("VENTURA TERMINAL"), else the origin (a California
// origin is a Ventura run, a Florida one a Miami run). Pure.
export const hubOf = (it) => {
  const load = (it && it._manifest && (it._manifest.stops || []).find((x) => /^LOAD/i.test(x.action || ''))) || {};
  for (const v of [it && it._tb && it._tb.hub, load.customer, load.city && `${load.city}, ${load.state || ''}`, tripOf(it).origZoneDesc]) { const h = hubKey(v); if (h) return h; }
  return null;
};
// Only Nadim and Ronen may set usual delivery times (by text, call or Ask Jarvis); Saray by replying to a running-late email.
export const SETTERS = ['3055040711', '3052063095'];
// Saray too: she checks the running-late emails and corrects the usual times by replying to them
export const maySet = ({ phone = null, name = '', email = '' } = {}) => (phone ? SETTERS.includes(String(phone).replace(/\D+/g, '').slice(-10))
  : /^(nadim|ronen|saray?)\b/i.test(String(name || '').trim()) || /^(ntellez|ronen|strujillo)@floridabeauty\.us$/i.test(String(email || '').trim()));

// "Thursday" / "thu" / "jueves" / 4 → 0–6 (Sunday = 0) | null. Pure.
export function parseWeekday(x) {
  if (x == null || x === '') return null;
  if (Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 6) return Number(x);
  const t = String(x).trim().toLowerCase();
  const names = [['sun', 'dom'], ['mon', 'lun'], ['tue', 'mar'], ['wed', 'mie', 'mié'], ['thu', 'jue'], ['fri', 'vie'], ['sat', 'sab', 'sáb']];
  const i = names.findIndex((alts) => alts.some((a) => t.startsWith(a)));
  return i < 0 ? null : i;
}

// "4am", "4:30 AM", "04:00", "16:30" → minutes after midnight | null. Pure.
export function parseClock(x) {
  const m = String(x || '').trim().toUpperCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(A\.?M\.?|P\.?M\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]); const mm = Number(m[2] || 0);
  if (mm > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) return null;
  if (m[3]) h = (h % 12) + (m[3].startsWith('P') ? 12 : 0);
  return h * 60 + mm;
}
// the most common "days after outbound" in what was learned (even one arrival) | null. Pure.
export function learnedDays(rec) {
  const c = {}; ((rec && rec.arrivals) || []).forEach((a) => { c[a.days] = (c[a.days] || 0) + 1; });
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? Number(top[0]) : null;
}

// one arrival from the stop-times log → what we learn from it (needs the trip's outbound day). Pure.
export function arrivalFact(row, outbound, hub = null) {
  if (!row || !row.arrivedMs || !row.customer || !row.place || !/^\d{4}-\d{2}-\d{2}$/.test(String(outbound || ''))) return null;
  const tz = tzOf(row.place);
  const days = daysBetween(outbound, ymdIn(row.arrivedMs, tz));
  if (days < 0 || days > 8) return null;
  return { trip: String(row.trip), ms: row.arrivedMs, outbound, dow: dowOf(outbound), days, min: minOfDay(row.arrivedMs, tz), hub: hub || 'unknown' };
}

// the middle arrival time — minutes counted from noon so a 11:50 PM / 12:10 AM pair doesn't average to noon. Pure.
const medianMin = (mins) => {
  const s = mins.map((m) => (m + 720) % 1440).sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  return (mid + 720) % 1440;
};
// When this customer usually gets the truck, for a load with this outbound day: the outbound weekday's own arrivals when
// there are 3+, else all of them. Needs 3+ arrivals that agree on the day (60%+). → { days, min, n, text } | null. Pure.
export function usualFor(rec, outbound, hub = null) {
  // set by Nadim / Ronen ("Pyramid Oxnard from Miami: 4 AM on the 3rd day") — per hub; wins over what was learned
  // a time saved for one outbound weekday ("Thursday outbounds → Monday 4 AM") wins over the hub's any-day time
  const byHub = (rec && rec.fixedByHub) || {};
  const byDow = (rec && rec.fixedByHubDow) || {};
  const day = outbound ? dowOf(outbound) : null;
  const fx = (hub && day != null && byDow[`${hub}:${day}`]) || (hub && byHub[hub]) || (!hub && Object.values(byHub).length === 1 ? Object.values(byHub)[0] : null) || (rec && rec.fixed) || null;
  if (fx && fx.days != null && fx.min != null) {
    const f = fx; const d = Number(f.days);
    return { days: d, min: f.min, n: 'set', of: 'set', set: true, by: f.by || null, hub: f.hub || null,
      text: `${d === 0 ? 'the outbound day' : d === 1 ? '1 day after the outbound day' : `${d} days after the outbound day`} at ${clock(f.min)} local${f.hub ? ` from ${f.hub === 'VENTURA' ? 'Ventura' : 'Miami'}` : ''}${f.dow != null ? ` (${DOW[f.dow]} outbounds)` : ''} (set by ${f.by || 'dispatch'})` };
  }
  // a load is compared only with arrivals from its own hub (a Ventura truck needs days longer than a Miami one to the same
  // customer); without a hub there's nothing fair to compare with
  const all = ((rec && rec.arrivals) || []).filter((a) => hub && a.hub === hub);
  if (all.length < 3) return null;
  const dow = outbound ? dowOf(outbound) : null;
  const same = dow != null ? all.filter((a) => a.dow === dow) : [];
  const pool = same.length >= 3 ? same : all;
  const count = {}; pool.forEach((a) => { count[a.days] = (count[a.days] || 0) + 1; });
  const [days, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  if (n < 3 || n / pool.length < 0.6) return null;   // 3+ arrivals that agree on the day
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
export function learn(store = {}, rows = [], outboundOf = () => null, hubFor = () => null) {
  const out = { ...store };
  for (const r of rows) {
    const k = stopKey(r.customer, r.place);
    const have = (out[k] && out[k].arrivals) || [];
    if (have.some((a) => a.trip === String(r.trip))) continue;
    const f = arrivalFact(r, outboundOf(String(r.trip)), hubFor(String(r.trip)));
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
        // routes change by outbound weekday (Wednesday's truck reaches Phoenix after Texas, Friday's after El Paso), so a
        // load is judged only against arrivals from its own outbound weekday, or a time staff set
        const u = usualFor(rec, od, hubOf(it)); const ms = u && (u.set || u.byWeekday) ? usualMs(u, od, s.label) : null;
        if (u && ms && (!best || ms < best.usualMs)) best = { customer: c, usual: u, usualMs: ms };
      }
      if (!best) continue;
      out.push({ trip: n, hub: hubOf(it), truck: String(tripOf(it).powerUnit || '').trim() || null, trailer: String(tripOf(it).trailer || '').trim() || null, outbound: od,
        label: s.label, customers: [...names], customer: best.customer, etaMs: s.etaMs, miles: s.miles != null && Number.isFinite(Number(s.miles)) ? Math.round(Number(s.miles)) : null, usual: best.usual, usualMs: best.usualMs, lateMin: Math.round((s.etaMs - best.usualMs) / MIN) });
    }
  }
  return out;
}

// alert now? first time it's past the limit, or an hour worse than the last alert. Pure.
export function shouldAlert(prev, lateMin, limit = 90) {
  if (lateMin < limit) return false;
  return !prev || lateMin - prev.lateMin >= 60;
}

// One email per load, not one per stop: the first stop running late is the news (the stops after it are late because of
// it). Again only when it's 3 h worse than the last email and 6 h have passed. sent = { 'trip:N': { lateMin, at, label } }
// (older 'N|stop' keys count too). → [{ row, worse }]. Pure.
export const WORSE_MIN = 180;
export const GAP_MS = 6 * 3600000;
export function dueByTrip(rows = [], sent = {}, limit = 90, now = Date.now()) {
  const first = new Map();
  for (const x of rows) if (x.lateMin >= limit && !first.has(x.trip)) first.set(x.trip, x);
  const out = [];
  for (const [trip, x] of first) {
    const old = Object.entries(sent).filter(([k]) => k.startsWith(`${trip}|`)).map(([, v]) => v);
    const prev = sent[`trip:${trip}`] || old.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0] || null;
    if (!prev) { out.push({ row: x, worse: false }); continue; }
    if (x.lateMin - prev.lateMin >= WORSE_MIN && now - Date.parse(prev.at || 0) >= GAP_MS) out.push({ row: x, worse: true });
  }
  return out;
}

const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the company's flower mark (the same one the trailer-change email carries), inside the email as a cid picture
const ASSET = (f) => { try { return readFileSync(new URL(`./assets/email/${f}`, import.meta.url)); } catch { return null; } };
const MARK = ASSET('flower-mark.png');
const ICONS = { route: ASSET('icon-route.png'), driver: ASSET('icon-driver.png'), truck: ASSET('icon-truck.png') };   // navy line icons
const ABBR = { Eastern: 'ET', Central: 'CT', Mountain: 'MT', Arizona: 'MST', Pacific: 'PT', Alaska: 'AKT', Hawaii: 'HT' };
const zoneAbbr = (tz) => ABBR[zoneName(tz)] || zoneName(tz);
// "Fri, Nov 13" and "6:47 PM CT" in a time zone. Pure.
const dayIn = (ms, tz) => new Date(ms).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
const yearIn = (ms, tz) => new Date(ms).toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' });
const timeIn = (ms, tz) => `${new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${zoneAbbr(tz)}`;
const shortIn = (ms, tz) => `${new Date(ms).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })} · ${timeIn(ms, tz)}`;
const tel = (p) => String(p || '').replace(/[^\d+]/g, '');
const phoneSaid = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || '').trim(); };
// The delay as the two times on the email show it (both to the minute), so "15 h 12 min" always matches 3:35 AM → 6:47 PM. Pure.
export const lateShown = (etaMs, usualMs) => Math.floor(etaMs / MIN) - Math.floor(usualMs / MIN);
// "HUNTSVILLE, AL, 35816" → "Huntsville, AL 35816". Pure.
const placeSaid = (label) => { const p = String(label || '').split(',').map((x) => x.trim()).filter(Boolean); const city = (p[0] || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); return [city, [p[1], p[2]].filter(Boolean).join(' ')].filter(Boolean).join(', '); };

// Samsara's "18435 US 84 / GA 38, Thomas County, GA, 31757" → street "18435 US 84 / GA 38", town "Thomas County, GA 31757". Pure.
export function whereSaid(location) {
  const p = String(location || '').split(',').map((v) => v.trim()).filter(Boolean);
  const zip = p.length && /^\d{5}(-\d{4})?$/.test(p[p.length - 1]) ? p.pop() : null;
  const state = p.length && /^[A-Z]{2}$/i.test(p[p.length - 1]) ? p.pop().toUpperCase() : null;
  const city = p.length > 1 ? p.pop() : null;
  return { street: p.join(', ') || city || null, town: [p.length ? city : null, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null };
}

// The drivers on the load (Samsara, else the trip's driver codes): name + phone; the team driver only when there is one. Pure.
export function driversOf(item) {
  const s = (item && item._samsara) || {}; const t = tripOf(item);
  const one = (name, info, code) => ({ name: (info && info.name) || name || (code ? `Driver ${code}` : null), phone: (info && info.phone) || null });
  const d1 = one(s.driver1, s.driver1Info, t.driver);
  const d2 = (s.driver2 || s.driver2Info || t.driver2) ? one(s.driver2, s.driver2Info, t.driver2) : null;
  return { driver: d1, team: d2 };
}

// "Arrival delay update" (the approved design): the customer, outbound day + updated ETA, how far past the usual arrival, the
// load, miles to this stop, the drivers, the usual time, where the truck is, and what the usual time comes from. Tables and inline
// styles only (Outlook, Gmail, Apple Mail), 600 px wide, the two date cards stack on a phone. Pure. → { subject, html, text, attachments }
export function lateEmail(x, item, { worse = false } = {}) {
  const tz = tzOf(x.label);
  const live = (item && item._samsara) || {};
  const late = lateShown(x.etaMs, x.usualMs);
  const others = (x.customers || []).filter((c) => c && c !== x.customer);
  const place = placeSaid(x.label);
  const titleCase = (v) => String(v).toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (m0, a, b) => a + b.toUpperCase()).replace(/\b(Llc|Inc|Dc)\b/g, (w) => w.toUpperCase());
  const sub = [others.map(titleCase).join(', '), place].filter(Boolean).join(' · ');
  const { driver, team } = driversOf(item);
  const { street, town } = whereSaid(live.location);
  const gpsMs = live.gpsAt ? Date.parse(live.gpsAt) : null;
  const basis = x.usual.set ? `Usual time set by ${x.usual.by || 'dispatch'}${x.usual.hub ? ` for ${x.usual.hub === 'VENTURA' ? 'Ventura' : 'Miami'} outbounds` : ''}. LTL runs only.`
    : `Based on the last ${x.usual.n} geofence arrival${x.usual.n === 1 ? '' : 's'} at this customer. LTL runs only.`;
  const hubName = x.hub === 'VENTURA' ? 'Ventura' : x.hub === 'MIAMI' ? 'Miami' : null;
  const outDay = new Date(`${x.outbound}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
  // a reply teaches Jarvis (Saray checks these): "correct", or when this weekday's loads from this hub really get there
  const ask = `Is this right? Reply to this email: "correct", or when ${outDay} outbounds${hubName ? ` from ${hubName}` : ''} usually get to ${x.customer} (for example "Friday 4 AM"). Jarvis saves it as the rule.`;
  const subject = `${worse ? 'Later still' : 'Running late'}: trip ${x.trip} — ${x.customer} (${String(x.label).replace(/,?\s*\d{5}.*$/, '')}) ETA ${hm(late)} past usual`;
  const attachments = [...(MARK ? [{ name: 'flower-mark.png', contentType: 'image/png', bytes: MARK, cid: 'ud-mark' }] : []),
    ...Object.entries(ICONS).filter(([, b]) => b).map(([k, b]) => ({ name: `icon-${k}.png`, contentType: 'image/png', bytes: b, cid: `ud-${k}` }))];

  const NAVY = '#13325B'; const TEXT = '#14213D'; const MUTED = '#5B6778'; const LINE = '#D9E0EA'; const BLUE = '#EEF4FB'; const AMBER = '#FDECC8'; const AMBER_DEEP = '#F8C55A'; const AMBER_INK = '#B45309'; const F = 'Arial,Helvetica,sans-serif';
  const nameSize = x.customer.length > 32 ? 24 : x.customer.length > 22 ? 30 : 38;
  const cap = (t) => `<div style="font-family:${F};font-size:11px;font-weight:bold;letter-spacing:1px;color:${TEXT};text-transform:uppercase;">${esc(t)}</div>`;
  const dateCard = (label, big, small, bg) => `<td class="ud-card" width="50%" valign="top" style="padding:0 5px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:10px;"><tr><td align="center" style="padding:12px 8px;">${cap(label)}<div class="ud-date" style="font-family:${F};font-size:24px;font-weight:bold;color:${TEXT};line-height:30px;margin-top:4px;">${esc(big)}</div><div style="font-family:${F};font-size:16px;font-weight:bold;color:${TEXT};">${esc(small)}</div></td></tr></table></td>`;
  const idCell = (label, v) => `<td width="33%" style="padding:0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:8px;"><tr><td align="center" style="padding:8px 4px;">${cap(label)}<div style="font-family:${F};font-size:20px;font-weight:bold;color:${TEXT};word-break:break-all;">${esc(v || 'Not provided')}</div></td></tr></table></td>`;
  const ico = (k) => `<td width="52" valign="middle" align="center" style="padding:0 6px;">${ICONS[k] ? `<img src="cid:ud-${k}" width="30" height="30" alt="" style="display:block;border:0;width:30px;height:30px;">` : ''}</td>`;
  const person = (label, d) => `<tr><td style="font-family:${F};font-size:13px;font-weight:bold;color:${TEXT};padding:2px 10px 2px 0;white-space:nowrap;">${esc(label)}</td><td style="font-family:${F};font-size:13px;color:${TEXT};padding:2px 0;">${esc(d && d.name ? d.name : 'Not available')}${d && d.phone ? ` · <a href="tel:${esc(tel(d.phone))}" style="color:#1D4ED8;text-decoration:underline;">${esc(phoneSaid(d.phone))}</a>` : (d && d.name ? ' · phone not available' : '')}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<style>@media only screen and (max-width:480px){.ud-wrap{width:100%!important}.ud-name{font-size:26px!important;line-height:30px!important}.ud-brand{font-size:15px!important;letter-spacing:.5px!important}.ud-date{font-size:20px!important;line-height:26px!important}}@media only screen and (max-width:340px){.ud-card{display:block!important;width:100%!important;padding:0 0 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#E8EEF6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EEF6;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" class="ud-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:14px 20px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
${MARK ? `<td valign="middle" style="padding-right:14px;border-right:1px solid #5F7799;"><img src="cid:ud-mark" width="40" height="40" alt="Florida Beauty Flora" style="display:block;border:0;width:40px;height:40px;"></td>` : ''}
<td valign="middle" style="padding-left:${MARK ? 14 : 0}px;"><div class="ud-brand" style="font-family:${F};font-size:19px;font-weight:bold;letter-spacing:1px;color:#FFFFFF;white-space:nowrap;">FLORIDA BEAUTY FLORA</div><div style="font-family:${F};font-size:12px;letter-spacing:2px;color:#C9D6EA;">JARVIS · DISPATCH ALERT</div></td></tr></table></td></tr>
<tr><td style="padding:18px 20px 6px;" align="center">
<div style="font-family:${F};font-size:15px;font-weight:bold;letter-spacing:1px;color:${AMBER_INK};">&#9888; ${worse ? 'ARRIVAL DELAY UPDATE — LATER STILL' : 'ARRIVAL DELAY UPDATE'}</div>
<div class="ud-name" style="font-family:${F};font-size:${nameSize}px;line-height:${nameSize + 6}px;font-weight:900;color:${TEXT};margin-top:6px;word-break:break-word;">${esc(String(x.customer).toUpperCase())}</div>
${sub ? `<div style="font-family:${F};font-size:15px;color:${TEXT};margin-top:4px;">${esc(sub)}</div>` : ''}
</td></tr>
<tr><td style="padding:10px 15px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${dateCard('Outbound date', dayIn(Date.parse(`${x.outbound}T12:00:00Z`), 'UTC'), `${yearIn(Date.parse(`${x.outbound}T12:00:00Z`), 'UTC')}${hubName ? ` · ${hubName}` : ''}`, BLUE)}
${dateCard('Updated ETA', dayIn(x.etaMs, tz), timeIn(x.etaMs, tz), AMBER)}
</tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${AMBER_DEEP};border-radius:8px;"><tr><td align="center" style="padding:10px 12px;">
<div style="font-family:${F};font-size:22px;font-weight:bold;color:${TEXT};">${esc(hm(late))} past usual arrival</div>
<div style="font-family:${F};font-size:13px;color:${TEXT};">Historical comparison, not a confirmed appointment.</div></td></tr></table></td></tr>
<tr><td style="padding:6px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${idCell('Trip', x.trip)}${idCell('Truck', x.truck)}${idCell('Trailer', x.trailer)}</tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};"><tr>${ico('route')}<td style="padding:10px 0;">${cap('Miles to customer')}<div style="font-family:${F};font-size:22px;font-weight:bold;color:${TEXT};">${x.miles != null ? `${x.miles.toLocaleString('en-US')} miles` : 'Unavailable'}</div></td></tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:8px;"><tr>${ico('driver')}<td style="padding:10px 10px 10px 0;border-left:1px solid ${LINE};padding-left:12px;">${cap('Driver information')}<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:4px;">${person('Driver', driver)}${team ? person('Team driver', team) : ''}</table></td></tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:8px;"><tr><td align="center" style="padding:8px;font-family:${F};font-size:15px;color:${TEXT};"><b>Usual arrival:</b> ${esc(shortIn(x.usualMs, tz))}</td></tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};"><tr>${ico('truck')}<td style="padding:10px 0;">${cap('Truck location')}
<div style="font-family:${F};font-size:18px;font-weight:bold;color:${TEXT};">${esc(street || 'Unavailable')}</div>${town ? `<div style="font-family:${F};font-size:13px;color:${TEXT};">${esc(town)}</div>` : ''}${gpsMs ? `<div style="font-family:${F};font-size:13px;color:${MUTED};">Updated ${esc(shortIn(gpsMs, 'America/New_York'))}</div>` : ''}</td></tr></table></td></tr>
<tr><td style="padding:6px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed #B45309;border-radius:8px;"><tr><td style="padding:9px 12px;font-family:${F};font-size:13px;color:${TEXT};">${esc(ask)}</td></tr></table></td></tr>
<tr><td style="padding:6px 20px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BLUE};border-radius:8px;"><tr><td width="44" align="center" style="font-family:${F};font-size:18px;color:${NAVY};">&#9432;</td><td style="padding:9px 10px 9px 0;font-family:${F};font-size:12px;color:${TEXT};">${esc(basis)}</td></tr></table></td></tr>
<tr><td align="center" style="background:${NAVY};padding:12px 20px;"><div style="font-family:${F};font-size:15px;font-weight:bold;color:#FFFFFF;">Jarvis · AI Dispatcher</div><div style="font-family:${F};font-size:13px;color:#C9D6EA;">Florida Beauty Flora</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    'FLORIDA BEAUTY FLORA — JARVIS · DISPATCH ALERT', '', worse ? 'ARRIVAL DELAY UPDATE — LATER STILL' : 'ARRIVAL DELAY UPDATE',
    String(x.customer).toUpperCase(), sub || null, '',
    `Outbound date: ${dayIn(Date.parse(`${x.outbound}T12:00:00Z`), 'UTC')}, ${yearIn(Date.parse(`${x.outbound}T12:00:00Z`), 'UTC')}${hubName ? ` · from ${hubName}` : ''}`,
    `Updated ETA: ${dayIn(x.etaMs, tz)} · ${timeIn(x.etaMs, tz)}`,
    `${hm(late)} past usual arrival — historical comparison, not a confirmed appointment.`, '',
    `Trip ${x.trip || 'Not provided'} · Truck ${x.truck || 'Not provided'} · Trailer ${x.trailer || 'Not provided'}`,
    `Miles to customer: ${x.miles != null ? `${x.miles.toLocaleString('en-US')} miles` : 'Unavailable'}`,
    `Driver: ${driver && driver.name ? driver.name : 'Not available'}${driver && driver.phone ? ` · ${phoneSaid(driver.phone)}` : ''}`,
    team ? `Team driver: ${team.name || 'Not available'}${team.phone ? ` · ${phoneSaid(team.phone)}` : ''}` : null,
    `Usual arrival: ${shortIn(x.usualMs, tz)}`,
    `Truck location: ${[street, town].filter(Boolean).join(', ') || 'Unavailable'}${gpsMs ? ` (updated ${shortIn(gpsMs, 'America/New_York')})` : ''}`, '',
    basis, '', ask, '', 'Jarvis · AI Dispatcher', 'Florida Beauty Flora',
  ].filter((l) => l !== null).join('\n');
  return { subject, html, text, attachments };
}

// For Jarvis: the usual time + how late, for one trip's open stops (from the last cycle). Pure.
export function usualView(list = []) {
  return list.map((x) => ({ stop: x.label, customer: x.customer, usually_there: `${fmtLocal(x.usualMs, x.label)} (${x.usual.text})`, eta: fmtLocal(x.etaMs, x.label),
    vs_usual: x.lateMin >= 15 ? `${hm(x.lateMin)} later than usual` : x.lateMin <= -15 ? `${hm(-x.lateMin)} earlier than usual` : 'about the usual time' }));
}

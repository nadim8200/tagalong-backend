// ---------------------------------------------------------------
// LTL reefer temperature alert (flower runs only — never broker loads). When a load's reefer reading is more than 5°F
// above or below its set point OR the temperature the load needs, and when ARTIS's set point isn't the temperature the
// load needs, an email goes to the "LTL reefer 5°F off" list (inbound@) and a text to Nadim. A reading: once it has
// been off for 2 hours straight (by the readings' own times), again only if 3°F worse; a set point: once per value. Readings while the truck is at a receiver
// (doors open, unloading) don't count. The reading is the card's: Samsara return air,
// else TruckMate's Thermo King, else ARTIS's Trip Status.
// Only while the flowers are on the trailer (Nov 17): not before loading, not after the last delivery (every bill
// delivered in TruckMate, or the truck has visited and left every delivery stop by GPS), and not once the trailer is on
// a newer trip — that's what was texting about the next load's set point. While loading (at the terminal/shipper, doors
// open) a warm reading doesn't count for up to 3 hours. Flowers at 33°F or colder freeze: a FREEZE RISK text after two
// readings in a row, wherever the truck is. 10°F or more warm: 30 minutes. More than 5°F off: 2 hours (as before).
// When an alerted reading comes back in range, one BACK IN RANGE text.
// ---------------------------------------------------------------
import { isLtl } from './usualarrival.js';
import { fmtLocalShort } from './localtime.js';

const KEY = (site) => `taLtlTempAlert:${site}`;
const CFG = 'taLtlTempAlertCfg';
const TRACK = (site) => `taLtlTempTrack:${site}`;   // trip → reading history (track)
const SENT = (site) => `taLtlTempSent:${site}`;     // texts already sent: trailer|trip|since|reading|kind
const MIN = 60000;
const PHASE = (site) => `taLtlTempPhase:${site}`;   // trip → { phase, since } (how long it has been loading)
export const FREEZE_F = 33;          // flowers at or below this freeze
export const SEVERE_F = 10;          // this far warm → 30 minutes, not 2 hours
export const SEVERE_HOLD_MIN = 30;
export const LOADING_MAX_MIN = 180;  // doors-open allowance while loading
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const r1 = (v) => Math.round(Number(v) * 10) / 10;
// "35°F per the trip sheet" — where the required temperature came from, said plainly. Pure.
const need = (t) => `${t.text}${t.from ? ` per the ${String(t.from).replace(/\s*\(.*\)\s*$/, '').trim()}` : ''}`;

// How far off the reading is — checked against BOTH the set point and the range the load needs; the worse one counts.
// → { offF, vs, refText } | null. Pure.
export function offBy(lt) {
  const c = lt && lt.current; if (!c || c.readingF == null || !Number.isFinite(Number(c.readingF))) return null;
  const v = Number(c.readingF);
  const checks = [];
  if (c.setF != null && Number.isFinite(Number(c.setF))) checks.push({ offF: r1(v - Number(c.setF)), vs: 'set point', refText: `set point ${r1(c.setF)}°F` });
  const t = lt.target;
  if (t && t.minF != null && t.maxF != null) checks.push({ offF: r1(v < t.minF ? v - t.minF : v > t.maxF ? v - t.maxF : 0), vs: 'required', refText: `required ${need(t)}` });
  return checks.sort((a, b) => Math.abs(b.offF) - Math.abs(a.offF))[0] || null;
}
// ARTIS's set point vs the temperature the load needs: different (more than 1°F outside the range) → { setF, target } | null. Pure.
export function setPointMismatch(it) {
  const lt = it && it._loadTemp; const t = lt && lt.target;
  const a = it && it._artisTemp;
  const setF = a && a.setPointF != null ? Number(a.setPointF) : lt && lt.current && lt.current.setF != null ? Number(lt.current.setF) : null;
  if (setF == null || !Number.isFinite(setF) || !t || t.minF == null || t.maxF == null) return null;
  const off = setF < t.minF ? setF - t.minF : setF > t.maxF ? setF - t.maxF : 0;
  return Math.abs(off) > 1 ? { setF: r1(setF), offF: r1(off), setFrom: a && a.setPointF != null ? 'ARTIS' : (lt.current.source || null), refText: `required ${need(t)}` } : null;
}

// Is the flower load on the trailer right now? → { phase: 'next-load' | 'delivered' | 'empty' | 'loading' | 'on', by }.
// next-load: the same trailer is on a newer trip that has started (at the shipper or later). delivered: every bill has a
// TruckMate delivery time, or every delivery stop on the trip sheet has a completed GPS visit (stops without a geofence
// never count as visited, so it stays on), or — Jarvis's own stop records (milestones: parked at the stop, then left) show
// every delivery stop left AND the reefer is now set far from flower temperature (33°F or colder, or 50°F+): the driver
// set it for the next load (627178, Nov 17: delivered in Boston, set −10°F, TruckMate not updated). Pure.
const STARTED = /^(LOADINGMAN|LOADEDTOGO|DISP|ARRSHIP|DEPSHIP|INTRAN|ENROUTE|WAY|ARRCONS|DEPCONS)/i;
const LOADING = /^(LOADINGMAN|LOADEDTOGO|DISP|ARRSHIP)/i;
const stOf = (it) => String(tripOf(it).status || '').trim();
const tlOf = (it) => String(tripOf(it).trailer || '').trim().toUpperCase();
export function loadPhase(it, { trips = [], visits = {}, milestones = {} } = {}) {
  const n = tripNo(it); const tl = tlOf(it);
  if (tl) {
    const newer = trips.find((o) => o !== it && tlOf(o) === tl && Number(tripNo(o)) > Number(n) && STARTED.test(stOf(o)));
    if (newer) return { phase: 'next-load', by: tripNo(newer) };
  }
  const bills = (it && (it.freightBills || it.orders)) || [];
  if (bills.length && bills.every((b) => b && b.actualDelivery)) return { phase: 'delivered', by: 'TruckMate' };
  const stops = ((it && it._manifest && it._manifest.stops) || []).filter((x) => x && x.key && !/^LOAD$/i.test(x.action || ''));
  const v = visits[n] || {};
  if (stops.length && stops.every((x) => v[x.key] && v[x.key].state === 'completed')) return { phase: 'delivered', by: 'GPS' };
  const places = [...new Set(bills.map((b) => b && (b.endZoneDescription || b.endZone)).filter(Boolean))];
  const ms = milestones[n];
  const left = (pl) => !!(ms && ((ms.ms && (ms.ms[`left:${pl}`] || ms.ms[`delivered:${pl}`])) || (ms.waits && ms.waits[pl] && ms.waits[pl].leftAt)));
  const sp = it && it._loadTemp && it._loadTemp.current && it._loadTemp.current.setF;
  const notFlowerSet = sp != null && Number.isFinite(Number(sp)) && (Number(sp) <= FREEZE_F || Number(sp) >= 50);
  if (places.length && places.every(left) && notFlowerSet) return { phase: 'delivered', by: 'stops left + set for the next load' };
  const st = stOf(it);
  if (!st || !STARTED.test(st)) return { phase: 'empty' };
  return { phase: LOADING.test(st) ? 'loading' : 'on' };
}
// flowers: the load needs 34°F or warmer (35°F, 33–36°F); no required temperature → a set point of 34°F or warmer. Pure.
export function isFlowerTemp(lt) {
  const t = lt && lt.target;
  if (t && t.maxF != null && Number.isFinite(Number(t.maxF))) return Number(t.maxF) >= 34 && (t.minF == null || Number(t.minF) >= 32);
  const sp = lt && lt.current && lt.current.setF;
  return sp != null && Number.isFinite(Number(sp)) && Number(sp) >= 34;
}
const frozenReading = (lt) => isFlowerTemp(lt) && lt.current && lt.current.readingF != null && Number.isFinite(Number(lt.current.readingF)) && r1(lt.current.readingF) <= FREEZE_F;
export const ONBOARD = new Set(['loading', 'on']);

const base = (it) => ({ trip: tripNo(it), truck: String(tripOf(it).powerUnit || '').trim() || null, trailer: String(tripOf(it).trailer || '').trim() || null, where: (it._samsara && it._samsara.location) || null });
// The LTL loads with a temperature problem right now: the reading more than `limit` °F off (kind 'reading'), or the set
// point not what the load needs (kind 'setpoint'). Pure.
// `phases` (trip → phase from loadPhase; missing = 'on'): only while the load is on the trailer; while loading a warm
// reading doesn't count (a freeze does). A flower load at 33°F or colder is kind 'freeze' — even at a receiver.
export function tempOff(items = [], { limit = 5, now = Date.now(), maxAgeMin = 240, phases = {} } = {}) {
  const out = [];
  for (const it of items) {
    if (!isLtl(it)) continue;
    const phase = phases[tripNo(it)] || 'on';
    if (!ONBOARD.has(phase)) continue;                                             // no flowers on this trailer now
    const lt = it._loadTemp;
    const sp = setPointMismatch(it);
    if (sp) out.push({ ...base(it), kind: 'setpoint', ...sp, ...(isFlowerTemp(lt) && sp.setF <= FREEZE_F ? { freeze: true } : {}) });
    const o = offBy(lt);
    const at = Date.parse((lt && lt.current && lt.current.at) || '');
    if (!o || (at && now - at > maxAgeMin * MIN)) continue;                        // an old reading isn't news
    const row = { ...base(it), readingF: r1(lt.current.readingF), setF: lt.current.setF != null ? r1(lt.current.setF) : null, source: lt.current.source || null, at: at || null, ...o };
    if (frozenReading(lt)) { out.push({ ...row, kind: 'freeze' }); continue; }
    if (/^ARRCONS/i.test(stOf(it))) continue;                                      // at a receiver: doors open while unloading
    if (phase === 'loading' && o.offF > 0) continue;                               // loading: doors open
    if (Math.abs(o.offF) <= limit) continue;
    out.push({ ...row, kind: 'reading' });
  }
  return out;
}

// alert now? a reading: the first time it's off, or 3°F worse than the last alert. A set point: once per set point value. Pure.
export const alertKey = (x) => (x.kind === 'setpoint' ? `${x.trip}|set` : x.trip);
// a freeze after a warm alert (or the other way) is news right away
export const shouldAlert = (prev, x) => !prev || (x.kind === 'setpoint' ? prev.setF !== x.setF : (prev.kind || 'reading') !== (x.kind || 'reading') || Math.abs(x.offF) - Math.abs(prev.offF) >= 3);

export function tempMessage(x, { worse = false } = {}) {
  if (x.kind === 'setpoint') {
    const dir = x.offF > 0 ? 'warmer' : 'colder';
    const subject = `${x.freeze ? 'FREEZE RISK — ' : ''}LTL set point doesn't match: trip ${x.trip}${x.trailer ? ` · trailer ${x.trailer}` : ''} — set ${x.setF}°F, ${x.refText}`;
    const rows = [['Trip', `${x.trip}${x.truck ? ` · truck ${x.truck}` : ''}${x.trailer ? ` · trailer ${x.trailer}` : ''}`], ['Set point', `${x.setF}°F${x.setFrom ? ` (${x.setFrom})` : ''}`], ['Load needs', x.refText], ['Difference', `set ${Math.abs(x.offF)}°F ${dir} than the range`], ...(x.where ? [['Truck now', x.where]] : [])];
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>The reefer set point on LTL trip ${esc(x.trip)} is not the temperature the load needs.</p>`
      + `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#555"><b>${esc(k)}</b></td><td style="padding:3px 0">${esc(v)}</td></tr>`).join('')}</table>`
      + '<p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>';
    return { subject, html, sms: `${x.freeze ? 'FREEZE RISK — flowers. ' : ''}LTL set point alert: trip ${x.trip}${x.trailer ? ` trailer ${x.trailer}` : ''} is set to ${x.setF}F but the load needs ${x.refText.replace(/^required /, '')}.` };
  }
  const dir = x.offF > 0 ? 'above' : 'below';
  const amt = `${Math.abs(x.offF)}°F ${dir} ${x.vs === 'set point' ? 'the set point' : 'the required temperature'}`;
  const when = x.at ? fmtLocalShort(x.at, 'FL') : null;
  const subject = `${x.kind === 'freeze' ? 'FREEZE RISK — flowers at ' + x.readingF + '°F · ' : ''}${worse ? 'Still off — ' : ''}LTL reefer ${amt}: trip ${x.trip}${x.trailer ? ` · trailer ${x.trailer}` : ''} — ${x.readingF}°F`;
  const rows = [
    ['Trip', `${x.trip}${x.truck ? ` · truck ${x.truck}` : ''}${x.trailer ? ` · trailer ${x.trailer}` : ''}`],
    ['Reading', `${x.readingF}°F${x.source ? ` (${x.source})` : ''}${when ? ` at ${when}` : ''}`],
    ['Against', x.refText],
    ['Off by', amt],
    ...(x.where ? [['Truck now', x.where]] : []),
  ];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>The reefer on LTL trip ${esc(x.trip)} is reading ${esc(amt)}.</p>`
    + `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#555"><b>${esc(k)}</b></td><td style="padding:3px 0">${esc(v)}</td></tr>`).join('')}</table>`
    + '<p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>';
  const sms = `LTL temp alert: trip ${x.trip}${x.trailer ? ` trailer ${x.trailer}` : ''} reads ${x.readingF}F — ${amt}${when ? ` (${when})` : ''}.`;
  return { subject, html, sms };
}

// ---- how long the reefer has been above (or below) its set point, from the readings and their own timestamps ----
// Per trip: { setF, lastAt, lastF, above: { dir, since, n, atLeast } | null, bad: { since } | null, setChangedAt }.
// A reading back at the set point ends the stretch; a swing that stays on the same side doesn't. Readings more than GAP_MIN
// apart aren't assumed continuous: the stretch starts over at the reading after the gap, marked "at least". A new set point
// starts it over too (timed from the first reading under it). `bad` is the same idea for "beyond the alert limit" — the 2-hour
// wait before the first alert. Pure.
export const GAP_MIN = 45;
export const HOLD_MIN = 120;
export function track(prev, r, { gapMin = GAP_MIN, bad = false, cold = false } = {}) {
  if (!r || r.f == null || r.f === '' || !Number.isFinite(Number(r.f)) || !Number.isFinite(Number(r.at))) return prev || null;
  if (prev && prev.lastAt && r.at <= prev.lastAt) return prev;                        // the same reading again (or an older one)
  const f = r1(r.f); const setF = r.setF != null && Number.isFinite(Number(r.setF)) ? r1(r.setF) : null;   // compared as shown (34.99 → 35.0)
  const joined = !!(prev && prev.lastAt && r.at - prev.lastAt <= gapMin * MIN);   // no telemetry gap since the last reading
  const setChanged = !!(prev && prev.setF != null && setF != null && prev.setF !== setF);
  const same = joined && !setChanged;
  let above = null;
  const dir = setF == null ? 0 : f > setF ? 1 : f < setF ? -1 : 0;
  if (dir) {
    if (same && prev.above && prev.above.dir === dir) above = { ...prev.above, n: prev.above.n + 1 };
    else {
      // the start is known only when the reading before it (same set point, no gap) was confirmed back at/inside the set point
      const confirmedBefore = same && prev.lastF != null && prev.setF != null && (dir > 0 ? prev.lastF <= prev.setF : prev.lastF >= prev.setF);
      above = { dir, since: r.at, n: 1, atLeast: !confirmedBefore };
    }
  }
  const badNow = bad ? (same && prev.bad ? { ...prev.bad, n: (prev.bad.n || 1) + 1 } : { since: r.at, n: 1 }) : null;
  const coldNow = cold ? (joined && prev.cold ? { since: prev.cold.since, n: prev.cold.n + 1 } : { since: r.at, n: 1 }) : null;   // readings in a row at/below freezing
  return { setF: setF ?? null, lastAt: r.at, lastF: f, above, bad: badNow, cold: coldNow, setChangedAt: setChanged ? r.at : (same ? prev.setChangedAt || null : null) };
}
// minutes on the same side of the set point (null = not known: one reading only, or no set point). Pure.
export const sideMin = (t) => (t && t.above && t.above.n >= 2 ? Math.round((t.lastAt - t.above.since) / MIN) : null);
// minutes beyond the alert limit, from the readings. Pure.
export const badMin = (t) => (t && t.bad ? Math.round((t.lastAt - t.bad.since) / MIN) : 0);

const ET = (ms) => `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
const f1 = (v) => `${Number(v).toFixed(1)}°F`;
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
// The text: REEFER TEMP ALERT (first), TEMP UPDATE (worse). Plain text, trailer first; nothing filled in that the readings
// don't say. Pure.
export function tempSms(x, t, { kind = 'alert' } = {}) {
  const head = kind === 'freeze' ? 'FREEZE RISK - FLOWERS' : kind === 'back' ? 'TEMP BACK IN RANGE' : kind === 'update' ? 'TEMP UPDATE' : 'REEFER TEMP ALERT';
  const lines = [head, `Trailer ${x.trailer || 'not on file'} | Trip ${x.trip}`, `Reading: ${f1(x.readingF)}`];
  const hasSet = x.setF != null && Number.isFinite(Number(x.setF));
  x = { ...x, readingF: r1(x.readingF), setF: hasSet ? r1(x.setF) : null };   // eslint-disable-line no-param-reassign
  lines.push(`Set point: ${hasSet ? f1(x.setF) : 'not reported'}`);
  if (x.vs === 'required') lines.push(`Load needs: ${x.refText.replace(/^required /, '')}`);
  const side = hasSet ? Math.sign(Math.round((x.readingF - x.setF) * 10)) : 0;
  const word = side < 0 ? 'Below' : 'Above';
  if (hasSet) {
    const d = Math.round((x.readingF - x.setF) * 10) / 10;
    lines.push(`${word} set point: ${d > 0 ? '+' : ''}${d.toFixed(1)}°F`);
  } else lines.push(`${x.offF > 0 ? 'Above' : 'Below'} required: ${x.offF > 0 ? '+' : ''}${Number(x.offF).toFixed(1)}°F`);
  const m = hasSet && side && t && t.above && t.above.dir === side && t.lastAt === x.at ? sideMin(t) : null;
  if (m != null) {
    lines.push(`${word} set point for: ${t.above.atLeast ? 'At least ' : ''}${dur(m)}`);
    lines.push(`Since: ${ET(t.above.since)}${t.above.atLeast ? ' or earlier' : ''}`);
    if (t.setChangedAt && t.setChangedAt <= t.above.since) lines.push(`Set point changed: ${ET(t.setChangedAt)}`);
  } else lines.push(`${word} set point for: Duration unavailable`);
  if (kind === 'freeze') lines.push(`At or below ${FREEZE_F}°F: ${t && t.cold && t.cold.n >= 2 ? `${t.cold.n} readings in a row since ${ET(t.cold.since)}` : 'this reading'}`);
  lines.push(`Reading taken: ${x.at ? ET(x.at) : 'time not reported'}`);
  lines.push('Jarvis · Florida Beauty Dispatch');
  return lines.join('\n');
}

// The "back in range" text after an alert. Pure.
export function backSms(x, prev) {
  return ['TEMP BACK IN RANGE', `Trailer ${x.trailer || 'not on file'} | Trip ${x.trip}`, `Reading: ${f1(x.readingF)}`, `Set point: ${x.setF != null ? f1(x.setF) : 'not reported'}`,
    ...(prev && prev.readingF != null ? [`Was: ${f1(prev.readingF)}${prev.readAt ? ` at ${ET(prev.readAt)}` : ''}`] : []),
    `Reading taken: ${x.at ? ET(x.at) : 'time not reported'}`, 'Jarvis · Florida Beauty Dispatch'].join('\n');
}
// minutes a reading must stay off before the FIRST text: freeze → 2 readings in a row (no clock); 10°F+ warm → 30 min;
// otherwise the 2 hours. → true while still holding. Pure.
export function holding(x, t, { holdMin = HOLD_MIN } = {}) {
  if (x.kind === 'freeze') return !(t && t.cold && t.cold.n >= 2);
  if (x.offF >= SEVERE_F) return !(t && t.bad && (t.bad.n || 1) >= 2 && badMin(t) >= SEVERE_HOLD_MIN);
  return badMin(t) < holdMin;
}

export function initLtlTempAlert({ db, sendMail = null, emails = async () => [], phones = async () => [], sendSms = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  // every board cycle
  async function process(site, board) {
    if (!enabled) return [];
    const cfg = { on: true, limitF: 5, holdMin: HOLD_MIN, ...((await db.get(CFG, {})) || {}) };
    if (!cfg.on) return [];
    const trips = (board && board.trips) || [];
    // is the flower load on the trailer? (loading for more than 3 hours counts as on: the warm allowance is over)
    const visits = (await db.get(`taStopVisits:${site}`, {})) || {};
    const milestones = (await db.get(`taMilestones:${site}`, {})) || {};
    const prevPh = (await db.get(PHASE(site), {})) || {};
    const ph = {}; const phases = {};
    for (const it of trips) {
      if (!isLtl(it)) continue;
      const n = tripNo(it); if (!n) continue;
      const p = loadPhase(it, { trips, visits, milestones });
      const since = prevPh[n] && prevPh[n].phase === p.phase ? prevPh[n].since : now();
      ph[n] = { phase: p.phase, since, ...(p.by ? { by: p.by } : {}) };
      phases[n] = p.phase === 'loading' && now() - since > LOADING_MAX_MIN * MIN ? 'on' : p.phase;
    }
    await db.set(PHASE(site), ph);
    const off = tempOff(trips, { limit: cfg.limitF, now: now(), phases });
    // each LTL reading folded into its trip's history — only while the flowers are on it (not at a receiver, doors open)
    const hist = (await db.get(TRACK(site), {})) || {};
    const nextHist = {};
    for (const it of trips) {
      if (!isLtl(it)) continue;
      const n = tripNo(it); const c = it._loadTemp && it._loadTemp.current;
      if (!n || !ONBOARD.has(phases[n])) continue;                                    // delivered / next load / not loaded: forgotten
      const cold = !!c && frozenReading(it._loadTemp);
      if (!c || (!cold && /^ARRCONS/i.test(stOf(it)))) { if (hist[n]) nextHist[n] = hist[n]; continue; }
      const o = offBy(it._loadTemp);
      const warmLoading = phases[n] === 'loading' && o && o.offF > 0;
      nextHist[n] = track(hist[n], { f: c.readingF, setF: c.setF, at: Date.parse(c.at || '') }, { bad: !!(o && !warmLoading && Math.abs(o.offF) > cfg.limitF), cold });
    }
    await db.set(TRACK(site), nextHist);
    const st = (await db.get(KEY(site), {})) || {};
    const next = {};
    const due = [];
    const offKeys = new Set(off.map(alertKey));
    for (const x of off) {
      const k = alertKey(x); const prev = st[k];
      const held = x.kind !== 'setpoint' && (!prev || (x.kind === 'freeze' && prev.kind !== 'freeze')) && holding(x, nextHist[x.trip], { holdMin: cfg.holdMin });
      const rec = { kind: x.kind, offF: x.offF, setF: x.setF, readingF: x.readingF ?? null, readAt: x.at || null, at: new Date(now()).toISOString() };
      if (!held && shouldAlert(prev, x)) { due.push({ x, worse: !!prev && x.kind !== 'setpoint' && (prev.kind || 'reading') === x.kind }); next[k] = rec; } else if (prev) next[k] = prev;
    }
    // an alerted reading back in range (the flowers still on the trailer, a fresh reading) → one BACK IN RANGE text;
    // delivered / next load → forgotten quietly. Set point alerts are just forgotten.
    const back = [];
    for (const [k, prev] of Object.entries(st)) {
      if (offKeys.has(k)) continue;
      const tk = k.replace(/\|set$/, '');
      const it = trips.find((x) => tripNo(x) === tk);
      // flowers off the trailer (or still loading in a way that hides it): remember what was already said while the trip
      // is on the board, so a phase that flips back — or an overlapping deploy — never repeats it
      if (it && !ONBOARD.has(phases[tk])) { next[k] = prev; continue; }
      if (k.endsWith('|set')) continue;                                             // set point fixed → forgotten
      const c = it && it._loadTemp && it._loadTemp.current;
      const at = c ? Date.parse(c.at || '') : null;
      if (!it || !ONBOARD.has(phases[k]) || !c || c.readingF == null || !at || (prev.readAt && at <= prev.readAt) || now() - at > 240 * MIN) { if (it && ONBOARD.has(phases[k])) next[k] = prev; continue; }
      back.push({ x: { ...base(it), readingF: r1(c.readingF), setF: c.setF != null ? r1(c.setF) : null, at }, prev });
    }
    await db.set(KEY(site), next);
    if (!due.length && !back.length) return [];
    const to = await emails(); const ph2 = sendSms ? await phones() : [];
    const sent = (await db.get(SENT(site), {})) || {};
    const once = async (id) => { if (sent[id]) return false; sent[id] = new Date(now()).toISOString(); await db.set(SENT(site), Object.fromEntries(Object.entries(sent).slice(-500))); return true; };
    for (const { x, worse } of due) {
      const m = tempMessage(x, { worse });
      if (x.kind === 'setpoint' && !(await once([x.trailer || '-', x.trip, 'set', x.setF].join('|')))) continue; // eslint-disable-line no-await-in-loop
      if (x.kind !== 'setpoint') {
        // once per trailer, trip, stretch and reading — a repeat cycle or a retry never texts the same thing twice
        const t = nextHist[x.trip];
        const kind = x.kind === 'freeze' && !worse ? 'freeze' : worse ? 'update' : 'alert';
        const id = [x.trailer || '-', x.trip, (t && t.above && t.above.since) || '-', x.at || '-', kind].join('|');
        if (!(await once(id))) continue; // eslint-disable-line no-await-in-loop
        m.sms = tempSms(x, t, { kind });
      }
      if (sendMail && to.length) await sendMail({ to, subject: m.subject, html: m.html }).catch((e) => console.warn('[ltl-temp] email:', e.message)); // eslint-disable-line no-await-in-loop
      for (const p of ph2) await sendSms(p, m.sms).catch((e) => console.warn('[ltl-temp] text:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[ltl-temp] trip ${x.trip}: ${x.kind === 'setpoint' ? `set ${x.setF}F vs ${x.refText}` : `${x.kind} ${x.readingF}F, ${x.offF}F vs ${x.vs}`}`);
    }
    for (const { x, prev } of back) {
      if (!(await once([x.trailer || '-', x.trip, x.at, 'back'].join('|')))) continue; // eslint-disable-line no-await-in-loop
      for (const p of ph2) await sendSms(p, backSms(x, prev)).catch((e) => console.warn('[ltl-temp] text:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[ltl-temp] trip ${x.trip}: back in range ${x.readingF}F`);
    }
    return due.map((d) => d.x);
  }
  return { process };
}

// ---------------------------------------------------------------
// LTL reefer temperature alert (flower runs only — never broker loads). When a load's reefer reading is more than 5°F
// above or below its set point OR the temperature the load needs, and when ARTIS's set point isn't the temperature the
// load needs, an email goes to the "LTL reefer 5°F off" list (inbound@) and a text to Nadim. A reading: once it has
// been off for 2 hours straight (by the readings' own times), again only if 3°F worse; a set point: once per value. Readings while the truck is at a receiver
// (doors open, unloading) don't count. The reading is the card's: Samsara return air,
// else TruckMate's Thermo King, else ARTIS's Trip Status.
// ---------------------------------------------------------------
import { isLtl } from './usualarrival.js';
import { fmtLocalShort } from './localtime.js';

const KEY = (site) => `taLtlTempAlert:${site}`;
const CFG = 'taLtlTempAlertCfg';
const TRACK = (site) => `taLtlTempTrack:${site}`;   // trip → reading history (track)
const SENT = (site) => `taLtlTempSent:${site}`;     // texts already sent: trailer|trip|since|reading|kind
const MIN = 60000;
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

const base = (it) => ({ trip: tripNo(it), truck: String(tripOf(it).powerUnit || '').trim() || null, trailer: String(tripOf(it).trailer || '').trim() || null, where: (it._samsara && it._samsara.location) || null });
// The LTL loads with a temperature problem right now: the reading more than `limit` °F off (kind 'reading'), or the set
// point not what the load needs (kind 'setpoint'). Pure.
export function tempOff(items = [], { limit = 5, now = Date.now(), maxAgeMin = 240 } = {}) {
  const out = [];
  for (const it of items) {
    if (!isLtl(it)) continue;
    const lt = it._loadTemp;
    const sp = setPointMismatch(it);
    if (sp) out.push({ ...base(it), kind: 'setpoint', ...sp });
    if (/^ARRCONS/i.test(String(tripOf(it).status || ''))) continue;               // at a receiver: doors open while unloading
    const o = offBy(lt);
    if (!o || Math.abs(o.offF) <= limit) continue;
    const at = Date.parse((lt.current && lt.current.at) || '');
    if (at && now - at > maxAgeMin * MIN) continue;                                // an old reading isn't news
    out.push({ ...base(it), kind: 'reading', readingF: r1(lt.current.readingF), setF: lt.current.setF != null ? r1(lt.current.setF) : null, source: lt.current.source || null, at: at || null, ...o });
  }
  return out;
}

// alert now? a reading: the first time it's off, or 3°F worse than the last alert. A set point: once per set point value. Pure.
export const alertKey = (x) => (x.kind === 'setpoint' ? `${x.trip}|set` : x.trip);
export const shouldAlert = (prev, x) => !prev || (x.kind === 'setpoint' ? prev.setF !== x.setF : Math.abs(x.offF) - Math.abs(prev.offF) >= 3);

export function tempMessage(x, { worse = false } = {}) {
  if (x.kind === 'setpoint') {
    const dir = x.offF > 0 ? 'warmer' : 'colder';
    const subject = `LTL set point doesn't match: trip ${x.trip}${x.trailer ? ` · trailer ${x.trailer}` : ''} — set ${x.setF}°F, ${x.refText}`;
    const rows = [['Trip', `${x.trip}${x.truck ? ` · truck ${x.truck}` : ''}${x.trailer ? ` · trailer ${x.trailer}` : ''}`], ['Set point', `${x.setF}°F${x.setFrom ? ` (${x.setFrom})` : ''}`], ['Load needs', x.refText], ['Difference', `set ${Math.abs(x.offF)}°F ${dir} than the range`], ...(x.where ? [['Truck now', x.where]] : [])];
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>The reefer set point on LTL trip ${esc(x.trip)} is not the temperature the load needs.</p>`
      + `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#555"><b>${esc(k)}</b></td><td style="padding:3px 0">${esc(v)}</td></tr>`).join('')}</table>`
      + '<p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>';
    return { subject, html, sms: `LTL set point alert: trip ${x.trip}${x.trailer ? ` trailer ${x.trailer}` : ''} is set to ${x.setF}F but the load needs ${x.refText.replace(/^required /, '')}.` };
  }
  const dir = x.offF > 0 ? 'above' : 'below';
  const amt = `${Math.abs(x.offF)}°F ${dir} ${x.vs === 'set point' ? 'the set point' : 'the required temperature'}`;
  const when = x.at ? fmtLocalShort(x.at, 'FL') : null;
  const subject = `${worse ? 'Still off — ' : ''}LTL reefer ${amt}: trip ${x.trip}${x.trailer ? ` · trailer ${x.trailer}` : ''} — ${x.readingF}°F`;
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
export function track(prev, r, { gapMin = GAP_MIN, bad = false } = {}) {
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
  const badNow = bad ? (same && prev.bad ? prev.bad : { since: r.at }) : null;
  return { setF: setF ?? null, lastAt: r.at, lastF: f, above, bad: badNow, setChangedAt: setChanged ? r.at : (same ? prev.setChangedAt || null : null) };
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
  const head = kind === 'update' ? 'TEMP UPDATE' : 'REEFER TEMP ALERT';
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
  lines.push(`Reading taken: ${x.at ? ET(x.at) : 'time not reported'}`);
  lines.push('Jarvis · Florida Beauty Dispatch');
  return lines.join('\n');
}

export function initLtlTempAlert({ db, sendMail = null, emails = async () => [], phones = async () => [], sendSms = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  // every board cycle
  async function process(site, board) {
    if (!enabled) return [];
    const cfg = { on: true, limitF: 5, holdMin: HOLD_MIN, ...((await db.get(CFG, {})) || {}) };
    if (!cfg.on) return [];
    const trips = (board && board.trips) || [];
    const off = tempOff(trips, { limit: cfg.limitF, now: now() });
    // each LTL reading folded into its trip's history (not at a receiver: doors open while unloading)
    const hist = (await db.get(TRACK(site), {})) || {};
    const nextHist = {};
    for (const it of trips) {
      if (!isLtl(it)) continue;
      const n = tripNo(it); const c = it._loadTemp && it._loadTemp.current;
      if (!n) continue;
      if (!c || /^ARRCONS/i.test(String(tripOf(it).status || ''))) { if (hist[n]) nextHist[n] = hist[n]; continue; }
      const o = offBy(it._loadTemp);
      nextHist[n] = track(hist[n], { f: c.readingF, setF: c.setF, at: Date.parse(c.at || '') }, { bad: !!(o && Math.abs(o.offF) > cfg.limitF) });
    }
    await db.set(TRACK(site), nextHist);
    const st = (await db.get(KEY(site), {})) || {};
    const next = {};
    const due = [];
    for (const x of off) {
      const k = alertKey(x); const prev = st[k];
      // a reading's first alert waits until it's been off for 2 hours (by the readings); the 3°F-worse update doesn't
      const held = x.kind === 'reading' && !prev && badMin(nextHist[x.trip]) < cfg.holdMin;
      if (!held && shouldAlert(prev, x)) { due.push({ x, worse: !!prev && x.kind === 'reading' }); next[k] = { offF: x.offF, setF: x.setF, at: new Date(now()).toISOString() }; } else if (prev) next[k] = prev;
    }
    // back within range → forgotten, so the next time it goes off alerts again
    await db.set(KEY(site), next);
    if (!due.length) return [];
    const to = await emails(); const ph = sendSms ? await phones() : [];
    const sent = (await db.get(SENT(site), {})) || {};
    for (const { x, worse } of due) {
      const m = tempMessage(x, { worse });
      if (x.kind === 'reading') {
        // once per trailer, trip, stretch and reading — a repeat cycle or a retry never texts the same thing twice
        const t = nextHist[x.trip];
        const id = [x.trailer || '-', x.trip, (t && t.above && t.above.since) || '-', x.at || '-', worse ? 'update' : 'alert'].join('|');
        if (sent[id]) continue;
        sent[id] = new Date(now()).toISOString();
        await db.set(SENT(site), Object.fromEntries(Object.entries(sent).slice(-500))); // eslint-disable-line no-await-in-loop
        m.sms = tempSms(x, t, { kind: worse ? 'update' : 'alert' });
      }
      if (sendMail && to.length) await sendMail({ to, subject: m.subject, html: m.html }).catch((e) => console.warn('[ltl-temp] email:', e.message)); // eslint-disable-line no-await-in-loop
      for (const p of ph) await sendSms(p, m.sms).catch((e) => console.warn('[ltl-temp] text:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[ltl-temp] trip ${x.trip}: ${x.kind === 'setpoint' ? `set ${x.setF}F vs ${x.refText}` : `${x.readingF}F, ${x.offF}F vs ${x.vs}`}`);
    }
    return due.map((d) => d.x);
  }
  return { process };
}

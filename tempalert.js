// ---------------------------------------------------------------
// LTL reefer temperature alert (flower runs only — never broker loads). When a load's reefer reading is more than 5°F
// above or below its set point OR the temperature the load needs, and when ARTIS's set point isn't the temperature the
// load needs, an email goes to the "LTL reefer 5°F off" list (inbound@) and a text to Nadim. A reading: once per
// time it goes off, again only if 3°F worse; a set point: once per value. Readings while the truck is at a receiver
// (doors open, unloading) don't count. The reading is the card's: Samsara return air,
// else TruckMate's Thermo King, else ARTIS's Trip Status.
// ---------------------------------------------------------------
import { isLtl } from './usualarrival.js';
import { fmtLocalShort } from './localtime.js';

const KEY = (site) => `taLtlTempAlert:${site}`;
const CFG = 'taLtlTempAlertCfg';
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

export function initLtlTempAlert({ db, sendMail = null, emails = async () => [], phones = async () => [], sendSms = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  // every board cycle
  async function process(site, board) {
    if (!enabled) return [];
    const cfg = { on: true, limitF: 5, ...((await db.get(CFG, {})) || {}) };
    if (!cfg.on) return [];
    const off = tempOff((board && board.trips) || [], { limit: cfg.limitF, now: now() });
    const st = (await db.get(KEY(site), {})) || {};
    const next = {};
    const due = [];
    for (const x of off) { const k = alertKey(x); const prev = st[k]; if (shouldAlert(prev, x)) { due.push({ x, worse: !!prev && x.kind === 'reading' }); next[k] = { offF: x.offF, setF: x.setF, at: new Date(now()).toISOString() }; } else next[k] = prev; }
    // back within range → forgotten, so the next time it goes off alerts again
    await db.set(KEY(site), next);
    if (!due.length) return [];
    const to = await emails(); const ph = sendSms ? await phones() : [];
    for (const { x, worse } of due) {
      const m = tempMessage(x, { worse });
      if (sendMail && to.length) await sendMail({ to, subject: m.subject, html: m.html }).catch((e) => console.warn('[ltl-temp] email:', e.message)); // eslint-disable-line no-await-in-loop
      for (const p of ph) await sendSms(p, m.sms).catch((e) => console.warn('[ltl-temp] text:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[ltl-temp] trip ${x.trip}: ${x.kind === 'setpoint' ? `set ${x.setF}F vs ${x.refText}` : `${x.readingF}F, ${x.offF}F vs ${x.vs}`}`);
    }
    return due.map((d) => d.x);
  }
  return { process };
}

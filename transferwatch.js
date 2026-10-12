// ---------------------------------------------------------------
// Transfer watch. A trip sheet that plans a truck change ("truck 734 leaves Miami, transfers to 4504"):
// Jarvis follows both trucks — reports when the transfer is planned (and every 2 h while they're apart:
// both rolling or stopped, how far apart), when they're together, and once they've been together 15+
// minutes asks the drivers by text whether the transfer was done (calls if nobody answers in 15 min),
// then reports their answer. Recipients: Employees → Alert emails ("Truck transfer").
// ---------------------------------------------------------------
import { haversineMi } from './watchtower.js';
import { transferTo } from './manifest.js';
import { samsaraTokenFrom, getLiveIndex } from './samsara.js';

const MIN = 60000;
const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const norm = (x) => String(x == null ? '' : x).trim().toLowerCase().replace(/^0+(?=\d)/, '');
const unitKey = (x) => String(x || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();
export const TOGETHER_MI = 0.5;
export const APART_MI = 1.5;            // together → apart again only past this (GPS jitter)
export const ASK_AFTER_MIN = 15;        // together this long → text the drivers
export const CALL_AFTER_MIN = 15;       // text not answered this long → call
export const UPDATE_EVERY_MIN = 120;    // report while apart
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;

// The planned transfer on a load: from the sheet's truck to the transfer truck. Pure. → { trip, from, to, trailer } | null
export function transferPlan(it) {
  const m = (it && it._manifest) || null;
  if (!m || !m.truck) return null;
  if (DONE.test(String(tripOf(it).status || ''))) return null;
  const pu = tripOf(it).powerUnit;
  const to = m.transferTruck ? m.transferTruck : (pu && transferTo(m, pu) ? pu : null);
  if (!to || unitKey(to) === unitKey(m.truck)) return null;
  return { trip: tripNo(it), from: String(m.truck), to: String(to), trailer: String(m.trailer || tripOf(it).trailer || '') || null };
}

// Where the two trucks are relative to each other. Pure. pos: { lat, lng, speedMph, location, at }
export function transferStatus(a, b) {
  const has = (p) => p && p.lat != null && p.lng != null;
  const rolling = (p) => (has(p) && p.speedMph != null ? p.speedMph > 5 : null);
  const distanceMi = has(a) && has(b) ? Math.round(haversineMi(a.lat, a.lng, b.lat, b.lng) * 10) / 10 : null;
  return { distanceMi, aRolling: rolling(a), bRolling: rolling(b), together: distanceMi != null && distanceMi <= TOGETHER_MI };
}

// What a driver's answer means. Pure (quick rules; the AI read refines it). → 'done' | 'not_done' | null
export function readTransferReply(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(no|not yet|haven'?t|still waiting|waiting|todav[ií]a no|a[uú]n no|no hemos)\b/.test(t)) return 'not_done';
  if (/\b(yes|yeah|yep|done|completed?|finished|ya|listo|hecho|s[ií]|transfer(red)? done|we switched|switched)\b/.test(t)) return 'done';
  return null;
}

// The next step for one transfer. Pure. st: saved state; s: transferStatus; now.
// → { state, actions: ['report_start'|'report_update'|'report_together'|'text'|'call'] }
export function step(st0, s, now) {
  const st = { ...(st0 || {}) };
  const actions = [];
  if (st.outcome && st.outcome.status === 'done') return { state: st, actions };
  if (!st.startedAt) { st.startedAt = new Date(now).toISOString(); actions.push('report_start'); st.lastReportAt = st.startedAt; }
  if (s.together) {
    if (!st.togetherSince) { st.togetherSince = new Date(now).toISOString(); if (!st.togetherReported) { actions.push('report_together'); st.togetherReported = st.togetherSince; } }
    const togetherMin = (now - Date.parse(st.togetherSince)) / MIN;
    if (togetherMin >= ASK_AFTER_MIN && !st.askedAt) { st.askedAt = new Date(now).toISOString(); actions.push('text'); }
  } else if (s.distanceMi != null && s.distanceMi > APART_MI && st.togetherSince && !st.askedAt) {
    st.togetherSince = null;                 // drove past each other / not the meeting yet
  }
  if (st.askedAt && !st.calledAt && !st.outcome && (now - Date.parse(st.askedAt)) / MIN >= CALL_AFTER_MIN) { st.calledAt = new Date(now).toISOString(); actions.push('call'); }
  if (!actions.length && !s.together && !st.askedAt && st.lastReportAt && (now - Date.parse(st.lastReportAt)) / MIN >= UPDATE_EVERY_MIN) { actions.push('report_update'); st.lastReportAt = new Date(now).toISOString(); }
  return { state: st, actions };
}

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const roll = (r) => (r == null ? 'no GPS' : r ? 'rolling' : 'stopped');
// The email for one report. Pure.
export function transferEmail(kind, plan, a, b, s, { outcome = null, now = Date.now() } = {}) {
  const head = {
    start: `Transfer planned — trip ${plan.trip}: truck ${plan.from} → ${plan.to}`,
    update: `Transfer update — trip ${plan.trip}: trucks ${s.distanceMi != null ? `${s.distanceMi} mi apart` : 'not both on GPS'}`,
    together: `Trucks together — trip ${plan.trip}: ${plan.from} and ${plan.to}`,
    outcome: `Transfer ${outcome && outcome.status === 'done' ? 'done' : 'not done yet'} — trip ${plan.trip}: ${plan.from} → ${plan.to}`,
  }[kind];
  const row = (label, unit, p, r) => `<tr><td><b>${label} ${esc(unit)}</b></td><td>${esc((p && p.location) || '—')}</td><td>${roll(r)}${p && p.speedMph != null ? ` (${p.speedMph} mph)` : ''}</td><td>${p && p.at ? when(Date.parse(p.at)) : '—'}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">
<p><b>${esc(head)}</b>${plan.trailer ? ` · trailer ${esc(plan.trailer)}` : ''}</p>
${outcome ? `<p>${esc(outcome.summary || '')}${outcome.source ? ` <i>(${esc(outcome.source)})</i>` : ''}</p>` : ''}
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Truck</th><th>Where</th><th>Moving</th><th>GPS time</th></tr>
${row('Leaving truck', plan.from, a, s.aRolling)}${row('Transfer truck', plan.to, b, s.bRolling)}</table>
<p>Distance between them: <b>${s.distanceMi != null ? `${s.distanceMi} mi` : 'unknown (one truck has no GPS)'}</b>${s.together ? ' — together' : ''} · as of ${when(now)} ET</p>
${kind === 'together' ? `<p>If they're still together in ${ASK_AFTER_MIN} minutes, Jarvis will text the driver to confirm the transfer (and call if there's no answer).</p>` : ''}
</div>`;
  return { subject: head, html, text: `${head}${s.distanceMi != null ? ` · ${s.distanceMi} mi apart` : ''} · ${plan.from}: ${roll(s.aRolling)} · ${plan.to}: ${roll(s.bRolling)}` };
}

export function initTransferWatch({ db, env = process.env, sendMail, recipients, textDriver = null, voice = null, comms = null, fetchFn = globalThis.fetch, now = () => Date.now(), livePos = null }) {
  const enabled = !!(db && db.enabled);
  const key = `taTransferWatch:${SITE}`;
  // live position of any truck by unit number (Samsara)
  async function positions() {
    if (livePos) return livePos;
    const token = samsaraTokenFrom(env);
    if (!token) return () => null;
    const idx = await getLiveIndex(token);
    return (unit) => {
      const st = idx.statsByUnit && idx.statsByUnit[norm(unit)];
      const g = st && st.gps;
      return g ? { lat: g.latitude, lng: g.longitude, speedMph: g.speedMilesPerHour != null ? Math.round(g.speedMilesPerHour) : null, location: (g.reverseGeo && g.reverseGeo.formattedLocation) || null, at: g.time || null } : null;
    };
  }
  async function mail(kind, plan, a, b, s, extra) {
    const to = await recipients();
    if (!to.length) return false;
    await sendMail({ to, ...transferEmail(kind, plan, a, b, s, { ...extra, now: now() }) });
    return true;
  }
  // the drivers' answer since we asked (texts back, or what they said on the call)
  async function answer(trip, since) {
    const log = (((await db.get(`taTripComms:${SITE}`, {})) || {})[trip] || []).filter((e) => e.type === 'reply' && Date.parse(e.at) >= since);
    const calls = voice && voice.callsFor ? (await voice.callsFor(trip, since)).filter((c) => c.purpose === 'transfer-check' || /transfer/i.test(c.summary || '')) : [];
    for (const r of log) { const st = readTransferReply(r.text); if (st) return { status: st, source: 'driver text', summary: `Driver replied: "${String(r.text).slice(0, 200)}"`, at: r.at }; }
    for (const c of calls) { const st = readTransferReply(`${c.summary || ''} ${c.transcript || ''}`); if (st) return { status: st, source: 'phone call', summary: c.summary || 'Driver answered on the call.', at: c.at }; }
    return null;
  }

  async function process(site, board) {
    if (!enabled || !board) return [];
    const plans = ((board.trips) || []).map(transferPlan).filter(Boolean);
    if (!plans.length) return [];
    const pos = await positions().catch(() => () => null);
    const all = (await db.get(key, {})) || {};
    const done = [];
    for (const plan of plans) {
      const prev = all[plan.trip] && all[plan.trip].from === plan.from && all[plan.trip].to === plan.to ? all[plan.trip] : null;
      if (prev && prev.outcome && prev.outcome.status === 'done') continue;
      const a = pos(plan.from); const b = pos(plan.to);
      const s = transferStatus(a, b);
      const { state, actions } = step(prev, s, now());
      state.from = plan.from; state.to = plan.to; state.last = { distanceMi: s.distanceMi, aRolling: s.aRolling, bRolling: s.bRolling, at: new Date(now()).toISOString() };
      for (const act of actions) {
        try {
          if (act === 'report_start') await mail('start', plan, a, b, s); // eslint-disable-line no-await-in-loop
          if (act === 'report_update') await mail('update', plan, a, b, s); // eslint-disable-line no-await-in-loop
          if (act === 'report_together') await mail('together', plan, a, b, s); // eslint-disable-line no-await-in-loop
          if (act === 'text') {
            const msg = `Florida Beauty dispatch: trucks ${plan.from} and ${plan.to}${plan.trailer ? `, trailer ${plan.trailer}` : ''} (trip ${plan.trip}) — is the transfer done? Reply YES when the trailer is hooked to ${plan.to}, or NO.`;
            const r = textDriver ? await textDriver(site, plan.trip, msg, 'Jarvis (transfer watch)').catch(() => null) : null; // eslint-disable-line no-await-in-loop
            state.textResult = r && (r.sent || r.via || r.training) ? 'sent' : 'not sent';
            if (state.textResult !== 'sent') state.askedAt = new Date(now() - CALL_AFTER_MIN * MIN).toISOString();   // no text possible → call on the next pass
          }
          if (act === 'call' && voice && voice.placeCall) {
            await voice.placeCall(plan.trip, { purpose: 'transfer-check', by: 'Jarvis (transfer watch)', vars: { from_truck: plan.from, to_truck: plan.to, trailer: plan.trailer || 'the trailer' } }).catch((e) => { state.callError = e.message; }); // eslint-disable-line no-await-in-loop
          }
        } catch (e) { console.warn('[transfer]', plan.trip, act, e.message); }
      }
      // the drivers' answer → report it (done ends the watch; "not yet" keeps it going)
      if (state.askedAt && !state.outcome) {
        const ans = await answer(plan.trip, Date.parse(state.askedAt) - MIN); // eslint-disable-line no-await-in-loop
        if (ans) {
          state.outcome = ans;
          await mail('outcome', plan, a, b, s, { outcome: ans }).catch(() => {}); // eslint-disable-line no-await-in-loop
          if (ans.status !== 'done') { state.outcome = null; state.askedAt = null; state.calledAt = null; state.togetherSince = null; state.notYetAt = ans.at; }
        }
      }
      all[plan.trip] = state;
      done.push({ trip: plan.trip, actions, distanceMi: s.distanceMi });
    }
    await db.update(key, (cur) => ({ ...(cur || {}), ...Object.fromEntries(done.map((d) => [d.trip, all[d.trip]])) }), {});
    return done;
  }
  return { process };
}

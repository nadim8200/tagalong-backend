// ---------------------------------------------------------------
// "Rolling to your next pickup?" — asked in the driver app. When a driver finishes an LTL run in the app (the load
// completed, or every stop marked done) and the truck starts rolling again, Jarvis asks them through a push notification
// and a Yes / No pop-up in the app about their next load's pickup. No asks for a reason (a comment box). Either answer goes to
// dispatch as the pickup follow-up email (pickupfollow.js driverAnswered). Also asked about any load an hour before its pickup, when
// the crew hasn't checked in at the shipper. Asked once per load; the question stays in the app for 12 hours.
// ---------------------------------------------------------------
import { isLtl } from './usualarrival.js';
import { loadsFor } from './driverauth.js';
import { plannedPickup } from './pickupfollow.js';

const SITE = 'florida-beauty';
const KEY = (site) => `taPickupAsk:${site}`;     // { done: { ltlTrip: { at, codes, unit } }, asks: { nextTrip: { afterTrip, codes, askedAt, place, when, answer } } }
const MIN = 60000;
export const MOVING_MPH = 10;
export const GPS_FRESH_MS = 15 * MIN;
export const OPEN_MS = 12 * 3600000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const norm = (c) => String(c == null ? '' : c).trim().toUpperCase();
const codesOf = (it) => [tripOf(it).driver, tripOf(it).driver2].map(norm).filter(Boolean);
const unitOf = (it) => norm(tripOf(it).powerUnit).replace(/^0+(?=\d)/, '');
const fmt = (ms, tz = 'America/New_York') => new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The LTL run is finished in the app: completed, or every stop marked done. → ISO time | null. Pure.
export function ltlFinishedAt(it) {
  const f = it && it._stopFlow;
  if (!f || !isLtl(it)) return null;
  if (f.completedAt) return f.completedAt;
  const rows = f.stops || [];
  if (f.total > 0 && f.done === f.total && rows.length) return rows.map((r) => r.doneAt).filter(Boolean).sort().pop() || null;
  return null;
}

// The truck's GPS says it's rolling now (fresh, over 10 mph, after the run ended). Pure.
export function rollingSince(items, unit, sinceMs, now = Date.now()) {
  for (const it of items) {
    if (unitOf(it) !== unit) continue;
    const s = it._samsara || {};
    const at = Date.parse(s.gpsAt || '');
    if (Number.isFinite(at) && now - at <= GPS_FRESH_MS && at > sinceMs && (Number(s.speedMph) || 0) > MOVING_MPH) return true;
  }
  return false;
}

// Remember finished runs, and find the questions due now. → { done, asks: [{ trip, afterTrip, codes, place, when }] }. Pure.
export function dueAsks(items = [], state = {}, now = Date.now()) {
  const done = { ...(state.done || {}) };
  for (const it of items) {
    const at = ltlFinishedAt(it);
    if (at && !done[tripNo(it)]) done[tripNo(it)] = { at, codes: codesOf(it), unit: unitOf(it) };
  }
  const asked = state.asks || {};
  const out = [];
  for (const [afterTrip, d] of Object.entries(done)) {
    const since = Date.parse(d.at);
    if (!Number.isFinite(since) || now - since > OPEN_MS || d.askedFor) continue;
    if (!d.unit || !rollingSince(items, d.unit, since, now)) continue;
    // the driver's next load: booked for them, not this run
    const next = d.codes.flatMap((c) => loadsFor(c, items).next.map((l) => l.trip)).find((t) => t !== afterTrip && !asked[t]);
    if (!next) continue;
    const it = items.find((x) => tripNo(x) === next);
    const plan = it ? plannedPickup(it) : null;
    out.push({ trip: next, afterTrip, codes: d.codes, place: (plan && plan.place) || null, when: plan && plan.ms ? fmt(plan.ms, plan.tz) : null });
  }
  // any load an hour before its pickup: the crew hasn't checked in at the shipper and TruckMate doesn't show it started
  const taps = state.taps || {};
  for (const it of items) {
    const n = tripNo(it); const codes = codesOf(it);
    if (!n || !codes.length || asked[n] || out.some((a) => a.trip === n)) continue;
    if (/^(ARRSHIP|DEPSHIP|ARRCONS|DEPCONS|DELV|INTRAN|ENROUTE|SPT)/i.test(String(tripOf(it).status || ''))) continue;
    const st = (taps[n] || {}).steps || {};
    if (st['at-shipper'] || st.loaded) continue;
    const plan = plannedPickup(it);
    if (!plan || !plan.ms) continue;
    const left = plan.ms - now;
    if (left > 60 * MIN || left < -30 * MIN) continue;
    out.push({ trip: n, afterTrip: null, codes, place: plan.place || null, when: fmt(plan.ms, plan.tz), before: true });
  }
  for (const k of Object.keys(done)) if (now - Date.parse(done[k].at) > 3 * 86400000) delete done[k];
  return { done, asks: out };
}

export function initPickupAsk(app, { db, requireDriver = null, getBoard, notify = null, onAnswer = null, env = process.env, now = () => Date.now() } = {}) {
  const enabled = !!(db && db.enabled);
  async function process(site = SITE) {
    if (!enabled) return [];
    const items = ((await getBoard(site)) || {}).trips || [];
    const st = (await db.get(KEY(site), {})) || {};
    const { done, asks } = dueAsks(items, { ...st, taps: (await db.get(`taDriverCheckins:${site}`, {})) || {} }, now());
    const at = new Date(now()).toISOString();
    const nextAsks = { ...(st.asks || {}) };
    for (const a of asks) {
      nextAsks[a.trip] = { afterTrip: a.afterTrip, codes: a.codes, askedAt: at, place: a.place, when: a.when, answer: null };
      if (a.afterTrip) done[a.afterTrip] = { ...done[a.afterTrip], askedFor: a.trip };
    }
    for (const [k, v] of Object.entries(nextAsks)) if (now() - Date.parse(v.askedAt) > 3 * 86400000) delete nextAsks[k];
    await db.set(KEY(site), { done, asks: nextAsks });
    for (const a of asks) {
      const body = `Load ${a.trip}${a.place ? ` · pickup ${a.place}` : ''}${a.when ? ` · ${a.when}` : ''}. Tap Yes or No.`;
      for (const c of a.codes) if (notify) await notify(c, { title: a.before ? 'Rolling to your pickup?' : 'Rolling to your next pickup?', body, data: { tab: 'now', ask: 'pickup', trip: a.trip } }).catch((e) => console.warn('[pickup-ask] push:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[pickup-ask] trip ${a.trip}: asked ${a.codes.join(', ')} ${a.afterTrip ? `after LTL ${a.afterTrip}` : '1 h before pickup'}`);
    }
    return asks;
  }
  if (enabled && env.NODE_ENV !== 'test') { const t = setInterval(() => { process().catch((e) => console.warn('[pickup-ask]', e.message)); }, 2 * MIN); if (t.unref) t.unref(); }

  // the question waiting for this driver (the app shows it as a pop-up)
  async function openFor(code, site = SITE) {
    const asks = ((await db.get(KEY(site), {})) || {}).asks || {};
    const hit = Object.entries(asks).find(([, a]) => !a.answer && (a.codes || []).includes(norm(code)) && now() - Date.parse(a.askedAt) <= OPEN_MS);
    return hit ? { trip: hit[0], place: hit[1].place || null, when: hit[1].when || null, askedAt: hit[1].askedAt } : null;
  }
  // Yes, or No with why → saved once, and dispatch gets the email
  async function answer(trip, code, { rolling, comment, by }, site = SITE) {
    const a = (((await db.get(KEY(site), {})) || {}).asks || {})[String(trip)];
    if (!a || !(a.codes || []).includes(norm(code))) return { code: 404, error: 'Nothing to answer for that load.' };
    if (a.answer) return { ok: true, already: true };
    if (typeof rolling !== 'boolean') return { code: 400, error: 'Choose Yes or No.' };
    const why = String(comment || '').trim().slice(0, 1000);
    if (!rolling && why.length < 2) return { code: 400, error: 'Tell dispatch why not.' };
    const ans = { rolling, comment: rolling ? (why || null) : why, by: by || 'the driver', at: new Date(now()).toISOString() };
    await db.update(KEY(site), (cur) => { const c = { ...(cur || {}) }; c.asks = { ...(c.asks || {}) }; if (c.asks[trip] && !c.asks[trip].answer) c.asks[trip] = { ...c.asks[trip], answer: ans }; return c; }, {});
    let emailed = null;
    if (onAnswer) { try { emailed = await onAnswer(String(trip), ans); } catch (e) { console.warn('[pickup-ask] email:', e.message); } }
    return { ok: true, emailed: !!(emailed && emailed.emailed) };
  }
  if (app && requireDriver) {
    app.get('/driver/me/pickup-ask', requireDriver, async (req, res) => { res.json({ ask: enabled ? await openFor(req.driver.code) : null }); });
    app.post('/driver/me/pickup-ask/:trip', requireDriver, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
      const b = req.body || {};
      const r = await answer(String(req.params.trip), req.driver.code, { rolling: b.rolling, comment: b.comment, by: req.driver.name });
      return r.error ? res.status(r.code || 400).json({ error: r.error }) : res.json(r);
    });
  }
  return { process, openFor, answer };
}

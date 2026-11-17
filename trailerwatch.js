// ---------------------------------------------------------------
// Trailer watch (Nov 17): two emails to Nadim from the trailer positions (Thermo King + Samsara, yardreport.js):
//   • a trailer that hasn't moved in more than 30 days — once per parked stretch;
//   • a trailer moving while it isn't on any load on the board — once per trailer every 12 hours while it keeps moving.
// Moves within 5 miles of the same yard (jockeying, a shuttle to the cooler or a warehouse close by) don't count. One email per check lists everything new.
// ---------------------------------------------------------------
import { hubAt, HUB_NAMES, trailerKey } from './yardreport.js';
import { staffEmail } from './staffmail.js';

const STATE = 'taTrailerWatch';      // { parked: { trailer: parkedSince }, moving: { trailer: { at, hub } }, last: { trailer: { lat, lng, hub } } }
const DAY = 86400000; const MIN = 60000;
export const LONG_PARKED_MS = 30 * DAY;
export const MOVE_REPEAT_MS = 12 * 60 * MIN;
const FRESH_MS = 45 * MIN;
export const YARD_AREA_MI = 5;   // shuttles to the cooler / a warehouse close by: within 5 miles of the same yard don't count
// the same yard points, 5 miles wide. Pure.
const areaOf = (points) => Object.fromEntries(Object.entries(points || {}).map(([h, l]) => [h, (l || []).map((y) => ({ ...y, miles: YARD_AREA_MI }))]));

const tripOf = (it) => (it && it.trip) || it || {};
// every trailer on a load on the board (either trailer of a double). Pure.
export function trailersOnLoads(items = []) {
  const s = new Set();
  for (const it of items) { const t = tripOf(it); for (const x of [t.trailer, t.trailer2]) { const k = trailerKey(x); if (k) s.add(k); } }
  return s;
}
const where = (u, points) => { const h = hubAt(u, points); return h ? `${HUB_NAMES[h]} yard` : (u.location || (u.lat != null ? `${Number(u.lat).toFixed(3)}, ${Number(u.lng).toFixed(3)}` : 'location unknown')); };

// What's new this check. units: merged trailer list; prev: the saved state. Pure. → { longParked, movingNoLoad, next }
export function checkTrailers(units = {}, items = [], points = {}, prev = {}, now = Date.now()) {
  const onLoad = trailersOnLoads(items);
  const parkedSent = { ...(prev.parked || {}) }; const movingSent = { ...(prev.moving || {}) }; const last = { ...(prev.last || {}) };
  const longParked = []; const movingNoLoad = [];
  const area = areaOf(points);
  for (const u of Object.values(units)) {
    const k = trailerKey(u.trailer); if (!k || u.lat == null) continue;
    const hub = hubAt(u, points); const near = hubAt(u, area);
    // 1) parked more than 30 days (silent trailers count: their last position is where they sit)
    const ps = Date.parse(u.parkedSince || '');
    if (Number.isFinite(ps) && now - ps >= LONG_PARKED_MS && parkedSent[k] !== u.parkedSince) {
      longParked.push({ trailer: k, days: Math.floor((now - ps) / DAY), atLeast: !!u.atLeast, parkedSince: u.parkedSince, where: where(u, points), source: u.source || null, onLoad: onLoad.has(k) });
      parkedSent[k] = u.parkedSince;
    }
    // 2) moving now (a fresh reading at speed, or it just moved more than half a mile) and not on any load
    const fresh = u.at && now - Date.parse(u.at) <= FRESH_MS;
    const justMoved = u.atLeast === false && Number.isFinite(ps) && now - ps <= FRESH_MS;
    const moving = fresh && ((u.mph || 0) > 5 || justMoved);
    const before = last[k];
    const sameYard = near && before && before.near === near;   // within 5 miles of the same yard before and now (yard, cooler, warehouse close by)
    if (moving && !onLoad.has(k) && !sameYard) {
      const sent = movingSent[k];
      if (!sent || now - Date.parse(sent.at) >= MOVE_REPEAT_MS) {
        movingNoLoad.push({ trailer: k, mph: u.mph ?? null, at: u.at, where: where(u, points), from: before ? (before.hub ? `${HUB_NAMES[before.hub]} yard` : before.where || null) : null, source: u.source || null });
        movingSent[k] = { at: new Date(now).toISOString() };
      }
    }
    if (!moving) last[k] = { lat: u.lat, lng: u.lng, hub: hub || null, near: near || null, where: where(u, points) };
  }
  return { longParked, movingNoLoad, next: { parked: parkedSent, moving: movingSent, last } };
}

const etTime = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET` : '');
// The email (the "A note from Jarvis" style). Pure.
export function trailerWatchEmail({ longParked = [], movingNoLoad = [] }) {
  const moving = movingNoLoad.map((x) => ({ icon: 'clock', title: `Trailer ${x.trailer} is moving — not on any load`, text: `${x.where}${x.mph != null ? ` · ${x.mph} mph` : ''}${x.from ? ` · last parked at ${x.from}` : ''} · ${etTime(x.at)}${x.source ? ` · ${x.source}` : ''}` }));
  const parked = longParked.map((x) => ({ icon: 'calendar', title: `Trailer ${x.trailer} hasn't moved in ${x.days}${x.atLeast ? '+' : ''} days`, text: `${x.where} · since ${etTime(x.parkedSince)}${x.onLoad ? ' · still on a load' : ''}${x.source ? ` · ${x.source}` : ''}` }));
  const all = [...moving, ...parked];
  const subject = [movingNoLoad.length && `${movingNoLoad.length} trailer${movingNoLoad.length === 1 ? '' : 's'} moving without a load`, longParked.length && `${longParked.length} trailer${longParked.length === 1 ? '' : 's'} parked 30+ days`].filter(Boolean).join(' · ');
  const rest = all.slice(6).map((u) => `${u.title} — ${u.text}`);
  return staffEmail({
    subject: `Trailer watch: ${subject}`, category: 'Trailer watch', headline: subject, greeting: 'Hi Nadim,',
    body: `Here's what the trailer GPS (Thermo King and Samsara) shows right now.\n\n{{updates}}${rest.length ? `\n\nAlso:\n${rest.join('\n')}` : ''}`,
    updates: all.slice(0, 6), closing: 'Jarvis',
  });
}

export function initTrailerWatch({ db, sendMail = null, to = () => [], now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  async function check(units, items, points) {
    if (!enabled) return null;
    const prev = (await db.get(STATE, {})) || {};
    const first = !prev.last;   // first check: learn where everything is; no "moving" email for trailers we never saw parked
    const r = checkTrailers(units, items, points, prev, now());
    if (first) { for (const x of r.movingNoLoad) delete r.next.moving[x.trailer]; r.movingNoLoad = []; }   // nothing marked as said
    await db.set(STATE, r.next);
    if (!r.longParked.length && !r.movingNoLoad.length) return r;
    const rcpt = await to();
    if (sendMail && rcpt.length) {
      const m = trailerWatchEmail(r);
      await sendMail({ to: rcpt, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments }).catch((e) => console.warn('[trailer-watch] email:', e.message));
    }
    console.log(`[trailer-watch] ${r.movingNoLoad.length} moving without a load, ${r.longParked.length} parked 30+ days`);
    return r;
  }
  return { check };
}

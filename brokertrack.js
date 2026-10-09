// ---------------------------------------------------------------
// Live tracking link for the broker / customer on the rate confirmation.
//   mytagalong.app/s/<token> → where the truck is now (map), moving or stopped, when the
//   GPS was read, the delivery city, ETA and appointment. Nothing else: no driver name /
//   phone / hours, no other customers' stops, no internal notes.
// The link stops working for good once the load is delivered (or leaves the board).
// ---------------------------------------------------------------
import { randomBytes } from 'crypto';
import { loadSnapshot } from './updateemail.js';

const SITE = 'florida-beauty';
const DAY = 86400000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const DONE = /^(delvd|deliv|del$|cmplt|complete)/i;
const DEAD = /^(canc|void)/i;

// Is the load finished (delivered / cancelled)? Pure.
export function isFinished(item) {
  if (!item) return true;
  const st = String(tripOf(item).status || '');
  if (DONE.test(st) || DEAD.test(st)) return true;
  const bills = (item.bills || tripOf(item).bills || []);
  return Array.isArray(bills) && bills.length > 0 && bills.every((b) => /deliv|cmplt|complete/i.test(String(b.status || '')));
}

// What the public page shows. Customer-safe on purpose. Pure.
export function publicView(item, { now = Date.now(), eta = null } = {}) {
  const live = (item && item._samsara) || {};
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  const s = loadSnapshot(item, { eta, now });
  const fresh = live.lat != null && live.gpsAt && now - Date.parse(live.gpsAt) < 3 * 3600000;
  return {
    active: true,
    trip: tripNo(item), loadNumber: rc.loadNumber || null,
    status: s.status === 'Being verified' ? 'In transit' : s.status,
    position: fresh ? { lat: Math.round(live.lat * 1e4) / 1e4, lng: Math.round(live.lng * 1e4) / 1e4, place: s.location || null, at: live.gpsAt, moving: s.moving, mph: s.mph } : null,
    destination: s.stopCity || null,
    etaMs: s.verify ? null : s.etaMs, etaNote: s.verify ? 'ETA being confirmed by dispatch' : null,
    apptMs: s.apptMs, miles: s.verify ? null : s.miles,
    updatedAt: new Date(now).toISOString(),
  };
}

export function initBrokerTrack(app, { db, getBoard, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = `taBrokerTrack:${SITE}`;           // { byToken: { tok: { trip, at, endedAt } }, byTrip: { trip: tok } }
  const base = String(env.APP_URL || 'https://mytagalong.app').replace(/\/+$/, '');

  // The link for a load (one per load; a new one only if the old one ended).
  async function linkFor(site, trip) {
    if (!enabled || !trip) return null;
    let tok = null;
    await db.update(key, (cur) => {
      const a = { byToken: {}, byTrip: {}, ...(cur || {}) };
      const old = a.byTrip[trip] && a.byToken[a.byTrip[trip]];
      if (old && !old.endedAt) { tok = a.byTrip[trip]; return a; }
      tok = randomBytes(12).toString('base64url');
      a.byToken = { ...a.byToken, [tok]: { trip: String(trip), site, at: new Date(now()).toISOString() } };
      a.byTrip = { ...a.byTrip, [trip]: tok };
      // keep the store small: drop links that ended more than 30 days ago
      for (const [k, v] of Object.entries(a.byToken)) if (v.endedAt && now() - Date.parse(v.endedAt) > 30 * DAY) delete a.byToken[k];
      return a;
    }, { byToken: {}, byTrip: {} });
    return `${base}/s/${tok}`;
  }

  async function end(tok, why) { await db.update(key, (cur) => { const a = { byToken: {}, byTrip: {}, ...(cur || {}) }; if (a.byToken[tok] && !a.byToken[tok].endedAt) a.byToken = { ...a.byToken, [tok]: { ...a.byToken[tok], endedAt: new Date(now()).toISOString(), why } }; return a; }, { byToken: {}, byTrip: {} }); }

  // Public — no sign-in. Only the token opens it.
  app.get('/track/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    const tok = String(req.params.token || '');
    const rec = (((await db.get(key, {})) || {}).byToken || {})[tok];
    if (!rec) return res.status(404).json({ active: false, error: 'This tracking link is not valid.' });
    if (rec.endedAt) return res.json({ active: false, ended: rec.why || 'delivered', trip: rec.trip });
    const item = ((((await getBoard(rec.site || SITE)) || {}).trips) || []).find((x) => tripNo(x) === rec.trip);
    if (!item || isFinished(item)) { await end(tok, 'delivered'); return res.json({ active: false, ended: 'delivered', trip: rec.trip }); }
    if (now() - Date.parse(rec.at) > 21 * DAY) { await end(tok, 'expired'); return res.json({ active: false, ended: 'expired', trip: rec.trip }); }
    const etas = ((await db.get(`taWatch:${rec.site || SITE}`, {})) || {}).etas || {};
    res.json(publicView(item, { now: now(), eta: etas[rec.trip] || null }));
  });

  return { linkFor };
}

// ---------------------------------------------------------------
// Driver tracking link for outside carriers (OC).
//
// An OC truck is not in Samsara or Traccar, so the only GPS we can get is the
// driver's phone. The dispatcher creates a private link for ONE load; the driver
// opens it in the TagAlong app (or the browser until the app is installed) and
// shares location until the load is delivered. Positions feed the same board
// (map, ETA, Watchtower) as a company truck, with source "driver app".
//
//   Dispatcher (signed in):
//   POST /truckmate/oc/:trip/link          → create a new link (replaces the old one)
//   POST /truckmate/oc/:trip/link/send     → text it from RingCentral (dispatcher click only)
//   POST /truckmate/oc/:trip/link/sent     → record that it was copied / sent another way
//   POST /truckmate/oc/:trip/link/revoke   → turn the link off
//
//   Driver (the link token is the only key — no account, no password):
//   GET  /driver/link/:token               → what load this is, is it still active
//   POST /driver/code                      → 6-digit load code → link token
//   POST /driver/link/:token/open          → app/page opened
//   POST /driver/link/:token/ping          → one or more GPS fixes
//   POST /driver/link/:token/checkin       → "Check in" button (note + position)
//   POST /driver/link/:token/stop          → driver turned sharing off
//
// A link only ever exposes its own load, stops working when the load is
// delivered / leaves the board, when revoked, or after LINK_DAYS. Nothing here
// texts anyone on its own.
// ---------------------------------------------------------------

import crypto from 'crypto';

const LINK_DAYS = 5;
const MIN_STORE_GAP_MS = 25 * 1000;   // keep at most one stored point per ~25s
const MAX_POINTS = 2000;
const FRESH_MIN = 20;                 // a fix older than this is not "live"
const MIN = 60000;

const toE164 = (p) => {
  const d = String(p || '').replace(/\D+/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d.length > 6 ? `+${d}` : null;
};
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Status a dispatcher sees, from the link record alone. Pure (tested).
export function linkStatus(link, now = Date.now()) {
  if (!link) return 'none';
  if (link.revokedAt) return 'revoked';
  if (link.completedAt) return 'completed';
  if (link.expiresAt && Date.parse(link.expiresAt) < now) return 'expired';
  const last = link.lastPingAt ? Date.parse(link.lastPingAt) : null;
  if (link.sharing && last && now - last < FRESH_MIN * MIN) return 'sharing';
  if (link.stoppedAt && (!last || Date.parse(link.stoppedAt) >= last)) return 'stopped';
  if (last) return 'quiet';
  if (link.openedAt) return 'opened';
  if (link.sentAt) return 'sent';
  return 'created';
}

// Clean a batch of fixes from the app/browser. Rejects junk instead of storing it.
export function cleanFixes(list, now = Date.now()) {
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((p) => {
    if (!p) return null;
    const lat = num(p.lat != null ? p.lat : p.latitude);
    const lng = num(p.lng != null ? p.lng : p.longitude);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    let at = num(p.time != null ? p.time : p.at);
    if (at == null && p.at) at = Date.parse(p.at);
    if (at == null || Number.isNaN(at) || at > now + 2 * MIN || at < now - 24 * 60 * MIN) at = now;
    const mps = num(p.speed);
    const course = num(p.bearing != null ? p.bearing : p.heading);
    return {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      at: new Date(at).toISOString(),
      speedMph: mps != null && mps >= 0 ? Math.round(mps * 2.23694) : null,
      course: course != null && course >= 0 ? Math.round(course) % 360 : null,
      accuracyM: num(p.accuracy) != null ? Math.round(num(p.accuracy)) : null,
    };
  }).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
}

export function initDriverLinks(app, { requireAuth, db, carriers = null, ringcentral = null, getBoard = null, env = process.env }) {
  const enabled = !!(db && db.enabled);
  const base = String(env.DRIVER_LINK_BASE || 'https://mytagalong.app').replace(/\/+$/, '');
  const company = env.DRIVER_LINK_COMPANY || 'Florida Beauty Flora';
  const linkKey = (tok) => `taDriverLink:${tok}`;
  const codeKey = (code) => `taDriverCode:${code}`;
  const posKey = (tok) => `taDriverPos:${tok}`;
  const siteKey = (site) => `taDriverLinks:${site}`;
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const urlOf = (tok) => `${base}/t/${tok}`;
  const messageFor = (link) => `${company} dispatch: please share your location for load ${link.trip} until delivery. Open in the TagAlong app: ${urlOf(link.token)} (load code ${link.code}). You can stop sharing any time.`;

  // Latest board snapshot per site, refreshed by the overlay (every board build).
  const boardTrips = new Map();

  async function newCode() {
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!(await db.get(codeKey(code), null))) return code;
    }
    throw new Error('Could not create a load code.');
  }

  // What the dispatcher card shows. Never includes the position history.
  const summary = (link, now = Date.now()) => (link ? {
    token: link.token, url: urlOf(link.token), code: link.code, message: messageFor(link),
    status: linkStatus(link, now),
    createdAt: link.createdAt, createdBy: link.createdBy, expiresAt: link.expiresAt,
    sentAt: link.sentAt || null, sentVia: link.sentVia || null, sentTo: link.sentTo || null,
    openedAt: link.openedAt || null, openedVia: link.openedVia || null,
    sharing: !!link.sharing, lastPingAt: link.lastPingAt || null, lastPing: link.lastPing || null,
    stoppedAt: link.stoppedAt || null, revokedAt: link.revokedAt || null, completedAt: link.completedAt || null,
    points: link.points || 0,
  } : null);

  const tripOf = (item) => (item && item.trip) || item || {};
  const deliveredAll = (item) => {
    const raw = (item && (item.freightBills || item.orders)) || tripOf(item).freightBills || [];
    const bills = Array.isArray(raw) ? raw : [];
    return bills.length > 0 && bills.every((b) => !!b.actualDelivery);
  };

  async function activeLink(token) {
    const link = await db.get(linkKey(token), null);
    if (!link) return { link: null, status: 'none' };
    return { link, status: linkStatus(link) };
  }
  const isLive = (s) => !['revoked', 'completed', 'expired', 'none'].includes(s);

  // ---- board overlay: _driverLink on OC trips + live position as _samsara ----
  async function overlay(site, trips) {
    if (!enabled) return;
    boardTrips.set(site, trips);
    const idx = await db.get(siteKey(site), { byTrip: {} });
    const byTrip = idx.byTrip || {};
    const onBoard = new Set();
    const now = Date.now();
    for (const item of trips) {
      const trip = String(tripOf(item).tripNumber || '');
      onBoard.add(trip);
      const tok = byTrip[trip];
      if (!tok) continue;
      let link = await db.get(linkKey(tok), null);
      if (!link) continue;
      // Load delivered → the link ends by itself.
      if (!link.completedAt && !link.revokedAt && deliveredAll(item)) {
        link = await db.update(linkKey(tok), (cur) => ({ ...cur, completedAt: new Date(now).toISOString(), sharing: false }), link);
      }
      item._driverLink = summary(link, now);
      const p = link.lastPing;
      const fresh = p && now - Date.parse(p.at) < FRESH_MIN * MIN;
      const s = item._samsara || null;
      const ownGps = s && s.lat != null && s.gpsAt && Date.parse(s.gpsAt) > (p ? Date.parse(p.at) : 0);
      if (p && !ownGps && (fresh || !s || s.lat == null)) {
        item._samsara = { ...(s || {}), source: 'driver app', lat: p.lat, lng: p.lng, speedMph: p.speedMph, course: p.course, gpsAt: p.at, accuracyM: p.accuracyM, location: null };
      }
    }
    // Loads that left the board (delivered / removed) end their links.
    const gone = Object.entries(byTrip).filter(([trip]) => !onBoard.has(trip));
    for (const [, tok] of gone) {
      const link = await db.get(linkKey(tok), null);
      if (link && !link.completedAt && !link.revokedAt) {
        await db.update(linkKey(tok), (cur) => ({ ...cur, completedAt: new Date(now).toISOString(), sharing: false }), link);
      }
    }
    if (gone.length && trips.length) {
      await db.update(siteKey(site), (cur) => {
        const b = { ...((cur && cur.byTrip) || {}) };
        gone.forEach(([trip]) => { delete b[trip]; });
        return { ...(cur || {}), byTrip: b };
      }, { byTrip: {} });
    }
  }

  // Breadcrumb for the dispatcher map, by the trip's unit (e.g. OC1016) — used
  // by /truckmate/route/:unit before Traccar / Samsara.
  async function routeFor(site, unit, fromMs) {
    if (!enabled) return null;
    const u = String(unit || '').toUpperCase().replace(/[\s-]/g, '');
    const trips = boardTrips.get(site) || [];
    const item = trips.find((it) => String(tripOf(it).powerUnit || '').toUpperCase().replace(/[\s-]/g, '') === u);
    if (!item || !item._driverLink) return null;
    const pts = (await db.get(posKey(item._driverLink.token), [])) || [];
    const out = pts.filter((p) => Date.parse(p.at) >= fromMs);
    return out.length ? out : null;
  }

  // ---- dispatcher endpoints ----
  const findItem = async (site, trip) => {
    if (!boardTrips.has(site) && getBoard) { try { await getBoard(site); } catch { /* board unavailable */ } }
    return (boardTrips.get(site) || []).find((it) => String(tripOf(it).tripNumber || '') === trip) || null;
  };

  app.post('/truckmate/oc/:trip/link', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const site = siteOf(req);
    const trip = String(req.params.trip || '').trim();
    if (!trip) return res.status(400).json({ error: 'Trip number missing.' });
    try {
      const item = await findItem(site, trip);
      const oc = item && item._oc;
      const now = new Date();
      const idx = await db.get(siteKey(site), { byTrip: {} });
      const old = (idx.byTrip || {})[trip];
      if (old) await db.update(linkKey(old), (cur) => (cur ? { ...cur, revokedAt: cur.revokedAt || now.toISOString(), revokedBy: who(req), sharing: false } : cur), null);
      const token = crypto.randomBytes(18).toString('base64url');
      const code = await newCode();
      const link = {
        token, code, site, trip,
        unit: item ? String(tripOf(item).powerUnit || '') : null,
        carrierName: (oc && oc.carrier && oc.carrier.name) || null,
        driverName: (oc && oc.driverName) || null,
        driverPhone: (oc && oc.driverPhone) || null,
        origin: item ? tripOf(item).origZoneDesc || null : null,
        destination: item ? tripOf(item).destZoneDesc || null : null,
        createdAt: now.toISOString(), createdBy: who(req),
        expiresAt: new Date(now.getTime() + LINK_DAYS * 24 * 60 * MIN).toISOString(),
        sharing: false, points: 0,
      };
      await db.set(linkKey(token), link);
      await db.set(codeKey(code), { token, expiresAt: link.expiresAt });
      await db.update(siteKey(site), (cur) => ({ ...(cur || {}), byTrip: { ...((cur && cur.byTrip) || {}), [trip]: token } }), { byTrip: {} });
      res.json(summary(link));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function markSent(site, trip, patch) {
    const idx = await db.get(siteKey(site), { byTrip: {} });
    const tok = (idx.byTrip || {})[trip];
    if (!tok) return null;
    return db.update(linkKey(tok), (cur) => (cur ? { ...cur, ...patch } : cur), null);
  }

  // Text the link from the company's RingCentral number. Only on a dispatcher click.
  app.post('/truckmate/oc/:trip/link/send', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    if (!ringcentral) return res.status(503).json({ error: 'RingCentral is not connected.' });
    const site = siteOf(req);
    const trip = String(req.params.trip || '').trim();
    try {
      const idx = await db.get(siteKey(site), { byTrip: {} });
      const tok = (idx.byTrip || {})[trip];
      const link = tok ? await db.get(linkKey(tok), null) : null;
      if (!link || !isLive(linkStatus(link))) return res.status(404).json({ error: 'Create a tracking link first.' });
      const item = await findItem(site, trip);
      const to = toE164((req.body && req.body.to) || (item && item._oc && item._oc.driverPhone) || link.driverPhone);
      if (!to) return res.status(400).json({ error: 'Add the driver’s phone number first.' });
      const owner = String(req.user.company || req.user.id);
      await ringcentral.sendSms(owner, { to, text: messageFor(link) });
      const updated = await markSent(site, trip, { sentAt: new Date().toISOString(), sentVia: 'RingCentral text', sentTo: to, sentBy: who(req) });
      res.json(summary(updated));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.post('/truckmate/oc/:trip/link/sent', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      const via = String((req.body && req.body.via) || 'copied').slice(0, 40);
      const updated = await markSent(siteOf(req), String(req.params.trip), { sentAt: new Date().toISOString(), sentVia: via, sentBy: who(req) });
      if (!updated) return res.status(404).json({ error: 'No tracking link for this trip.' });
      res.json(summary(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/truckmate/oc/:trip/link/revoke', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      const updated = await markSent(siteOf(req), String(req.params.trip), { revokedAt: new Date().toISOString(), revokedBy: who(req), sharing: false });
      if (!updated) return res.status(404).json({ error: 'No tracking link for this trip.' });
      res.json(summary(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- driver endpoints (token only) ----
  const publicView = (link, status) => ({
    active: isLive(status), status, company, trip: link.trip,
    carrierName: link.carrierName || null, origin: link.origin || null, destination: link.destination || null,
    sharing: !!link.sharing && status === 'sharing', lastPingAt: link.lastPingAt || null,
    expiresAt: link.expiresAt, pingEverySec: 60,
  });

  app.get('/driver/link/:token', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    try {
      const { link, status } = await activeLink(String(req.params.token));
      if (!link) return res.status(404).json({ error: 'This tracking link is not valid.' });
      res.json(publicView(link, status));
    } catch (e) { res.status(500).json({ error: 'Could not load this link.' }); }
  });

  // Small in-memory throttle so the 6-digit code can't be guessed.
  const tries = new Map();
  app.post('/driver/code', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const t = tries.get(ip) || { n: 0, since: Date.now() };
    if (Date.now() - t.since > 15 * MIN) { t.n = 0; t.since = Date.now(); }
    t.n += 1; tries.set(ip, t);
    if (t.n > 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes or open the link from the text.' });
    const code = String((req.body && req.body.code) || '').replace(/\D+/g, '');
    if (code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit load code.' });
    try {
      const hit = await db.get(codeKey(code), null);
      if (!hit || Date.parse(hit.expiresAt) < Date.now()) return res.status(404).json({ error: 'That code is not valid or has expired.' });
      res.json({ token: hit.token });
    } catch (e) { res.status(500).json({ error: 'Could not check the code.' }); }
  });

  app.post('/driver/link/:token/open', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    try {
      const tok = String(req.params.token);
      const { link, status } = await activeLink(tok);
      if (!link) return res.status(404).json({ error: 'This tracking link is not valid.' });
      if (!isLive(status)) return res.json(publicView(link, status));
      const via = (req.body && req.body.via) === 'app' ? 'app' : 'browser';
      const updated = await db.update(linkKey(tok), (cur) => ({ ...cur, openedAt: cur.openedAt || new Date().toISOString(), openedVia: via === 'app' || cur.openedVia !== 'app' ? via : cur.openedVia, lastOpenAt: new Date().toISOString() }), link);
      res.json(publicView(updated, linkStatus(updated)));
    } catch (e) { res.status(500).json({ error: 'Could not open this link.' }); }
  });

  app.post('/driver/link/:token/ping', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    try {
      const tok = String(req.params.token);
      const { link, status } = await activeLink(tok);
      if (!link) return res.status(404).json({ active: false, error: 'This tracking link is not valid.' });
      if (!isLive(status)) return res.status(410).json({ active: false, status });
      const b = req.body || {};
      const fixes = cleanFixes(b.points || b.point || b);
      if (!fixes.length) return res.status(400).json({ error: 'No usable location.' });
      const via = b.via === 'app' ? 'app' : 'browser';
      let added = 0;
      await db.update(posKey(tok), (cur) => {
        const pts = Array.isArray(cur) ? [...cur] : [];
        for (const f of fixes) {
          const last = pts[pts.length - 1];
          if (last && Date.parse(f.at) - Date.parse(last.at) < MIN_STORE_GAP_MS) continue;
          pts.push(f); added += 1;
        }
        return pts.slice(-MAX_POINTS);
      }, []);
      const last = fixes[fixes.length - 1];
      const updated = await db.update(linkKey(tok), (cur) => ({
        ...cur, sharing: true, stoppedAt: null, lastPingVia: via,
        lastPingAt: !cur.lastPingAt || last.at > cur.lastPingAt ? last.at : cur.lastPingAt,
        lastPing: !cur.lastPing || last.at >= cur.lastPing.at ? last : cur.lastPing,
        firstPingAt: cur.firstPingAt || last.at,
        openedAt: cur.openedAt || new Date().toISOString(), openedVia: cur.openedVia || via,
        points: (cur.points || 0) + added,
      }), link);
      res.json({ ok: true, active: true, status: linkStatus(updated), nextSec: 60 });
    } catch (e) { res.status(500).json({ error: 'Could not save the location.' }); }
  });

  app.post('/driver/link/:token/checkin', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    try {
      const tok = String(req.params.token);
      const { link, status } = await activeLink(tok);
      if (!link) return res.status(404).json({ error: 'This tracking link is not valid.' });
      if (!isLive(status)) return res.status(410).json({ active: false, status });
      const b = req.body || {};
      const fix = cleanFixes(b.point || [])[0] || link.lastPing || null;
      const note = String(b.note || '').trim().slice(0, 300);
      const entry = {
        at: new Date().toISOString(), source: 'driver app',
        location: fix ? `${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}` : null,
        text: note || 'Driver checked in from the TagAlong link',
        issue: !!b.issue, by: link.driverName || 'OC driver',
      };
      if (carriers && carriers.addCheckins) await carriers.addCheckins(link.site, link.trip, [entry]);
      res.json({ ok: true, entry });
    } catch (e) { res.status(500).json({ error: 'Could not send the check-in.' }); }
  });

  app.post('/driver/link/:token/stop', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Tracking is not available right now.' });
    try {
      const tok = String(req.params.token);
      const { link } = await activeLink(tok);
      if (!link) return res.status(404).json({ error: 'This tracking link is not valid.' });
      const updated = await db.update(linkKey(tok), (cur) => ({ ...cur, sharing: false, stoppedAt: new Date().toISOString() }), link);
      res.json(publicView(updated, linkStatus(updated)));
    } catch (e) { res.status(500).json({ error: 'Could not stop sharing.' }); }
  });

  console.log(`[driverlink] OC driver tracking links ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { overlay, routeFor };
}

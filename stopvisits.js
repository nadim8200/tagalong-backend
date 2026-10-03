// ---------------------------------------------------------------
// Stop visits — server-side geofence tracking for each trip stop.
//
// A visit is tracked ONLY when the stop matches a validated facility geofence
// (a Samsara address with a circle/polygon boundary). ZIP or city-centre
// coordinates are never used to mark a stop visited.
//
// Deterministic state machine per (trip, stop):
//   upcoming → arriving (first fresh sample inside)
//            → at_stop  (≥ N samples inside spanning ≥ arriveConfirmSec)
//            → departing (fresh sample clearly OUTSIDE boundary + exit buffer)
//            → completed (≥ N outside samples spanning ≥ departConfirmSec AND
//                          dwell ≥ minDwellMin)   — "visit complete"
//   A short stay (dwell < minDwellMin) is a drive-by → back to upcoming.
//   Samples just outside the boundary but inside the buffer are jitter: ignored.
//   Duplicate / out-of-order / stale / inaccurate samples are ignored.
//   A different vehicle mid-visit → needs_review.
//
// A completed VISIT is NOT proof of delivery: it never touches TruckMate
// delivery status, bills, or POD. Evidence (entered/exited/dwell/samples/rule
// version) is stored with every visit.
// ---------------------------------------------------------------

export const RULES = {
  version: 'geofence-v1',
  maxSampleAgeSec: 300,       // older than 5 min when processed → ignored
  maxAccuracyM: 100,          // when the source reports accuracy
  arriveConfirmSamples: 2,
  arriveConfirmSec: 60,
  departConfirmSamples: 2,
  departConfirmSec: 60,
  exitBufferM: 150,           // must be this far OUTSIDE the boundary to count as left
  minDwellMin: 8,             // shorter stays are drive-bys
  maxCircleRadiusM: 2000,     // bigger "geofences" are too coarse to trust
};

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
export function metersBetween(a, b) {
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Signed distance to the boundary in metres: ≤ 0 inside, > 0 outside.
export function distanceToGeofence(p, gf) {
  if (gf.circle) return metersBetween(p, gf.circle) - gf.circle.radiusM;
  const v = gf.polygon || [];
  if (v.length < 3) return Infinity;
  // local planar projection around the point (fine at facility scale)
  const kx = 111320 * Math.cos(toRad(p.lat)); const ky = 110540;
  const pts = v.map((q) => ({ x: (q.lng - p.lng) * kx, y: (q.lat - p.lat) * ky }));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]; const b = pts[j];
    if ((a.y > 0) !== (b.y > 0) && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]; const b = pts[i];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((-a.x) * dx + (-a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return inside ? -best : best;
}

export function newVisit({ trip, stopKey, unit, geofence }) {
  return {
    trip: String(trip), stopKey, unit: unit ? String(unit) : null,
    geofence: { id: geofence.id, name: geofence.name, source: geofence.source },
    state: 'upcoming', enteredAt: null, exitedAt: null, dwellMin: null,
    insideSince: null, insideCount: 0, outsideSince: null, outsideCount: 0,
    lastSampleAt: null, samples: 0, ignored: 0,
    rule: RULES.version, evidence: [],
  };
}

const log = (v, t, event, detail) => {
  v.evidence.push({ at: new Date(t).toISOString(), event, detail });
  if (v.evidence.length > 30) v.evidence = v.evidence.slice(-30);
};

// Advance one visit with one position sample. Pure: returns a new object.
// sample: { t: ms, lat, lng, unit, accuracyM? }
export function stepVisit(prev, sample, geofence, now = Date.now(), rules = RULES) {
  const v = JSON.parse(JSON.stringify(prev));
  if (v.state === 'completed' || v.state === 'needs_review') return v;
  if (!sample || sample.lat == null || sample.lng == null || !sample.t) return v;
  if (v.lastSampleAt && sample.t <= v.lastSampleAt) { v.ignored += 1; return v; }       // duplicate / out of order
  if (now - sample.t > rules.maxSampleAgeSec * 1000) { v.ignored += 1; return v; }      // stale
  if (sample.accuracyM != null && sample.accuracyM > rules.maxAccuracyM) { v.ignored += 1; return v; }
  v.lastSampleAt = sample.t; v.samples += 1;

  if (v.unit && sample.unit && String(sample.unit) !== v.unit && ['arriving', 'at_stop', 'departing'].includes(v.state)) {
    v.state = 'needs_review';
    log(v, sample.t, 'reassigned', `Position now from unit ${sample.unit}, visit started with unit ${v.unit}`);
    return v;
  }
  if (!v.unit && sample.unit) v.unit = String(sample.unit);

  const d = distanceToGeofence(sample, geofence);
  const inside = d <= 0;
  const clearlyOut = d > rules.exitBufferM;

  switch (v.state) {
    case 'upcoming':
      if (inside) { v.state = 'arriving'; v.insideSince = sample.t; v.insideCount = 1; }
      break;
    case 'arriving':
      if (inside) {
        v.insideCount += 1;
        if (v.insideCount >= rules.arriveConfirmSamples && sample.t - v.insideSince >= rules.arriveConfirmSec * 1000) {
          v.state = 'at_stop'; v.enteredAt = v.insideSince;
          log(v, v.insideSince, 'arrived', `Inside ${v.geofence.name} (${v.insideCount} samples)`);
        }
      } else if (clearlyOut) {
        v.state = 'upcoming'; v.insideSince = null; v.insideCount = 0;
        log(v, sample.t, 'pass-through', 'Entered and left before arrival was confirmed');
      }
      break;
    case 'at_stop':
      if (clearlyOut) { v.state = 'departing'; v.outsideSince = sample.t; v.outsideCount = 1; }
      break;
    case 'departing':
      if (inside) {
        v.state = 'at_stop'; v.outsideSince = null; v.outsideCount = 0;
        log(v, sample.t, 'returned', 'Back inside the boundary — still at stop');
      } else if (clearlyOut) {
        v.outsideCount += 1;
        if (v.outsideCount >= rules.departConfirmSamples && sample.t - v.outsideSince >= rules.departConfirmSec * 1000) {
          const dwellMin = Math.round((v.outsideSince - v.enteredAt) / 60000);
          if (dwellMin >= rules.minDwellMin) {
            v.state = 'completed'; v.exitedAt = v.outsideSince; v.dwellMin = dwellMin;
            log(v, v.outsideSince, 'departed', `Visit complete · dwell ${dwellMin} min`);
          } else {
            log(v, v.outsideSince, 'drive-by', `Left after ${dwellMin} min (< ${rules.minDwellMin} min) — not counted`);
            v.state = 'upcoming'; v.enteredAt = null; v.insideSince = null; v.insideCount = 0; v.outsideSince = null; v.outsideCount = 0;
          }
        }
      }
      break;
    default: break;
  }
  return v;
}

// ---- matching trip stops to validated facility geofences ----
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\b(INC|LLC|CO|CORP|THE|DBA|WHOLESALE|WHSL)\b/g, ' ').replace(/\s+/g, ' ').trim();

export function geofenceFromAddress(a, rules = RULES) {
  const g = a && a.geofence;
  if (!g) return null;
  if (g.circle && g.circle.latitude != null && g.circle.radiusMeters > 0 && g.circle.radiusMeters <= rules.maxCircleRadiusM) {
    return { id: String(a.id), name: a.name, source: 'Samsara address', circle: { lat: g.circle.latitude, lng: g.circle.longitude, radiusM: g.circle.radiusMeters } };
  }
  const verts = g.polygon && g.polygon.vertices;
  if (Array.isArray(verts) && verts.length >= 3) {
    return { id: String(a.id), name: a.name, source: 'Samsara address', polygon: verts.map((x) => ({ lat: x.latitude, lng: x.longitude })) };
  }
  return null;
}

// A stop matches an address only when the customer name clearly matches AND
// the address is in the same city + state. Ambiguous (several) → no match.
export function matchGeofence(stop, addresses) {
  const who = norm(stop.customer);
  if (!who || who.length < 3) return null;
  const city = norm(stop.city); const st = norm(stop.state);
  const hits = (addresses || []).filter((a) => {
    const name = norm(a.name);
    if (!name || !(name.includes(who) || who.includes(name))) return false;
    const fa = norm(a.formattedAddress);
    return city && fa.includes(city) && (!st || fa.includes(` ${st} `) || fa.endsWith(` ${st}`) || fa.includes(` ${st}`));
  }).map((a) => geofenceFromAddress(a)).filter(Boolean);
  return hits.length === 1 ? hits[0] : null;
}

export function initStopVisits({ db, env = process.env, listAddresses, tokenFrom }) {
  const key = (site) => `taStopVisits:${site}`;
  let addrCache = { at: 0, list: [] };
  async function addresses() {
    if (Date.now() - addrCache.at < 60 * 60 * 1000) return addrCache.list;
    const token = tokenFrom(env);
    if (!token) return [];
    try { addrCache = { at: Date.now(), list: await listAddresses(token) }; } catch (e) { console.warn('[stopvisits] addresses:', e.message); }
    return addrCache.list;
  }

  // Called once per Watchtower cycle with the freshly built board.
  async function process(site, board, now = Date.now()) {
    if (!db || !db.enabled) return;
    const list = await addresses();
    if (!list.length) return;
    await db.update(key(site), (prev) => {
      const all = { ...(prev || {}) };
      for (const item of board.trips || []) {
        const t = (item && item.trip) || item || {};
        const trip = String(t.tripNumber || '');
        const sheet = item._manifest;
        if (!trip || !sheet || !Array.isArray(sheet.stops)) continue;
        const live = item._samsara || {};
        const sample = live.lat != null && live.gpsAt ? { t: Date.parse(live.gpsAt), lat: live.lat, lng: live.lng, unit: t.powerUnit } : null;
        const visits = { ...(all[trip] || {}) };
        for (const stop of sheet.stops) {
          if (!stop.key || /^LOAD$/i.test(stop.action || '')) continue;
          const gf = matchGeofence(stop, list);
          if (!gf) continue;
          let v = visits[stop.key] || newVisit({ trip, stopKey: stop.key, unit: t.powerUnit, geofence: gf });
          if (sample) v = stepVisit(v, sample, gf, now);
          visits[stop.key] = v;
        }
        if (Object.keys(visits).length) all[trip] = visits;
      }
      // forget trips that left the board more than 3 days ago
      const active = new Set((board.trips || []).map((i) => String(((i && i.trip) || i || {}).tripNumber || '')));
      for (const k of Object.keys(all)) {
        const vs = Object.values(all[k] || {});
        const last = Math.max(0, ...vs.map((v) => v.lastSampleAt || 0));
        if (!active.has(k) && now - last > 3 * 24 * 3600 * 1000) delete all[k];
      }
      return all;
    }, {});
  }
  return { process, key };
}

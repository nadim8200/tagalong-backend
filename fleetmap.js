// ---------------------------------------------------------------
// Fleet map: every truck and trailer with a position, in one list.
//
// Trucks: every Samsara vehicle with GPS, overridden by a fresh FMC00A (Traccar)
// fix for the same unit, plus outside-carrier loads tracked by the driver's
// phone. Traccar devices that are NOT fleet trucks (customers' TagAlong cars)
// are never included.
// Trailers: own GPS (Samsara asset gateway) when it is fresher than 2 h, else
// the truck pulling it on an active trip ("with truck").
// Pure — the route in truckmate.js feeds it.
// ---------------------------------------------------------------

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^0+(?=\d)/, '');
const MIN = 60000;
const fresh = (at, now, mins) => !!at && now - Date.parse(at) < mins * MIN;

export function buildFleet({ trips = [], idx = null, traccar = null, trailerLoc = null, now = Date.now() }) {
  // what each unit / trailer is doing on the board
  const tripByUnit = new Map(); const tripByTrailer = new Map();
  for (const item of trips) {
    const t = (item && item.trip) || item || {};
    const info = {
      trip: String(t.tripNumber || ''), status: t.statusDesc || t.status || null,
      origin: t.origZoneDesc || null, destination: t.destZoneDesc || null,
      driver: (item._samsara && item._samsara.driver1) || t.driver || null,
      driver2: (item._samsara && item._samsara.driver2) || t.driver2 || null,
      oc: item._oc ? ((item._oc.carrier && item._oc.carrier.name) || 'Outside carrier') : null,
      unit: t.powerUnit ? String(t.powerUnit) : null, trailer: t.trailer ? String(t.trailer) : null,
      tempF: item._samsara && item._samsara.tempF != null ? item._samsara.tempF : null,
    };
    if (t.powerUnit && !tripByUnit.has(norm(t.powerUnit))) tripByUnit.set(norm(t.powerUnit), { ...info, live: item._samsara || null });
    for (const tr of [t.trailer, t.trailer2]) if (tr && !tripByTrailer.has(norm(tr))) tripByTrailer.set(norm(tr), info);
  }

  const trucks = new Map();
  const put = (unit, rec) => { trucks.set(norm(unit), { ...(trucks.get(norm(unit)) || {}), ...rec }); };
  // 1) Samsara vehicles
  const seen = new Set();
  for (const st of Object.values((idx && idx.statsByUnit) || {})) {
    if (!st || seen.has(st.id)) continue; seen.add(st.id);
    const g = st.gps || {};
    if (g.latitude == null || g.longitude == null) continue;
    const unit = (st.externalIds && st.externalIds.unitId) || st.name;
    const veh = (idx.vehByUnit || {})[norm(unit)] || {};
    const engine = st.engineState ? st.engineState.value : null;
    put(unit, {
      id: `veh-${st.id}`, unit: String(unit), lat: g.latitude, lng: g.longitude,
      course: g.headingDegrees != null ? Math.round(g.headingDegrees) : null,
      speedMph: g.speedMilesPerHour != null ? Math.round(g.speedMilesPerHour) : null,
      gpsAt: g.time || null, location: (g.reverseGeo && g.reverseGeo.formattedLocation) || null,
      engine, source: 'Samsara',
      assignedDriver: veh.staticAssignedDriver ? veh.staticAssignedDriver.name : null,
    });
  }
  // 2) FMC00A (Traccar) — only for units that are fleet trucks (on the board or in Samsara)
  for (const [u, live] of Object.entries(traccar || {})) {
    if (!live || live.lat == null) continue;
    const known = trucks.has(u) || tripByUnit.has(u);
    if (!known) continue;
    const cur = trucks.get(u);
    if (cur && cur.gpsAt && live.gpsAt && Date.parse(cur.gpsAt) >= Date.parse(live.gpsAt)) continue;
    put(u, { id: (cur && cur.id) || `trc-${u}`, unit: (cur && cur.unit) || (tripByUnit.get(u) || {}).unit || u, lat: live.lat, lng: live.lng, course: live.course, speedMph: live.speedMph, gpsAt: live.gpsAt, location: live.location || (cur && cur.location) || null, engine: live.engine, source: 'FMC00A' });
  }
  // 3) outside carriers tracked by the driver's phone
  for (const [u, info] of tripByUnit) {
    const l = info.live;
    if (!info.oc || !l || l.source !== 'driver app' || l.lat == null) continue;
    put(u, { id: `oc-${info.trip}`, unit: info.unit || `OC ${info.trip}`, lat: l.lat, lng: l.lng, course: l.course, speedMph: l.speedMph, gpsAt: l.gpsAt, location: l.location || null, engine: null, source: 'Driver phone' });
  }

  const truckList = [...trucks.entries()].map(([k, tr]) => {
    const job = tripByUnit.get(k) || null;
    const moving = tr.speedMph != null && tr.speedMph >= 3;
    const stale = !fresh(tr.gpsAt, now, 30);
    const engineOn = tr.engine ? /^(on|idle)$/i.test(String(tr.engine)) : null;
    return {
      ...tr, kind: 'truck',
      state: stale ? 'stale' : moving ? 'moving' : engineOn ? 'idling' : 'parked',
      trip: job ? job.trip : null, tripStatus: job ? job.status : null, destination: job ? job.destination : null, origin: job ? job.origin : null,
      driver: job ? [job.driver, job.driver2].filter(Boolean).join(' & ') || tr.assignedDriver || null : tr.assignedDriver || null,
      trailer: job ? job.trailer : null, oc: job ? job.oc : null, tempF: job ? job.tempF : null,
    };
  });
  const truckByUnit = new Map(truckList.map((t) => [norm(t.unit), t]));

  // trailers: own GPS, else with the truck pulling it
  const trailers = new Map();
  const assets = (idx && idx.trailerAssets) || {};
  const locs = (trailerLoc && trailerLoc.byId) || {};
  for (const [id, name] of Object.entries(assets)) {
    const fix = locs[id];
    const job = tripByTrailer.get(norm(name)) || null;
    const reefer = (idx.reeferByKey || {})[norm(name)] || null;
    trailers.set(norm(name), {
      id: `trl-${id}`, kind: 'trailer', trailer: String(name),
      lat: fix ? fix.lat : null, lng: fix ? fix.lng : null, gpsAt: fix ? fix.at : null, speedMph: fix ? fix.speedMph : null, course: fix ? fix.course : null,
      location: fix ? fix.location : null, source: fix ? 'Samsara' : null,
      trip: job ? job.trip : null, truck: job ? job.unit : null, destination: job ? job.destination : null,
      tempF: reefer && reefer.tempF != null ? reefer.tempF : null, setpointF: reefer && reefer.setpointF != null ? reefer.setpointF : null,
    });
  }
  for (const [k, job] of tripByTrailer) {
    if (!trailers.has(k)) trailers.set(k, { id: `trl-tm-${k}`, kind: 'trailer', trailer: job.trailer || k, lat: null, lng: null, gpsAt: null, source: null, trip: job.trip, truck: job.unit, destination: job.destination, tempF: job.tempF });
  }
  const trailerList = [...trailers.values()].map((tr) => {
    const truck = tr.truck ? truckByUnit.get(norm(tr.truck)) : null;
    const ownFresh = tr.lat != null && fresh(tr.gpsAt, now, 120);
    if (!ownFresh && truck && truck.lat != null) {
      return { ...tr, lat: truck.lat, lng: truck.lng, gpsAt: truck.gpsAt, speedMph: truck.speedMph, location: truck.location, source: `With truck ${truck.unit}`, hitched: true };
    }
    return { ...tr, hitched: !!(truck && tr.lat != null && Math.abs(truck.lat - tr.lat) + Math.abs(truck.lng - tr.lng) < 0.01) };
  }).filter((tr) => tr.lat != null).map((tr) => ({ ...tr, state: !fresh(tr.gpsAt, now, 24 * 60) ? 'stale' : (tr.speedMph != null && tr.speedMph >= 3 ? 'moving' : 'parked') }));

  return {
    trucks: truckList.sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })),
    trailers: trailerList.sort((a, b) => String(a.trailer).localeCompare(String(b.trailer), undefined, { numeric: true })),
    trailerSource: (trailerLoc && trailerLoc.source) || null,
    trailerError: (trailerLoc && trailerLoc.error) || null,
    at: new Date(now).toISOString(),
  };
}

// ---- how long each truck / trailer has sat still, and where dropped trailers are ----
// The store is updated every few minutes (and on every map view). Trailers keep
// their last known spot after they leave a load — Samsara gives us no trailer
// GPS, so a dropped trailer stays where its truck last had it.
const STILL_M = 300;           // moved less than this = still parked
const KEEP_DAYS = 30;          // forget trailers not seen on a load for a month
const distM = (a, b) => {
  const R = 6371000; const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r; const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const nk = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^0+(?=\d)/, '');

export function updateStill(store, fleet, now = Date.now()) {
  const s = { trucks: { ...((store && store.trucks) || {}) }, trailers: { ...((store && store.trailers) || {}) } };
  const step = (prev, x, extra) => {
    const at = x.gpsAt && Date.parse(x.gpsAt) <= now ? x.gpsAt : new Date(now).toISOString();
    const moved = !prev || distM(prev, x) > STILL_M;
    return {
      ...(prev || {}), ...extra,
      lat: moved ? x.lat : prev.lat, lng: moved ? x.lng : prev.lng,
      since: moved ? at : prev.since,
      fromStart: moved ? !prev : !!prev.fromStart,      // still since tracking began (true length unknown)
      seenAt: at, location: x.location || (prev && prev.location) || null,
    };
  };
  for (const t of fleet.trucks || []) if (t.lat != null && t.state !== 'stale') s.trucks[nk(t.unit)] = step(s.trucks[nk(t.unit)], t, { unit: t.unit });
  for (const t of fleet.trailers || []) {
    if (t.lat == null) continue;
    s.trailers[nk(t.trailer)] = step(s.trailers[nk(t.trailer)], t, { trailer: t.trailer, lastTrip: t.trip || (s.trailers[nk(t.trailer)] || {}).lastTrip || null, lastTruck: t.truck || (s.trailers[nk(t.trailer)] || {}).lastTruck || null });
  }
  const cutoff = now - KEEP_DAYS * 24 * 3600000;
  for (const [k, v] of Object.entries(s.trailers)) if (Date.parse(v.seenAt || 0) < cutoff) delete s.trailers[k];
  return s;
}

// Add stillSince / assigned to the live fleet, plus dropped trailers at their last spot.
export function withStill(fleet, store, now = Date.now()) {
  const st = store || { trucks: {}, trailers: {} };
  const trucks = (fleet.trucks || []).map((t) => {
    const p = st.trucks[nk(t.unit)];
    return { ...t, stillSince: p && t.state !== 'moving' ? p.since : null, stillFromStart: !!(p && p.fromStart) };
  });
  const live = new Set();
  const trailers = (fleet.trailers || []).map((t) => {
    live.add(nk(t.trailer));
    const p = st.trailers[nk(t.trailer)];
    return { ...t, assigned: !!t.trip, stillSince: p ? p.since : null, stillFromStart: !!(p && p.fromStart) };
  });
  for (const [k, p] of Object.entries(st.trailers)) {
    if (live.has(k) || p.lat == null) continue;
    trailers.push({
      id: `drop-${k}`, kind: 'trailer', trailer: p.trailer || k, lat: p.lat, lng: p.lng, gpsAt: p.seenAt, location: p.location,
      source: p.lastTruck ? `Last known — dropped by truck ${p.lastTruck}` : 'Last known position', hitched: false,
      trip: null, truck: null, assigned: false, lastTrip: p.lastTrip || null, lastTruck: p.lastTruck || null,
      state: 'parked', stillSince: p.since, stillFromStart: !!p.fromStart,
    });
  }
  return { ...fleet, trucks, trailers: trailers.sort((a, b) => String(a.trailer).localeCompare(String(b.trailer), undefined, { numeric: true })), trackingSince: st.startedAt || null };
}

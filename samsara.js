// ---------------------------------------------------------------
// Samsara API client — used to correlate LIVE telematics (reefer
// temperature, GPS position, driver assignment, diagnostics) against the
// TruckMate trips the connector delivers. TruckMate is already fed by Samsara
// (Samsara flips TruckMate's stop statuses), so the two share unit numbers —
// which is what lets us match a Samsara truck/trailer/driver to a TM trip.
//
// The token is read from the environment (SAMSARA_TOKEN_TM overrides the
// fleet-wide SAMSARA_TOKEN, so the TruckMate site can use Florida Beauty's own
// Samsara org token). We never log or return the token.
// ---------------------------------------------------------------
const API = 'https://api.samsara.com';

export function samsaraTokenFrom(env = process.env) {
  return env.SAMSARA_TOKEN_TM || env.SAMSARA_TOKEN || null;
}

// GET that follows Samsara's cursor pagination and returns the merged `data`
// array. Non-list endpoints (no `data` array) return the raw JSON.
async function sGet(token, path, { paginate = true, maxPages = 25 } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  const out = [];
  let after = '';
  for (let i = 0; i < maxPages; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${after ? `${sep}after=${encodeURIComponent(after)}` : ''}`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Samsara ${r.status} on ${path}: ${body.slice(0, 180)}`);
    }
    const j = await r.json();
    if (!Array.isArray(j.data)) return j;               // single-object endpoint
    out.push(...j.data);
    const pg = j.pagination || {};
    if (!paginate || !pg.hasNextPage || !pg.endCursor) break;
    after = pg.endCursor;
  }
  return out;
}

// ---- resource fetchers (each defensive; caller decides what to do on error)
export const listDrivers = (token) => sGet(token, '/fleet/drivers?limit=512');
export const listVehicles = (token) => sGet(token, '/fleet/vehicles?limit=512');
export const listTrailers = (token) => sGet(token, '/fleet/trailers?limit=512');
export const driverVehicleAssignments = (token) => sGet(token, '/fleet/driver-vehicle-assignments');
export const vehicleStats = (token, types = 'gps,engineStates,fuelPercents,obdOdometerMeters') =>
  sGet(token, `/fleet/vehicles/stats?types=${types}`);

// Reefer / trailer temperature. The reliable source is the legacy "all reefers"
// endpoint, which returns every reefer's zone temps + setpoints — but it REQUIRES
// a startMs/endMs window (we ask for the last hour and take the latest reading).
// Falls back to the beta trailer-stats snapshot. Returns the raw payload so the
// caller can inspect/parse whatever shape this org returns.
export async function reeferStats(token) {
  const end = Date.now();
  const start = end - 60 * 60 * 1000; // last hour
  try {
    return await sGet(token, `/v1/fleet/assets/reefers?startMs=${start}&endMs=${end}&limit=512`, { paginate: false });
  } catch { /* fall through */ }
  try {
    return await sGet(token, '/beta/fleet/trailers/stats/snapshot?types=reeferTempZone1,reeferSetPointZone1,reeferPowerStatus,reeferAmbientAirTemperature', { paginate: false });
  } catch { return []; }
}

// A single call that pulls everything needed for correlation, tolerating any
// one resource failing (returns an { error } marker for that slice instead).
export async function snapshot(token) {
  const safe = (p) => p.then((v) => v).catch((e) => ({ error: String(e.message || e) }));
  const [drivers, vehicles, trailers, stats, assignments, reefer] = await Promise.all([
    safe(listDrivers(token)),
    safe(listVehicles(token)),
    safe(listTrailers(token)),
    safe(vehicleStats(token)),
    safe(driverVehicleAssignments(token)),
    safe(reeferStats(token)),
  ]);
  return { drivers, vehicles, trailers, stats, assignments, reefer };
}

// ===============================================================
// Correlation — turn a Samsara snapshot into fast lookup maps keyed by the same
// identifiers TruckMate uses (driver CODE = Samsara username; truck/trailer
// number = Samsara asset name / unitId), then attach live data to a TM trip.
// ===============================================================
const arr = (v) => (Array.isArray(v) ? v : []);
// normalise a unit/code for matching: string, trimmed, lowercased, leading
// zeros dropped (TruckMate "0257" ↔ Samsara "257" both match).
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^0+(?=\d)/, '');
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Convert a Samsara temperature value to °F, guessing the unit from the field
// name and magnitude (milli-°C is the common reefer encoding).
function toF(val, key) {
  if (val == null || Number.isNaN(Number(val))) return null;
  const v = Number(val); const k = String(key || '').toLowerCase();
  if (k.includes('milli')) return round1((v / 1000) * 9 / 5 + 32);
  if (k.includes('fahrenheit')) return round1(v);
  if (k.includes('celsius') || /(^|[^a-z])c$/.test(k)) return round1(v * 9 / 5 + 32);
  if (Math.abs(v) > 200) return round1((v / 1000) * 9 / 5 + 32); // big ⇒ milli-°C
  return round1(v * 9 / 5 + 32);                                  // else ⇒ °C
}

// Flatten nested objects to { 'a.b.c': value } for leaf scalars.
function flatten(obj, prefix = '', out = {}) {
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object') flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}
const pickPath = (flat, regexes, wantNumber = true) => {
  for (const re of regexes) {
    const hit = Object.keys(flat).find((p) => re.test(p) && (!wantNumber || Number.isFinite(Number(flat[p]))));
    if (hit) return hit;
  }
  return null;
};

// Pull temp / setpoint / power / timestamp out of one reefer record, whatever
// its shape. Heuristic — verify against the diagnostic once live.
function parseReefer(r) {
  const flat = flatten(r);
  const tKey = pickPath(flat, [/reefer.*temp/i, /ambient.*air/i, /return.*air/i, /temp.*zone.?1/i, /zone.?1.*temp/i, /tempinmillic/i, /temperature/i]);
  const sKey = pickPath(flat, [/set.?point/i]);
  const pKey = pickPath(flat, [/power.?status/i, /reeferpower/i, /powerstate/i], false);
  const aKey = pickPath(flat, [/time$/i, /timestamp/i], false);
  return {
    name: r.name || r.assetName || null,
    id: r.id || null,
    tempF: tKey ? toF(flat[tKey], tKey) : null,
    setpointF: sKey ? toF(flat[sKey], sKey) : null,
    power: pKey ? flat[pKey] : null,
    at: aKey ? flat[aKey] : null,
  };
}
function reeferRecords(reefer) {
  if (Array.isArray(reefer)) return reefer;
  if (reefer && typeof reefer === 'object') {
    const listKey = Object.keys(reefer).find((k) => Array.isArray(reefer[k]));
    if (listKey) return reefer[listKey];
  }
  return [];
}

export function indexSnapshot(snap) {
  const driversByCode = {};
  for (const d of arr(snap.drivers)) if (d.username) driversByCode[norm(d.username)] = { id: d.id, name: d.name };
  const vehByUnit = {};
  for (const v of arr(snap.vehicles)) for (const key of [v.name, v.externalIds && v.externalIds.unitId]) if (key) vehByUnit[norm(key)] = v;
  const statsByUnit = {};
  for (const s of arr(snap.stats)) {
    if (s.name) statsByUnit[norm(s.name)] = s;
    if (s.externalIds && s.externalIds.unitId) statsByUnit[norm(s.externalIds.unitId)] = s;
  }
  const reeferByKey = {};
  for (const r of reeferRecords(snap.reefer)) {
    const p = parseReefer(r);
    for (const key of [r.name, r.id, r.assetName]) if (key) reeferByKey[norm(key)] = p;
  }
  return { driversByCode, vehByUnit, statsByUnit, reeferByKey };
}

// Build the live data object for one TruckMate trip item.
export function correlate(item, idx) {
  const t = (item && item.trip) || item || {};
  const live = {};
  const d1 = idx.driversByCode[norm(t.driver)];
  const d2 = idx.driversByCode[norm(t.driver2)];
  if (d1) live.driver1 = d1.name;
  if (d2) live.driver2 = d2.name;
  const st = idx.statsByUnit[norm(t.powerUnit)];
  if (st) {
    const g = st.gps || {};
    live.location = (g.reverseGeo && g.reverseGeo.formattedLocation) || null;
    live.lat = g.latitude; live.lng = g.longitude;
    live.speedMph = g.speedMilesPerHour != null ? Math.round(g.speedMilesPerHour) : null;
    live.gpsAt = g.time || null;
    live.fuelPct = st.fuelPercent ? st.fuelPercent.value : null;
    live.engine = st.engineState ? st.engineState.value : null;
  }
  const veh = idx.vehByUnit[norm(t.powerUnit)];
  if (veh && veh.staticAssignedDriver) live.samsaraDriver = veh.staticAssignedDriver.name;
  const reef = idx.reeferByKey[norm(t.trailer)] || idx.reeferByKey[norm(t.trailer2)];
  if (reef) { live.tempF = reef.tempF; live.setpointF = reef.setpointF; live.reeferPower = reef.power; live.tempAt = reef.at; }
  return Object.keys(live).length ? live : null;
}

// Cached live index so /truckmate/active doesn't re-pull all of Samsara per hit.
let _idxCache = { at: 0, token: '', idx: null };
export async function getLiveIndex(token, ttlMs = 60000) {
  const now = Date.now();
  if (_idxCache.idx && _idxCache.token === token && (now - _idxCache.at) < ttlMs) return _idxCache.idx;
  const idx = indexSnapshot(await snapshot(token));
  _idxCache = { at: now, token, idx };
  return idx;
}

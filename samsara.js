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
export const hosClocks = (token) => sGet(token, '/fleet/hos/clocks?limit=200');
// Saved known locations (customers/terminals) with geocoded lat/lng + geofences.
export const listAddresses = (token) => sGet(token, '/addresses');

// ---- LIVE reefer via the Readings API (the source the Samsara UI uses) ----
// /readings/latest gives the last-known value per asset. readingIds is capped at
// 3 per request, so we fetch in batches and merge by entityId (the asset id).
const readingsLatest = (token, ids) => sGet(token, `/readings/latest?entityType=asset&readingIds=${ids.join(',')}`);
export async function reeferReadings(token) {
  const batches = [
    ['reeferReturnAirZone1', 'reeferSetPointZone1', 'reeferSupplyAirZone1'],
    ['reeferAmbientAir', 'reeferState', 'reeferRunMode'],
    ['reeferFuelLevel', 'reeferPowerSource', 'reeferEngineHours'],
  ];
  const byEntity = {};
  for (const ids of batches) {
    let data;
    try { data = await readingsLatest(token, ids); } catch { continue; }
    for (const r of (Array.isArray(data) ? data : [])) {
      const id = String(r.entityId);
      if (!byEntity[id]) byEntity[id] = {};
      byEntity[id][r.readingId] = { value: r.value, at: r.happenedAtTime };
    }
  }
  return byEntity; // { entityId: { readingId: { value, at } } }
}

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
  const [drivers, vehicles, trailers, stats, assignments, reefer, hos, reeferRead] = await Promise.all([
    safe(listDrivers(token)),
    safe(listVehicles(token)),
    safe(listTrailers(token)),
    safe(vehicleStats(token)),
    safe(driverVehicleAssignments(token)),
    safe(reeferStats(token)),      // legacy bulk — kept only for asset id→name mapping
    safe(hosClocks(token)),
    safe(reeferReadings(token)),   // LIVE reefer values (Readings API)
  ]);
  return { drivers, vehicles, trailers, stats, assignments, reefer, hos, reeferRead };
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

// Samsara reefer shape (legacy /v1/fleet/assets/reefers):
//   { id, name, reeferStats: { returnAirTemperature:[{changedAtMs, tempInMilliC}],
//     ambientAirTemperature:[...], setPoint:[{changedAtMs, tempInMilliC}],
//     powerStatus:[{changedAtMs, status}], reeferAlarms:[...] } }
// Each is a time-series ARRAY — take the most recent entry. Temps are milli-°C.
const latestOf = (a) => (Array.isArray(a) && a.length
  ? a.reduce((x, y) => (Number(y.changedAtMs || 0) >= Number(x.changedAtMs || 0) ? y : x))
  : null);
const milliCToF = (m) => (m == null ? null : round1((Number(m) / 1000) * 9 / 5 + 32));

function parseReefer(r) {
  const rs = (r && r.reeferStats) || {};
  const tRec = latestOf(rs.returnAirTemperature) || latestOf(rs.ambientAirTemperature) || latestOf(rs.dischargeAirTemperature);
  const sRec = latestOf(rs.setPoint);
  const pRec = latestOf(rs.powerStatus);
  const aRec = latestOf(rs.reeferAlarms);
  const changed = tRec && tRec.changedAtMs ? Number(tRec.changedAtMs) : null;
  return {
    name: r.name || r.assetName || null,
    id: r.id != null ? String(r.id) : null,
    tempF: tRec ? milliCToF(tRec.tempInMilliC) : null,
    setpointF: sRec ? milliCToF(sRec.tempInMilliC) : null,
    power: pRec ? (pRec.status || null) : null,
    fuel: (() => { const f = latestOf(rs.fuelPercentage); return f && f.fuelPercentage != null ? f.fuelPercentage : null; })(),
    engineHours: (() => { const e = latestOf(rs.engineHours); return e && e.engineHours != null ? e.engineHours : null; })(),
    alarms: aRec && Array.isArray(aRec.alarms) && aRec.alarms.length ? aRec.alarms : null,
    at: changed ? new Date(changed).toISOString() : null,
    // these legacy "Carrier" reefers can report months-old values — flag stale so
    // we neither trust the number nor raise a false temperature alert on it.
    stale: changed ? (Date.now() - changed) > 6 * 60 * 60 * 1000 : true,
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

// One-shot audit of the reefer feed: how many reefers report a real, fresh
// temperature vs zero/stale — tells us whether live reefer temp exists at all,
// and under what names, so we know whether the gap is matching or missing data.
export function analyzeReefers(rawReefer) {
  const recs = reeferRecords(rawReefer);
  let withTemp = 0; let nonZero = 0; let fresh = 0;
  const freshRealSamples = [];
  for (const r of recs) {
    const p = parseReefer(r);
    if (p.tempF != null) withTemp += 1;
    if (p.tempF != null && p.tempF !== 32) nonZero += 1; // 32°F == 0 milli-°C
    if (!p.stale) fresh += 1;
    if (!p.stale && p.tempF != null && p.tempF !== 32 && freshRealSamples.length < 6) {
      freshRealSamples.push({ name: p.name, tempF: p.tempF, setpointF: p.setpointF, at: p.at });
    }
  }
  return { total: recs.length, withTemp, nonZero, fresh, freshRealSamples };
}

// Parse one asset's merged reefer readings (Readings API, °C) into °F fields
// matching the reefer panel: Return Air, Set Point, Supply/Discharge Air, Ambient,
// power state, run mode (Continuous/Start-Stop), power source, fuel, engine hours.
const cToF = (c) => (c == null ? null : round1(Number(c) * 9 / 5 + 32));
function parseReadingReefer(rec) {
  const val = (k) => (rec[k] && rec[k].value != null ? rec[k].value : null);
  const at = (k) => (rec[k] && rec[k].at ? rec[k].at : null);
  const tAt = at('reeferReturnAirZone1') || at('reeferSetPointZone1') || at('reeferState') || at('reeferAmbientAir');
  const ms = tAt ? Date.parse(tAt) : null;
  const fuel = val('reeferFuelLevel');
  const eng = val('reeferEngineHours');
  return {
    tempF: cToF(val('reeferReturnAirZone1')),      // Return Air (RA) — the load temp
    setpointF: cToF(val('reeferSetPointZone1')),   // Set Point (SP)
    supplyF: cToF(val('reeferSupplyAirZone1')),    // Supply/Discharge Air (DA)
    ambientF: cToF(val('reeferAmbientAir')),
    state: val('reeferState'),                     // On / Off
    runMode: val('reeferRunMode'),                 // Continuous / Start-Stop
    powerSource: val('reeferPowerSource'),
    fuel: fuel != null ? Math.round(fuel) : null,
    engineHours: eng != null ? round1(eng) : null,
    at: tAt,
    stale: ms ? (Date.now() - ms) > 6 * 60 * 60 * 1000 : true,
  };
}

// Audit the live readings feed: how many assets report a fresh return-air temp.
export function analyzeReeferReadings(reeferRead) {
  if (!reeferRead || reeferRead.error) return { error: (reeferRead && reeferRead.error) || 'none' };
  const ids = Object.keys(reeferRead);
  let withRA = 0; let fresh = 0; const samples = [];
  for (const id of ids) {
    const p = parseReadingReefer(reeferRead[id]);
    if (p.tempF != null) withRA += 1;
    if (!p.stale) fresh += 1;
    if (!p.stale && p.tempF != null && samples.length < 6) samples.push({ entityId: id, ...p });
  }
  return { entities: ids.length, withReturnAir: withRA, fresh, samples };
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
  // map asset id → name (trailer number) from every asset list we have
  const nameById = {};
  for (const v of arr(snap.vehicles)) if (v.id != null && v.name) nameById[String(v.id)] = v.name;
  for (const t of arr(snap.trailers)) if (t.id != null && t.name) nameById[String(t.id)] = t.name;
  for (const r of reeferRecords(snap.reefer)) if (r.id != null && r.name) nameById[String(r.id)] = r.name;
  // LIVE reefer values keyed by trailer number (and by asset id as a fallback)
  const reeferByKey = {};
  const reads = (snap.reeferRead && !snap.reeferRead.error) ? snap.reeferRead : {};
  for (const [entityId, rec] of Object.entries(reads)) {
    const parsed = parseReadingReefer(rec);
    const name = nameById[String(entityId)];
    if (name) reeferByKey[norm(name)] = parsed;
    reeferByKey[norm(entityId)] = parsed;
  }
  // HOS clocks keyed by Samsara driver id — drive/shift time left + duty status.
  const MIN = 60 * 1000;
  const hosById = {};
  for (const c of arr(snap.hos)) {
    const id = c.driver && c.driver.id;
    if (!id) continue;
    const drive = (c.clocks && c.clocks.drive) || {};
    const shift = (c.clocks && c.clocks.shift) || {};
    const cycle = (c.clocks && c.clocks.cycle) || {};
    const mins = (ms) => (ms != null ? Math.round(ms / MIN) : null);
    hosById[String(id)] = {
      status: (c.currentDutyStatus && c.currentDutyStatus.hosStatusType) || null,
      vehicle: (c.currentVehicle && c.currentVehicle.name) || null,
      driveLeftMin: mins(drive.driveRemainingDurationMs),
      shiftLeftMin: mins(shift.shiftRemainingDurationMs),
      cycleLeftMin: mins(cycle.cycleRemainingDurationMs),
      breakInMin: mins(drive.timeUntilBreakDurationMs),
    };
  }
  return { driversByCode, vehByUnit, statsByUnit, reeferByKey, hosById };
}

// Build the live data object for one TruckMate trip item.
export function correlate(item, idx) {
  const t = (item && item.trip) || item || {};
  const live = {};
  const d1 = idx.driversByCode[norm(t.driver)];
  const d2 = idx.driversByCode[norm(t.driver2)];
  if (d1) { live.driver1 = d1.name; if (idx.hosById[String(d1.id)]) live.hos = idx.hosById[String(d1.id)]; }
  if (d2) { live.driver2 = d2.name; if (idx.hosById[String(d2.id)]) live.hos2 = idx.hosById[String(d2.id)]; }
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
  if (reef) {
    live.tempF = reef.tempF;              // return air (the load temp)
    live.setpointF = reef.setpointF;      // set point
    live.supplyF = reef.supplyF;          // supply/discharge air
    live.ambientF = reef.ambientF;
    live.reeferState = reef.state;        // On / Off
    live.reeferRunMode = reef.runMode;    // Continuous / Start-Stop
    live.reeferPowerSource = reef.powerSource;
    live.reeferFuel = reef.fuel;
    live.reeferEngineHours = reef.engineHours;
    live.reeferPower = reef.state;        // back-compat
    live.tempAt = reef.at; live.tempStale = reef.stale;
  }
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

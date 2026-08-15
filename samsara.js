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

// Reefer / trailer temperature. The modern path is the trailer-stats snapshot;
// older orgs expose it through the legacy reefer stats. Try the snapshot first,
// then fall back — the caller gets whichever responds (or [] if neither does).
export async function trailerStats(token) {
  try { return await sGet(token, '/beta/fleet/trailers/stats/snapshot', { paginate: false }); }
  catch { /* fall through to legacy */ }
  try { return await sGet(token, '/fleet/trailers/stats?types=reeferTemperature,reeferStatus,reeferSetPoint', { paginate: false }); }
  catch { return []; }
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
    safe(trailerStats(token)),
  ]);
  return { drivers, vehicles, trailers, stats, assignments, reefer };
}

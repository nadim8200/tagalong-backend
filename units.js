// ---------------------------------------------------------------
// Truck names that aren't the truck's real number.
// ---------------------------------------------------------------
// TruckMate / EDI names for a truck that aren't its real number ("OC2" is truck 4550 — Samsara, the driver and the
// customer know it as 4550). Applied as the board is built, so GPS, ETAs, Jarvis and customers all see the real
// truck; TruckMate's own name stays on the trip (tmPowerUnit). Pure.
export const UNIT_ALIASES = { OC2: '4550' };
export function applyUnitAliases(trips, aliases = UNIT_ALIASES) {
  const map = Object.fromEntries(Object.entries(aliases || {}).map(([k, v]) => [String(k).toUpperCase().replace(/[\s-]/g, ''), String(v)]));
  for (const item of trips || []) {
    const t = (item && item.trip) || item;
    if (!t) continue;
    const real = map[String(t.powerUnit || '').toUpperCase().replace(/[\s-]/g, '')];
    if (real) { t.tmPowerUnit = t.tmPowerUnit || t.powerUnit; t.powerUnit = real; }
  }
  return trips;
}
// the real truck number for what someone typed or said ("oc2", "OC-2" → 4550); anything else unchanged. Pure.
export function realUnit(x, aliases = UNIT_ALIASES) {
  const k = String(x == null ? '' : x).toUpperCase().replace(/[\s-]/g, '');
  const hit = Object.entries(aliases || {}).find(([a]) => String(a).toUpperCase().replace(/[\s-]/g, '') === k);
  return hit ? String(hit[1]) : x;
}


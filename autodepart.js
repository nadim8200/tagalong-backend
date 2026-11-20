// Did the truck leave the cooler with its trailer? When the driver never tapped "Llegué a cargar" / "Cargado y saliendo",
// the driver app moves on to stop 1 once Jarvis sees it. The steps are shown as detected (by GPS), never stored as the driver's
// check-ins, so no waiting-time clock starts from them. Pure.
const MIAMI = { s: 25.55, n: 25.98, w: -80.55, e: -80.12 };          // Miami-Dade: the cooler is in Doral
const DEPARTED = /^(DEPSHIP|INTRAN|ENROUTE|ARRCONS|DEPCONS)/i;
const FRESH_MS = 30 * 60000;
const tripOf = (it) => (it && it.trip) || it || {};

// → { at, why } | null
export function leftCooler(item, nowMs = Date.now()) {
  const t = tripOf(item); const s = (item && item._samsara) || {};
  if (!t.trailer || s.lat == null || s.lng == null) return null;
  const at = Date.parse(s.gpsAt || '');
  if (!at || nowMs - at > FRESH_MS) return null;                     // old GPS proves nothing
  const fromMiami = /MIAMI|DORAL/i.test(String(t.origZoneDesc || t.origin || ''));
  const outside = !(s.lat >= MIAMI.s && s.lat <= MIAMI.n && s.lng >= MIAMI.w && s.lng <= MIAMI.e);
  const rolling = Number(s.speedMph || 0) >= 10;
  if (fromMiami && outside) return { at: s.gpsAt, why: 'out of the Miami area with the trailer' };
  if (rolling && DEPARTED.test(String(t.status || ''))) return { at: s.gpsAt, why: 'rolling with the trailer, TruckMate says departed' };
  return null;
}

// The steps the app shows: what the driver tapped, plus the detected loading steps they skipped. Pure.
export function withDetected(steps = {}, seen = null) {
  if (!seen || (steps['at-shipper'] && steps.loaded)) return steps;
  const d = { at: seen.at, auto: true, by: 'Jarvis (GPS)' };
  return { 'at-shipper': d, loaded: d, ...steps };
}

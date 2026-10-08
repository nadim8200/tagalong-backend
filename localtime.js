// Times the way the customer lives them: an ETA for a California delivery is said in
// Pacific time ("Thu, Oct 8, 1:00 AM Pacific"), not Miami's Eastern clock. Every ETA,
// appointment and due time a customer, broker or Jarvis hears is in the delivery's local
// time, with the zone named. Dispatch views show Eastern with the local time beside it.
export const STATE_TZ = {
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York', MI: 'America/Detroit', NC: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VA: 'America/New_York', VT: 'America/New_York', WV: 'America/New_York', DC: 'America/New_York', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver', AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
};

const ZONE = { 'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Indiana/Indianapolis': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Boise': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific' };
const SHORT = { Eastern: 'ET', Central: 'CT', Mountain: 'MT', Arizona: 'AZ time', Pacific: 'PT' };

// "LOMBARD, IL, 60148" / "Ventura, California" / "CA" → its time zone (Eastern when unknown)
export function tzOf(place) {
  const s = String(place || '').trim();
  const code = (s.match(/,\s*([A-Z]{2})\b/) || s.match(/^([A-Z]{2})$/) || [])[1];
  if (code && STATE_TZ[code]) return STATE_TZ[code];
  const NAMES = { CALIFORNIA: 'CA', TEXAS: 'TX', ILLINOIS: 'IL', ARIZONA: 'AZ', NEVADA: 'NV', OREGON: 'OR', WASHINGTON: 'WA', COLORADO: 'CO', TENNESSEE: 'TN', MINNESOTA: 'MN', MISSOURI: 'MO', LOUISIANA: 'LA', OKLAHOMA: 'OK', UTAH: 'UT' };
  const n = Object.keys(NAMES).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(s));
  return (n && STATE_TZ[NAMES[n]]) || 'America/New_York';
}
export const zoneName = (tz) => ZONE[tz] || 'Eastern';

// "Thu, Oct 8, 1:00 AM Pacific (local time)" — the delivery's local time, zone named (for customers / Jarvis)
export function fmtLocal(ms, place, { local = true } = {}) {
  if (ms == null || Number.isNaN(ms)) return null;
  const tz = tzOf(place);
  return `${new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ${zoneName(tz)}${local && zoneName(tz) !== 'Eastern' ? ' (local time)' : ''}`;
}
// "Oct 9, 5:00 AM ET (4:00 AM CT local)" — for dispatch: Eastern, plus the local time when it differs
export function fmtLocalShort(ms, place) {
  if (ms == null || Number.isNaN(ms)) return '';
  const et = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tz = tzOf(place); const z = zoneName(tz);
  if (z === 'Eastern') return `${et} ET`;
  return `${et} ET (${new Date(ms).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${SHORT[z] || z} local)`;
}

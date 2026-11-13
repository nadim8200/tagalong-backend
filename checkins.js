// ---------------------------------------------------------------
// Driver check-ins from the driver app (company drivers): "I'm at the shipper", "Loaded & leaving", "I'm at the receiver",
// "Delivered" for each stop. The emails about a load's progress wait for them: an arrival / departure / delivery email goes
// out when the driver taps, and only if they never do, 30 minutes after TruckMate or GPS showed it — marked "not confirmed
// by the driver". LTL runs don't use these: their stops are marked done (with boxes and paperwork) in the app instead.
// ---------------------------------------------------------------
export const CHECKINS = (site) => `taDriverCheckins:${site}`;   // trip → { steps: { [step]: { at, by } } }
export const HOLD_MS = 30 * 60000;

// The steps a driver can tap: at-shipper, loaded, arrived:<stop>, delivered:<stop> (a stop is a statusmail stop key). Pure.
export const validStep = (step, stopKeys = []) => step === 'at-shipper' || step === 'loaded'
  || (/^(arrived|delivered):/.test(String(step)) && stopKeys.includes(String(step).replace(/^(arrived|delivered):/, '')));

// A tap → the milestone keys it confirms (milestones.js). "Loaded & leaving" is both loaded and rolling. Pure.
export const milestoneKeys = (step) => (step === 'at-shipper' ? ['arrived-shipper'] : step === 'loaded' ? ['loaded', 'departed'] : [String(step)]);

// Did the driver confirm this email's event? ms = item._milestones ({ key: { src } }); a tap shows as src "driver". Pure.
export function driverConfirmed(ev, ms = {}, stopKeys = []) {
  const by = (k) => !!(ms[k] && /driver/.test(String(ms[k].src || '')));
  if (ev.kind === 'at-shipper') return by('arrived-shipper');
  if (ev.kind === 'picked-up') return by('departed') || by('loaded');
  if (ev.kind === 'arrived') return by(`arrived:${ev.stop}`) || by(`delivered:${ev.stop}`);
  if (ev.kind === 'delivered') return stopKeys.length > 0 && stopKeys.every((k) => by(`delivered:${k}`));
  return true;
}

// Send now, keep waiting for the driver, or send unconfirmed after 30 min. wait = { [event key]: first seen ISO }. Pure.
// → { send, unconfirmed }
export function holdForDriver(ev, { ms = {}, stopKeys = [], wait = {}, now = Date.now() } = {}) {
  const k = `${ev.kind}${ev.stop ? `:${ev.stop}` : ''}`;
  if (driverConfirmed(ev, ms, stopKeys)) { delete wait[k]; return { send: true, unconfirmed: false }; }
  if (!wait[k]) { wait[k] = new Date(now).toISOString(); return { send: false, unconfirmed: false }; }
  if (now - Date.parse(wait[k]) >= HOLD_MS) { delete wait[k]; return { send: true, unconfirmed: true }; }
  return { send: false, unconfirmed: false };
}

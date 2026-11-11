// ---------------------------------------------------------------
// Load geofences — where Jarvis checks in with the driver.
//
// Each load gets its own geofences as soon as we have its addresses: the pickups and deliveries from the trip sheet
// (ARTIS / customer profiles) or the broker's rate con. Only a real street address gets a fence: a city or ZIP is too coarse.
// Our own Miami yard is never a fence (dispatch is there).
//
// Jarvis texts the driver only on what the truck's GPS does at those fences — never on TruckMate statuses (dispatch often
// changes those at the moment it dispatches the load):
//   • parked inside a fence 20 min   → "Are you checked in? Did they give you a door yet?"
//   • left that fence (after 20 min)  → pickup: "Are you loaded?" + BOL / seal / temp photos; delivery: "Delivered complete?" + POD
// One text at a time: only the newest event is sent (a truck that already left never gets "are you checked in?"), at least
// 15 min apart. LTL runs (2+ trip-sheet stops) get no stop texts — the driver submits each stop's paperwork in the app.
// ---------------------------------------------------------------
import { ltlStops } from './stopflow.js';
import { metersBetween } from './stopvisits.js';

const MIN = 60000;
export const FENCE = { insideM: 500, leftM: 1600, dwellMin: 20, gapMin: 15, leftFreshMin: 60, gpsFreshMin: 10 };
const S = (x) => String(x == null ? '' : x).trim();
const tripOf = (it) => (it && it.trip) || it || {};
const first = (n) => S(n).split(/\s+/)[0] || '';
const norm = (c) => S(c).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
const street = (a) => /\d/.test(S(a)) && /[a-z]{3}/i.test(S(a));
const query = (s) => [s.address, s.city, [s.state, s.zip].filter(Boolean).join(' ')].map(S).filter(Boolean).join(', ');
const cityOf = (s) => [s.city, s.state].map(S).filter(Boolean).join(', ');

// The load's pickups and deliveries that can have a fence, in order. Delivery fences carry the status-email stop key
// (statusmail.stopsOf) so a driver's YES lands on the right stop. Pure.
export function fencesFor(item, stops = []) {
  if (!item) return [];
  const t = tripOf(item);
  const sheet = ((item._manifest && item._manifest.stops) || []).filter(Boolean);
  const rc = (item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  const out = [];
  const yard = (s) => /MIAMI|MEDLEY|DORAL/i.test(`${s.city} ${s.customer || ''}`);
  const sheetPick = sheet.filter((s) => /PICK|LOAD/i.test(s.action || ''));
  // TruckMate's own shipper / consignee on each bill (the connector reads them per bill): name, street, city, state, zip
  const bills = (item.freightBills || item.orders || []).filter(Boolean);
  const tmAddr = (x) => (x && (x.address1 || x.address) ? { name: x.name, address: [x.address1 || x.address, x.address2].filter(Boolean).join(' '), city: x.city, state: x.province, zip: x.postalCode } : null);
  const tmShippers = [...new Map(bills.map((b) => tmAddr(b.shipper)).filter(Boolean).map((a) => [norm(`${a.address}${a.city}`), a])).values()];
  const picks = sheetPick.length ? sheetPick.map((s) => ({ name: s.customer, address: s.address, city: s.city, state: s.state, zip: s.zip }))
    : (rc.pickups || []).filter((p) => street(p.address)).length ? (rc.pickups || []).map((p) => ({ name: p.name, address: p.address, city: p.city, state: p.state, zip: p.zip }))
      : tmShippers;
  if (!/MIAMI/i.test(t.origZoneDesc || '')) {
    picks.forEach((p, i) => { if (street(p.address) && !yard(p)) out.push({ key: `pickup:${i}`, kind: 'pickup', n: i, name: S(p.name) || null, city: cityOf(p), q: query(p) }); });
  }
  const sheetDel = sheet.filter((s) => /DELIVER/i.test(s.action || ''));
  const rcDel = rc.deliveries || [];
  stops.forEach((st, i) => {
    const city = norm(String(st.place || '').split(',')[0]);
    const s = sheetDel.find((x) => (st.sheetKey && x.key === st.sheetKey) || norm(x.city) === city);
    const r = rcDel.find((x) => norm(x.city) === city);
    const tmc = bills.map((b) => tmAddr(b.consignee)).find((x) => x && (norm(x.city) === city || (st.zip && String(x.zip || '').slice(0, 5) === String(st.zip).slice(0, 5))));
    const a = s && street(s.address) ? { name: s.customer, address: s.address, city: s.city, state: s.state, zip: s.zip } : (r && street(r.address) ? r : (tmc && street(tmc.address) ? tmc : null));
    if (a) out.push({ key: `delivery:${st.key}`, kind: 'delivery', n: i, stopKey: st.key, name: S(a.name) || S(st.name) || (st.customers || [])[0] || null, city: cityOf(a), q: query(a) });
  });
  return out;
}

// LTL run: the trip sheet has 2+ delivery stops. Pure.
export const isLtlRun = (item) => { const s = ltlStops(item); return !!(s && s.length >= 2); };

// One GPS reading against the load's fences. Pure. f: { [key]: { inAt, lastInAt, leftAt, arrive, left } } → updated copy.
export function stepFences(fences, points, f = {}, { lat, lng, at }, now) {
  const next = JSON.parse(JSON.stringify(f || {}));
  if (lat == null || !at || now - Date.parse(at) > FENCE.gpsFreshMin * MIN) return next;
  const iso = new Date(now).toISOString();
  for (const fe of fences) {
    const p = points[fe.key];
    if (!p) continue;
    const s = next[fe.key] || {};
    if (s.leftAt) { next[fe.key] = s; continue; }                      // a fence is done once the truck left it
    const d = metersBetween({ lat, lng }, p);
    if (d <= FENCE.insideM) { s.inAt = s.inAt || iso; s.lastInAt = iso; } else if (s.inAt && d >= FENCE.leftM) {
      if (Date.parse(s.lastInAt) - Date.parse(s.inAt) >= FENCE.dwellMin * MIN) s.leftAt = iso;
      else { delete s.inAt; delete s.lastInAt; }                        // only drove by
    }
    next[fe.key] = s;
  }
  return next;
}

// The one text to send now, or null. Only the newest event counts: older unsent ones are marked skipped. Pure.
// → { fence, event: 'arrive'|'left', skip: [[key, event]] }
export function nextAsk(fences, f = {}, { now, lastAskAt = null, resting = false }) {
  const due = [];
  fences.forEach((fe, i) => {
    const s = f[fe.key] || {};
    if (s.inAt && !s.leftAt && !s.arrive && now - Date.parse(s.inAt) >= FENCE.dwellMin * MIN) due.push({ fe, event: 'arrive', at: Date.parse(s.inAt) + FENCE.dwellMin * MIN, i });
    if (s.leftAt && !s.left) due.push({ fe, event: 'left', at: Date.parse(s.leftAt), i });
    if (s.leftAt && !s.arrive) due.push({ fe, event: 'arrive', at: Date.parse(s.inAt), i, stale: true });   // never asked while there
  });
  if (!due.length) return null;
  due.sort((a, b) => b.at - a.at || b.i - a.i);
  const [top, ...rest] = due;
  const skip = rest.map((x) => [x.fe.key, x.event]);
  if (top.stale || (top.event === 'left' && now - top.at > FENCE.leftFreshMin * MIN)) return { fence: null, skip: due.map((x) => [x.fe.key, x.event]) };
  if (resting || (lastAskAt && now - Date.parse(lastAskAt) < FENCE.gapMin * MIN)) return { fence: null, skip, wait: true };
  return { fence: top.fe, event: top.event, skip };
}

// The text. Pure.
export function fenceText(fe, event, { name, trip }) {
  const hi = `Florida Beauty Flora dispatch (Jarvis): Hi${name ? ` ${first(name)}` : ''},`;
  const where = [fe.name, fe.city ? `in ${fe.city}` : ''].filter(Boolean).join(' ') || (fe.kind === 'pickup' ? 'the shipper' : 'the receiver');
  if (event === 'arrive') return `${hi} it looks like you're at ${where} for load ${trip}. Are you checked in? Did they give you a door yet?`;
  if (fe.kind === 'pickup') return `${hi} I see you left ${where} on load ${trip}. Are you loaded and sealed? Please send the BOL, seal and reefer temp photos in the TagAlong app.`;
  return `${hi} I see you left ${where} on load ${trip}. Was it delivered complete? Please send the signed POD (all pages) in the TagAlong app, and tell me about any rejected product or extra charges.`;
}

// The milestone a driver's YES confirms (milestones.applyReply reads st.asks by these keys). Pure.
export function askKey(fe, event) {
  if (fe.kind === 'pickup') return event === 'arrive' ? 'arrived-shipper' : 'loaded';
  return event === 'arrive' ? `arrived:${fe.stopKey}` : `left:${fe.stopKey}`;
}

// ---------------------------------------------------------------
// Structured dispatch answers for Ask Jarvis — the console draws trip cards from THIS, never from the
// model's prose. Built from the same live data the tools read (board item, the watchtower's stop ETAs,
// TruckMate bills, the trip sheet), so nothing is guessed: a missing field is left out, not shown as 0.
// Times are epoch ms + the stop's IANA time zone (the console formats them); TruckMate delivery times are
// the stop's wall clock as entered, kept as-is ("deliveredLocal"). A snapshot: `asOf` says when it was built.
// ---------------------------------------------------------------
import { STATE_TZ } from './localtime.js';
import { billsOf } from './statusmail.js';
import { originOf, isOcLoad, nameScore } from './voice.js';

const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const up = (x) => String(x == null ? '' : x).toUpperCase().replace(/\s+/g, ' ').trim();
// "BOSTON, MA, 02118" → "BOSTON, MA"
const townOf = (label) => { const p = String(label || '').split(',').map((x) => x.trim()); return p[0] && p[1] ? `${up(p[0])}, ${up(p[1]).slice(0, 2)}` : up(p[0]); };
const zipOf = (label) => (String(label || '').match(/\b(\d{5})\b/) || [])[1] || null;
const title = (x) => String(x || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const pretty = (town) => { const [c, s] = town.split(',').map((x) => x.trim()); return s ? `${title(c)}, ${s}` : title(c); };
const stateOf = (town) => (String(town).split(',')[1] || '').trim().slice(0, 2);
const sameTown = (a, b) => { const x = townOf(a); const y = townOf(b); return !!x && x === y; };

// Where the appointment came from, and whether it's confirmed. Pure.
export const APPT_SOURCE = {
  committed: { label: 'Committed to the customer', verified: true },
  'truckmate-appt': { label: 'TruckMate appointment', verified: true },
  ratecon: { label: 'Rate con', verified: true },
  printed: { label: 'Trip sheet', verified: true },
  sheet: { label: 'Trip sheet', verified: true },
  handwritten: { label: 'Handwritten on the trip sheet', verified: false },
  'truckmate-due': { label: 'TruckMate due time — not a confirmed appointment', verified: false },
};

// "Ventura Freeway, Thousand Oaks, CA, 91320" → "Thousand Oaks, CA". Pure.
export function placeOfGps(loc) {
  const p = String(loc || '').split(',').map((x) => x.trim()).filter(Boolean);
  const i = p.findIndex((x) => /^[A-Z]{2}$/.test(x));
  if (i > 0) return `${p[i - 1]}, ${p[i]}`;
  return p.length ? p.slice(-2).join(', ') : null;
}

// One trip as a card. `towns` (optional) limits it to those stops — a customer's own stops. Pure.
export function tripCard(it, eta, { towns = null, customer = null } = {}) {
  const t = tripOf(it);
  const s = it._samsara || {};
  const bills = billsOf(it);
  const sheet = ((it._manifest && it._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || ''));
  // every delivery town on the load: TruckMate bills + the trip sheet (its town, or the TruckMate town it pairs with)
  const sheetTown = (x) => townOf(x.tmPlace || `${x.city || ''}, ${x.state || ''}`);
  const all = [...new Set([...bills.map((b) => townOf(b.endZoneDescription)), ...sheet.map(sheetTown)].filter((x) => x && x.includes(',')))];
  const want = towns ? all.filter((x) => towns.some((w) => sameTown(w, x) || sheet.some((h) => sheetTown(h) === x && sameTown(`${h.city}, ${h.state}`, w)))) : all;
  const legs = (eta && eta.stops) || [];
  const passed = (eta && eta.passed) || [];
  const stops = want.map((town) => {
    const onSheet = sheet.filter((h) => sheetTown(h) === town);
    let bs = bills.filter((b) => townOf(b.endZoneDescription) === town);
    // a customer's own bills only (several customers can share a town)
    // never another customer's bills: no match → no bills (the trip sheet's count is used instead)
    const same = (x, y) => nameScore(x, y) >= 0.75 || nameScore(y, x) >= 0.75;
    if (customer) bs = bs.filter((b) => same(customer, b.billToName || '') || onSheet.some((h) => same(customer, h.customer || '') && same(h.customer || '', b.billToName || '')));
    const zip = bs.map((b) => zipOf(b.endZoneDescription)).find(Boolean) || null;
    const leg = legs.find((x) => (zip && String(x.zip) === zip) || townOf(x.label) === town) || null;
    const delivered = bs.length > 0 && bs.every((b) => b.actualDelivery);
    const counted = bs.filter((b) => b.pieces != null);
    const boxes = counted.length ? counted.reduce((n, b) => n + (Number(b.pieces) || 0), 0) : null;
    const sheetCargo = onSheet.map((h) => h.piecesText).find(Boolean) || null;
    const seq = onSheet.map((h) => h.stopNumber).find((n) => n != null);
    const st = stateOf(town);
    const src = leg && leg.apptMs ? (APPT_SOURCE[leg.apptFrom] || { label: 'Appointment', verified: false }) : null;
    const last = delivered ? bs.map((b) => String(b.actualDelivery)).sort().pop() : null;
    return {
      seq: seq != null ? Number(seq) : null, place: pretty(town), state: st, tz: STATE_TZ[st] || 'America/New_York',
      customers: [...new Set([...onSheet.map((h) => h.customer), ...(customer ? [] : bs.map((b) => b.billToName))].filter(Boolean))].slice(0, 6),
      // the source's own units: TruckMate boxes, or the trip sheet's wording ("1 LOAD", "2,600 CUBES")
      cargo: boxes != null && boxes > 0 ? `${boxes.toLocaleString('en-US')} box${boxes === 1 ? '' : 'es'}` : sheetCargo || null,
      sheetCargo: boxes != null && sheetCargo && !new RegExp(`\\b${boxes}\\b`).test(sheetCargo.replace(/,/g, '')) ? sheetCargo : null,
      bills: bs.map((b) => b.billNumber).filter(Boolean),
      delivered,
      deliveredLocal: last && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(last) ? last.slice(0, 16) : null,
      passed: !delivered && passed.some((x) => (zip && String(x.zip) === zip) || townOf(x.label) === town),
      etaMs: !delivered && leg ? leg.etaMs : null, miles: !delivered && leg ? leg.miles : null,
      appt: leg && leg.apptMs ? { ms: leg.apptMs, source: src.label, verified: src.verified } : null,
    };
  }).sort((a, b) => ((a.seq ?? 999) - (b.seq ?? 999)) || ((a.etaMs ?? Infinity) - (b.etaMs ?? Infinity)));
  const gpsMs = s.gpsAt ? Date.parse(s.gpsAt) : null;
  const mp = it._macropoint && it._macropoint.fresh ? it._macropoint : null;
  const oc = isOcLoad(it);
  return {
    trip: tripNo(it), truck: t.powerUnit || null, trailer: t.trailer || null,
    status: stops.length && stops.every((x) => x.delivered) ? 'delivered' : 'active',
    origin: originOf(it) || null,
    outsideCarrier: oc || undefined,
    location: mp ? { text: [mp.city, mp.state].filter(Boolean).join(', ') || null, motion: null, atMs: mp.at ? Date.parse(mp.at) : null, source: 'MacroPoint' }
      : s.location ? { text: placeOfGps(s.location), motion: s.speedMph == null ? null : s.speedMph > 3 ? `Rolling ${Math.round(s.speedMph)} mph` : 'Stopped', atMs: gpsMs, source: 'Samsara GPS' } : null,
    team: !!(eta && eta.team),
    etaAt: eta && eta.at ? eta.at : null,
    sheet: it._manifest ? { version: it._manifest.version || 1, uploadedAt: it._manifest.uploadedAt || null } : null,
    notes: ((it._manifest && it._manifest.diffs) || []).map((d) => d.msg).filter((m) => !towns || towns.some((w) => up(m).includes(up(String(w).split(',')[0])))).slice(0, 4),
    stops,
  };
}

// A customer's answer: every load with a stop for them. stops = customerStops() output. Pure.
export function customerAnswer({ heading, items, stops, etas = {}, now = Date.now() }) {
  const byTrip = new Map();
  for (const x of stops || []) { const a = byTrip.get(x.trip) || []; a.push(x.city); byTrip.set(x.trip, a); }
  const trips = [...byTrip.entries()].map(([n, towns]) => {
    const it = (items || []).find((i) => tripNo(i) === n);
    return it ? tripCard(it, etas[n], { towns, customer: (stops.find((x) => x.trip === n) || {}).customer || null }) : null;
  }).filter((c) => c && c.stops.length);
  return trips.length ? { v: 1, kind: 'customer', heading: heading || null, asOf: new Date(now).toISOString(), trips: order(trips).slice(0, 12) } : null;
}
// One load (load_details). Pure.
export function loadAnswer({ item, eta, now = Date.now() }) {
  const c = item ? tripCard(item, eta) : null;
  return c && c.stops.length ? { v: 1, kind: 'load', heading: `Trip ${c.trip}`, asOf: new Date(now).toISOString(), trips: [c] } : null;
}
// arriving first (soonest ETA), then delivered (most recent first)
function order(trips) {
  const next = (c) => Math.min(...c.stops.filter((s) => !s.delivered && s.etaMs).map((s) => s.etaMs), Infinity);
  const lastDel = (c) => c.stops.map((s) => s.deliveredLocal || '').sort().pop() || '';
  return [...trips.filter((c) => c.status === 'active').sort((a, b) => next(a) - next(b)), ...trips.filter((c) => c.status === 'delivered').sort((a, b) => lastDel(b).localeCompare(lastDel(a)))];
}

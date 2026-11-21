// ---------------------------------------------------------------
// The stops a company driver works through in the driver app: one list, one screen, whatever the load has.
//   · a trip sheet → its delivery stops in its order (address, appointment, receiving hours, call-aheads, notes), each with the
//     TruckMate bills for its city; a TruckMate city the sheet doesn't have is added after, so no stop is ever dropped
//   · no trip sheet → TruckMate's bills, one stop per customer, in route order from where the load started (the same distance
//     order the console's ETAs use; places come from the saved zip lookups — nothing is asked from ARTIS)
// The step key stays the TruckMate stop label ("SOUTH WINDSOR, CT, 06074") wherever one customer has the city, so check-ins
// already tapped keep matching; a second customer in the same city gets "label · customer". Pure.
// ---------------------------------------------------------------
import { ltlStops } from './stopflow.js';

const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const labelOf = (b) => String(b.endZoneDescription || b.endZone || '').trim();
const cityKey = (x) => String(x || '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
const labelCity = (label) => cityKey(String(label).split(',')[0]);
const zipOf = (x) => (String(x || '').match(/\b(\d{5})\b/) || [])[1] || null;
const cleanName = (x) => String(x || '').replace(/\s*\*+\s*$/, '').trim();
const MIAMI = { lat: 25.82, lng: -80.32 };
const miles = (a, b) => { const R = 3958.8; const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const billRow = (b) => ({ bill: String(b.billNumber || b.bill || ''), pieces: Number(b.pieces) || 0 });
const done = (bs) => bs.length > 0 && bs.every((b) => !!b.actualDelivery);

// → [{ key, number, name, place, address, appt, receivingHours, callAhead, instructions, references, boxes, sheetBoxes, bills, delivered, source }]
export function driverStops(item, { geo = {} } = {}) {
  const bills = billsOf(item).filter((b) => labelOf(b));
  const raw = ((item && item._manifest && item._manifest.stops) || []).filter((s) => s && /DELIVER/i.test(s.action || ''));
  const sheet = ltlStops(item);
  if (sheet && sheet.length) {
    const taken = new Set();
    const cityCount = new Map();
    const matched = sheet.map((s, i) => {
      const r = raw[i] || {};
      const cities = [cityKey(s.city), labelCity(r.tmPlace || '')].filter(Boolean);
      const mine = bills.filter((b) => cities.includes(labelCity(labelOf(b))));
      const label = mine.length ? labelOf(mine[0]) : null;
      if (label) cityCount.set(label, (cityCount.get(label) || 0) + 1);
      return { s, r, mine, label };
    });
    const out = matched.map(({ s, r, mine, label }, i) => {
      mine.forEach((b) => taken.add(b));
      const place = label ? label.replace(/,\s*\d{5}(-\d{4})?\s*$/, '') : [s.city, s.state].filter(Boolean).join(', ');
      // the count the driver checks against: the trip sheet's (Nov 21), else TruckMate's bills
      const billBoxes = mine.length ? mine.reduce((n, b) => n + (Number(b.pieces) || 0), 0) : null;
      // the stop's boxes and pallets as printed — the trip sheet's; a stop only ARTIS's Truck Builder listed is ARTIS's count; when
      // the printed sheet and ARTIS differ, the sheet's number wins (Nov 21)
      const sp = piecesOf(s.piecesText, s.boxes);
      const fromArtis = s.from === 'ARTIS';
      const sheetN = s.sheetPieces != null ? s.sheetPieces : sp.boxes != null ? sp.boxes : sp.pallets != null ? 0 : null;   // pallets only: no loose boxes
      return { key: label && cityCount.get(label) === 1 ? label : s.key, number: i + 1, name: s.customer || (mine[0] && cleanName(mine[0].billToName)) || null, place, address: s.address || null, zip: s.zip || zipOf(label) || zipOf(s.address) || null,
        appt: s.appt || null, receivingHours: s.receivingHours || null, callAhead: s.callAhead || [], instructions: s.instructions || [], references: s.references || [],
        boxes: sheetN != null ? sheetN : billBoxes, pallets: sp.pallets, boxesFrom: sheetN != null || sp.pallets != null ? (fromArtis ? 'ARTIS' : 'trip sheet') : 'TruckMate', billBoxes, sheetBoxes: s.boxes, bills: mine.map(billRow), delivered: done(mine), source: 'trip sheet', zip: s.zip || zipOf(label) || null, tmPlace: r.tmPlace || null };
    });
    // a TruckMate stop the trip sheet doesn't list: still the driver's stop
    const left = bills.filter((b) => !taken.has(b));
    return [...out, ...withArtis(fromBills(left, { geo, start: out.length }), item)];
  }
  return withArtis(fromBills(bills, { geo, start: 0, origin: zipOf(tripOf(item).origZoneDesc || tripOf(item).origin), tb: (item && item._tb && item._tb.stops) || [] }), item);
}

// TruckMate bills → one stop per customer: in ARTIS's delivery order when Truck Builder has the truck (Nov 21 — its stops are in
// LOADING order, so delivery = count + 1 − order, as truckbuilder.js reads it), the rest nearest to where the load started. Pure.
function fromBills(bills, { geo = {}, start = 0, origin = null, tb = [] }) {
  const groups = new Map();
  for (const b of bills) {
    const label = labelOf(b); const who = cleanName(b.billToName) || null;
    const k = `${label}|${cityKey(who)}`;
    const g = groups.get(k) || { label, name: who, bills: [] };
    g.bills.push(b); groups.set(k, g);
  }
  const perLabel = new Map(); for (const g of groups.values()) perLabel.set(g.label, (perLabel.get(g.label) || 0) + 1);
  const o = (origin && geo[origin]) || MIAMI;
  const dist = (g) => { const p = geo[zipOf(g.label)]; return p && p.lat != null ? miles(o, p) : Infinity; };
  const n = tb.length;
  const seqOf = (g) => {
    const here = tb.filter((t) => cityKey(t.city) === labelCity(g.label));
    const t = here.length === 1 ? here[0] : here.find((x) => (cityKey(x.consignee).split(' ')[0] || '-') === (cityKey(g.name).split(' ')[0] || '+'));
    return t && t.order ? n + 1 - t.order : null;
  };
  const list = [...groups.values()].map((g, i) => ({ g, i, d: dist(g), q: n ? seqOf(g) : null }))
    .sort((a, b) => ((a.q == null) - (b.q == null)) || (a.q != null && b.q != null ? a.q - b.q : 0) || (a.d - b.d) || (a.i - b.i));
  return list.map(({ g, q }, k) => ({ key: perLabel.get(g.label) === 1 ? g.label : `${g.label} · ${g.name || 'customer'}`, number: start + k + 1, name: g.name, place: g.label.replace(/,\s*\d{5}(-\d{4})?\s*$/, ''),
    address: null, appt: null, receivingHours: null, callAhead: [], instructions: [], references: [], boxes: g.bills.reduce((s, b) => s + (Number(b.pieces) || 0), 0), sheetBoxes: null,
    bills: g.bills.map(billRow), delivered: done(g.bills), source: 'TruckMate', zip: zipOf(g.label), cityLabel: g.label, ...(n ? { orderFrom: q != null ? 'ARTIS' : 'distance' } : {}) }));
}

// No trip sheet: the boxes ARTIS listed for that customer the first time it read the trip (artisweb.js — read twice a day for
// every active run, the count kept from the first read) — else TruckMate's bills. Matched by city and the customer's name. Pure.
const word1 = (x) => cityKey(x).split(' ')[0] || '';
function withArtis(stops, item) {
  const art = ((item && item._artisEta && item._artisEta.stops) || []).filter((a) => a && a.city);
  if (!art.length) return stops;
  return stops.map((s) => {
    const inCity = art.filter((a) => cityKey(a.city) === labelCity(s.cityLabel || s.place || s.key));
    const a = inCity.length === 1 ? inCity[0] : inCity.find((x) => word1(x.name) && word1(x.name) === word1(s.name));
    const n = a ? (a.first && a.first.boxes != null ? a.first.boxes : a.boxes) : null;
    return n != null && Number(n) > 0 ? { ...s, billBoxes: s.boxes, boxes: Number(n), boxesFrom: 'ARTIS', pallets: a.first && a.first.pallets != null ? a.first.pallets : a.pallets } : { ...s, boxesFrom: 'TruckMate' };
  });
}

// The trip sheet's pieces as printed ("68 BOXES + 1 PALLET", "2 PALLETS", or just a number) → { boxes, pallets }. Pure.
export function piecesOf(text, pieces = null) {
  const t = String(text || '').toUpperCase();
  const pallets = (() => { const all = [...t.matchAll(/(\d+)\s*(?:PALLETS?|PLTS?|SKIDS?)\b/g)].map((m) => Number(m[1])); return all.length ? all.reduce((a, b) => a + b, 0) : null; })();
  const boxes = (() => { const all = [...t.matchAll(/(\d+)\s*(?:BOXES|BOX|BXS?|CASES?|PCS|PIECES)\b/g)].map((m) => Number(m[1])); return all.length ? all.reduce((a, b) => a + b, 0) : null; })();
  const num = pieces != null && pieces !== '' && Number.isFinite(Number(pieces)) ? Number(pieces) : null;
  if (boxes != null || pallets != null) return { boxes: boxes != null ? boxes : (pallets != null && num != null && num !== pallets ? num : null), pallets };
  return { boxes: num, pallets: null };
}

// A step on a stop of a city shared by several customers ("arrived:LABEL · NAME") → the city step too, once, so the progress
// emails (which go by city) still see it. Pure. → extra step or null
export function cityStep(step, stops) {
  const m = String(step || '').match(/^(arrived|delivered):(.+)$/);
  if (!m) return null;
  const s = stops.find((x) => x.key === m[2]);
  if (!s || !s.cityLabel || s.cityLabel === s.key) return null;
  return `${m[1]}:${s.cityLabel}`;
}

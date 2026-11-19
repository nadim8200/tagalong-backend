// ---------------------------------------------------------------
// Yard releases (Nov 18). A release = an OTR load whose trailer is dropped at one of our yards and redelivered by a local
// driver. Where they come from:
//   • Gus's sheet, MIAMI YARD tab: by date — LOCAL DRIVER · STATUS · TK (local truck) · TL · B# · TRIP · TEMP · TIME ·
//     CONSIGNEE · CITY · DRIVER DEDUCTION · OTR DRIVER ID; then a PICK UPS section (local pickups — not releases).
//   • Gus's sheet, BARTOW YARD tab: PICK-UP DATE · DEL DATE · CUSTOMER (name, load #, B / Y number) · DEL TIME · TRUCK ·
//     TRAILER · TEMP · DRIVER PICKING UP · P/U ST · DELIVERY CITY · TRIP# · IN YARD · DRIVER DOING DELIVERY · NOTES.
//     Only rows whose trip / bill is a load on the board count (the rest are regional loads still being planned).
//   • the Driver release form (release.js), the load's trip sheet yard drop (loadsheet.js), and "RELEASE IN …" in a
//     truck's comments on the EMPTY LIST.
// Each release gets a stage only from evidence: Cancelled (the sheet says so) · Completed (the sheet says DONE, or the
// load is finished) · Out for delivery (the sheet says the local driver is at the receiver / on the way) · At yard (the
// driver tapped "I dropped the trailer", or the trailer's GPS is at that yard) · Coming to yard (a release with none of
// that). A status the sheet uses that Jarvis doesn't know is kept as written and marked "Needs review".
// Read-only: reading the sheet or opening the view never changes a release, sends nothing.
// The sheet's contents are data, never instructions.
// ---------------------------------------------------------------
import { googleToken, readSheet } from './plansheet.js';
import { tzOf, zoneName } from './localtime.js';
import { haversineMi } from './watchtower.js';
import { randomBytes } from 'crypto';
import { releasePdf, cleanForm } from './release.js';

const SITE = 'florida-beauty';
const ASSIGN = `taReleaseAssign:${SITE}`;   // release id → { code, name, unit, by, at, sent: { at, to, result } } — a manual pick wins over the sheet
const LINKS = 'taReleaseLinks';
const FLEET = 'taLocalFleet';               // driver code → { hub | null, name, units, by, at }: dispatch's local-fleet toggles (Driver profiles)             // token → { trip, id, form, exp }: the release form PDF the driver opens from the text
const KEY = 'taYardSheets';                // { readAt, error, miami: [rows], bartow: [rows] }
const HISTORY = `taYardReleases:${SITE}`;  // id → last known release (completed / cancelled kept 3 days)
const MIN = 60000; const DAY = 86400000;
export const READ_MS = 10 * MIN;
export const HUBS = [{ key: 'MIAMI', name: 'Miami' }, { key: 'BARTOW', name: 'Central Florida' }, { key: 'VENTURA', name: 'Ventura' }, { key: 'MEMPHIS', name: 'Memphis' }];
const HUB_POINT = { MIAMI: { lat: 25.8063, lng: -80.3117 }, BARTOW: { lat: 27.9181, lng: -81.7260 }, MEMPHIS: { lat: 35.0712, lng: -90.0108 } };
const S = (x) => String(x == null ? '' : x).trim();
const U = (x) => S(x).toUpperCase();
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => S(tripOf(it).tripNumber);
const billKey = (b) => U(b).replace(/[^A-Z0-9]/g, '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const BILL_RE = /\b([BTYR])\s?-?(\d{6})\b|\b(M\d{7})\b/gi;
const billsIn = (txt) => [...S(txt).matchAll(BILL_RE)].map((m) => (m[3] ? U(m[3]) : `${U(m[1])}${m[2]}`));
const cell = (row, i) => (i >= 0 ? S((row || [])[i]) : '');
const headIdx = (head, re) => head.findIndex((h) => re.test(U(h)));

// The local drivers who redeliver releases, by yard. Miami: the fuel-card list (unit · driver ID · name), Nov 18; Bartow: the
// regional drivers at the top of the BARTOW YARD tab. Cells come from their driver profile (Samsara / Driver profiles).
export const LOCAL_DRIVERS = {
  MIAMI: [['4712', 'Leandro Pineda', ['605']], ['6748', 'Eduardo Castillo', ['932']], ['0992', 'Yordan Gonzalez', ['936']], ['5395', 'Javier Castano', ['933']],
    ['5008', 'Jose Garcia', ['934', '2402']], ['0956', 'Alexis Cala', ['936']], ['7522', 'Santonio Miller', ['933']], ['4065', 'Brian Reyes', ['939']],
    ['1344', 'Julio Hernandez', ['935']], ['2811', 'Yordani Calzadilla', ['930']], ['7014', 'Thomas Fuentes', ['2005']], ['0511', 'Luis Perez', ['602']],
    ['8212', 'Joel Pando', ['936']], ['9415', 'Manuel Umanzor', ['602']], ['6918', 'Giraldo Thaureaux', []]],
  BARTOW: [['0243', 'Herlan Quintana', ['987']], ['5318', 'Luis Montiel', ['1909']], ['3338', 'Jorge Rodriguez', []], ['4009', 'Thaddeus Casey', []],
    ['5656', 'Osvaldo Delgado', ['4563']], ['7245', 'Romane Williams', []], ['1727', 'Bramha Maharaj', []], ['5149', 'Fritz Frederic', ['2003']]],
};
// A yard's local drivers: the lists above, changed by the Driver profiles toggle (a driver added to a yard, moved, or taken off). Pure.
const pad4 = (c) => String(c || '').trim().padStart(4, '0');
export function localsFor(hub, fleet = {}) {
  const out = new Map();
  for (const [h, list] of Object.entries(LOCAL_DRIVERS)) for (const [code, name, units] of list) { const f = fleet[pad4(code)]; const at = f ? f.hub : h; if (at === hub) out.set(code, { code, name: (f && f.name) || name, units: (f && f.units && f.units.length ? f.units : units) }); }
  for (const [code, f] of Object.entries(fleet)) if (f && f.hub === hub && !out.has(code)) out.set(code, { code, name: f.name || `Driver ${code}`, units: f.units || [] });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// Every driver's local yard (or null). Pure.
export function fleetOf(fleet = {}) {
  const out = {};
  for (const [h, list] of Object.entries(LOCAL_DRIVERS)) for (const [code] of list) out[code] = h;
  for (const [code, f] of Object.entries(fleet)) out[code] = f ? f.hub || null : null;
  return out;
}
// The sheet's name for the local driver ("YORDAN G", "LUIS P", "JOSE GARCIA", "HERLAN QUINTANA") → one driver on that yard's list,
// by first name + last name (or its first letter); an ID in the cell wins. Two possible → null (never a guess). Pure.
export function matchLocal(txt, hub, id = null, fleet = {}) {
  const list = localsFor(hub, fleet);
  if (id) { const d = list.find((x) => x.code === String(id).padStart(4, '0')); if (d) return d; }
  const w = U(txt).replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return null;
  const hits = list.filter((d) => { const n = U(d.name).split(/\s+/); return n[0] === w[0] && (w.length === 1 || n.slice(1).some((x) => x === w[1] || (w[1].length === 1 && x.startsWith(w[1])))); });
  return hits.length === 1 ? hits[0] : null;
}

// a date cell → { y, m, d } (11/20/2026, Thu 11/19, 11/19). year: the one to use when the cell has none. Pure.
export function dateOf(x, year) {
  const m = S(x).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
  return { y, m: Number(m[1]), d: Number(m[2]) };
}
const pad = (n) => String(n).padStart(2, '0');
const timeOf = (x) => { const m = S(x).match(/(\d{1,2}):(\d{2})\s*([AP])M/i); if (!m) return null; let h = Number(m[1]) % 12; if (/p/i.test(m[3])) h += 12; return `${pad(h)}:${m[2]}`; };

// MIAMI YARD tab → rows. Pure.
export function parseMiami(rows = [], { year = new Date().getFullYear() } = {}) {
  const hi = rows.findIndex((r) => (r || []).some((c) => /^B#$/i.test(S(c))) && (r || []).some((c) => /^TRIP$/i.test(S(c))));
  if (hi < 0) return [];
  const head = rows[hi].map(S);
  const col = { driver: headIdx(head, /LOCAL DRIVER/), status: headIdx(head, /^STATUS$/), tk: headIdx(head, /^TK$/), tl: headIdx(head, /^TL$/), bill: headIdx(head, /^B#$/), trip: headIdx(head, /^TRIP$/),
    temp: headIdx(head, /^TEMP/), time: headIdx(head, /^TIME$/), consignee: headIdx(head, /CONSIGNEE/), city: headIdx(head, /^CITY$/), deduction: headIdx(head, /DEDUCTION/), otr: headIdx(head, /OTR DRIVER/) };
  const out = []; let date = null; let section = 'release';
  rows.slice(hi + 1).forEach((r, k) => {
    const filled = (r || []).map(S).filter(Boolean);
    if (filled.length === 1 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(filled[0])) { date = dateOf(filled[0], year); section = 'release'; return; }
    if (filled.length === 1 && /PICK\s*-?\s*UPS?/i.test(filled[0])) { section = 'pickup'; return; }
    const bill = U(cell(r, col.bill)).replace(/\s+/g, ''); const trip = cell(r, col.trip).replace(/\D/g, '');
    if (!bill && !trip) return;
    out.push({ sheet: 'MIAMI YARD', row: hi + 2 + k, hub: 'MIAMI', section, date, time: cell(r, col.time) || null, localDriver: cell(r, col.driver) || null, status: cell(r, col.status) || null,
      localTruck: cell(r, col.tk) || null, trailer: cell(r, col.tl) || null, bill: bill || null, trip: trip || null, temp: cell(r, col.temp) || null,
      consignee: cell(r, col.consignee) || null, city: cell(r, col.city) || null, state: null, deduction: cell(r, col.deduction) || null,
      otrDriverIds: cell(r, col.otr).split(/\s+/).filter(Boolean), notes: null, otrTruck: null, otrDriver: null, inYard: null });
  });
  return out;
}

// BARTOW YARD tab → rows. Pure.
export function parseBartow(rows = [], { year = new Date().getFullYear() } = {}) {
  const hi = rows.findIndex((r) => (r || []).some((c) => /DEL DATE/i.test(S(c))) && (r || []).some((c) => /TRIP#?/i.test(S(c))));
  if (hi < 0) return [];
  const head = rows[hi].map(S);
  const col = { pick: headIdx(head, /PICK-?\s*UP DATE/), del: headIdx(head, /DEL DATE/), customer: headIdx(head, /^CUSTOMER$/), time: headIdx(head, /DEL TIME/), truck: headIdx(head, /^TRUCK$/),
    trailer: headIdx(head, /^TRAILER$/), temp: headIdx(head, /^TEMP/), otrDriver: headIdx(head, /DRIVER PICKING UP/), city: headIdx(head, /DELIVERY CITY/), trip: headIdx(head, /^TRIP#?$/),
    inYard: headIdx(head, /IN YARD/), local: headIdx(head, /DRIVER DOING DELIVERY/), notes: headIdx(head, /^NOTES$/) };
  const out = []; let section = null;
  rows.slice(hi + 1).forEach((r, k) => {
    const filled = (r || []).map(S).filter(Boolean);
    if (filled.length === 1 && !/\d{3,}/.test(filled[0])) { section = filled[0]; return; }
    const cust = cell(r, col.customer);
    if (!cust || /DROP\s*&\s*HOOK/i.test(`${cell(r, col.del)} ${cust}`)) return;
    const lines = cust.split(/\n+/).map(S).filter(Boolean);
    const trip = cell(r, col.trip).replace(/\D/g, '');
    const bills = billsIn(cust);
    const local = cell(r, col.local);
    const lm = local.match(/TK\s*#?\s*(\w+)\s*\/?\s*([^(]+?)\s*(?:\((\d+)\))?\s*$/i);
    const city = cell(r, col.city).split(/\n+/).map(S).filter(Boolean).pop() || '';
    const cm = city.match(/^(.*?),\s*([A-Z]{2})$/i);
    const d = dateOf(cell(r, col.del).split(/\n+/).filter((x) => !/^\s*$/.test(x) && !/~|strike/i.test(x)).pop(), year);
    out.push({ sheet: 'BARTOW YARD', row: hi + 2 + k, hub: 'BARTOW', section, date: d, time: (cell(r, col.time).split(/\n+/).map(S).filter(Boolean).pop()) || null,
      localDriver: lm ? S(lm[2]) : (/OTR/i.test(local) ? null : (local || null)), localTruck: lm ? lm[1] : null, localDriverId: lm && lm[3] ? lm[3] : null, otrDelivers: /OTR DRIVER/i.test(local),
      status: null, inYard: cell(r, col.inYard) || null, trailer: cell(r, col.trailer).replace(/\?+/g, '') || null, bill: bills[0] || null, trip: trip || null, temp: cell(r, col.temp) || null,
      consignee: lines[0] || null, refs: lines.slice(1), city: cm ? cm[1] : city || null, state: cm ? U(cm[2]) : null,
      otrTruck: cell(r, col.truck).replace(/\?+/g, '') || null, otrDriver: cell(r, col.otrDriver) || null, notes: cell(r, col.notes) || null, otrDriverIds: [], deduction: null });
  });
  return out;
}

// What the sheet's status says. → { stage, review } . Pure.
export function sheetStage(status) {
  const s = U(status);
  if (!s) return null;
  if (/CANCEL/.test(s)) return { stage: 'cancelled' };
  if (/^DONE\b|DELIVERED|COMPLETE/.test(s)) return { stage: 'completed' };
  if (/AT RECEIVER|EN ROUTE|ON THE WAY|OUT FOR DELIVERY|ROLLING/.test(s)) return { stage: 'out' };
  if (/AT (THE )?YARD|DROPPED|IN YARD/.test(s)) return { stage: 'at-yard' };
  return { review: true };
}
const hubFromText = (t) => { const s = U(t); return /VENTURA|OXNARD/.test(s) ? 'VENTURA' : /MEMPHIS/.test(s) ? 'MEMPHIS' : /BARTOW|CENTRAL|CFL/.test(s) ? 'BARTOW' : /MIAMI|MEDLEY|DORAL/.test(s) ? 'MIAMI' : null; };
export const HUB_KEYS = { Miami: 'MIAMI', Ventura: 'VENTURA', Memphis: 'MEMPHIS', 'Central Florida (Bartow)': 'BARTOW' };

// Everything we know → the releases. Pure.
// sheets: { miami, bartow } rows · items: the board · trailerHubs: trailer → { hub, at, source } · plan: { sheetNotes }
// history: id → last release seen (for completed / cancelled ones whose load left the board) · finished: trip → { at, reason }
export function buildReleases({ sheets = {}, items = [], trailerHubs = {}, plan = {}, history = {}, finished = {}, assignments = {}, fleet = {}, now = Date.now() } = {}) {
  const byTrip = new Map(items.map((it) => [tripNo(it), it]));
  const byBill = new Map(); items.forEach((it) => billsOf(it).forEach((b) => { const k = billKey(b && b.billNumber); if (k) byBill.set(k, it); }));
  const found = (r) => (r.trip && byTrip.get(r.trip)) || (r.bill && byBill.get(billKey(r.bill))) || null;
  const out = new Map();
  const put = (id, rec) => { const cur = out.get(id); out.set(id, cur ? { ...cur, ...Object.fromEntries(Object.entries(rec).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))), sources: [...cur.sources, ...rec.sources] } : rec); };
  const recent = (d) => !d || (now - Date.UTC(d.y, d.m - 1, d.d) < 7 * DAY && Date.UTC(d.y, d.m - 1, d.d) - now < 21 * DAY);
  const rowSource = (r) => ({ name: r.sheet === 'MIAMI YARD' ? 'Miami yard sheet' : 'Bartow yard sheet', status: r.status || r.inYard || null, row: r.row });
  for (const r of [...(sheets.miami || []), ...(sheets.bartow || [])]) {
    if (r.section === 'pickup' || !recent(r.date)) continue;
    const it = found(r);
    if (r.sheet === 'BARTOW YARD' && !it && !(history[`${r.trip || ''}|${r.bill || ''}`])) continue;   // a regional load still being planned, not a release
    const trip = r.trip || (it ? tripNo(it) : null);
    put(`${trip || ''}|${r.bill || ''}`, { trip, bill: r.bill || null, hub: r.hub, row: r, item: it, sources: [rowSource(r)] });
  }
  for (const it of items) {
    const n = tripNo(it);
    const rel = it._release; const ls = it._loadSheet && it._loadSheet.release;
    const mine = [...out.values()].some((x) => x.trip === n);
    if (rel && rel.hub) {
      if (mine) for (const [id, x] of out) { if (x.trip === n) out.set(id, { ...x, form: rel, sources: [...x.sources, { name: 'Release form', at: rel.at, by: rel.by }] }); }
      else put(`${n}|`, { trip: n, bill: null, hub: rel.hub, item: it, form: rel, sources: [{ name: 'Release form', at: rel.at, by: rel.by }] });
    }
    if (ls && ls.yard) {
      const hub = hubFromText(ls.yard);
      if (hub) {
        if ([...out.values()].some((x) => x.trip === n)) for (const [id, x] of out) { if (x.trip === n) out.set(id, { ...x, drop: ls.dropped || x.drop || null, sources: [...x.sources, { name: 'Trip sheet yard drop', at: ls.dropped ? ls.dropped.at : null }] }); }
        else put(`${n}|`, { trip: n, bill: null, hub, item: it, drop: ls.dropped || null, sources: [{ name: 'Trip sheet yard drop', at: ls.dropped ? ls.dropped.at : null }] });
      }
    }
  }
  // the EMPTY LIST: "RELEASE IN VENTURA" in a truck's comments → that truck's load on the road now
  for (const [truck, txt] of Object.entries(plan.sheetNotes || {})) {
    const m = U(txt).match(/RELEASE\s+(?:IN|AT)\s+([A-Z ]+?)(?=\s*(?:THEN\b|·|$))/);
    const hub = m && hubFromText(m[1]); if (!hub) continue;
    const it = items.find((x) => U(tripOf(x).powerUnit).replace(/^0+/, '') === U(truck) && /^(DEPSHIP|INTRAN|ENROUTE|ARRCONS|DEPCONS)/i.test(S(tripOf(x).status)));
    if (!it || [...out.values()].some((x) => x.trip === tripNo(it))) continue;
    put(`${tripNo(it)}|`, { trip: tripNo(it), bill: null, hub, item: it, sources: [{ name: 'Empty list', text: S(txt).slice(0, 120) }] });
  }
  const list = [];
  for (const [id, x] of out) list.push(shape(id, x, { trailerHubs, finished, assignments, fleet, now }));
  // completed / cancelled ones whose rows aged off or whose load left the board: kept for 3 days
  for (const [id, h] of Object.entries(history)) {
    if (list.some((x) => x.id === id)) continue;
    if ((h.stage === 'completed' || h.stage === 'cancelled') && now - Date.parse(h.seenAt || 0) < 3 * DAY) list.push({ ...h, fromHistory: true });
  }
  return list;
}

// The load's temperature (the sheet, else what TruckMate / the rate con require) and the trailer's reading now (the board's
// load temp — Samsara / Thermo King — else the trailer's own Thermo King unit). in range: within 5°F of what the load needs
// (the flower rule). Pure.
const num = (x) => { const m = S(x).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
export function tempsOf(r = {}, it = null, gps = null, lastBill = {}, rc = {}, now = Date.now()) {
  const lt = (it && it._loadTemp) || {};
  const tg = lt.target || null;
  const loadText = S(r.temp) || (tg && tg.minF != null ? (tg.minF === tg.maxF ? `${tg.minF}°F` : `${tg.minF}–${tg.maxF}°F`) : null) || (lastBill.temperature != null ? `${lastBill.temperature}°F` : null) || S(rc.tempSetting) || null;
  const dry = /DRY/i.test(loadText || '');
  const loadF = dry ? null : num(loadText);
  const c = lt.current || null;
  const cur = c && c.readingF != null ? { f: Number(c.readingF), setF: c.setF != null ? Number(c.setF) : null, source: c.source || null, at: c.at || null }
    : gps && gps.returnF != null ? { f: Number(gps.returnF), setF: gps.setF != null ? Number(gps.setF) : null, source: 'Thermo King', at: gps.at || null, powerOn: gps.powerOn } : null;
  const ageMin = cur && cur.at ? Math.round((now - Date.parse(cur.at)) / MIN) : null;
  const off = cur && loadF != null ? Math.round((cur.f - loadF) * 10) / 10 : null;
  return {
    loadText: loadText ? loadText.replace(/\s*°?\s*F$/i, '°F') : null, loadF, dry,
    currentF: cur ? Math.round(cur.f * 10) / 10 : null, setF: cur ? cur.setF : null, source: cur ? cur.source : null, at: cur ? cur.at : null, ageMin, powerOn: cur && cur.powerOn != null ? cur.powerOn : null,
    offF: off, inRange: off == null ? null : Math.abs(off) <= 5, stale: ageMin != null && ageMin > 120,
  };
}

function shape(id, x, { trailerHubs, finished, assignments = {}, fleet = {}, now }) {
  const r = x.row || {}; const it = x.item; const t = tripOf(it);
  const trailer = S(r.trailer || t.trailer) || null;
  const issues = [];
  // stage from evidence, most final first
  const ss = sheetStage(r.status);
  const fin = x.trip && finished[x.trip] && !finished[x.trip].reopened ? finished[x.trip] : null;
  const gps = trailer && trailerHubs[U(trailer).replace(/^0+(?=\d)/, '')];
  const relAt = Date.parse((x.form && x.form.at) || '') || 0;
  const atYardGps = gps && gps.hub && gps.hub === x.hub && (!relAt || Date.parse(gps.at || 0) >= relAt - 6 * 3600000);
  let stage; let evidence = null;
  if (ss && ss.stage === 'cancelled') { stage = 'cancelled'; evidence = `${r.sheet === 'BARTOW YARD' ? 'Bartow' : 'Miami'} yard sheet: ${r.status}`; }
  else if (ss && ss.stage === 'completed') { stage = 'completed'; evidence = `${r.sheet === 'BARTOW YARD' ? 'Bartow' : 'Miami'} yard sheet: ${r.status}`; }
  else if (fin) { stage = 'completed'; evidence = `Load finished — ${fin.reason || 'delivered'}`; }
  else if (ss && ss.stage === 'out') { stage = 'out'; evidence = `${r.sheet === 'BARTOW YARD' ? 'Bartow' : 'Miami'} yard sheet: ${r.status}`; }
  else if (x.drop && x.drop.at) { stage = 'at-yard'; evidence = `Driver tapped "I dropped the trailer" (${x.drop.by || 'driver'})`; }
  else if (atYardGps) { stage = 'at-yard'; evidence = `Trailer ${trailer} GPS at the yard (${gps.source || 'GPS'})`; }
  else if (ss && ss.stage === 'at-yard') { stage = 'at-yard'; evidence = `${r.sheet === 'BARTOW YARD' ? 'Bartow' : 'Miami'} yard sheet: ${r.status}`; }
  else { stage = 'coming'; evidence = null; }
  const review = !!(ss && ss.review);
  if (review) issues.push(`The sheet's status "${r.status}" isn't one Jarvis knows — check it`);
  if (ss && ss.stage === 'completed' && it && !fin && /^(DISP|ASSGN|ARRSHIP|DEPSHIP|INTRAN|ENROUTE)/i.test(S(t.status))) issues.push(`The sheet says ${r.status}; TruckMate still shows trip ${x.trip} as ${t.status}`);
  if (stage === 'coming' && gps && gps.hub && gps.hub !== x.hub) issues.push(`Trailer ${trailer} GPS shows it at the ${HUBS.find((h) => h.key === gps.hub).name} yard, not ${HUBS.find((h) => h.key === x.hub).name}`);
  if (!it && stage !== 'completed' && stage !== 'cancelled') issues.push(x.trip ? `Trip ${x.trip} isn't on Active trips` : 'No trip # on the sheet and the bill isn\'t on a load on the board');
  // the delivery appointment: the sheet's date + time, in the destination's time zone (Miami-yard redeliveries are local)
  const state = r.state || (x.hub === 'MIAMI' || x.hub === 'BARTOW' ? 'FL' : null);
  const lastBill = billsOf(it).slice(-1)[0] || {};
  const place = state ? `${r.city || ''}, ${state}` : S(lastBill.endZoneDescription) || null;
  const tz = place ? tzOf(place) : null;
  const hm = timeOf(r.time);
  const appt = r.date ? { date: `${r.date.y}-${pad(r.date.m)}-${pad(r.date.d)}`, time: hm, tz, zone: tz ? zoneName(tz) : null, raw: [r.time].filter(Boolean).join(' ') || null } : null;
  const sam = (it && it._samsara) || {};
  const hp = HUB_POINT[x.hub];
  const miles = hp && sam.lat != null ? Math.round(haversineMi(Number(sam.lat), Number(sam.lng), hp.lat, hp.lng)) : null;
  const rc = (it && it._ratecon && (it._ratecon.data || it._ratecon)) || {};
  const temps = tempsOf(r, it, gps, lastBill, rc, now);
  return {
    id, hub: x.hub, stage, evidence, review, issues,
    sourceStatus: r.status || null, inYard: r.inYard || null,
    trip: x.trip || null, bill: x.bill || (billsOf(it)[0] && billsOf(it)[0].billNumber) || null, bills: billsOf(it).map((b) => b && b.billNumber).filter(Boolean).slice(0, 6), trailer,
    customer: r.consignee || S(lastBill.consigneeName || (lastBill.consignee && lastBill.consignee.name)) || null, city: r.city || null, state: r.state || state,
    destination: r.city ? [r.city, r.state || state].filter(Boolean).join(', ') : (S(lastBill.endZoneDescription) || null),
    temp: r.temp || (lastBill.temperature != null ? `${lastBill.temperature}F` : null) || (rc.tempSetting || null),
    appt, temps,
    local: localOf(r, x.hub, assignments[id], fleet),
    otr: { truck: S(t.powerUnit) || r.otrTruck || null, driver: sam.driver1 || r.otrDriver || null, driverIds: r.otrDriverIds && r.otrDriverIds.length ? r.otrDriverIds : [t.driver, t.driver2].map(S).filter(Boolean), status: S(t.status) || null, location: sam.location || null, gpsAt: sam.gpsAt || null, milesToYard: miles },
    yard: { name: (HUBS.find((h) => h.key === x.hub) || {}).name || x.hub, eta: null, drop: x.drop && x.drop.at ? { at: x.drop.at, by: x.drop.by || null, source: 'Driver app' } : atYardGps ? { at: gps.at, source: gps.source || 'GPS' } : null },
    notes: [r.notes, r.refs && r.refs.length ? `Refs: ${r.refs.join(' · ')}` : null].filter(Boolean),
    form: x.form ? { at: x.form.at, by: x.form.by || null, hub: x.form.hub } : null,
    sources: x.sources, onBoard: !!it, seenAt: new Date(now).toISOString(),
  };
}

// The local driver: a manual pick in the console wins; else the yard sheet's name matched to the yard's list (else as written). Pure.
export function localOf(r = {}, hub, a = null, fleet = {}) {
  const base = { otrDelivers: !!r.otrDelivers, deduction: r.deduction || null, sheetName: r.localDriver || null, sent: a && a.sent ? a.sent : null };
  if (a && a.code) return { ...base, driver: a.name, truck: a.unit || null, code: a.code, how: 'manual', by: a.by || null, at: a.at || null };
  const m = r.localDriver || r.localDriverId ? matchLocal(r.localDriver, hub, r.localDriverId, fleet) : null;
  if (m) return { ...base, driver: m.name, truck: r.localTruck || m.units[0] || null, code: m.code, how: 'sheet' };
  return { ...base, driver: r.localDriver || null, truck: r.localTruck || null, code: r.localDriverId || null, how: r.localDriver ? 'sheet-unmatched' : null };
}

// The text the local driver gets: everything for the delivery, and the release form link. Pure.
export function driverText(rel, form = null, link = null, rcNotes = []) {
  const f = form || {};
  const stops = (f.stops || []).filter((x) => x && (x.consignee || x.address || x.city));
  const lines = [`Florida Beauty dispatch — release delivery for you`, `Trip ${rel.trip || '—'} · Trailer ${rel.trailer || f.trailer || '—'}${rel.bill || f.fb ? ` · Bill ${rel.bill || f.fb}` : ''}`, `Pick up the trailer at the ${rel.yard ? rel.yard.name : ''} yard`.replace('  ', ' ')];
  const apptTxt = rel.appt && rel.appt.date ? `${rel.appt.date.slice(5).replace('-', '/')}${rel.appt.raw ? ` ${rel.appt.raw}` : rel.appt.time ? ` ${rel.appt.time}` : ''}${rel.appt.zone ? ` ${({ Eastern: 'ET', Central: 'CT', Mountain: 'MT', Pacific: 'PT' })[rel.appt.zone] || ''}` : ''}` : null;
  if (stops.length) stops.forEach((x, i) => lines.push(`${stops.length > 1 ? `Stop ${i + 1}: ` : 'Deliver to: '}${[x.consignee, x.address, x.cityStateZip || [x.city, x.state].filter(Boolean).join(', ')].filter(Boolean).join(', ')}${x.date || x.time ? ` · ${[x.date, x.time].filter(Boolean).join(' ')}` : ''}`));
  else lines.push(`Deliver to: ${[rel.customer, rel.destination].filter(Boolean).join(', ') || '—'}`);
  if (apptTxt) lines.push(`Appointment: ${apptTxt}`);
  const temp = (rel.temps && rel.temps.loadText) || f.temp;
  if (temp) lines.push(`Temp: ${temp}`);
  const notes = [f.comments, ...(rel.notes || []), ...rcNotes].map(S).filter(Boolean);
  if (notes.length) lines.push(`Instructions: ${[...new Set(notes)].join(' / ')}`.slice(0, 600));
  if (link) lines.push(`Release form: ${link}`);
  lines.push('Text back here with any questions.');
  return lines.join('\n');
}

// counts per yard: active = not completed / cancelled. Pure.
export function counts(list = []) {
  const out = Object.fromEntries(HUBS.map((h) => [h.key, { active: 0, coming: 0, 'at-yard': 0, out: 0, completed: 0, cancelled: 0 }]));
  for (const r of list) { const c = out[r.hub]; if (!c) continue; c[r.stage] = (c[r.stage] || 0) + 1; if (r.stage !== 'completed' && r.stage !== 'cancelled') c.active += 1; }
  return out;
}

// The card's marker for a load being released. Pure.
export function cardMark(r) {
  return { hub: r.hub, yard: r.yard.name, stage: r.stage, review: r.review, localDriver: r.local.driver, localTruck: r.local.truck, appt: r.appt, sourceStatus: r.sourceStatus, sources: r.sources.map((s) => s.name) };
}

export function initYardReleases(app, { requireAuth, db, getBoard, trailerHubs = async () => ({}), formFor = async () => null, roster = async () => [], sendSms = null, log = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const enabled = !!(db && db.enabled);
  // read the two yard tabs (no AI — straight values)
  async function read() {
    if (!enabled || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
    const cfg = (await db.get('taPlanSheetCfg', {})) || {};
    if (!cfg.sheetId) return null;
    try {
      const { token } = await googleToken(env.GOOGLE_SERVICE_ACCOUNT_JSON, { fetchFn, now: now() });
      const sheet = await readSheet(cfg.sheetId, { token, fetchFn, only: ['MIAMI YARD', 'BARTOW YARD'] });
      const year = new Date(now()).getFullYear();
      const tab = (re) => (sheet.tabs.find((t) => re.test(t.title)) || {}).rows || [];
      const st = { readAt: new Date(now()).toISOString(), error: null, miami: parseMiami(tab(/MIAMI\s*YARD/i), { year }), bartow: parseBartow(tab(/BARTOW\s*YARD/i), { year }) };
      await db.set(KEY, st);
      return st;
    } catch (e) { await db.update(KEY, (c) => ({ ...(c || {}), error: e.message, failedAt: new Date(now()).toISOString() }), {}); return null; }
  }
  if (enabled && env.NODE_ENV !== 'test') { const t = setInterval(() => { read().catch(() => {}); }, READ_MS); if (t.unref) t.unref(); setTimeout(() => { read().catch(() => {}); }, 45000); }

  const fleetStore = async () => (enabled ? ((await db.get(FLEET, {})) || {}) : {});
  async function current(site = SITE, items = null) {
    const st = (await db.get(KEY, {})) || {};
    const trips = items || (((await getBoard(site)) || {}).trips || []);
    const list = buildReleases({ sheets: st, items: trips, trailerHubs: await trailerHubs().catch(() => ({})), plan: (await db.get(`taPlanSheet:${SITE}`, {})) || {},
      history: (await db.get(HISTORY, {})) || {}, finished: (await db.get(`taFinished:${site}`, {})) || {}, assignments: (await db.get(ASSIGN, {})) || {}, fleet: await fleetStore(), now: now() });
    return { list, readAt: st.readAt || null, error: st.error || null };
  }
  let lastKept = 0;
  // the board: a release marker on each load being released (cards), and the history kept
  async function overlay(site, trips) {
    if (!enabled) return;
    const { list } = await current(site, trips);
    const by = new Map(); list.forEach((r) => { if (r.trip && !by.has(r.trip)) by.set(r.trip, r); });
    for (const it of trips) { const r = by.get(tripNo(it)); if (r) it._yardRelease = cardMark(r); }
    if (now() - lastKept < 5 * MIN) return;   // the history is written at most every 5 min (the board builds every minute)
    lastKept = now();
    const keep = Object.fromEntries(list.filter((r) => !r.fromHistory).map((r) => [r.id, r]));
    await db.update(HISTORY, (cur) => {
      const next = { ...(cur || {}) };
      for (const [k, v] of Object.entries(keep)) next[k] = { ...v };
      for (const k of Object.keys(next)) if (now() - Date.parse(next[k].seenAt || 0) > 4 * DAY) delete next[k];
      return next;
    }, {});
  }
  // a driver's cell from their profile (Samsara / Driver profiles) and whether they replied STOP
  const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  async function cellOf(code) {
    const list = (await roster().catch(() => [])) || [];
    const d = list.find((x) => String(x.code || '').replace(/^0+/, '') === String(code).replace(/^0+/, ''));
    const phone = d ? (d.phone || ((d.phones || [])[0] && ((d.phones[0].number) || d.phones[0]))) : null;
    const out = phone ? !!((await db.get('taSmsOptOut', {})) || {})[last10(phone)] : false;
    return { phone: phone ? String(phone) : null, optedOut: out, name: d ? d.name : null };
  }
  async function message(rel, driver, withLink) {
    const ff = rel.trip ? await formFor(rel.trip).catch(() => null) : null;
    const items = (((await getBoard(SITE)) || {}).trips || []);
    const it = items.find((x) => tripNo(x) === rel.trip);
    const rc = (it && it._ratecon && (it._ratecon.data || it._ratecon)) || {};
    let link = null;
    if (withLink && ff && ff.form) {
      const token = randomBytes(16).toString('hex');
      await db.update(LINKS, (cur) => { const c = { ...(cur || {}) }; for (const k of Object.keys(c)) if (Date.parse(c[k].exp) < now()) delete c[k]; c[token] = { trip: rel.trip, id: rel.id, driver: driver.code, form: ff.form, exp: new Date(now() + 14 * DAY).toISOString() }; return c; }, {});
      link = `${(env.PUBLIC_API_BASE || 'https://tagalong-backend-fdzx.onrender.com').replace(/\/$/, '')}/release-form/${token}.pdf`;
    }
    return { text: driverText(rel, ff && ff.form, withLink ? (link || null) : '[release form link]', (rc.specialInstructions || []).map(String)), link, formSent: !!(ff && ff.sent), hasForm: !!(ff && ff.form) };
  }
  if (app && requireAuth) {
    app.get('/truckmate/releases', requireAuth, async (req, res) => {
      try { const c = await current(); const fl = await fleetStore(); res.json({ hubs: HUBS, counts: counts(c.list), releases: c.list, locals: Object.fromEntries(HUBS.map((h) => [h.key, localsFor(h.key, fl)])), readAt: c.readAt, error: c.error }); } catch (e) { res.status(502).json({ error: e.message }); }
    });
    // what the driver would get (the console shows it before sending) — sends nothing
    app.get('/truckmate/releases/message', requireAuth, async (req, res) => {
      try {
        const rel = (await current()).list.find((r) => r.id === String(req.query.id || ''));
        if (!rel) return res.status(404).json({ error: 'That release isn\'t on the list any more.' });
        const d = localsFor(rel.hub, await fleetStore()).find((x) => x.code === String(req.query.code || ''));
        if (!d) return res.status(400).json({ error: 'Pick a driver from the list.' });
        const m = await message(rel, d, false); const c = await cellOf(d.code);
        res.json({ text: m.text, hasForm: m.hasForm, formSent: m.formSent, phone: c.phone, optedOut: c.optedOut });
      } catch (e) { res.status(502).json({ error: e.message }); }
    });
    // assign a local driver (manual — it stays over what the sheet says); send: also text them the load and the release form
    app.post('/truckmate/releases/assign', requireAuth, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
      const b = req.body || {}; const id = String(b.id || '');
      const who = (req.user && (req.user.name || req.user.email)) || 'dispatch';
      try {
        const rel = (await current()).list.find((r) => r.id === id);
        if (!rel) return res.status(404).json({ error: 'That release isn\'t on the list any more.' });
        if (!b.code) { await db.update(ASSIGN, (cur) => { const c = { ...(cur || {}) }; delete c[id]; return c; }, {}); return res.json({ ok: true, cleared: true }); }
        const d = localsFor(rel.hub, await fleetStore()).find((x) => x.code === String(b.code));
        if (!d) return res.status(400).json({ error: 'Pick a driver from the list.' });
        const unit = b.unit && d.units.includes(String(b.unit)) ? String(b.unit) : d.units[0] || null;
        let sent = null;
        if (b.send) {
          const c = await cellOf(d.code);
          if (!c.phone) return res.status(400).json({ error: `No cell on file for ${d.name} — add it in Driver profiles, then send again.` });
          if (c.optedOut) return res.status(400).json({ error: `${d.name} replied STOP — texts are off for that number.` });
          if (!sendSms) return res.status(503).json({ error: 'Texting isn\'t connected.' });
          const m = await message(rel, d, true);
          const r = await sendSms({ to: c.phone, text: m.text });
          sent = { at: new Date(now()).toISOString(), to: c.phone, held: !!(r && r.id === 'training'), by: who, link: !!m.link };
          if (log && rel.trip) await log(SITE, rel.trip, { type: 'text', kind: 'release-local', to: c.phone, text: m.text, by: `${who} (release to ${d.name})`, held: sent.held }).catch(() => {});
        }
        await db.update(ASSIGN, (cur) => ({ ...(cur || {}), [id]: { code: d.code, name: d.name, unit, by: who, at: new Date(now()).toISOString(), ...(sent ? { sent } : (((cur || {})[id] || {}).sent ? { sent: cur[id].sent } : {})) } }), {});
        res.json({ ok: true, driver: d.name, unit, sent });
      } catch (e) { res.status(502).json({ error: e.message }); }
    });
  }
  // the local fleet (Driver profiles toggle): which yard each driver redelivers releases for
  if (app && requireAuth) {
    app.get('/truckmate/local-fleet', requireAuth, async (req, res) => res.json({ yards: HUBS.filter((h) => h.key === 'MIAMI' || h.key === 'BARTOW'), fleet: fleetOf(await fleetStore()) }));
    app.put('/truckmate/local-fleet/:code', requireAuth, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
      const code = pad4(String(req.params.code).replace(/\D/g, '')); const b = req.body || {};
      if (!/^\d{3,6}$/.test(code)) return res.status(400).json({ error: 'That driver ID doesn\'t look right.' });
      const hub = b.hub ? String(b.hub).toUpperCase() : null;
      if (hub && !HUBS.some((h) => h.key === hub)) return res.status(400).json({ error: 'Pick a yard.' });
      const who = (req.user && (req.user.name || req.user.email)) || 'dispatch';
      const units = (Array.isArray(b.units) ? b.units : String(b.units || '').split(/[\s,]+/)).map((x) => S(x)).filter(Boolean).slice(0, 4);
      const next = await db.update(FLEET, (cur) => ({ ...(cur || {}), [code]: { hub, name: S(b.name).slice(0, 60) || null, units, by: who, at: new Date(now()).toISOString() } }), {});
      res.json({ ok: true, code, hub, fleet: fleetOf(next) });
    });
  }
  // the release form the driver opens from the text (no login: a long random link that ends after 14 days)
  if (app) {
    app.get('/release-form/:token.pdf', async (req, res) => {
      try {
        const l = (((await db.get(LINKS, {})) || {})[String(req.params.token)]);
        if (!l || Date.parse(l.exp) < now()) return res.status(404).send('This release form link has expired. Ask dispatch to send it again.');
        const pdf = await releasePdf(cleanForm(l.form));
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Release-${l.trip || 'load'}.pdf"`, 'Cache-Control': 'no-store' });
        res.send(Buffer.from(pdf));
      } catch (e) { res.status(500).send('Could not open the release form.'); }
    });
  }
  return { read, current, overlay };
}

// ---------------------------------------------------------------
// ARTIS Truck Builder — read once a night per hub (Miami after its trip sheets, Ventura after California's)
// to check what the AI read off the SCANNED trip sheets against the digital originals: the trip sheet is a
// printout of the Truck Builder. Read-only: signs in with the ARTIS web login set in Render
// (ARTIS_WEB_USER / ARTIS_WEB_PASSWORD), reads the trucks of the night, never changes anything in ARTIS.
// One sign-in attempt per hub per night — a wrong password can't lock the account.
// ---------------------------------------------------------------
import { nameScore } from './voice.js';
import { linkSheetStops } from './manifest.js';

const SITE = 'florida-beauty';
const KEY = `taTruckBuilder:${SITE}`;
const MIN = 60000;
export const HUBS = [
  { id: 3, name: 'Miami', tz: 'America/New_York', origin: /MIAMI|,\s*FL\b|\bFL$/i },
  { id: 5, name: 'Ventura', tz: 'America/Los_Angeles', origin: /VENTURA|OXNARD|CALIF|,\s*CA\b|\bCA$/i },
];
const tripOf = (it) => (it && it.trip) || it || {};
const up = (x) => String(x == null ? '' : x).toUpperCase().replace(/\s+/g, ' ').trim();
const town = (x) => up(x).replace(/[^A-Z ]/g, '').trim();

export function webConfig(env = process.env) {
  const base = String(env.ARTIS_WEB_URL || env.ARTIS_API_URL || 'https://www.floridabeauty.com').replace(/\/+$/, '');
  return { base, user: env.ARTIS_WEB_USER || '', password: env.ARTIS_WEB_PASSWORD || '', ready: !!(env.ARTIS_WEB_USER && env.ARTIS_WEB_PASSWORD) };
}

// Local date / hour at a hub. Pure.
export function hubClock(tz, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// The Truck Builder's routes → the trucks of the night that have a TruckMate trip. Pure.
export function normalizeTrucks(routes, { hub, date, all = false } = {}) {
  const out = [];
  for (const r of Array.isArray(routes) ? routes : []) {
    for (const t of r.routeTrucks || []) {
      const info = t.truckInfo || {};
      if (!info.tripNumber && !all) continue;
      out.push({
        trip: info.tripNumber ? String(info.tripNumber) : null, hub, date, route: t.truckRouteName || r.name || null, manifest: t.truckSeqno || null,
        truck: t.truckId || null, trailer: t.trailerId || null, driver1: info.driver1Name || t.driver1 || null, driver2: info.driver2Name || t.driver2 || null,
        closed: !!t.closed, closedAt: info.closedDateStr || null, boxes: Number(t.boxes) || 0, cubes: Number(t.cubes) || 0,
        comments: String(info.comments || '').trim() || null,
        stops: combineStops(t.truckRouteStops || []).map((x) => ({ ...x, hub, date })),
      });
    }
  }
  return out;
}

// One stop per customer per city per truck: ARTIS can list a customer twice for the same place — a BOX line and a
// PALLET line (on a PALLET line the number is pallets, not boxes). The same customer in another city stays its own
// stop. Loading order kept (the lowest line). Pure.
export function combineStops(lines) {
  const by = new Map();
  for (const s of lines.slice().sort((a, b) => (a.stopOrder || 0) - (b.stopOrder || 0))) {
    // same customer + same city = one stop; the same customer in another city is its own stop
    const k = `${s.consigneeId || up(s.consigneeName)}|${town(s.consigneeCity)}`;
    const pallet = /PALLET/i.test(String(s.packType || ''));
    const cur = by.get(k) || { order: s.stopOrder, consigneeId: s.consigneeId || null, consignee: String(s.consigneeName || '').trim(), city: String(s.consigneeCity || '').trim(), state: String(s.consigneeState || '').trim(), boxes: 0, pallets: 0, cubes: 0, notScanned: 0, split: false };
    if (pallet) cur.pallets += Number(s.boxes) || 0; else cur.boxes += Number(s.boxes) || 0;
    cur.cubes = Math.round((cur.cubes + (Number(s.cubes) || 0)) * 100) / 100;
    cur.notScanned += Number(s.boxesNotScanned) || 0;
    cur.split = cur.split || !!s.splitStop;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => a.order - b.order).map((x, i) => ({ ...x, order: i + 1 }));
}
// A customer whose order is split between trailers — the boxes received in the cooler for them are on more
// than one truck: ARTIS marks the stop split, or the same customer in the same city is on another truck that night. Every
// truck's stop gets the other trucks' share (splitWith). Mutates the trucks; returns them. Pure input→output.
export function markSplits(trucks, all = trucks) {
  const by = new Map();
  // a split is the same customer AND the same city on another truck (another city is another location, not a split)
  const keyOf = (st) => `${st.consigneeId || up(st.consignee)}|${town(st.city)}`;
  for (const t of all) for (const st of t.stops) { const k = keyOf(st); by.set(k, [...(by.get(k) || []), { t, st }]); }
  for (const t of trucks) for (const st of t.stops) {
    const k = keyOf(st);
    const others = (by.get(k) || []).filter((x) => x.t !== t);
    if (!others.length && !st.split) continue;
    st.split = true;
    st.splitWith = others.map((x) => ({ trip: x.t.trip || null, truck: x.t.truck || null, trailer: x.t.trailer || null, boxes: x.st.boxes, pallets: x.st.pallets }));
  }
  return trucks;
}
// ARTIS flagged a stop split but its other part isn't on a truck that night: look at the night before / after
// and the other hub — only stops ARTIS also flags split, same customer + city (a customer's normal daily
// delivery on another night is not a split). Mutates; pure input→output.
export function resolveFlaggedSplits(trucks, extra) {
  const keyOf = (st) => `${st.consigneeId || up(st.consignee)}|${town(st.city)}`;
  for (const t of trucks) for (const st of t.stops) {
    if (!st.split || (st.splitWith || []).length) continue;
    const near = [];
    for (const o of extra) {
      if (o === t || (o.trip && o.trip === t.trip)) continue;
      for (const x of o.stops) if (x.split && keyOf(x) === keyOf(st)) near.push({ trip: o.trip || null, truck: o.truck || null, trailer: o.trailer || null, boxes: x.boxes, pallets: x.pallets, date: o.date, hub: o.hub });
    }
    if (near.length) st.splitWith = near;
  }
  return trucks;
}
const share = (x) => [x.boxes ? `${x.boxes} box${x.boxes === 1 ? '' : 'es'}` : null, x.pallets ? `${x.pallets} pallet${x.pallets === 1 ? '' : 's'}` : null].filter(Boolean).join(' + ') || '0 boxes';
// "Split: 52 boxes on this truck; 140 boxes on a truck not assigned yet". Pure.
export function splitNote(st) {
  if (!st || !st.split) return null;
  const when = (x) => [x.hub && x.hub !== st.hub ? x.hub : null, x.date ? x.date.slice(5).replace('-', '/') : null].filter(Boolean).join(' ');
  const rest = (st.splitWith || []).map((x) => `${share(x)} on ${x.trip ? `trip ${x.trip}` : 'a truck not assigned yet'}${x.truck || (x.date && x.date !== st.date) ? ` (${[x.truck ? `truck ${x.truck}${x.trailer ? `, trailer ${x.trailer}` : ''}` : null, x.date && x.date !== st.date ? when(x) : null].filter(Boolean).join(', ')})` : ''}`);
  return `Split between trailers: ${share(st)} on this truck${rest.length ? `; ${rest.join('; ')}` : ' — the rest is on another trailer'}.`;
}

// How well a trip-sheet customer and a Truck Builder customer are the same business (same town). Pure.
const fit = (a, b) => Math.max(nameScore(a, b), nameScore(b, a));
// Trip sheet (read by the AI off the scan) vs the Truck Builder (digital original). Pure.
export function compareSheet(sheet, truck) {
  const sheetStops = ((sheet && sheet.stops) || []).filter((x) => /DELIVER/i.test(x.action || ''));
  const used = new Set(); const pairs = []; const onlyOnSheet = [];
  // best match per sheet stop: same town first, then the name
  const cands = [];
  sheetStops.forEach((s, i) => truck.stops.forEach((b, j) => {
    const sameTown = town(s.city) && town(b.city) && (town(s.city) === town(b.city) || town(s.city).startsWith(town(b.city)) || town(b.city).startsWith(town(s.city)));
    const sc = fit(s.customer, b.consignee);
    if (sameTown ? sc >= 0.5 : sc >= 0.9) cands.push({ i, j, sc: sc + (sameTown ? 1 : 0) });
  }));
  cands.sort((a, b) => b.sc - a.sc);
  const doneSheet = new Set();
  for (const c of cands) { if (doneSheet.has(c.i) || used.has(c.j)) continue; doneSheet.add(c.i); used.add(c.j); pairs.push(c); }
  sheetStops.forEach((s, i) => { if (!doneSheet.has(i)) onlyOnSheet.push({ customer: s.customer, city: s.city, boxes: s.pieces != null ? Number(s.pieces) : null }); });
  const onlyInBuilder = truck.stops.filter((_, j) => !used.has(j)).map((b) => ({ customer: b.consignee, city: b.city, boxes: b.boxes }));
  const boxDiffs = pairs.map(({ i, j }) => ({ s: sheetStops[i], b: truck.stops[j] }))
    .filter(({ s, b }) => s.pieces != null && Number(s.pieces) !== b.boxes)
    .map(({ s, b }) => ({ customer: b.consignee, city: b.city, sheet: Number(s.pieces), builder: b.boxes }));
  const unclear = (sheet && sheet.unreadable) || [];
  const same = (a, b) => !a || !b || up(a).replace(/^0+/, '') === up(b).replace(/^0+/, '');
  const truckDiff = same(sheet && sheet.truck, truck.truck) ? null : { sheet: sheet.truck, builder: truck.truck };
  const trailerDiff = same(sheet && sheet.trailer, truck.trailer) ? null : { sheet: sheet.trailer, builder: truck.trailer };
  const ok = !boxDiffs.length && !onlyOnSheet.length && !onlyInBuilder.length && !trailerDiff;
  return { ok, boxDiffs, onlyOnSheet, onlyInBuilder, truckDiff, trailerDiff, matched: pairs.length, sheetStops: sheetStops.length, builderStops: truck.stops.length, unclearOnScan: unclear.length };
}

// The Truck Builder's count for one customer on a trip (Jarvis uses it over the scanned sheet's). Pure.
export function builderBoxesFor(it, customer, city = null) {
  const tb = it && it._tb;
  if (!tb || !tb.stops) return null;
  const t = town(String(city || '').split(',')[0]);
  const hits = tb.stops.filter((b) => fit(customer, b.consignee) >= 0.75 && (!t || !town(b.city) || town(b.city).startsWith(t) || t.startsWith(town(b.city))));
  return hits.length ? hits.reduce((n, b) => n + b.boxes, 0) : null;
}

// The nightly email: every truck checked, what differed. Pure.
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function checkEmail(hub, date, rows) {
  const bad = rows.filter((r) => r.check && !r.check.ok);
  const noSheet = rows.filter((r) => !r.check);
  const md = date.slice(5).replace('-', '/');
  const block = (r) => {
    const c = r.check; const li = [];
    for (const d of c.boxDiffs) li.push(`<li><b>${esc(d.customer)}</b> (${esc(d.city)}): trip sheet read <b>${d.sheet}</b> boxes — ARTIS has <b>${d.builder}</b></li>`);
    for (const d of c.onlyInBuilder) li.push(`<li><b>${esc(d.customer)}</b> (${esc(d.city)}, ${d.boxes} boxes) is on the truck in ARTIS but was not read on the trip sheet</li>`);
    for (const d of c.onlyOnSheet) li.push(`<li><b>${esc(d.customer)}</b> (${esc(d.city)}) was read on the trip sheet but is not on this truck in ARTIS</li>`);
    if (c.trailerDiff) li.push(`<li>Trailer: trip sheet ${esc(c.trailerDiff.sheet)} — ARTIS ${esc(c.trailerDiff.builder)}</li>`);
    if (c.truckDiff) li.push(`<li>Truck: trip sheet ${esc(c.truckDiff.sheet)} — ARTIS ${esc(c.truckDiff.builder)} (a handwritten transfer can explain this)</li>`);
    return `<p><b>Trip ${esc(r.trip)}</b> · truck ${esc(r.truck)} · trailer ${esc(r.trailer)}</p><ul>${li.join('')}</ul>`;
  };
  const notes = rows.filter((r) => r.comments || (r.stops || []).some((b) => b.split)).map((r) => `<p><b>Trip ${esc(r.trip)}</b> · truck ${esc(r.truck)}${r.comments ? ` — ARTIS comment: <i>${esc(r.comments)}</i>` : ''}</p>${(r.stops || []).filter((b) => b.split).length ? `<ul>${r.stops.filter((b) => b.split).map((b) => `<li><b>${esc(b.consignee)}</b> (${esc(b.city)}): ${esc(splitNote(b))}</li>`).join('')}</ul>` : ''}`).join('');
  return {
    subject: `Trip sheets checked against ARTIS — ${hub.name} ${md}: ${rows.length} truck${rows.length === 1 ? '' : 's'}, ${bad.length ? `${bad.length} with differences` : 'all match'}`,
    html: `<p>Each night Jarvis compares what it read off the scanned trip sheets with ARTIS's Truck Builder (the digital original). Where they differ, Jarvis now uses ARTIS's count.</p>
${bad.length ? bad.map(block).join('') : '<p>Every truck matches its trip sheet. ✓</p>'}
${notes ? `<p><b>Comments and split stops</b> (a split customer's boxes received in the cooler are on more than one trailer):</p>${notes}` : ''}
${rows.filter((r) => r.check && r.check.ok).length ? `<p>Verified ✓: ${rows.filter((r) => r.check && r.check.ok).map((r) => `trip ${esc(r.trip)}`).join(', ')}</p>` : ''}
${noSheet.length ? `<p>No trip sheet read yet for: ${noSheet.map((r) => `trip ${esc(r.trip)} (truck ${esc(r.truck)})`).join(', ')}</p>` : ''}`,
  };
}

// The night a moment belongs to at a hub: trip sheets come in the evening; until noon the next day it is
// still the night before. Pure.
const prevDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
export function nightOf(tz, ms) { const c = hubClock(tz, ms); return c.hour >= 12 ? c.date : prevDay(c.date); }
// Should a hub be read now? Once a night: when that night's trip sheets for the hub were read and nothing new
// came in for 20 minutes — or at 6 AM hub time (6 AM Miami, 6 AM California) if no trip sheet came. Pure.
export function dueNow(hub, { state = {}, sheets = [], now = Date.now() } = {}) {
  const c = hubClock(hub.tz, now);
  const night = nightOf(hub.tz, now);
  if (state.hubs && state.hubs[hub.id] && state.hubs[hub.id].night === night) return null;
  if (c.hour >= 12 && c.hour < 17) return null;                       // daytime: nothing to check yet
  const mine = sheets.filter((s) => s && s.uploadedAt && hubOfSheet(s) === hub.id && nightOf(hub.tz, Date.parse(s.uploadedAt)) === night);
  const last = mine.reduce((m, s) => Math.max(m, Date.parse(s.uploadedAt) || 0), 0);
  const dates = [...new Set([night, ...mine.map((s) => s.dateLoaded).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')))])].slice(0, 3);
  if (mine.length && now - last >= 20 * MIN) return { night, reason: `${mine.length} trip sheet${mine.length === 1 ? '' : 's'} read`, dates };
  if (c.hour >= 6 && c.hour < 12) return { night, reason: '6 AM — no trip sheets seen', dates };
  return null;
}
// Which hub a trip sheet is from (its LOAD stop / origin). Pure.
export function hubOfSheet(s) {
  const load = ((s && s.stops) || []).find((x) => /LOAD|PICK/i.test(x.action || ''));
  const label = load ? `${load.customer || ''} ${load.city || ''}, ${load.state || ''}` : String((s && (s.origin || s.from)) || '');
  const h = HUBS.find((x) => x.origin.test(label));
  return h ? h.id : null;
}

// The trip's stops from ARTIS (stop order, customers, boxes, cubes, truck totals — the digital original) with
// the trip sheet's instructions kept on each stop (appointments, call-aheads, location notes, references,
// handwritten marks) and its trip-wide notes (transfers, dispatch time, pickup plan). ARTIS lists stops in
// LOADING order — the last one loaded is delivered first. A stop only on the sheet stays, marked notInArtis. Pure.
export function mergeStops(sheet, truck, item = null) {
  const n = truck.stops.length;
  const pairs = new Map();   // builder index → sheet stop
  const sheetStops = ((sheet && sheet.stops) || []).filter((x) => /DELIVER/i.test(x.action || ''));
  if (sheet) {
    const cands = [];
    sheetStops.forEach((s, i) => truck.stops.forEach((b, j) => {
      const sameTown = town(s.city) && town(b.city) && (town(s.city) === town(b.city) || town(s.city).startsWith(town(b.city)) || town(b.city).startsWith(town(s.city)));
      const sc = fit(s.customer, b.consignee);
      if (sameTown ? sc >= 0.5 : sc >= 0.9) cands.push({ i, j, sc: sc + (sameTown ? 1 : 0) });
    }));
    cands.sort((a, b) => b.sc - a.sc);
    const usedS = new Set();
    for (const c of cands) { if (usedS.has(c.i) || pairs.has(c.j)) continue; usedS.add(c.i); pairs.set(c.j, sheetStops[c.i]); }
  }
  const pairedSheet = new Set(pairs.values());
  const delivers = truck.stops.map((b, j) => {
    const sh = pairs.get(j) || null;
    const seq = n + 1 - (b.order || j + 1);                 // delivery order
    return { ...(sh || { action: 'DELIVER', key: `artis.${b.consigneeId || j}` }), action: 'DELIVER', stopNumber: seq + 1,
      customer: b.consignee, sheetCustomer: sh ? sh.customer : undefined, consigneeId: b.consigneeId, city: b.city, state: b.state || (sh && sh.state) || null,
      pieces: b.boxes, piecesText: `${b.boxes} BOXES${b.pallets ? ` + ${b.pallets} PALLET${b.pallets === 1 ? '' : 'S'}` : ''}`, cubes: b.cubes, ...(b.pallets ? { pallets: b.pallets } : {}),
      ...(b.split ? { split: true, splitWith: b.splitWith || [], splitNote: splitNote(b) } : {}),
      ...(sh && sh.pieces != null && Number(sh.pieces) !== b.boxes ? { sheetPieces: Number(sh.pieces) } : {}), from: sh ? 'ARTIS + trip sheet' : 'ARTIS' };
  });
  const extra = sheetStops.filter((s) => !pairedSheet.has(s)).map((s) => ({ ...s, notInArtis: true, from: 'trip sheet only' }));
  const load = ((sheet && sheet.stops) || []).find((x) => /LOAD/i.test(x.action || '')) || { action: 'LOAD', customer: `${String(truck.hub || '').toUpperCase()} TERMINAL`, stopNumber: 1, key: 'artis.load' };
  const stops = [{ ...load, pieces: truck.boxes, piecesText: `${truck.boxes} BOXES`, cubes: Math.round(truck.cubes * 100) / 100, ...(load.pieces != null && Number(load.pieces) !== truck.boxes ? { sheetPieces: Number(load.pieces) } : {}) },
    ...[...delivers, ...extra].sort((a, b) => (a.stopNumber || 999) - (b.stopNumber || 999))];
  // stops ARTIS added that the sheet never had: pair them with TruckMate's towns like a sheet stop
  const linked = item ? linkSheetStops(stops.filter((x) => !x.tmPlace), item) : [];
  const out = stops.map((x) => (x.tmPlace ? x : (linked.shift() || x)));
  return {
    ...(sheet || { tripNumber: truck.trip, truck: truck.truck, trailer: truck.trailer, artisOnly: true }),
    stops: out,
    artis: { readAt: truck.readAt, date: truck.date, hub: truck.hub, route: truck.route, manifest: truck.manifest, truck: truck.truck, trailer: truck.trailer, drivers: [truck.driver1, truck.driver2].filter(Boolean), boxes: truck.boxes, cubes: truck.cubes, closedAt: truck.closedAt, comments: truck.comments || null,
      splits: truck.stops.filter((b) => b.split).map((b) => ({ customer: b.consignee, note: splitNote(b) })) },
    stopsFrom: sheet ? 'ARTIS Truck Builder (stops, order, boxes, cubes) + trip sheet (instructions)' : 'ARTIS Truck Builder (no trip sheet yet)',
  };
}

export function initTruckBuilder(app, { requireAdmin, db, sendMail = null, recipients = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const cfg = () => webConfig(env);
  const enabled = () => !!(db && db.enabled) && cfg().ready;
  let cache = null;
  const load = async () => { if (!cache) cache = (await db.get(KEY, null)) || { hubs: {}, trips: {} }; return cache; };

  // sign in (one attempt) → session cookie
  async function signIn() {
    const { base, user, password } = cfg();
    const r = await fetchFn(`${base}/login?serviceUrl=/artis-spa/truck/builder`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'FBF-Jarvis-nightly-check (read-only)' },
      body: new URLSearchParams({ username: user, password }).toString(),
    });
    const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : String(r.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
    const cookie = set.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) throw new Error(`ARTIS sign-in gave no session (HTTP ${r.status})`);
    return cookie;
  }
  async function getJson(cookie, path) {
    const r = await fetchFn(`${cfg().base}${path}`, { headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': 'FBF-Jarvis-nightly-check (read-only)' }, redirect: 'manual' });
    const t = await r.text();
    try { return JSON.parse(t); } catch { throw new Error(r.status >= 300 && r.status < 400 ? 'ARTIS sign-in was not accepted (check ARTIS_WEB_USER / ARTIS_WEB_PASSWORD in Render)' : `ARTIS answered HTTP ${r.status}, not data`); }
  }

  // one hub's trucks for a date (every route), splits marked within that night (trucks without a trip included)
  async function readDay(cookie, hub, d, cache) {
    const k = `${hub.id}|${d}`;
    if (!cache.has(k)) {
      const routes = await getJson(cookie, `/routes/truck-builder/truck-routes/${d}?warehouseId=${hub.id}&qs=${now()}`);
      const withTrip = normalizeTrucks(routes, { hub: hub.name, date: d });
      const noTrip = normalizeTrucks(routes, { hub: hub.name, date: d, all: true }).filter((t) => !t.trip);
      markSplits(withTrip, [...withTrip, ...noTrip]);
      cache.set(k, { withTrip, all: [...withTrip, ...noTrip] });
    }
    return cache.get(k);
  }
  // read hubs × dates, find the other part of ARTIS-flagged splits (night before / after, other hub), compare
  // with the trip sheets, keep every trip
  async function readAndStore(cookie, plan) {
    const cache = new Map(); const trucks = [];
    for (const { hub, dates } of plan) for (const d of dates) trucks.push(...(await readDay(cookie, hub, d, cache)).withTrip); // eslint-disable-line no-await-in-loop
    const lonely = trucks.some((t) => t.stops.some((x) => x.split && !(x.splitWith || []).length));
    if (lonely) {
      const extra = [];
      const days = [...new Set(trucks.map((t) => t.date))];
      for (const hub of HUBS) for (const d of [...new Set(days.flatMap((x) => [prevDay(x), x, nextDay(x)]))]) {
        try { extra.push(...(await readDay(cookie, hub, d, cache)).all); } catch { /* that day / hub can't be read — leave it */ } // eslint-disable-line no-await-in-loop
      }
      resolveFlaggedSplits(trucks, extra);
    }
    const seen = new Map(trucks.map((t) => [t.trip, t]));   // a trip on two dates → the later read wins
    const sheets = (await db.get(`taTruckMateManifest:${SITE}`, {})) || {};
    const rows = [...seen.values()].map((t) => ({ ...t, readAt: new Date(now()).toISOString(), check: sheets[t.trip] ? compareSheet(sheets[t.trip], t) : null }));
    const st = await load();
    for (const r of rows) st.trips[r.trip] = r;
    for (const [k, v] of Object.entries(st.trips)) if (Date.parse(v.readAt) < now() - 10 * 86400000) delete st.trips[k];
    await db.set(KEY, st);
    return rows;
  }

  // read one hub for the given dates, compare with the trip sheets, keep it, email the result
  async function run(hub, { dates, night = hubClock(hub.tz, now()).date, reason = 'manual', email = true } = {}) {
    const st = await load();
    st.hubs[hub.id] = { ...(st.hubs[hub.id] || {}), night, at: new Date(now()).toISOString(), reason, ok: false, error: null };
    await db.set(KEY, st);   // marked first: one attempt per night even if it fails
    try {
      const cookie = await signIn();
      const rows = await readAndStore(cookie, [{ hub, dates: dates && dates.length ? dates : [night] }]);
      st.hubs[hub.id] = { ...st.hubs[hub.id], ok: true, trucks: rows.length, differences: rows.filter((r) => r.check && !r.check.ok).length };
      await db.set(KEY, st);
      if (email && sendMail && rows.length) {
        const to = recipients ? await recipients() : ['ntellez@floridabeauty.us'];
        if (to.length) await sendMail({ to, ...checkEmail(hub, night, rows) });
      }
      return st.hubs[hub.id];
    } catch (e) {
      st.hubs[hub.id] = { ...st.hubs[hub.id], ok: false, error: e.message };
      await db.set(KEY, st);
      if (sendMail) {
        const to = recipients ? await recipients().catch(() => []) : [];
        await sendMail({ to: to.length ? to : ['ntellez@floridabeauty.us'], subject: `Trip sheet check — couldn't read ARTIS Truck Builder (${hub.name})`, html: `<p>Tonight's check of the ${hub.name} trip sheets against ARTIS didn't run: ${esc(e.message)}.</p><p>Jarvis tries once a night only (so the ARTIS login can't get locked). If the ARTIS password changed, update ARTIS_WEB_PASSWORD in Render.</p>` }).catch(() => {});
      }
      throw e;
    }
  }

  // once (after this is first deployed): the trips already on the road — the last 4 nights, both hubs, one sign-in
  const BACKFILL = 'v1';
  async function backfill({ force = false } = {}) {
    if (!enabled()) return null;
    const st = await load();
    if (!force && st.backfill && st.backfill.v === BACKFILL) return null;
    st.backfill = { v: BACKFILL, at: new Date(now()).toISOString(), ok: false };
    await db.set(KEY, st);   // one try — no retry loop on a bad login
    try {
      const cookie = await signIn();
      const plan = HUBS.map((hub) => { const t = hubClock(hub.tz, now()).date; const ds = [t]; for (let i = 1; i < 4; i++) ds.push(prevDay(ds[ds.length - 1])); return { hub, dates: ds }; });
      const rows = await readAndStore(cookie, plan);
      st.backfill = { ...st.backfill, ok: true, trucks: rows.length, differences: rows.filter((r) => r.check && !r.check.ok).length };
      await db.set(KEY, st);
      if (sendMail && rows.length) {
        const to = recipients ? await recipients() : ['ntellez@floridabeauty.us'];
        const mail = checkEmail({ name: 'Miami + Ventura (trips on the road, last 4 nights)' }, hubClock(HUBS[0].tz, now()).date, rows.filter((r) => r.check || r.comments || r.stops.some((x) => x.split)));
        if (to.length) await sendMail({ to, ...mail, subject: `ARTIS Truck Builder: ${rows.length} trips on the road updated — ${st.backfill.differences} with trip-sheet differences` });
      }
      return st.backfill;
    } catch (e) {
      st.backfill = { ...st.backfill, ok: false, error: e.message };
      await db.set(KEY, st);
      throw e;
    }
  }

  async function tick() {
    if (!enabled()) return;
    const st = await load();
    const sheets = Object.values((await db.get(`taTruckMateManifest:${SITE}`, {})) || {});
    for (const hub of HUBS) {
      const due = dueNow(hub, { state: st, sheets, now: now() });   // after the night's trip sheets, or 6 AM hub time
      if (due) await run(hub, { dates: due.dates, night: due.night, reason: due.reason }).catch((e) => console.warn(`[truckbuilder] ${hub.name}:`, e.message)); // eslint-disable-line no-await-in-loop
    }
  }
  if (env.NODE_ENV !== 'test') {
    const t = setInterval(() => { tick().catch((e) => console.warn('[truckbuilder]', e.message)); }, 10 * MIN); if (t.unref) t.unref();
    setTimeout(() => { backfill().then((r) => r && console.log(`[truckbuilder] trips on the road updated from ARTIS: ${r.trucks}`)).catch((e) => console.warn('[truckbuilder] backfill:', e.message)); }, MIN).unref?.();
  }

  // the board: each trip gets what ARTIS's Truck Builder says is on it, and the trip-sheet check
  async function overlay(site, trips) {
    if (!(db && db.enabled)) return;
    const st = await load();
    for (const it of trips) {
      const r = st.trips[String(tripOf(it).tripNumber || '')];
      if (!r) continue;
      it._tb = r;
      it._manifest = mergeStops(it._manifest || null, r, it);
    }
  }

  app.get('/truckmate/truck-builder/status', requireAdmin, async (req, res) => {
    try {
      const st = (db && db.enabled) ? await load() : { hubs: {}, trips: {} };
      res.json({ configured: cfg().ready, hubs: HUBS.map((h) => ({ id: h.id, name: h.name, ...(st.hubs[h.id] || {}) })), trips: Object.values(st.trips).map((r) => ({ trip: r.trip, hub: r.hub, date: r.date, truck: r.truck, trailer: r.trailer, readAt: r.readAt, ok: r.check ? r.check.ok : null, check: r.check })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // admin: run one hub now (e.g. to test the login) — doesn't use up tonight's automatic read
  app.post('/truckmate/truck-builder/run', requireAdmin, async (req, res) => {
    const hub = HUBS.find((h) => String(h.id) === String((req.body && req.body.hub) || req.query.hub) || h.name.toLowerCase() === String((req.body && req.body.hub) || req.query.hub || '').toLowerCase());
    if (!hub) return res.status(400).json({ error: 'hub must be Miami or Ventura' });
    if (!cfg().ready) return res.status(400).json({ error: 'Set ARTIS_WEB_USER and ARTIS_WEB_PASSWORD in Render first.' });
    const date = String((req.body && req.body.date) || req.query.date || '');
    try { res.json(await run(hub, { dates: /^\d{4}-\d{2}-\d{2}$/.test(date) ? [date] : [hubClock(hub.tz, now()).date], night: `manual ${new Date(now()).toISOString()}`, reason: 'admin run', email: !!(req.body && req.body.email) })); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // admin: read the last 4 nights again (both hubs) — the trips on the road
  app.post('/truckmate/truck-builder/backfill', requireAdmin, async (req, res) => {
    if (!cfg().ready) return res.status(400).json({ error: 'Set ARTIS_WEB_USER and ARTIS_WEB_PASSWORD in Render first.' });
    try { res.json(await backfill({ force: true })); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  return { overlay, run, tick, backfill };
}

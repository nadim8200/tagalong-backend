// ---------------------------------------------------------------
// ARTIS Truck Builder — read once a night per hub (Miami after its trip sheets, Ventura after California's)
// to check what the AI read off the SCANNED trip sheets against the digital originals: the trip sheet is a
// printout of the Truck Builder. Read-only: signs in with the ARTIS web login set in Render
// (ARTIS_WEB_USER / ARTIS_WEB_PASSWORD), reads the trucks of the night, never changes anything in ARTIS.
// One sign-in attempt per hub per night — a wrong password can't lock the account.
// ---------------------------------------------------------------
import { nameScore } from './voice.js';

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
export function normalizeTrucks(routes, { hub, date } = {}) {
  const out = [];
  for (const r of Array.isArray(routes) ? routes : []) {
    for (const t of r.routeTrucks || []) {
      const info = t.truckInfo || {};
      if (!info.tripNumber) continue;
      out.push({
        trip: String(info.tripNumber), hub, date, route: t.truckRouteName || r.name || null, manifest: t.truckSeqno || null,
        truck: t.truckId || null, trailer: t.trailerId || null, driver1: info.driver1Name || t.driver1 || null, driver2: info.driver2Name || t.driver2 || null,
        closed: !!t.closed, closedAt: info.closedDateStr || null, boxes: Number(t.boxes) || 0, cubes: Number(t.cubes) || 0,
        stops: (t.truckRouteStops || []).slice().sort((a, b) => (a.stopOrder || 0) - (b.stopOrder || 0)).map((s) => ({
          order: s.stopOrder, consigneeId: s.consigneeId || null, consignee: String(s.consigneeName || '').trim(), city: String(s.consigneeCity || '').trim(), state: String(s.consigneeState || '').trim(),
          boxes: Number(s.boxes) || 0, cubes: Math.round((Number(s.cubes) || 0) * 100) / 100, notScanned: Number(s.boxesNotScanned) || 0,
        })),
      });
    }
  }
  return out;
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
  return {
    subject: `Trip sheets checked against ARTIS — ${hub.name} ${md}: ${rows.length} truck${rows.length === 1 ? '' : 's'}, ${bad.length ? `${bad.length} with differences` : 'all match'}`,
    html: `<p>Each night Jarvis compares what it read off the scanned trip sheets with ARTIS's Truck Builder (the digital original). Where they differ, Jarvis now uses ARTIS's count.</p>
${bad.length ? bad.map(block).join('') : '<p>Every truck matches its trip sheet. ✓</p>'}
${rows.filter((r) => r.check && r.check.ok).length ? `<p>Verified ✓: ${rows.filter((r) => r.check && r.check.ok).map((r) => `trip ${esc(r.trip)}`).join(', ')}</p>` : ''}
${noSheet.length ? `<p>No trip sheet read yet for: ${noSheet.map((r) => `trip ${esc(r.trip)} (truck ${esc(r.truck)})`).join(', ')}</p>` : ''}`,
  };
}

// Should a hub be read now? After that night's trip sheets for the hub were read and nothing new came in
// for 20 minutes — or at 11:30 PM hub time if no sheet came. Once per night. Pure.
export function dueNow(hub, { state = {}, sheets = [], now = Date.now() } = {}) {
  const c = hubClock(hub.tz, now);
  const done = state.hubs && state.hubs[hub.id] && state.hubs[hub.id].night === c.date;
  if (done) return null;
  if (c.hour < 17) return null;
  const mine = sheets.filter((s) => s && s.uploadedAt && hubOfSheet(s) === hub.id && hubClock(hub.tz, Date.parse(s.uploadedAt)).date === c.date);
  const last = mine.reduce((m, s) => Math.max(m, Date.parse(s.uploadedAt) || 0), 0);
  if (mine.length && now - last >= 20 * MIN) return { night: c.date, reason: `${mine.length} trip sheet${mine.length === 1 ? '' : 's'} read`, dates: [...new Set([c.date, ...mine.map((s) => s.dateLoaded).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')))])].slice(0, 3) };
  if (c.hour === 23 && c.minute >= 30) return { night: c.date, reason: 'end of the night', dates: [c.date] };
  return null;
}
// Which hub a trip sheet is from (its LOAD stop / origin). Pure.
export function hubOfSheet(s) {
  const load = ((s && s.stops) || []).find((x) => /LOAD|PICK/i.test(x.action || ''));
  const label = load ? `${load.customer || ''} ${load.city || ''}, ${load.state || ''}` : String((s && (s.origin || s.from)) || '');
  const h = HUBS.find((x) => x.origin.test(label));
  return h ? h.id : null;
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

  // read one hub for the given dates, compare with the trip sheets, keep it, email the result
  async function run(hub, { dates, night = hubClock(hub.tz, now()).date, reason = 'manual', email = true } = {}) {
    const st = await load();
    st.hubs[hub.id] = { ...(st.hubs[hub.id] || {}), night, at: new Date(now()).toISOString(), reason, ok: false, error: null };
    await db.set(KEY, st);   // marked first: one attempt per night even if it fails
    try {
      const cookie = await signIn();
      const trucks = [];
      for (const d of dates && dates.length ? dates : [night]) {
        trucks.push(...normalizeTrucks(await getJson(cookie, `/routes/truck-builder/truck-routes/${d}?warehouseId=${hub.id}&qs=${now()}`), { hub: hub.name, date: d })); // eslint-disable-line no-await-in-loop
      }
      const seen = new Map(trucks.map((t) => [t.trip, t]));   // a trip on two dates → the later read wins
      const sheets = (await db.get(`taTruckMateManifest:${SITE}`, {})) || {};
      const rows = [...seen.values()].map((t) => ({ ...t, readAt: new Date(now()).toISOString(), check: sheets[t.trip] ? compareSheet(sheets[t.trip], t) : null }));
      for (const r of rows) st.trips[r.trip] = r;
      for (const [k, v] of Object.entries(st.trips)) if (Date.parse(v.readAt) < now() - 10 * 86400000) delete st.trips[k];
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

  async function tick() {
    if (!enabled()) return;
    const st = await load();
    const sheets = Object.values((await db.get(`taTruckMateManifest:${SITE}`, {})) || {});
    for (const hub of HUBS) {
      const due = dueNow(hub, { state: st, sheets, now: now() });
      if (due) await run(hub, { dates: due.dates, night: due.night, reason: due.reason }).catch((e) => console.warn(`[truckbuilder] ${hub.name}:`, e.message)); // eslint-disable-line no-await-in-loop
    }
  }
  if (env.NODE_ENV !== 'test') { const t = setInterval(() => { tick().catch((e) => console.warn('[truckbuilder]', e.message)); }, 10 * MIN); if (t.unref) t.unref(); }

  // the board: each trip gets what ARTIS's Truck Builder says is on it, and the trip-sheet check
  async function overlay(site, trips) {
    if (!(db && db.enabled)) return;
    const st = await load();
    for (const it of trips) { const r = st.trips[String(tripOf(it).tripNumber || '')]; if (r) it._tb = r; }
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

  return { overlay, run, tick };
}

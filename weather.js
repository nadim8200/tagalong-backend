// Weather on the road (Nov 21, 2026). Every hour, for each truck that is rolling, we look where it is now and where it is going
// next (its next stop's ZIP):
//   - official warnings from the US National Weather Service (api.weather.gov, free): winter storm, ice, flood, tornado, high wind…
//   - Google's hourly forecast (Weather API, $0.15 per 1,000 after the first 10,000 a month): rain, heavy rain / storms, snow, ice
//     in the next 12 hours.
// Each warning goes to the driver's phone once (both drivers on a team); in training mode the push is held and copied to Nadim.
// Trucks close together share one look (a ~15-mile grid square, kept for the hour), so the cost stays at a few dollars a month.
import { driverStops } from './driverstops.js';
import { CHECKINS } from './checkins.js';
import { placeKey } from './watchtower.js';

const SITE = 'florida-beauty';
const KEY = `taWeather:${SITE}`;
const HOUR = 3600000;
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE|ARRSHIP|LOADED|SPOT)/i;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const UA = 'TagAlong-Dispatch/1.0 (dispatch weather alerts; ntellez@floridabeauty.us)';

// NWS warnings worth a driver's attention (advisories for frost or air quality are not)
const NWS_EVENTS = /winter storm|blizzard|ice storm|freezing (rain|drizzle|fog)|winter weather|snow squall|lake effect|heavy snow|flood|flash flood|tornado|severe thunderstorm|hurricane|tropical storm|high wind|wind advisory|dust storm|dense fog|extreme cold|wind chill|hail/i;

const OFF_ROAD = /marine|small craft|gale|coastal|lakeshore|beach|rip current|surf|storm surge|hurricane force wind|low water/i;   // on the water, not the road

// Google weatherCondition.type → what the driver should know. Pure.
export function hazardOf(type, { percent = 0, tempF = null } = {}) {
  const t = String(type || '').toUpperCase();
  if (!t) return null;
  if (/SNOW|BLIZZARD|HAIL/.test(t) && percent >= 40) return 'snow';
  if (/RAIN|SHOWER|THUNDER|DRIZZLE/.test(t) && tempF != null && tempF <= 32 && percent >= 40) return 'ice';
  if (/THUNDER|HEAVY_RAIN|MODERATE_TO_HEAVY|PERIODICALLY_HEAVY|WIND_AND_RAIN/.test(t) && percent >= 50) return 'storm';
  if (/RAIN|SHOWER|DRIZZLE/.test(t) && percent >= 60) return 'rain';
  return null;
}
const RANK = { rain: 1, storm: 2, snow: 3, ice: 4 };
const ICON = { rain: '🌧️', storm: '⛈️', snow: '❄️', ice: '🧊', alert: '⚠️' };
const ES = { rain: 'Lluvia', storm: 'Tormenta / lluvia fuerte', snow: 'Nieve', ice: 'Hielo en la vía' };
const EN = { rain: 'Rain', storm: 'Storms / heavy rain', snow: 'Snow', ice: 'Ice on the road' };
const TIP_ES = { rain: 'Más distancia y luces encendidas.', storm: 'Baje la velocidad; si no ve, oríllese en un lugar seguro.', snow: 'Despacio, más distancia; tenga las cadenas listas.', ice: 'Muy despacio, sin frenazos; puentes primero se congelan.' };

// the worst hour of the next 12 in Google's hourly forecast → { kind, at, percent, tempF, text } | null. Pure.
export function worstHour(forecast, { hours = 12 } = {}) {
  let best = null;
  for (const h of ((forecast && forecast.forecastHours) || []).slice(0, hours)) {
    const percent = Number((((h.precipitation || {}).probability) || {}).percent) || 0;
    const tempF = h.temperature && h.temperature.degrees != null ? Number(h.temperature.degrees) : null;
    const type = (h.weatherCondition || {}).type;
    const kind = hazardOf(type, { percent, tempF });
    if (!kind) continue;
    const at = ((h.interval || {}).startTime) || null;
    if (!best || RANK[kind] > RANK[best.kind]) best = { kind, at, percent, tempF, text: (((h.weatherCondition || {}).description) || {}).text || null };
  }
  return best;
}

// NWS active alerts at a point → the ones a driver should hear about. Pure.
export function roadAlerts(geo) {
  return ((geo && geo.features) || []).map((f) => f.properties || {})
    .filter((p) => NWS_EVENTS.test(p.event || '') && !OFF_ROAD.test(p.event || '') && !/^(Minor|Unknown)$/i.test(p.severity || '') && p.status !== 'Test' && p.messageType !== 'Cancel')
    .map((p) => ({ id: p.id || `${p.event}|${p.onset}`, event: p.event, severity: p.severity || null, headline: p.headline || null, area: p.areaDesc || null, from: p.onset || p.effective || null, until: p.ends || p.expires || null, instruction: p.instruction ? String(p.instruction).slice(0, 400) : null }));
}

// where to look: the truck now (fresh GPS) and its next stop not delivered. Pure.
export function lookPoints(item, { geo = {}, steps = {}, now = Date.now() } = {}) {
  const pts = [];
  const s = (item && item._samsara) || {};
  if (s.lat != null && s.lng != null && (!s.at || now - Date.parse(s.at) < 2 * HOUR)) pts.push({ role: 'truck', lat: Number(s.lat), lng: Number(s.lng), place: s.location || null });
  const stops = driverStops(item, { geo });
  const next = stops.find((x) => !x.delivered && !steps[`delivered:${x.key}`]);
  // the same ZIP / city keys the ETA geocoder fills in (watchtower.js): the stop's ZIP, its bill's end zone, or the city
  const bill = next ? ((it) => ((it && (it.freightBills || it.orders)) || []))(item).find((b) => (next.bills || []).some((x) => x.bill === b.billNumber)) : null;
  const zipOf = (x) => (String(x || '').match(/\b(\d{5})\b/) || [])[1] || null;
  const g = next ? [next.zip, bill && zipOf(bill.endZone), placeKey(next.place || next.key)].map((k) => (k ? geo[k] : null)).find((x) => x && x.lat != null) : null;
  if (g) pts.push({ role: 'next', lat: g.lat, lng: g.lng, place: next.place || next.name || null, stop: next.key });
  return pts;
}
const cell = (p) => `${(Math.round(p.lat * 4) / 4).toFixed(2)},${(Math.round(p.lng * 4) / 4).toFixed(2)}`;   // ~15 miles

const hm = (iso) => { const d = new Date(iso || ''); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }); };

// the push the driver gets (Spanish first, English under it — the phone's language isn't known here). Pure.
export function pushFor(a) {
  if (a.kind === 'alert') {
    return { title: `⚠️ ${a.event}${a.place ? ` · ${a.place}` : ''}`, body: `Aviso oficial del clima en su ruta${a.until ? ` hasta ${hm(a.until)}` : ''}. Maneje con cuidado. · Official weather warning on your route${a.until ? ` until ${hm(a.until)}` : ''}.` };
  }
  const where = a.place ? ` ${a.role === 'next' ? 'en su próxima parada' : 'cerca de'} ${a.place}` : '';
  const whereEn = a.place ? ` ${a.role === 'next' ? 'at your next stop' : 'near'} ${a.place}` : '';
  const when = a.at ? ` ~${hm(a.at)}` : '';
  return { title: `${ICON[a.kind]} ${ES[a.kind]}${where}${when}`, body: `${TIP_ES[a.kind]} · ${EN[a.kind]}${whereEn}${when} (${a.percent}%).` };
}

export function initWeather(app, { db, board, notify, requireAuth = null, requireDriver = null, loadsFor = null, env = process.env, fetchFn = (...a) => fetch(...a), now = () => Date.now() }) {
  const gKey = () => env.GOOGLE_WEATHER_KEY || env.GOOGLE_PLACES_KEY || env.GOOGLE_MAPS_KEY || '';
  const cache = new Map();   // grid cell → { at, nws, forecast }
  const getJson = async (url, headers = {}) => { const r = await fetchFn(url, { headers }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

  async function look(p) {
    const c = cell(p); const had = cache.get(c);
    if (had && now() - had.at < 55 * 60000) return had;
    const lat = p.lat.toFixed(4); const lng = p.lng.toFixed(4);
    const nws = await getJson(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, { 'User-Agent': UA, Accept: 'application/geo+json' }).catch(() => null);
    const k = gKey();
    const forecast = k ? await getJson(`https://weather.googleapis.com/v1/forecast/hours:lookup?key=${encodeURIComponent(k)}&location.latitude=${lat}&location.longitude=${lng}&hours=12&unitsSystem=IMPERIAL`).catch(() => null) : null;
    const v = { at: now(), nws, forecast };
    cache.set(c, v);
    return v;
  }

  // one pass over the board: work out each rolling trip's weather, push what's new, keep it for the console and the app
  async function sweep() {
    const items = (await board()).filter((it) => ROLLING.test(String(tripOf(it).status || '')));
    const geo = (await db.get('taGeoZip', {}).catch(() => ({}))) || {};
    const checkins = (await db.get(CHECKINS(SITE), {}).catch(() => ({}))) || {};
    const state = (await db.get(KEY, {})) || {};
    const sent = { ...(state.sent || {}) };
    const trips = {};
    let pushed = 0;
    for (const it of items) {
      const trip = tripNo(it); if (!trip) continue;
      const pts = lookPoints(it, { geo, steps: (checkins[trip] || {}).steps || {}, now: now() });
      const alerts = [];
      for (const p of pts) {
        const w = await look(p).catch(() => null); // eslint-disable-line no-await-in-loop
        if (!w) continue;
        for (const a of roadAlerts(w.nws)) if (!alerts.some((x) => x.id === a.id)) alerts.push({ kind: 'alert', ...a, role: p.role, place: p.place });
        const h = worstHour(w.forecast);
        if (h) alerts.push({ kind: h.kind, id: `${h.kind}|${p.role}|${p.place || cell(p)}`, at: h.at, percent: h.percent, tempF: h.tempF, text: h.text, role: p.role, place: p.place });
      }
      trips[trip] = { alerts, checkedAt: new Date(now()).toISOString(), truck: tripOf(it).powerUnit || null };
      // push each one once: an official warning once per warning; a forecast once per kind and place every 6 hours
      const t = tripOf(it); const codes = [t.driver, t.driver2].map((x) => String(x || '').trim()).filter(Boolean);
      const mine = { ...(sent[trip] || {}) };
      let forecastPushed = false;   // at most one forecast push per truck per hour (the worst one); official warnings always
      for (const a of [...alerts].sort((x, y) => (RANK[y.kind] || 9) - (RANK[x.kind] || 9))) {
        const key = a.kind === 'alert' ? `nws|${a.id}` : `${a.id}|${Math.floor(now() / (6 * HOUR))}`;
        if (mine[key]) continue;
        mine[key] = new Date(now()).toISOString();   // a milder forecast skipped this hour counts as covered by the one sent
        if (a.kind !== 'alert') { if (forecastPushed) continue; forecastPushed = true; }
        if (notify && codes.length) {
          const m = pushFor(a);
          for (const c of codes) await notify(c, { ...m, data: { tab: 'now', trip } }).catch(() => null); // eslint-disable-line no-await-in-loop
          pushed += 1;
        }
      }
      sent[trip] = mine;
    }
    for (const k of Object.keys(sent)) if (!trips[k]) delete sent[k];   // loads that left the road
    await db.set(KEY, { trips, sent, checkedAt: new Date(now()).toISOString() });
    return { trips: Object.keys(trips).length, pushed, looks: cache.size };
  }

  if (app && requireAuth) {
    // the console: every rolling trip's weather (the trip card shows it)
    app.get('/truckmate/weather', requireAuth, async (req, res) => { const s = (await db.get(KEY, {})) || {}; res.json({ trips: s.trips || {}, checkedAt: s.checkedAt || null }); });
  }
  if (app && requireDriver && loadsFor) {
    // the driver app: the weather on their loads rolling now
    app.get('/driver/me/weather', requireDriver, async (req, res) => {
      const s = (await db.get(KEY, {})) || {};
      const mine = loadsFor(req.driver.code, await board()).current.map((l) => l.trip);
      res.json({ trips: Object.fromEntries(mine.filter((t) => (s.trips || {})[t]).map((t) => [t, s.trips[t]])) });
    });
  }
  if (env.WEATHER_OFF !== '1' && env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    const run = () => { sweep().catch((e) => console.warn('[weather]', e.message)); };
    const first = setTimeout(run, 3 * 60000); if (first.unref) first.unref();
    const t = setInterval(run, HOUR); if (t.unref) t.unref();
  }
  return { sweep };
}

// Weather on the road (Nov 21, 2026). Every hour, for each truck that is rolling, we look where it is now and where it is going
// next (its next stop's ZIP):
//   - official warnings from the US National Weather Service (api.weather.gov, free): winter storm, ice, flood, tornado, high wind…
//   - the hourly forecast: the National Weather Service's own (free, api.weather.gov gridpoints) first; Google's Weather API
//     ($0.15 per 1,000 after 10,000 free a month) only when the NWS doesn't answer (Nov 21: the user's call, to keep it ~free).
// The driver hears about it once, when it starts (both drivers on a team); after that only when it changes: a new official
// warning, the forecast getting worse, or it getting better / clearing (after two checks in a row, so a borderline forecast
// doesn't flip back and forth). Weather pushes go out for real even in training mode (Nov 21: the user's call).
// Trucks close together share one look (a ~15-mile grid square, kept for the hour), so the cost stays at a few dollars a month.
import { driverStops } from './driverstops.js';
import { CHECKINS } from './checkins.js';
import { placeKey, haversineMi } from './watchtower.js';
import { asLive } from './training.js';

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
  if (/FREEZING|SLEET|ICE_PELLETS|WINTRY/.test(t) && percent >= 40) return 'ice';
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

// The NWS hourly forecast in the same shape as Google's (so every rule above works on either). NWS says it in words
// ("Rain And Snow Likely", "Mostly Sunny"); this turns the words into a condition type. Pure.
export function nwsType(text = '') {
  const t = String(text);
  const heavy = /heavy/i.test(t);
  if (/thunder|t-storm/i.test(t)) return 'THUNDERSTORM';
  if (/blizzard/i.test(t)) return 'BLIZZARD';
  if (/freezing|sleet|ice pellets|wintry/i.test(t)) return 'FREEZING_RAIN';
  if (/snow|flurr/i.test(t)) return /rain/i.test(t) ? 'RAIN_AND_SNOW' : heavy ? 'HEAVY_SNOW' : 'SNOW';
  if (/rain|shower|drizzle/i.test(t)) return heavy ? 'HEAVY_RAIN' : 'RAIN';
  if (/fog|haze|smoke|mist/i.test(t)) return 'FOG';
  if (/wind|breezy|blustery|gust/i.test(t)) return 'WINDY';
  if (/mostly cloudy|cloudy|overcast/i.test(t) && !/partly/i.test(t)) return 'CLOUDY';
  if (/sunny|clear|partly cloudy/i.test(t)) return 'CLEAR';
  return null;
}
export function fromNws(json) {
  const periods = ((json && json.properties && json.properties.periods) || []);
  if (!periods.length) return null;
  return { source: 'NWS', forecastHours: periods.map((x) => ({ interval: { startTime: x.startTime }, isDaytime: x.isDaytime !== false,
    temperature: { degrees: x.temperatureUnit === 'C' ? Math.round(x.temperature * 9 / 5 + 32) : x.temperature },
    precipitation: { probability: { percent: Number((x.probabilityOfPrecipitation || {}).value) || 0 } },
    weatherCondition: { type: nwsType(x.shortForecast), description: { text: x.shortForecast || null } } })) };
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
// every stop not delivered yet that we can place on the map (for the weather picture on each stop card). Pure.
export function stopPoints(item, { geo = {}, steps = {}, etas = {} } = {}) {
  const bills = (item && (item.freightBills || item.orders)) || [];
  const zipOf = (x) => (String(x || '').match(/\b(\d{5})\b/) || [])[1] || null;
  return driverStops(item, { geo }).filter((x) => !x.delivered && !steps[`delivered:${x.key}`]).map((x) => {
    const bill = bills.find((b) => (x.bills || []).some((y) => y.bill === b.billNumber));
    const g = [x.zip, bill && zipOf(bill.endZone), placeKey(x.place || x.key)].map((k) => (k ? geo[k] : null)).find((v) => v && v.lat != null);
    const log = etas[placeKey(x.place || x.key)]; const last = log && (log.ours || []).slice(-1)[0];
    return g ? { role: 'stop', stop: x.key, lat: g.lat, lng: g.lng, place: x.place || x.name || null, eta: last && last.etaMs ? last.etaMs : null } : null;
  }).filter(Boolean);
}

// No ETA logged for a stop yet (Nov 22, Ferney in Miami: stops in Connecticut / Massachusetts showed tonight's storms): a rough
// arrival from where the truck is, in stop order — road miles ≈ 1.2 × straight line at 50 mph, an hour at each stop before.
// Good enough to pick the right day's forecast; never shown as an ETA. Pure. → points with eta filled in
export function roughEtas(points = [], truck = null, now = Date.now()) {
  if (!truck || truck.lat == null || truck.lng == null) return points;
  let at = { lat: Number(truck.lat), lng: Number(truck.lng) }; let hours = 0;
  return points.map((p, i) => {
    hours += (haversineMi(at.lat, at.lng, p.lat, p.lng) * 1.2) / 50 + (i ? 1 : 0);
    at = { lat: p.lat, lng: p.lng };
    return p.eta ? p : { ...p, eta: now + hours * HOUR, rough: true };
  });
}

// the picture for one stop when the truck gets there (our ETA): an official warning still on then, else the worst forecast
// within 2 hours of the ETA, else sun / clouds. No ETA yet: the next 24 hours. Pure.
const SKY_OF_TYPE = (t) => (/CLEAR|SUNNY|PARTLY_CLOUDY/.test(t) ? 'sun' : /CLOUDY|OVERCAST/.test(t) ? 'cloud' : /WIND/.test(t) ? 'wind' : /FOG|HAZE|MIST/.test(t) ? 'fog' : null);
export function stopSky(w, { eta = null, now = Date.now() } = {}) {
  if (!w) return null;
  // our ETA for the stop (etareport.js log): the weather around when the truck gets there; a warning only if it still runs then
  const at = eta && eta > now ? eta : null;
  const al = roadAlerts(w.nws).find((a) => !at || !a.until || Date.parse(a.until) >= at - HOUR);
  if (al) {
    const e = al.event || '';
    const scene = /flood/i.test(e) ? 'flood' : /ice|freezing|sleet/i.test(e) ? 'ice' : /snow|winter|blizzard|cold|chill/i.test(e) ? 'snow' : /wind|dust/i.test(e) ? 'wind' : /fog/i.test(e) ? 'fog' : 'storm';
    return { scene, event: e, until: al.until || null, ...(at ? { eta: at } : {}) };
  }
  const all = (w.forecast && w.forecast.forecastHours) || [];
  const near = at ? all.filter((x) => Math.abs(Date.parse(((x.interval || {}).startTime) || 0) - at) <= 2 * HOUR) : all.slice(0, 24);
  if (at && !near.length) return null;   // arriving past what the forecast covers: no guess
  const h = worstHour({ forecastHours: near }, { hours: near.length });
  if (h) return { scene: h.kind, at: h.at, percent: h.percent, ...(at ? { eta: at } : {}) };
  const hours = at ? near : near.slice(0, 12);
  const day = hours.filter((x) => x.isDaytime !== false);
  const count = {};
  (day.length ? day : hours).forEach((x) => { const k = SKY_OF_TYPE(String((x.weatherCondition || {}).type || '').toUpperCase()); if (k && !(k === 'sun' && x.isDaytime === false)) count[k] = (count[k] || 0) + 1; });   // no sun at night
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return top ? { scene: top[0], ...(at ? { eta: at } : {}) } : null;
}

const cell = (p) => `${(Math.round(p.lat * 4) / 4).toFixed(2)},${(Math.round(p.lng * 4) / 4).toFixed(2)}`;   // ~15 miles

const hm = (iso) => { const d = new Date(iso || ''); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }); };

// official warnings arrive in English: the common ones in Spanish for the push title (same names as the driver app). Pure.
const EVENT_ES = [[/flash flood warning/i, 'Aviso de inundación repentina'], [/flash flood watch/i, 'Vigilancia de inundación repentina'], [/flood warning/i, 'Aviso de inundación'], [/flood watch/i, 'Vigilancia de inundación'], [/flood advisory/i, 'Advertencia de inundación'],
  [/winter storm warning/i, 'Aviso de tormenta invernal'], [/winter storm watch/i, 'Vigilancia de tormenta invernal'], [/winter weather advisory/i, 'Advertencia de clima invernal'], [/blizzard warning/i, 'Aviso de ventisca'], [/ice storm warning/i, 'Aviso de tormenta de hielo'],
  [/freezing rain/i, 'Lluvia helada'], [/freezing fog/i, 'Niebla helada'], [/snow squall warning/i, 'Aviso de ráfagas de nieve'], [/lake effect snow/i, 'Nieve por efecto lago'], [/heavy snow/i, 'Nevada fuerte'],
  [/tornado warning/i, 'Aviso de tornado'], [/tornado watch/i, 'Vigilancia de tornado'], [/severe thunderstorm warning/i, 'Aviso de tormenta severa'], [/severe thunderstorm watch/i, 'Vigilancia de tormenta severa'],
  [/hurricane warning/i, 'Aviso de huracán'], [/hurricane watch/i, 'Vigilancia de huracán'], [/tropical storm warning/i, 'Aviso de tormenta tropical'], [/tropical storm watch/i, 'Vigilancia de tormenta tropical'],
  [/high wind warning/i, 'Aviso de vientos fuertes'], [/high wind watch/i, 'Vigilancia de vientos fuertes'], [/wind advisory/i, 'Advertencia de viento'], [/dust storm warning/i, 'Aviso de tormenta de polvo'],
  [/dense fog advisory/i, 'Advertencia de niebla densa'], [/extreme cold warning/i, 'Aviso de frío extremo'], [/cold weather advisory|wind chill/i, 'Advertencia de frío']];
export const eventEs = (e) => { const hit = EVENT_ES.find(([re]) => re.test(String(e || ''))); return hit ? hit[1] : e; };

// the push the driver gets (Spanish first, English under it — the phone's language isn't known here). Pure.
export function pushFor(a) {
  if (a.kind === 'clear') return { title: '✅ El clima mejoró en su ruta', body: 'Ya no hay avisos de clima en su ruta. Buen viaje. · Weather cleared on your route.' };
  if (a.kind === 'better') return { title: `🌤️ Mejora: ahora ${ES[a.now].toLowerCase()}${a.place ? ` ${a.role === 'next' ? 'en su próxima parada' : 'cerca de'} ${a.place}` : ''}`, body: `Lo peor ya pasó. ${TIP_ES[a.now]} · Improving: now ${EN[a.now].toLowerCase()}${a.place ? ` ${a.role === 'next' ? 'at your next stop' : 'near'} ${a.place}` : ''}.` };
  if (a.kind === 'alert') {
    return { title: `⚠️ ${eventEs(a.event)}${a.place ? ` · ${a.place}` : ''}`, body: `Aviso oficial del clima en su ruta${a.until ? ` hasta ${hm(a.until)}` : ''}. Maneje con cuidado. · ${a.event} on your route${a.until ? ` until ${hm(a.until)}` : ''}.` };
  }
  const where = a.place ? ` ${a.role === 'next' ? 'en su próxima parada' : 'cerca de'} ${a.place}` : '';
  const whereEn = a.place ? ` ${a.role === 'next' ? 'at your next stop' : 'near'} ${a.place}` : '';
  const when = a.at ? ` ~${hm(a.at)}` : '';
  return { title: `${ICON[a.kind]} ${a.worse ? 'Empeora: ' : ''}${ES[a.kind]}${where}${when}`, body: `${TIP_ES[a.kind]} · ${EN[a.kind]}${whereEn}${when} (${a.percent}%).` };
}

// What to tell the driver this hour, given what they were last told. Pure.
//   prev: { nws: [ids told], fcRank, fcKind, quiet } ; alerts: this hour's list ; failed: a look didn't answer (never read as "cleared")
//   → { say: [items for pushFor], next }
export function decide(prev, alerts = [], { failed = false } = {}) {
  const p = { nws: [], fcRank: 0, fcKind: null, quiet: 0, ...(prev || {}) };
  const nws = alerts.filter((a) => a.kind === 'alert');
  const fc = alerts.filter((a) => a.kind !== 'alert').sort((x, y) => RANK[y.kind] - RANK[x.kind])[0] || null;
  const fcRank = fc ? RANK[fc.kind] : 0;
  const say = [];
  for (const a of nws) if (!p.nws.includes(a.id)) say.push(a);                                    // a new official warning
  if (fc && fcRank > p.fcRank) say.push({ ...fc, worse: p.fcRank > 0 });                           // the first heads-up, or worse
  const next = { nws: [...new Set([...p.nws, ...nws.map((a) => a.id)])], fcRank: Math.max(p.fcRank, fcRank), fcKind: fcRank > p.fcRank ? fc.kind : p.fcKind, quiet: 0 };
  const calmer = !failed && ((nws.length === 0 && p.nws.length > 0) || fcRank < p.fcRank) && !say.length;
  if (calmer) {
    const quiet = (p.quiet || 0) + 1;
    if (quiet < 2) return { say, next: { ...p, quiet } };                                            // wait one more hour to be sure
    const nowNws = nws.map((a) => a.id);
    if (!nws.length && !fc) say.push({ kind: 'clear' });
    else if (fc && !nws.length) say.push({ kind: 'better', now: fc.kind, role: fc.role, place: fc.place });
    return { say, next: { nws: nowNws, fcRank, fcKind: fc ? fc.kind : null, quiet: 0 } };
  }
  return { say, next };
}

export function initWeather(app, { db, board, notify, requireAuth = null, requireDriver = null, loadsFor = null, env = process.env, fetchFn = (...a) => fetch(...a), now = () => Date.now() }) {
  const gKey = () => env.GOOGLE_WEATHER_KEY || env.GOOGLE_PLACES_KEY || env.GOOGLE_MAPS_KEY || '';
  const cache = new Map();   // grid cell → { at, nws, forecast }
  const grid = new Map();    // grid cell → its NWS hourly-forecast address (doesn't change)
  let googleCalls = 0;       // the backup's calls (the only ones that cost)
  const getJson = async (url, headers = {}) => { const r = await fetchFn(url, { headers }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

  // every look is good for an hour (trucks, next stops and every stop — the NWS forecast is free)
  async function look(p, maxAgeMin = 55) {
    const c = cell(p); const had = cache.get(c);
    if (had && now() - had.at < maxAgeMin * 60000) return had;
    const lat = p.lat.toFixed(4); const lng = p.lng.toFixed(4);
    const nws = await getJson(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, { 'User-Agent': UA, Accept: 'application/geo+json' }).catch(() => null);
    // the NWS forecast for this square: its grid address once (kept), then the hourly periods; Google only if that fails
    const nwsHeaders = { 'User-Agent': UA, Accept: 'application/geo+json' };
    let forecast = null;
    try {
      let url = grid.get(c);
      if (!url) { const pt = await getJson(`https://api.weather.gov/points/${lat},${lng}`, nwsHeaders); url = pt && pt.properties && pt.properties.forecastHourly; if (url) grid.set(c, url); }
      if (url) forecast = fromNws(await getJson(url, nwsHeaders));
    } catch { forecast = null; }
    const k = gKey();
    if (!forecast && k) {
      forecast = await getJson(`https://weather.googleapis.com/v1/forecast/hours:lookup?key=${encodeURIComponent(k)}&location.latitude=${lat}&location.longitude=${lng}&hours=48&unitsSystem=IMPERIAL`).then((g) => ({ ...g, source: 'Google' })).catch(() => null);
      if (forecast) googleCalls += 1;
    }
    const v = { at: now(), nws, forecast };
    cache.set(c, v);
    return v;
  }

  // one pass over the board: work out each rolling trip's weather, push what's new, keep it for the console and the app
  async function sweep() {
    const items = (await board()).filter((it) => ROLLING.test(String(tripOf(it).status || '')));
    const geo = (await db.get('taGeoZip', {}).catch(() => ({}))) || {};
    const checkins = (await db.get(CHECKINS(SITE), {}).catch(() => ({}))) || {};
    const etaLog = (await db.get(`taEtaLog:${SITE}`, {}).catch(() => ({}))) || {};   // our ETA per stop (etareport.js)
    const state = (await db.get(KEY, {})) || {};
    const told = { ...(state.told || {}) };   // trip → what the driver was last told (decide)
    const trips = {};
    let pushed = 0;
    for (const it of items) {
      const trip = tripNo(it); if (!trip) continue;
      const pts = lookPoints(it, { geo, steps: (checkins[trip] || {}).steps || {}, now: now() });
      const alerts = []; let failed = false;
      for (const p of pts) {
        const w = await look(p).catch(() => null); // eslint-disable-line no-await-in-loop
        if (!w || !w.nws) failed = true;
        if (!w) continue;
        for (const a of roadAlerts(w.nws)) if (!alerts.some((x) => x.id === a.id)) alerts.push({ kind: 'alert', ...a, role: p.role, place: p.place });
        const h = worstHour(w.forecast);
        if (h) alerts.push({ kind: h.kind, id: `${h.kind}|${p.role}|${p.place || cell(p)}`, at: h.at, percent: h.percent, tempF: h.tempF, text: h.text, role: p.role, place: p.place });
      }
      const stops = {};
      const sm = it._samsara || {};
      for (const sp of roughEtas(stopPoints(it, { geo, steps: (checkins[trip] || {}).steps || {}, etas: etaLog[trip] || {} }), sm.lat != null ? { lat: sm.lat, lng: sm.lng } : null, now())) {
        const w = await look(sp, 55).catch(() => null); // eslint-disable-line no-await-in-loop   // hourly: the NWS is free
        const sky = stopSky(w, { eta: sp.eta, now: now() });
        if (sky) stops[sp.stop] = sp.rough ? { ...sky, roughEta: true } : sky;
      }
      trips[trip] = { alerts, stops, checkedAt: new Date(now()).toISOString(), truck: tripOf(it).powerUnit || null };
      const t = tripOf(it); const codes = [t.driver, t.driver2].map((x) => String(x || '').trim()).filter(Boolean);
      const { say, next } = decide(told[trip], alerts, { failed });
      told[trip] = next;
      if (notify && codes.length) {
        for (const a of say) {
          const m = pushFor(a);
          for (const c of codes) await asLive(() => notify(c, { ...m, data: { tab: 'now', trip } })).catch(() => null); // eslint-disable-line no-await-in-loop
          pushed += 1;
        }
      }
    }
    for (const k of Object.keys(told)) if (!trips[k]) delete told[k];   // loads that left the road
    await db.set(KEY, { trips, told, checkedAt: new Date(now()).toISOString() });
    return { trips: Object.keys(trips).length, pushed, looks: cache.size, googleCalls };
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
    const run = () => { sweep().then((r) => console.log('[weather]', JSON.stringify(r))).catch((e) => console.warn('[weather]', e.message)); };
    const first = setTimeout(run, 3 * 60000); if (first.unref) first.unref();
    const t = setInterval(run, HOUR); if (t.unref) t.unref();
  }
  return { sweep };
}

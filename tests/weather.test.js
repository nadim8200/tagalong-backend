import test from 'node:test';
import assert from 'node:assert/strict';
import { hazardOf, worstHour, roadAlerts, pushFor, initWeather, decide, stopSky, nwsType, fromNws } from '../weather.js';

const mem = () => { const s = {}; return { s, get: async (k, d) => (k in s ? JSON.parse(JSON.stringify(s[k])) : d), set: async (k, v) => { s[k] = JSON.parse(JSON.stringify(v)); }, update: async (k, f, d) => { s[k] = f(k in s ? s[k] : d); return s[k]; } }; };
const NOW = Date.parse('2026-11-21T18:00:00Z');
const hour = (h, type, percent, degrees = 50) => ({ interval: { startTime: new Date(NOW + h * 3600000).toISOString() }, weatherCondition: { type, description: { text: type } }, precipitation: { probability: { percent } }, temperature: { degrees } });

test('what the forecast means for a driver: rain, storms, snow, ice; a slight chance is not worth a push (Nov 21)', () => {
  assert.equal(hazardOf('LIGHT_RAIN', { percent: 70 }), 'rain');
  assert.equal(hazardOf('LIGHT_RAIN', { percent: 30 }), null);
  assert.equal(hazardOf('THUNDERSTORM', { percent: 60 }), 'storm');
  assert.equal(hazardOf('HEAVY_SNOW', { percent: 50 }), 'snow');
  assert.equal(hazardOf('LIGHT_RAIN', { percent: 60, tempF: 30 }), 'ice');
  assert.equal(hazardOf('CLEAR', { percent: 0 }), null);
  const w = worstHour({ forecastHours: [hour(1, 'CLOUDY', 10), hour(3, 'LIGHT_RAIN', 70), hour(6, 'SNOW', 60, 28), hour(14, 'HEAVY_SNOW', 90)] });
  assert.equal(w.kind, 'snow'); assert.equal(w.at, new Date(NOW + 6 * 3600000).toISOString());   // hour 14 is past the 12-hour look
});

test('official NWS warnings: road-relevant ones only, never tests or cancels', () => {
  const geo = { features: [
    { properties: { id: 'a1', event: 'Winter Storm Warning', severity: 'Severe', status: 'Actual', messageType: 'Alert', areaDesc: 'Knox, TN', ends: '2026-11-22T06:00:00Z' } },
    { properties: { id: 'a2', event: 'Frost Advisory', severity: 'Minor', status: 'Actual' } },
    { properties: { id: 'a3', event: 'Tornado Warning', severity: 'Extreme', status: 'Test' } },
    { properties: { id: 'a4', event: 'Flood Watch', severity: 'Moderate', status: 'Actual', messageType: 'Update' } },
  ] };
  assert.deepEqual(roadAlerts(geo).map((a) => a.id), ['a1', 'a4']);
  const wp = pushFor({ kind: 'alert', event: 'Winter Storm Warning', place: 'Knoxville, TN', until: '2026-11-22T06:00:00Z' });
  assert.match(wp.title, /Aviso de tormenta invernal · Knoxville/); assert.match(wp.body, /Winter Storm Warning on your route/);
  assert.match(pushFor({ kind: 'snow', role: 'next', place: 'LUDLOW, MA', at: new Date(NOW).toISOString(), percent: 60 }).title, /❄️ Nieve en su próxima parada LUDLOW, MA/);
});

test('the hourly sweep: rolling trucks only, both drivers of a team, each warning once, trucks close together share one look', async () => {
  const db = mem();
  await db.set('taGeoZip', { '01056': { lat: 42.16, lng: -72.48 } });
  const item = (n, lat, status = 'INTRAN') => ({ trip: { tripNumber: n, status, driver: 'A1', driver2: n === '1' ? 'B2' : null, powerUnit: `T${n}` }, freightBills: [{ billNumber: `B${n}`, endZoneDescription: 'LUDLOW, MA', endZone: '01056', billToName: 'COSTCO', pieces: 10 }], _samsara: { lat, lng: -77.0, at: new Date(NOW - 600000).toISOString(), location: 'Harrisburg, PA' } });
  const board = async () => [item('1', 40.27), item('2', 40.28), item('3', 40.3, 'DISP')];
  const urls = []; const pushes = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url.includes('/alerts/active')) return { ok: true, json: async () => ({ features: url.includes('40.') ? [{ properties: { id: 'w1', event: 'Winter Weather Advisory', severity: 'Moderate', status: 'Actual' } }] : [] }) };
    if (url.includes('/points/')) return { ok: true, json: async () => ({ properties: { forecastHourly: `https://api.weather.gov/gridpoints/X/${url.split('/points/')[1]}/forecast/hourly` } }) };
    if (url.includes('/forecast/hourly')) return { ok: true, json: async () => ({ properties: { periods: Array.from({ length: 12 }, (_, i) => ({ startTime: new Date(NOW + (2 + i) * 3600000).toISOString(), isDaytime: true, temperature: 30, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 70 }, shortForecast: 'Snow Likely' })) } }) };   // 12 hours: the Ludlow stop is ~6 h out (rough ETA)
    throw new Error('Google should not be called while the NWS answers');
  };
  let clock = NOW;
  const w = initWeather(null, { db, board, notify: async (code, m) => { pushes.push([code, m.title]); }, env: { GOOGLE_WEATHER_KEY: 'k', NODE_ENV: 'test' }, fetchFn, now: () => clock });
  const r = await w.sweep();
  assert.equal(r.trips, 2, 'the DISP truck is not rolling');
  assert.equal(urls.filter((u) => u.includes('/alerts/active')).length, 2, 'trucks 1 and 2 share the Harrisburg square; the Ludlow stop is the other look');
  assert.equal(r.googleCalls, 0, 'the free NWS forecast answered: no Google calls');
  const s = (await db.get('taWeather:florida-beauty')).trips;
  assert.deepEqual(s['1'].alerts.map((a) => a.kind).sort(), ['alert', 'snow', 'snow']);
  assert.deepEqual(Object.keys(s['1'].stops), ['LUDLOW, MA']); assert.equal(s['1'].stops['LUDLOW, MA'].scene, 'snow');   // the picture on the stop card
  assert.deepEqual(pushes.filter(([c]) => c === 'B2').length, 2, 'the co-driver too: the warning and one forecast push (the worst)');
  pushes.length = 0; clock = NOW + 3600000;
  await w.sweep();
  assert.deepEqual(pushes, [], 'nothing new an hour later: no repeat');
});

test('tell the driver once; again only when it changes: a new warning, worse, or better / cleared (two checks in a row) (Nov 21)', () => {
  const rain = { kind: 'rain', id: 'rain|truck|Ocala', role: 'truck', place: 'Ocala, FL', percent: 70 };
  const snow = { kind: 'snow', id: 'snow|next|Ludlow', role: 'next', place: 'LUDLOW, MA', percent: 80 };
  const warn = { kind: 'alert', id: 'nws1', event: 'Winter Storm Warning' };
  let r = decide(null, [rain]);
  assert.deepEqual(r.say.map((a) => a.kind), ['rain']); assert.equal(r.say[0].worse, false);
  r = decide(r.next, [rain]); assert.deepEqual(r.say, [], 'same weather next hour: quiet');
  r = decide(r.next, [rain, snow]); assert.deepEqual(r.say.map((a) => [a.kind, a.worse]), [['snow', true]], 'worse: tell them');
  assert.match(pushFor(r.say[0]).title, /^❄️ Empeora: Nieve/);
  r = decide(r.next, [snow, warn]); assert.deepEqual(r.say.map((a) => a.id), ['nws1'], 'a new official warning');
  r = decide(r.next, [snow, warn]); assert.deepEqual(r.say, []);
  r = decide(r.next, [rain]); assert.deepEqual(r.say, [], 'better for one hour: wait to be sure');
  r = decide(r.next, [snow, warn]); assert.deepEqual(r.say, [], 'it came back: nothing new to say');
  r = decide(r.next, [rain]); r = decide(r.next, [rain]);
  assert.deepEqual(r.say.map((a) => [a.kind, a.now]), [['better', 'rain']], 'better two hours in a row: tell them once');
  assert.match(pushFor(r.say[0]).title, /^🌤️ Mejora: ahora lluvia/);
  r = decide(r.next, [rain]); assert.deepEqual(r.say, []);
  r = decide(r.next, [], { failed: true }); assert.deepEqual(r.say, [], 'no answer from the weather service is not "cleared"');
  r = decide(r.next, []); r = decide(r.next, []);
  assert.deepEqual(r.say.map((a) => a.kind), ['clear']); assert.match(pushFor(r.say[0]).title, /✅/);
  r = decide(r.next, []); assert.deepEqual(r.say, []);
});

test('the picture on each stop card: a warning there, else the worst of the next 24 hours, else sun or clouds (Nov 21)', () => {
  const sky = (types, nws = []) => stopSky({ nws: { features: nws }, forecast: { forecastHours: types.map((t, i) => ({ ...hour(i, t[0], t[1]), isDaytime: true })) } });
  assert.deepEqual(sky([['CLEAR', 0], ['PARTLY_CLOUDY', 10], ['MOSTLY_CLOUDY', 10]]), { scene: 'sun' });
  assert.deepEqual(sky([['CLOUDY', 10], ['CLOUDY', 20], ['CLEAR', 0]]), { scene: 'cloud' });
  assert.equal(sky([['CLEAR', 0], ['HEAVY_RAIN', 80]]).scene, 'storm');
  assert.equal(sky([['CLEAR', 0]], [{ properties: { id: 'f', event: 'Flood Warning', severity: 'Severe', status: 'Actual' } }]).scene, 'flood');
  assert.equal(stopSky(null), null);
  assert.equal(stopSky({ nws: { features: [] }, forecast: null }), null, 'no forecast yet (Google not on): no picture, never a guess');
});

test('the stop picture is the weather when the truck gets there (our ETA), not now (Nov 21)', () => {
  const fc = { forecastHours: [hour(0, 'CLEAR', 0), hour(1, 'CLEAR', 0), hour(5, 'SNOW', 80, 28), hour(6, 'SNOW', 80, 28), hour(7, 'CLOUDY', 10), hour(12, 'CLEAR', 0)].map((x) => ({ ...x, isDaytime: true })) };
  const w = { nws: { features: [] }, forecast: fc };
  assert.equal(stopSky(w, { eta: NOW + 6 * 3600000, now: NOW }).scene, 'snow', 'arrives at 6 h: snow then');
  assert.equal(stopSky(w, { eta: NOW + 12 * 3600000, now: NOW }).scene, 'sun', 'arrives at 12 h: clear by then');
  assert.equal(stopSky(w, { eta: NOW + 60 * 3600000, now: NOW }), null, 'past the forecast: no guess');
  const warn = { nws: { features: [{ properties: { id: 'f', event: 'Flood Warning', severity: 'Severe', status: 'Actual', ends: new Date(NOW + 3 * 3600000).toISOString() } }] }, forecast: fc };
  assert.equal(stopSky(warn, { eta: NOW + 2 * 3600000, now: NOW }).scene, 'flood', 'the warning still runs when they arrive');
  assert.equal(stopSky(warn, { eta: NOW + 12 * 3600000, now: NOW }).scene, 'sun', 'the warning ends before they get there');
  assert.equal(stopSky(w, { eta: NOW + 6 * 3600000, now: NOW }).eta, NOW + 6 * 3600000);
});

test('the NWS forecast words become the same weather kinds (free forecast first) (Nov 21)', () => {
  assert.equal(nwsType('Rain And Snow Likely'), 'RAIN_AND_SNOW');
  assert.equal(nwsType('Light Rain Likely'), 'RAIN');
  assert.equal(nwsType('Heavy Rain'), 'HEAVY_RAIN');
  assert.equal(nwsType('Chance Showers And Thunderstorms'), 'THUNDERSTORM');
  assert.equal(nwsType('Freezing Rain'), 'FREEZING_RAIN');
  assert.equal(nwsType('Patchy Fog'), 'FOG');
  assert.equal(nwsType('Mostly Sunny'), 'CLEAR'); assert.equal(nwsType('Partly Cloudy'), 'CLEAR'); assert.equal(nwsType('Mostly Cloudy'), 'CLOUDY');
  const f = fromNws({ properties: { periods: [
    { startTime: '2026-11-21T19:00:00-05:00', isDaytime: false, temperature: 31, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 60 }, shortForecast: 'Rain And Snow Likely' },
    { startTime: '2026-11-21T20:00:00-05:00', isDaytime: false, temperature: 30, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 70 }, shortForecast: 'Freezing Rain Likely' },
  ] } });
  assert.equal(f.source, 'NWS');
  assert.equal(worstHour(f).kind, 'ice', 'freezing rain beats the mix');
  assert.equal(hazardOf('RAIN_AND_SNOW', { percent: 60, tempF: 31 }), 'snow');
  assert.equal(fromNws({ properties: { periods: [] } }), null);
  const night = { nws: { features: [] }, forecast: fromNws({ properties: { periods: [{ startTime: new Date(NOW).toISOString(), isDaytime: false, temperature: 40, probabilityOfPrecipitation: { value: 0 }, shortForecast: 'Clear' }] } }) };
  assert.equal(stopSky(night, { now: NOW - 1 }), null, 'a clear night is not a sun picture');
});

test('when the NWS forecast does not answer, Google fills in (and only then it costs) (Nov 21)', async () => {
  const db = mem();
  const item = { trip: { tripNumber: '9', status: 'INTRAN', driver: 'A1', powerUnit: 'T9' }, freightBills: [], _samsara: { lat: 30.3, lng: -81.6, at: new Date(NOW).toISOString(), location: 'Jacksonville, FL' } };
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url.includes('/alerts/active')) return { ok: true, json: async () => ({ features: [] }) };
    if (url.includes('api.weather.gov')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, json: async () => ({ forecastHours: [hour(1, 'HEAVY_RAIN', 80)] }) };
  };
  const w = initWeather(null, { db, board: async () => [item], notify: async () => {}, env: { GOOGLE_WEATHER_KEY: 'k', NODE_ENV: 'test' }, fetchFn, now: () => NOW });
  const r = await w.sweep();
  assert.equal(r.googleCalls, 1);
  assert.equal((await db.get('taWeather:florida-beauty')).trips['9'].alerts[0].kind, 'storm');
});

test('a stop with no ETA yet gets a rough one from where the truck is, in order — so the right day\'s forecast is used (Nov 22, Miami → Massachusetts)', async () => {
  const { roughEtas } = await import('../weather.js');
  const now = Date.parse('2026-11-23T01:00:00Z');
  const pts = [{ stop: 'SOUTHAMPTON, PA', lat: 40.17, lng: -75.03 }, { stop: 'WINCHESTER, MA', lat: 42.45, lng: -71.14, eta: now + 99 }];
  const r = roughEtas(pts, { lat: 25.8, lng: -80.3 }, now);
  const h = (r[0].eta - now) / 3600000;
  assert.ok(h > 20 && h < 30, `about a day of driving, got ${h}`); assert.equal(r[0].rough, true);
  assert.equal(r[1].eta, now + 99, 'a logged ETA wins'); assert.equal(r[1].rough, undefined);
  assert.deepEqual(roughEtas(pts, null, now), pts, 'no truck position: unchanged');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hazardOf, worstHour, roadAlerts, pushFor, initWeather } from '../weather.js';

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
  assert.match(pushFor({ kind: 'alert', event: 'Winter Storm Warning', place: 'Knoxville, TN', until: '2026-11-22T06:00:00Z' }).title, /Winter Storm Warning · Knoxville/);
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
    if (url.includes('api.weather.gov')) return { ok: true, json: async () => ({ features: url.includes('40.') ? [{ properties: { id: 'w1', event: 'Winter Weather Advisory', severity: 'Moderate', status: 'Actual' } }] : [] }) };
    return { ok: true, json: async () => ({ forecastHours: [hour(2, 'SNOW', 70, 30)] }) };
  };
  let clock = NOW;
  const w = initWeather(null, { db, board, notify: async (code, m) => { pushes.push([code, m.title]); }, env: { GOOGLE_WEATHER_KEY: 'k', NODE_ENV: 'test' }, fetchFn, now: () => clock });
  const r = await w.sweep();
  assert.equal(r.trips, 2, 'the DISP truck is not rolling');
  assert.equal(urls.filter((u) => u.includes('api.weather.gov')).length, 2, 'trucks 1 and 2 share the Harrisburg square; the Ludlow stop is the other look');
  const s = (await db.get('taWeather:florida-beauty')).trips;
  assert.deepEqual(s['1'].alerts.map((a) => a.kind).sort(), ['alert', 'snow', 'snow']);
  assert.deepEqual(pushes.filter(([c]) => c === 'B2').length, 2, 'the co-driver too: the warning and one forecast push (the worst)');
  pushes.length = 0; clock = NOW + 3600000;
  await w.sweep();
  assert.deepEqual(pushes, [], 'nothing new an hour later: no repeat');
});

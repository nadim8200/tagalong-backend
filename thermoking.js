// ---------------------------------------------------------------
// Thermo King TracKing (REST web service, READ ONLY): the reefer readings of our trailers — return air, discharge air, set
// point, unit on / off, alarms — every 15 minutes, for the load cards and the reefer temperature alerts. TruckMate's own
// TK Tracking job uses the same web-service account, so this is careful with it:
//  • the login (obtainToken) at most once a day, kept in the database; Thermo King blocks an account after 35 logins a day
//    (HTTP 423) — on a 423 Jarvis stops asking for 24 hours;
//  • reading data takes nothing away from TruckMate: Thermo King serves the readings stored in a time range to anyone asking;
//  • the Command API (unit settings, door locks) is never used.
// Render: THERMOKING_USER, THERMOKING_PASSWORD, THERMOKING_CUSTOMER_ID (the external customer ID). Temperatures come in °C,
// times in UTC (TKA TracKing REST WS API, June 2024).
// ---------------------------------------------------------------
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const KEY = 'taThermoKing';                // { units: { trailer: reading }, history: { trailer: [{ at, returnF, setF }] }, lastEnd, lastPoll, error }
const TOKEN = 'taThermoKingToken';         // { accessToken, obtainedAt, refreshExpiresAt, attempts: { [ET day]: n }, blockedUntil }
export const TK_BASE = 'https://rest.tracking.thermoking.com/connected-solutions';
export const POLL_MS = 15 * MIN;
export const MAX_LOGINS_A_DAY = 3;

export const cToF = (c) => (c == null || c === '' || !Number.isFinite(Number(c)) ? null : Math.round((Number(c) * 9 / 5 + 32) * 10) / 10);
// the trailer number a unit is named by in TracKing (external ID, else vehicle name) — "07200" and "7200" are the same. Pure.
export const tkTrailer = (v) => String((v && (v.externalId || v.vehicleName)) || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
// "2026-11-16 18:05:00" in UTC, the API's date format. Pure.
export const tkStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const utcMs = (s) => { const t = String(s || '').trim(); if (!t) return NaN; return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(/\+0000$/, 'Z') : `${t.replace(' ', 'T')}Z`); };

// One unit's reading, kept small, in °F. Pure.
export function slimTk(v) {
  const at = utcMs(v.dataDate);
  return {
    trailer: tkTrailer(v), serial: v.reeferSerialNumber || null, at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    returnF: cToF(v.returnAir1), supplyF: cToF(v.dischargeAir1), setF: cToF(v.setPoint1),
    zone2: v.setPoint2 != null || v.returnAir2 != null ? { returnF: cToF(v.returnAir2), setF: cToF(v.setPoint2) } : null,
    powerOn: v.powerOn == null ? null : !!v.powerOn, controller: v.controllerStatus || null, mode: v.operatingMode1 || null,
    doorOpen: v.zone1DoorOpen == null ? null : !!v.zone1DoorOpen,
    alarms: (Array.isArray(v.alarms) ? v.alarms : []).slice(0, 6).map((a) => ({ code: a.alarmCode, text: a.alarmDescription || null, severity: a.alarmSeverity || null })),
    location: v.locationDescription || null, lat: v.latitude ?? null, lng: v.longitude ?? null, mph: v.speed == null ? null : Math.round(Number(v.speed) * 0.621371),
  };
}
// The newest reading per trailer in an API answer (v1 is a list, v2 has it under "data"). Pure.
export function latestByTrailer(answer) {
  const list = Array.isArray(answer) ? answer : ((answer && answer.data) || []);
  const out = {};
  for (const v of list) {
    const r = slimTk(v || {});
    if (!r.trailer || !r.at) continue;
    if (!out[r.trailer] || r.at > out[r.trailer].at) out[r.trailer] = r;
  }
  return out;
}
// Every reading per trailer in an API answer, oldest first. Pure.
export function readingsByTrailer(answer) {
  const list = Array.isArray(answer) ? answer : ((answer && answer.data) || []);
  const out = {};
  for (const v of list) { const r = slimTk(v || {}); if (r.trailer && r.at && r.lat != null && r.lng != null) (out[r.trailer] = out[r.trailer] || []).push(r); }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.at.localeCompare(b.at));
  return out;
}
const MOVE_MI = 0.5;
const miles = (a, b) => { const R = 3958.8; const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng); const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
// Since when the trailer has sat where it is now: walking back through its readings while it stays within half a mile and
// isn't moving. atLeast = it was already parked at the oldest reading we have. Pure. → { parkedSince, atLeast }
export function parkedSinceOf(readings = []) {
  if (!readings.length) return null;
  const last = readings[readings.length - 1];
  let since = last.at; let atLeast = true;
  for (let i = readings.length - 1; i >= 0; i -= 1) {
    const r = readings[i];
    if (miles(r, last) > MOVE_MI || (r.mph || 0) > 5) { atLeast = false; break; }
    since = r.at;
  }
  return { parkedSince: since, atLeast };
}
// The next reading: still parked → keeps its parked-since; moved → parked since this reading. Pure.
export function nextParked(prev, x) {
  if (!prev || prev.lat == null || x.lat == null) return { parkedSince: x.at, atLeast: true };
  if (miles(prev, x) > MOVE_MI || (x.mph || 0) > 5) return { parkedSince: x.at, atLeast: false };
  return { parkedSince: prev.parkedSince || prev.at, atLeast: prev.parkedSince ? !!prev.atLeast : true };
}

// A new login? Only when there's no token, it's a day old, or the refresh token runs out within 6 hours — never past the
// daily cap, never while Thermo King has us blocked. Pure.
export function needLogin(tok = {}, now = Date.now(), day = '') {
  if (tok.blockedUntil && now < tok.blockedUntil) return false;
  if (((tok.attempts || {})[day] || 0) >= MAX_LOGINS_A_DAY) return false;
  if (!tok.accessToken) return true;
  if (now - (tok.obtainedAt || 0) >= DAY) return true;
  return !!(tok.refreshExpiresAt && tok.refreshExpiresAt - now < 6 * 60 * MIN);
}

export function initThermoKing({ app = null, requireAuth = null, db, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const cfg = () => ({ user: env.THERMOKING_USER || '', password: env.THERMOKING_PASSWORD || '', customer: env.THERMOKING_CUSTOMER_ID || '', base: String(env.THERMOKING_URL || TK_BASE).replace(/\/+$/, '') });
  const ready = () => { const c = cfg(); return !!(db && db.enabled && c.user && c.password && c.customer); };
  const etDay = () => new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  async function token({ force = false } = {}) {
    const c = cfg();
    const tok = (await db.get(TOKEN, {})) || {};
    if (!force && !needLogin(tok, now(), etDay())) return tok.accessToken || null;
    if (tok.blockedUntil && now() < tok.blockedUntil) return null;
    const day = etDay();
    if (((tok.attempts || {})[day] || 0) >= MAX_LOGINS_A_DAY) return tok.accessToken || null;
    const attempts = { [day]: ((tok.attempts || {})[day] || 0) + 1 };
    await db.set(TOKEN, { ...tok, attempts });   // counted before the call: a crash can't loop logins
    const r = await fetchFn(`${c.base}/obtainToken/`, { method: 'POST', headers: { 'X-External-ID': c.customer, 'Content-Type': 'application/json' }, body: JSON.stringify({ userName: c.user, password: c.password }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 423) { await db.set(TOKEN, { ...tok, attempts, blockedUntil: now() + DAY, error: 'Thermo King blocked the login (423) — waiting 24 h; tracking@thermoking.com can unblock it' }); throw new Error('Thermo King blocked the login (423)'); }
    if (!r.ok || !j.accessToken) {
      // keep Thermo King's own words (never the request: it carries the password)
      const why = String(j.message || j.error || j.errorMessage || j.detail || '').replace(/\s+/g, ' ').slice(0, 200);
      await db.set(TOKEN, { ...tok, attempts, error: `login refused (HTTP ${r.status})${why ? `: ${why}` : ''}`, errorAt: now() });
      throw new Error(`Thermo King login refused (HTTP ${r.status})${why ? `: ${why}` : ''}`);
    }
    await db.set(TOKEN, { accessToken: j.accessToken, obtainedAt: now(), refreshExpiresAt: j.expiresIn ? now() + Number(j.expiresIn) * 1000 : null, attempts, error: null });
    return j.accessToken;
  }

  async function poll() {
    if (!ready()) return { skipped: 'not configured' };
    const c = cfg();
    const st = (await db.get(KEY, {})) || {};
    let loginErr = null;
    // a refused login keeps the token we have (it may still work for a while) — and the reason is kept for the status
    let tk = await token().catch(async (e) => { loginErr = e.message; return ((await db.get(TOKEN, {})) || {}).accessToken || null; });
    if (!tk) { if (loginErr) await db.set(KEY, { ...st, lastPoll: new Date(now()).toISOString(), error: loginErr }); return loginErr ? { error: loginErr } : { skipped: 'no token (blocked or out of logins for today)' }; }
    // since the last read (5 min overlap), at most the last 2 hours — Thermo King refuses ranges over 24 h
    const end = now(); const start = Math.max(end - 2 * 60 * MIN, (st.lastEnd || 0) - 5 * MIN);
    const url = `${c.base}/getTemperatureDataForVehicles/${encodeURIComponent(tkStamp(start))}/${encodeURIComponent(tkStamp(end))}/`;
    const get = (t) => fetchFn(url, { headers: { 'X-External-ID': c.customer, 'X-OAuth2-Token': t, 'Content-Type': 'application/json' } });
    let r = await get(tk);
    if (r.status === 401 || r.status === 403) {
      // a refused read means the token is no good — log in again, but not twice within an hour (a login that just worked
      // and still gets refused isn't a token problem; logins are capped a day)
      const t0 = (await db.get(TOKEN, {})) || {};
      if (!t0.obtainedAt || now() - t0.obtainedAt > 60 * MIN) { tk = await token({ force: true }).catch((e) => { loginErr = e.message; return null; }); if (tk) r = await get(tk); }
    }
    if (!r.ok) { const error = loginErr || `data read refused (HTTP ${r.status})`; await db.set(KEY, { ...st, lastPoll: new Date(end).toISOString(), error }); return { error }; }
    const fresh = latestByTrailer(await r.json().catch(() => []));
    const units = { ...(st.units || {}) }; const history = { ...(st.history || {}) };
    // one time: the last 3 days (3 requests of 24 h — Thermo King's limit), to know how long each trailer has been parked
    if (!st.backfilledAt) {
      const all = {};
      for (let d = 3; d >= 1; d -= 1) {
        const a = end - d * DAY; const b = end - (d - 1) * DAY;
        try {
          const rr = await fetchFn(`${c.base}/getTemperatureDataForVehicles/${encodeURIComponent(tkStamp(a))}/${encodeURIComponent(tkStamp(b))}/`, { headers: { 'X-External-ID': c.customer, 'X-OAuth2-Token': tk, 'Content-Type': 'application/json' } }); // eslint-disable-line no-await-in-loop
          if (rr.ok) for (const [t, l] of Object.entries(readingsByTrailer(await rr.json().catch(() => [])))) (all[t] = all[t] || []).push(...l); // eslint-disable-line no-await-in-loop
        } catch { /* that day stays unknown */ }
      }
      for (const [t, l] of Object.entries(all)) { l.sort((p, q) => p.at.localeCompare(q.at)); const ps = parkedSinceOf(l); const last = l[l.length - 1]; if (ps) units[t] = { ...(units[t] || {}), ...last, ...ps }; }
      st.backfilledAt = new Date(end).toISOString();
    }
    for (const [t, x] of Object.entries(fresh)) {
      if (!units[t] || x.at >= units[t].at) units[t] = { ...x, ...nextParked(units[t], x) };
      history[t] = [...(history[t] || []).filter((h) => h.at !== x.at), { at: x.at, returnF: x.returnF, setF: x.setF }].slice(-48);
    }
    for (const [t, x] of Object.entries(units)) if (end - Date.parse(x.at) > 3 * DAY) { delete units[t]; delete history[t]; }
    await db.set(KEY, { units, history, lastEnd: end, lastPoll: new Date(end).toISOString(), error: null, lastCount: Object.keys(fresh).length, backfilledAt: st.backfilledAt || null });
    return { units: Object.keys(fresh).length };
  }

  // the board: each load's trailer gets its latest Thermo King reading (2 hours old at most)
  async function overlay(site, trips) {
    if (!(db && db.enabled)) return;
    const units = ((await db.get(KEY, {})) || {}).units || {};
    if (!Object.keys(units).length) return;
    for (const it of trips) {
      const tr = String(((it && it.trip) || {}).trailer || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
      const x = tr && units[tr];
      if (x && now() - Date.parse(x.at) <= 2 * 60 * MIN) it._tkApi = x;
    }
  }

  if (ready() && env.NODE_ENV !== 'test') {
    setTimeout(() => { poll().catch((e) => console.warn('[thermoking]', e.message)); }, 2 * MIN).unref?.();
    const t = setInterval(() => { poll().then((r) => r && r.units != null && console.log(`[thermoking] ${r.units} units read`)).catch((e) => console.warn('[thermoking]', e.message)); }, POLL_MS);
    if (t.unref) t.unref();
  }
  if (app && requireAuth) {
    // what's connected (never the password or token)
    app.get('/truckmate/thermoking/status', requireAuth, async (req, res) => {
      const st = (await db.get(KEY, {})) || {}; const tok = (await db.get(TOKEN, {})) || {};
      const newest = Object.values(st.units || {}).reduce((m, x) => (x.at > m ? x.at : m), '');
      res.json({ configured: ready(), lastPoll: st.lastPoll || null, lastCount: st.lastCount ?? null, units: Object.keys(st.units || {}).length, error: st.error || tok.error || null, loginError: tok.error || null, loginErrorAt: tok.errorAt ? new Date(tok.errorAt).toISOString() : null, lastLoginOk: tok.obtainedAt ? new Date(tok.obtainedAt).toISOString() : null, newestReading: newest || null, blockedUntil: tok.blockedUntil || null, loginsToday: (tok.attempts || {})[etDay()] || 0, loginsPerDay: MAX_LOGINS_A_DAY, sample: Object.values(st.units || {}).slice(0, 3).map(({ lat, lng, location, ...x }) => x) });
    });
  }
  return { poll, overlay, token, ready };
}

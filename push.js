// ---------------------------------------------------------------
// TagAlong push notifications (APNs) — fires alerts to a LOCKED phone.
//
// When the phone is locked the app isn't running, so the server has to detect
// alerts and push them through Apple. This module:
//   • stores each device's APNs token (in the Traccar host device attributes),
//   • exposes /push/register + /push/unregister,
//   • polls Traccar every 30s per registered user, translates Traccar events +
//     live position data into alerts, de-dupes them, and sends an APNs push with
//     a sound + "time-sensitive" interruption level (breaks through the lock
//     screen / focus).
//
// Needs these env vars (see PUSH_SETUP.md):
//   APNS_KEY         the .p8 auth key contents (newlines OK, or \n-escaped)
//   APNS_KEY_ID      the 10-char Key ID
//   APNS_TEAM_ID     your Apple Team ID
//   APNS_BUNDLE_ID   com.dynamicsbpo.tagalong (default)
//   APNS_PRODUCTION  "true" for TestFlight/App Store builds, else sandbox
// ---------------------------------------------------------------
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KNOTS_TO_MPH = 1.15078;
// A sleeping tracker keeps re-reporting the last speed it saw, so a parked car
// reads as still doing 9 mph. Treat the car as stopped unless the report is
// recent AND the tracker says it's actually in motion — otherwise a stale
// reading can trigger speeding, tow and idling alerts on a car in a driveway.
const FRESH_FIX_MS = 7 * 60 * 1000;
function liveMph(pos) {
  if (!pos) return 0;
  const at = pos.attributes || {};
  const fix = pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
  if (!fix || Date.now() - fix > FRESH_FIX_MS) return 0;
  if (at.motion === false || at.ignition === false) return 0;
  return Math.round((pos.speed || 0) * KNOTS_TO_MPH);
}
// A fault condition must be absent this long before it's allowed to alert again
// (a code cleared at the shop that genuinely returns still notifies) …
const REARM_AFTER_MS = 6 * 60 * 60 * 1000;
// … and no derived condition may repeat on the same car faster than this,
// no matter how its underlying value flaps.
const REPEAT_FLOOR_MS = 6 * 60 * 60 * 1000;

export function initPush(app, { TRACCAR_URL, traccarHeaders, requireAuth, env, db }) {
  const {
    APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID,
    APNS_BUNDLE_ID = 'com.dynamicsbpo.tagalong',
    APNS_PRODUCTION,
  } = env;

  // Rebuild a valid PEM even if the .p8 got flattened/space-mangled when pasted
  // into the env var (Render often strips the line breaks). We pull the base64
  // body out from between the BEGIN/END markers and re-wrap it at 64 chars.
  function normalizePem(raw) {
    const k = String(raw || '').trim().replace(/\\n/g, '\n');
    if (!k) return '';
    const m = k.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END [A-Z0-9 ]+?-----/);
    if (!m) return k;
    const label = m[1].trim();
    const b64 = m[2].replace(/[^A-Za-z0-9+/=]/g, ''); // strip everything that isn't base64
    const wrapped = (b64.match(/.{1,64}/g) || []).join('\n');
    return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
  }
  const key = normalizePem(APNS_KEY);
  const enabled = !!(key && APNS_KEY_ID && APNS_TEAM_ID);
  // Default host when a token doesn't declare its environment (older records).
  const defaultHost = APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  // Pick the Apple host for a token based on the environment the app reported at
  // registration: dev/cable builds → sandbox, TestFlight/App Store → production.
  function apnsHostFor(envName) {
    if (envName === 'sandbox') return 'api.sandbox.push.apple.com';
    if (envName === 'production') return 'api.push.apple.com';
    return defaultHost;
  }

  if (!enabled) console.warn('[push] APNs not configured — set APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID to enable locked-phone alerts.');

  // ---- APNs provider JWT (reused up to ~50 min) ----
  let jwtCache = null, jwtAt = 0;
  const providerJwt = () => {
    if (jwtCache && Date.now() - jwtAt < 50 * 60 * 1000) return jwtCache;
    jwtCache = jwt.sign({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }, key, { algorithm: 'ES256', keyid: APNS_KEY_ID });
    jwtAt = Date.now();
    return jwtCache;
  };

  // ---- send one push; resolves { ok, status } ----
  const sendOne = (token, payload, host = defaultHost) => new Promise((resolve) => {
    let client;
    let jwtToken;
    try {
      jwtToken = providerJwt(); // throws if the .p8 key is malformed
    } catch (e) {
      console.log('[push] JWT sign FAILED — check APNS_KEY / KEY_ID / TEAM_ID:', e.message);
      return resolve({ ok: false, status: 0 });
    }
    try {
      client = http2.connect(`https://${host}`);
      client.on('error', (e) => { console.log('[push] APNs connect error:', e.code || e.message); resolve({ ok: false, status: 0 }); });
      const body = JSON.stringify(payload);
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwtToken}`,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0; let respBody = '';
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { respBody += d; });
      req.on('end', () => { try { client.close(); } catch { /* */ } if (status !== 200) console.log(`[push] APNs response ${status}: ${respBody}`); resolve({ ok: status === 200, status }); });
      req.on('error', (e) => { try { client.close(); } catch { /* */ } console.log('[push] APNs req error:', e.code || e.message); resolve({ ok: false, status: 0 }); });
      req.end(body);
    } catch (e) {
      try { client && client.close(); } catch { /* */ }
      console.log('[push] sendOne threw:', e.message);
      resolve({ ok: false, status: 0 });
    }
  });

  // Accepts token records ({ token, env }) or plain token strings. Returns the
  // list of tokens Apple says are dead (410/BadDeviceToken) so they get pruned.
  async function sendToTokens(tokenRecs, { title, body, data }) {
    if (!enabled || !tokenRecs || !tokenRecs.length) return [];
    const payload = {
      aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'time-sensitive' },
      ...(data || {}),
    };
    const dead = [];
    for (const tr of tokenRecs) {
      const token = typeof tr === 'string' ? tr : tr.token;
      const host = apnsHostFor(typeof tr === 'string' ? '' : tr.env);
      const r = await sendOne(token, payload, host);
      console.log(`[push]   APNs → ${r.ok ? 'OK 200' : `FAIL ${r.status}`} (${host})`);
      if (!r.ok && (r.status === 410 || r.status === 400)) dead.push(token);
    }
    return dead;
  }

  // ---- token store: lives in the Traccar host device's attributes (taPush) ----
  async function hostDevice() {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    if (!r.ok) throw new Error('devices fetch failed');
    const all = await r.json();
    if (!all.length) throw new Error('no devices');
    return all.reduce((min, d) => (!min || d.id < min.id ? d : min), null);
  }
  const USE_DB = !!(db && db.enabled);

  async function readStore() {
    if (USE_DB) return { host: null, store: await db.get('taPush', {}) };
    const host = await hostDevice();
    return { host, store: (host.attributes || {}).taPush || {} };
  }
  async function writeStore(store) {
    // With a database there's no size ceiling, so the whole store — tokens AND
    // signatures — can simply be saved. The stripping below only matters for
    // the Traccar fallback path.
    if (USE_DB) { await db.set('taPush', store); return true; }
    const host = await hostDevice();
    // Strip the bulky, file-backed parts before this ever touches Traccar. The
    // attributes column is capped at 4000 chars for the whole blob (shared with
    // the community store, shop and orders), so only small durable state —
    // tokens and scope — belongs here.
    const lean = {};
    for (const [uid, rec] of Object.entries(store)) {
      const { sigs, log, ...keep } = rec; // eslint-disable-line no-unused-vars
      lean[uid] = keep;
    }
    const attributes = { ...(host.attributes || {}), taPush: lean };
    // Send ONLY the writable fields. Echoing the whole device object back —
    // including server-computed fields like status, lastUpdate and positionId —
    // is what Traccar was rejecting with a 400, and because every write failed,
    // no de-dupe signature was ever saved. That's the repeat-alert spam.
    const body = JSON.stringify({
      id: host.id,
      name: host.name,
      uniqueId: host.uniqueId,
      groupId: host.groupId || 0,
      phone: host.phone || '',
      model: host.model || '',
      contact: host.contact || '',
      category: host.category || null,
      disabled: !!host.disabled,
      attributes,
    });
    const r = await fetch(`${TRACCAR_URL}/api/devices/${host.id}`, {
      method: 'PUT',
      headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body,
    });
    if (!r.ok) {
      // Print what Traccar actually objected to — guessing at this has cost
      // far more time than one line of error text.
      let detail = '';
      try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
      console.error(`[push] writeStore FAILED ${r.status} — taPush ${JSON.stringify(lean).length} chars, `
        + `whole attributes blob ${JSON.stringify(attributes).length} chars (Traccar cap 4000) — ${detail}`);
    }
    return r.ok;
  }

  // ---- alert history (file-backed) ----
  // Deliberately NOT kept in the Traccar attribute above: the history grows
  // without bound and would blow the column limit, taking tokens and sigs down
  // with it. This lives on the server's own disk instead.
  const LOG_PATH = path.join(process.env.PUSH_LOG_DIR || os.tmpdir(), 'tagalong-alert-log.json');

  // ---- de-dupe signatures (file-backed) ----
  // These used to live in the Traccar device attribute alongside the push
  // tokens. That column is capped at 4000 chars for the WHOLE attributes blob —
  // shared with the community store, shop products and orders — so as the sig
  // map grew, every write was rejected with "value too long for type character
  // varying(4000)". Nothing was ever remembered, so every poll re-alerted
  // conditions it had already notified. Tokens stay in Traccar (small and worth
  // persisting); the churn lives here.
  const SIG_PATH = path.join(process.env.PUSH_LOG_DIR || os.tmpdir(), 'tagalong-sigs.json');
  let sigCache = null;
  async function readSigs() {
    if (sigCache) return sigCache;
    if (USE_DB) { try { sigCache = await db.get('taSigs', {}); return sigCache; } catch (e) { console.error('[push] sig read failed:', e.message); } }
    try { sigCache = JSON.parse(await fsp.readFile(SIG_PATH, 'utf8')) || {}; } catch { sigCache = {}; }
    return sigCache;
  }
  async function writeSigs() {
    if (!sigCache) return;
    if (USE_DB) { try { await db.set('taSigs', sigCache); return; } catch (e) { console.error('[push] sig db write failed:', e.message); } }
    try { await fsp.writeFile(SIG_PATH, JSON.stringify(sigCache)); } catch (e) {
      console.error('[push] sig write failed:', e.message);
    }
  }
  let logCache = null;
  async function readLog() {
    if (logCache) return logCache;
    try { logCache = JSON.parse(await fsp.readFile(LOG_PATH, 'utf8')) || {}; } catch { logCache = {}; }
    return logCache;
  }
  async function appendLog(uidKey, entry) {
    // Database first: survives redeploys and instance replacement, which the
    // /tmp file does not.
    if (USE_DB) { try { await db.appendAlert(uidKey, entry); return; } catch (e) { console.error('[push] alert-log db write failed:', e.message); } }
    const log = await readLog();
    const arr = Array.isArray(log[uidKey]) ? log[uidKey] : [];
    arr.push(entry);
    log[uidKey] = arr.slice(-400);
    try { await fsp.writeFile(LOG_PATH, JSON.stringify(log)); } catch (e) {
      console.error('[push] alert-log write failed:', e.message);
    }
  }

  // ---- register / unregister ----
  app.post('/push/register', requireAuth, async (req, res) => {
    // the client also sends its scope (account / customerId) so the poller can
    // find which cars belong to this user — they're linked by attribute, not by
    // Traccar user permissions.
    const { token, platform = 'ios', account = '', cid = '', environment = '' } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const { store } = await readStore();
      const uidKey = String(req.user.id);
      const rec = store[uidKey] || { role: req.user.role, email: req.user.email, tokens: [], sigs: {} };
      const env = environment === 'sandbox' || environment === 'production' ? environment : '';
      if (!rec.tokens.some((t) => t.token === token)) {
        rec.tokens.push({ token, platform, env, ts: Date.now() });
      } else if (env) {
        // update the environment on the existing token (e.g. dev → TestFlight)
        rec.tokens = rec.tokens.map((t) => (t.token === token ? { ...t, env, ts: Date.now() } : t));
      }
      // cap + drop tokens older than 60 days (stale installs)
      rec.tokens = rec.tokens.filter((t) => Date.now() - (t.ts || 0) < 60 * 24 * 3600 * 1000).slice(-10);
      rec.email = req.user.email; rec.role = req.user.role;
      if (account) rec.account = String(account);
      if (cid) rec.cid = String(cid);
      store[uidKey] = rec;
      await writeStore(store);
      console.log(`[push] REGISTERED device — user ${uidKey}, account ${rec.account || '(none)'}, cid ${rec.cid || '(none)'}, tokens now ${rec.tokens.length}, apns ${enabled}`);
      res.json({ ok: true, enabled });
    } catch (e) { console.log('[push] register error:', e.message); res.status(500).json({ error: e.message }); }
  });

  // Fire a test notification to the caller's own registered devices — lets the
  // user lock the phone and confirm push + sound end-to-end on demand.
  app.post('/push/test', requireAuth, async (req, res) => {
    try {
      const { store } = await readStore();
      const rec = store[String(req.user.id)];
      const tokenRecs = (rec && rec.tokens) || [];
      if (!enabled) return res.json({ ok: false, reason: 'apns-not-configured' });
      if (!tokenRecs.length) return res.json({ ok: false, reason: 'no-tokens' });
      const dead = await sendToTokens(tokenRecs, {
        title: '🔔 TagAlong test alert',
        body: 'Your alerts are working. You can lock your phone.',
        data: { path: '/car?tagalong' },
      });
      if (dead.length && rec) {
        rec.tokens = tokenRecs.filter((t) => !dead.includes(t.token));
        await writeStore(store);
      }
      res.json({ ok: true, sent: tokenRecs.length - dead.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Alert history recorded server-side. The app only logs what it sees while it's
  // OPEN, so anything that fired while the phone was locked never appeared in the
  // Alerts tab. Every push we send is appended here with its location, so the
  // history is complete regardless of whether the app was running.
  app.get('/push/history', requireAuth, async (req, res) => {
    try {
      if (USE_DB) {
        const rows = await db.readAlerts(req.user.id);
        if (rows) return res.json({ ok: true, alerts: rows });
      }
      const log = await readLog();
      res.json({ ok: true, alerts: log[String(req.user.id)] || [] });
    } catch (e) { res.status(500).json({ error: e.message, alerts: [] }); }
  });

  app.post('/push/unregister', requireAuth, async (req, res) => {
    const { token } = req.body || {};
    try {
      const { store } = await readStore();
      const uidKey = String(req.user.id);
      if (store[uidKey]) {
        store[uidKey].tokens = (store[uidKey].tokens || []).filter((t) => t.token !== token);
        await writeStore(store);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ---- helpers to read devices + latest positions ----
  async function allDevices() {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    if (!r.ok) return [];
    return r.json();
  }
  // geofenceId → friendly name (strip our ⭐/⏱ prefixes)
  async function geofenceNames() {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/geofences`, { headers: traccarHeaders });
      if (!r.ok) return {};
      const arr = await r.json();
      const map = {};
      for (const g of arr) map[g.id] = String(g.name || '').replace(/^[⭐⏱]\s*/, '').trim();
      return map;
    } catch { return {}; }
  }
  // a car belongs to this user if its account/customerId attribute matches the
  // scope the app sent at registration time.
  function scopeDevices(devices, rec) {
    // an admin monitors the whole fleet (they see every car on the app too)
    if (rec.role === 'admin') return devices.filter((d) => String((d.attributes || {}).account || '') !== 'TA');
    if (!rec.account && !rec.cid) return [];
    return devices.filter((d) => {
      const a = d.attributes || {};
      if (rec.cid && String(a.customerId) === String(rec.cid)) return true;
      if (rec.account && String(a.account) === String(rec.account)) return true;
      return false;
    });
  }
  // latest position for every device, keyed by deviceId
  async function allPositions() {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/positions`, { headers: traccarHeaders });
      if (!r.ok) return {};
      const arr = await r.json();
      const byDev = {};
      for (const p of arr) byDev[p.deviceId] = p;
      return byDev;
    } catch { return {}; }
  }
  async function recentEvents(deviceId, fromISO, toISO) {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/reports/events?deviceId=${deviceId}&from=${fromISO}&to=${toISO}`, {
        headers: { ...traccarHeaders, Accept: 'application/json' },
      });
      if (!r.ok) return [];
      return r.json();
    } catch { return []; }
  }

  // ---- turn a Traccar event into a friendly push (null = ignore) ----
  const NAMED = (d) => (d.attributes && d.attributes.displayName) || d.name || 'Your car';
  function eventToPush(d, ev, geoNames = {}) {
    const car = NAMED(d);
    const a = ev.attributes || {};
    const placeName = geoNames[ev.geofenceId] || '';
    switch (ev.type) {
      case 'alarm': {
        const al = a.alarm || '';
        if (/sos|accident|crash/i.test(al)) return { key: `alarm-${al}`, title: `🚨 ${car} — possible crash`, body: 'A crash/impact alarm was reported. Tap to see where.' };
        if (/tow|movement/i.test(al)) return { key: `alarm-${al}`, title: `🪝 ${car} — moving while off`, body: 'Your parked car is moving — it may be getting towed.' };
        if (/overspeed/i.test(al)) return { key: 'alarm-overspeed', title: `⏩ ${car} — speeding`, body: 'Your car is over the speed limit.' };
        if (/lowBattery|battery/i.test(al)) return { key: 'alarm-battery', title: `🔋 ${car} — low battery`, body: 'The tracker battery is low.' };
        if (/jamming/i.test(al)) return { key: 'alarm-jam', title: `📡 ${car} — signal jammed`, body: 'A GPS/signal jammer may be in use.' };
        if (/hardBrak|harshBrak|braking/i.test(al)) return { key: 'harsh-brake', title: `🛑 ${car} — hard braking`, body: 'A sudden hard brake was detected.' };
        if (/hardAcc|harshAcc|acceleration/i.test(al)) return { key: 'harsh-accel', title: `🏎️ ${car} — hard acceleration`, body: 'A sudden hard acceleration was detected.' };
        if (/hardCorner|harshCorner|cornering/i.test(al)) return { key: 'harsh-corner', title: `↩️ ${car} — hard cornering`, body: 'A sharp turn was taken at speed.' };
        if (/powerCut|powerOff|unplug/i.test(al)) return { key: 'alarm-power', title: `🔌 ${car} — power cut`, body: 'The tracker lost power — it may have been unplugged.' };
        if (/idle/i.test(al)) return { key: 'alarm-idle', title: `⏱️ ${car} — idling`, body: 'The engine is running while parked.' };
        return { key: `alarm-${al}`, title: `🔔 ${car} — alarm`, body: `Alarm: ${al}` };
      }
      // some trackers report harsh driving as its own event type, not an alarm
      case 'hardBraking':
        return { key: 'harsh-brake', title: `🛑 ${car} — hard braking`, body: 'A sudden hard brake was detected.' };
      case 'hardAcceleration':
        return { key: 'harsh-accel', title: `🏎️ ${car} — hard acceleration`, body: 'A sudden hard acceleration was detected.' };
      case 'hardCornering':
        return { key: 'harsh-corner', title: `↩️ ${car} — hard cornering`, body: 'A sharp turn was taken at speed.' };
      case 'deviceOverspeed':
        return { key: 'overspeed', title: `⏩ ${car} — speeding`, body: `Going ${Math.round((a.speed || 0) * KNOTS_TO_MPH)} mph.` };
      case 'geofenceEnter':
        return { key: `geo-in-${ev.geofenceId}`, title: `📍 ${car} arrived${placeName ? ` at ${placeName}` : ''}`, body: placeName ? `Your car arrived at ${placeName}.` : 'Your car arrived at a saved place.' };
      case 'geofenceExit':
        return { key: `geo-out-${ev.geofenceId}`, title: `📍 ${car} left${placeName ? ` ${placeName}` : ''}`, body: placeName ? `Your car left ${placeName}.` : 'Your car left a saved place.' };
      case 'deviceFuelDrop':
        return { key: 'fueldrop', title: `⛽ ${car} — fuel drop`, body: 'A sudden fuel drop was detected.' };
      case 'ignitionOn':
        return { key: 'ign-on', title: `🚗 ${car} started`, body: 'The engine was turned on.' };
      // engine-off is intentionally NOT pushed — it fires on every park and is
      // too noisy; "Car turned on" stays as the meaningful ignition alert.
      default:
        return null;
    }
  }

  // ---- derived alerts from the latest position (not event-based) ----
  function derivedAlerts(d, pos) {
    const car = NAMED(d);
    const out = [];
    const a = (pos && pos.attributes) || {};
    // Tracker gone quiet. An OBD tracker SLEEPS when the car is parked so it
    // doesn't flatten the battery, so silence on its own means nothing — the
    // old 20-minute threshold cried wolf on every normal park. What matters is
    // the state it was in when it stopped reporting:
    //   • went quiet with the engine RUNNING  → suspicious, could be unplugged
    //   • went quiet after being parked       → almost certainly just asleep
    const last = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : (d.lastUpdate ? new Date(d.lastUpdate).getTime() : 0);
    const silentMs = last ? Date.now() - last : 0;
    // Not just "ignition was on" — a tracker very often sends its LAST report
    // with ignition still true and then sleeps the moment you park, so that
    // alone makes every normal park look like an unplug. A tracker pulled
    // mid-drive was actually MOVING when it went quiet.
    const lastMph = Math.round(((pos && pos.speed) || 0) * KNOTS_TO_MPH);
    const wasRunning = a.ignition === true && lastMph >= 5;
    // per-car override, in hours, for the parked case
    const parkedHrs = Number((d.attributes || {}).taOfflineHours) > 0
      ? Number((d.attributes || {}).taOfflineHours) : 24;
    if (last && wasRunning && silentMs > 30 * 60 * 1000) {
      out.push({
        key: 'disconnect', val: 'running',
        title: `🔌 ${car} — tracker stopped reporting`,
        body: `It stopped reporting while the car was moving at ${lastMph} mph. It may have been unplugged or lost power.`,
      });
    } else if (last && !wasRunning && silentMs > parkedHrs * 60 * 60 * 1000) {
      const hrs = Math.round(silentMs / 3600000);
      out.push({
        key: 'disconnect', val: 'parked',
        title: `🔌 ${car} — no signal for ${hrs}h`,
        body: `The car has been parked and the tracker hasn't checked in for ${hrs} hours. This is usually normal sleep, but worth a look if you expected it to move.`,
      });
    }
    // check-engine — matches the app: io30 = count of active fault codes, with
    // the code list from io281/dtcs/dtc/faultCodes when the decoder provides it.
    const dtcCount = Number(a.io30 != null ? a.io30 : 0);
    const codeList = [a.io281, a.dtcs, a.dtc, a.faultCodes, a.troubleCodes].find((v) => v != null && String(v).trim() !== '');
    if (dtcCount > 0 || (codeList && String(codeList).trim())) {
      const val = String(dtcCount || codeList);
      out.push({
        key: 'dtc', val,
        title: `🔧 ${car} — check engine`,
        body: codeList ? `Fault code${String(codeList).includes(',') ? 's' : ''} ${codeList}.` : `${dtcCount} active fault code${dtcCount === 1 ? '' : 's'}.`,
      });
    }
    // Engine running hot. Engines don't all run the same: most sit 90–110 °C and
    // many modern ones (VW/Audi) normally cruise at 100–110 °C, so a 105 °C limit
    // false-alarms on healthy cars. Only push when it's genuinely high, and let a
    // specific car override via its tempWarnC attribute.
    const coolant = Number(a.io32 != null ? a.io32 : a.coolantTemp);
    const hotLimit = Number((d.attributes || {}).tempWarnC) > 0 ? Number((d.attributes || {}).tempWarnC) : 115;
    if (!isNaN(coolant) && coolant > hotLimit) {
      out.push({ key: 'enginehot', val: String(Math.round(coolant)), title: `🌡️ ${car} — engine running hot`, body: `Coolant is at ${Math.round(coolant)} °C (over this car's ${hotLimit} °C limit).` });
    }
    // charging / battery voltage trouble while the engine is running
    const volts = Number(a.power);
    if (!isNaN(volts) && volts > 0) {
      if (a.ignition === true && volts < 12.2) {
        out.push({ key: 'charging', val: volts.toFixed(1), title: `🔌 ${car} — not charging`, body: `System voltage is ${volts.toFixed(1)}V while running — the alternator may be failing.` });
      } else if (volts > 15.2) {
        out.push({ key: 'overcharge', val: volts.toFixed(1), title: `⚡ ${car} — overcharging`, body: `System voltage is ${volts.toFixed(1)}V — the regulator may be faulty.` });
      }
    }
    // low fuel
    const fuel = a.fuel != null ? a.fuel : a.io48;
    if (fuel != null && fuel > 0 && fuel < 15) {
      out.push({ key: 'lowfuel', val: '1', title: `⛽ ${car} — low fuel`, body: `Fuel is at ${Math.round(fuel)}%.` });
    }
    // low tracker battery
    const bl = a.batteryLevel;
    if (bl != null && bl <= 15) {
      out.push({ key: 'lowbatt', val: '1', title: `🔋 ${car} — low battery`, body: `Tracker battery at ${Math.round(bl)}%.` });
    }
    // aggressive revving — threshold per car via rpmAlertRpm, default 4000
    const rpm = Number(a.io36 != null ? a.io36 : a.rpm);
    const rpmLimit = Number((d.attributes || {}).rpmAlertRpm) > 0 ? Number((d.attributes || {}).rpmAlertRpm) : 4000;
    if (!isNaN(rpm) && rpm > rpmLimit) {
      out.push({ key: 'rpm', val: 'on', title: `🏎️ ${car} — hard revving`, body: `Engine hit ${Math.round(rpm)} RPM (over the ${rpmLimit} limit).` });
    }

    // speeding — warning threshold and the hard over-speed limit, per car.
    // val is 'on' so it fires once on crossing and re-arms when back under.
    const mph = liveMph(pos);
    const warnAt = Number((d.attributes || {}).speedWarnMph) > 0 ? Number((d.attributes || {}).speedWarnMph) : 70;
    const maxAt = Number((d.attributes || {}).speedMaxMph) > 0 ? Number((d.attributes || {}).speedMaxMph) : 85;
    if (mph >= maxAt) {
      out.push({ key: 'overspeed-hard', val: 'on', title: `🚨 ${car} — over ${maxAt} mph`, body: `Travelling at ${mph} mph.` });
    } else if (mph >= warnAt) {
      out.push({ key: 'speedwarn', val: 'on', title: `⏩ ${car} — speeding`, body: `Travelling at ${mph} mph (over your ${warnAt} mph warning).` });
    }

    // NOTE: tow/theft is handled in the poll loop, not here — it needs a debounce
    // (the tracker reports motion a beat before the ignition flag flips on at
    // startup, which fired a false "being towed" alert every time the car started).
    return out;
  }

  // ---- posted speed limit for a point (OpenStreetMap, cached) ----
  const speedLimitCache = new Map(); // "lat,lng"(3dp) -> { mph, at }
  function parseMaxspeed(s) {
    if (!s) return null;
    const str = String(s).toLowerCase();
    const m = str.match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!n) return null;
    return str.includes('mph') ? n : Math.round(n * 0.621371); // OSM default is km/h
  }
  async function roadSpeedLimit(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`; // ~110 m grid
    const c = speedLimitCache.get(key);
    if (c && Date.now() - c.at < 24 * 3600 * 1000) return c.mph;
    let mph = null;
    try {
      // Ask for ALL nearby roads, not just tagged ones. Requiring [maxspeed]
      // meant most US residential and city streets returned nothing at all, so
      // the alert silently never fired. When there's no posted tag we fall back
      // to the typical limit for that road class, which is what a driver would
      // reasonably expect the street to be.
      const q = `[out:json][timeout:8];way(around:60,${lat},${lng})[highway];out tags 8;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (r.ok) {
        const j = await r.json();
        const els = (j.elements || []).filter((e) => (e.tags || {}).highway);
        // 1) a real posted limit always wins
        for (const el of els) {
          const v = parseMaxspeed((el.tags || {}).maxspeed);
          if (v) { mph = v; break; }
        }
        // 2) otherwise infer from the road classification
        if (!mph) {
          const BY_CLASS = {
            motorway: 65, motorway_link: 45, trunk: 55, trunk_link: 40,
            primary: 45, primary_link: 35, secondary: 40, secondary_link: 30,
            tertiary: 35, tertiary_link: 25, unclassified: 30,
            residential: 25, living_street: 15, service: 15,
          };
          // prefer the biggest road nearby — that's the one you're driving on
          const ORDER = Object.keys(BY_CLASS);
          let best = null;
          for (const el of els) {
            const cls = (el.tags || {}).highway;
            if (BY_CLASS[cls] == null) continue;
            if (best === null || ORDER.indexOf(cls) < ORDER.indexOf(best)) best = cls;
          }
          if (best) mph = BY_CLASS[best];
        }
      }
    } catch { /* leave null */ }
    speedLimitCache.set(key, { mph, at: Date.now() });
    if (speedLimitCache.size > 3000) speedLimitCache.clear();
    return mph;
  }

  // ---- is this point on a highway? (OpenStreetMap, cached) ----
  // Used for the "stopped on the highway" alert — a car stopped in a driveway is
  // nothing, a car stopped on a motorway is an emergency. Only queried when a
  // stop has already lasted a while, so it costs very few lookups.
  const roadCache = new Map(); // "lat,lng"(3dp) -> { hw, at }
  async function onHighway(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const c = roadCache.get(key);
    if (c && Date.now() - c.at < 24 * 3600 * 1000) return c.hw;
    let hw = false;
    try {
      const q = `[out:json][timeout:10];way(around:28,${lat},${lng})[highway~"^(motorway|trunk|primary|motorway_link|trunk_link)$"];out ids 1;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (r.ok) {
        const j = await r.json();
        hw = Array.isArray(j.elements) && j.elements.length > 0;
      }
    } catch { /* unknown → treat as not a highway, don't cry wolf */ }
    roadCache.set(key, { hw, at: Date.now() });
    if (roadCache.size > 2000) roadCache.clear();
    return hw;
  }

  // ---- weekly digest (Sunday evening, once per week) ----
  async function reportArray(kind, deviceId, fromISO, toISO) {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/reports/${kind}?deviceId=${deviceId}&from=${fromISO}&to=${toISO}`, {
        headers: { ...traccarHeaders, Accept: 'application/json' },
      });
      if (!r.ok) return [];
      return r.json();
    } catch { return []; }
  }
  async function runWeeklyDigest() {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    const fromISO = from.toISOString(), toISO = to.toISOString();
    const { store } = await readStore();
    const fleet = await allDevices();
    for (const rec of Object.values(store)) {
      const tokenRecs = rec.tokens || [];
      if (!tokenRecs.length) continue;
      const devs = scopeDevices(fleet, rec);
      if (!devs.length) continue;
      let miles = 0, trips = 0, harsh = 0, alerts = 0;
      for (const d of devs) {
        const sum = await reportArray('summary', d.id, fromISO, toISO);
        if (sum && sum[0] && sum[0].distance) miles += sum[0].distance * 0.000621371;
        const tr = await reportArray('trips', d.id, fromISO, toISO);
        trips += (tr || []).length;
        const evs = await reportArray('events', d.id, fromISO, toISO);
        for (const e of (evs || [])) {
          if (/overspeed|hardBraking|hardAcceleration|alarm/i.test(e.type)) harsh++;
          if (eventToPush(d, e, {})) alerts++;
        }
      }
      miles = Math.round(miles);
      // simple driver score: start at 100, penalize harsh events per mile driven
      const score = Math.max(40, Math.min(100, Math.round(100 - (miles > 0 ? (harsh / miles) * 100 * 4 : harsh * 2))));
      const title = `📊 Your week: ${miles} mi, ${trips} trip${trips === 1 ? '' : 's'}`;
      const body = `Driver score ${score}/100 · ${alerts} alert${alerts === 1 ? '' : 's'} this week. Tap for the full breakdown.`;
      console.log(`[push]   WEEKLY DIGEST → user ${rec.email || '?'}: ${miles}mi ${trips}trips score ${score}`);
      await sendToTokens(tokenRecs, { title, body, data: { path: '/history' } });
    }
  }
  // fire once when it's Sunday night (>= 23:00 UTC ≈ Sun evening US) and not yet
  // sent this week.
  let lastDigestWeek = '';
  async function maybeWeeklyDigest() {
    const now = new Date();
    if (now.getUTCDay() !== 0 || now.getUTCHours() < 23) return;
    const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const wk = `${now.getUTCFullYear()}-${Math.floor((now - jan1) / (7 * 24 * 3600 * 1000))}`;
    if (wk === lastDigestWeek) return;
    lastDigestWeek = wk;
    try { await runWeeklyDigest(); } catch (e) { console.error('[push] digest error:', e.message); }
  }

  // ---- the poll loop ----
  // Persisted across restarts: this used to be memory-only, so every deploy or
  // sleep/wake reset the window to "now minus 5 minutes" and silently dropped
  // every event in the gap. That's what made ignition alerts miss at random.
  const MAX_CATCHUP_MS = 45 * 60 * 1000;
  let lastCheck = 0;
  async function loadLastCheck() {
    let saved = 0;
    if (USE_DB) {
      try { saved = Number((await db.get('taPushMeta', {})).lastCheck || 0); } catch { /* fall through */ }
    } else {
      const log = await readLog();
      saved = Number(log.__lastCheck || 0);
    }
    const floor = Date.now() - MAX_CATCHUP_MS;
    lastCheck = saved && saved > floor ? saved : Date.now() - 5 * 60 * 1000;
  }
  async function saveLastCheck(t) {
    if (USE_DB) { try { await db.set('taPushMeta', { lastCheck: t }); return; } catch { /* fall through */ } }
    const log = await readLog();
    log.__lastCheck = t;
    try { await fsp.writeFile(LOG_PATH, JSON.stringify(log)); } catch { /* best effort */ }
  }

  async function poll() {
    if (!enabled) return;
    if (!lastCheck) await loadLastCheck();
    const now = Date.now();
    const fromISO = new Date(lastCheck).toISOString();
    const toISO = new Date(now).toISOString();
    try {
      const { store } = await readStore();
      const fleet = await allDevices();
      const positions = await allPositions();
      const geoNames = await geofenceNames();
      let changed = false;      // sig state → file
      let devChanged = false;   // token state → Traccar
      const sigs = await readSigs();
      for (const [uid, rec] of Object.entries(store)) {
        const tokenRecs = rec.tokens || [];
        if (!tokenRecs.length) continue;
        // signatures now come from (and go back to) the file store
        if (!sigs[uid]) sigs[uid] = {};
        // one-time migration of anything still sitting in the Traccar attribute
        if (rec.sigs && typeof rec.sigs === 'object') {
          Object.assign(sigs[uid], rec.sigs);
          delete rec.sigs; devChanged = true; changed = true;
        }
        rec.sigs = sigs[uid];
        // legacy: older builds stored the history inline, which is what pushed
        // the attribute over Traccar's size limit. Migrate it out and reclaim.
        if (Array.isArray(rec.log)) {
          for (const old of rec.log) await appendLog(uid, old);
          delete rec.log; devChanged = true;
        }
        const devices = scopeDevices(fleet, rec);
        if (!devices.length) continue;

        for (const d of devices) {
          const pos = positions[d.id];
          const toSend = [];

          // event-based (crash, geofence, overspeed, ignition, fuel drop…)
          const events = await recentEvents(d.id, fromISO, toISO);
          if (events.length) {
            console.log(`[push] ${NAMED(d)}: ${events.length} event(s) — ${events.map((e) => e.type).join(', ')}`);
          }
          for (const ev of events) {
            const p = eventToPush(d, ev, geoNames);
            if (!p) continue;
            const sig = `ev:${ev.id}`;
            if (rec.sigs[sig]) continue;
            rec.sigs[sig] = 1;
            toSend.push(p);
          }
          // derived (disconnect, dtc, low fuel/battery, tow)
          const derived = derivedAlerts(d, pos);
          for (const da of derived) {
            const sig = `dv:${d.id}:${da.key}`;
            if (rec.sigs[sig] === da.val) continue; // same state already notified
            // Hard floor between repeats of the same condition on the same car,
            // whatever the value did in between. A fault code that flaps 1→0→1
            // is one problem, not six notifications.
            const lastKey = `dvat:${d.id}:${da.key}`;
            const last = Number(rec.sigs[lastKey] || 0);
            if (last && Date.now() - last < REPEAT_FLOOR_MS) { rec.sigs[sig] = da.val; changed = true; continue; }
            rec.sigs[sig] = da.val;
            rec.sigs[lastKey] = String(Date.now());
            toSend.push(da);
          }
          // RE-ARM: any derived condition that is no longer present gets its
          // remembered state cleared, so if the SAME fault returns later (e.g. a
          // check-engine code cleared at the shop that comes back) it alerts
          // again instead of being suppressed by the stale signature.
          // The condition must stay gone for a sustained stretch, not just one
          // poll — otherwise a flapping sensor re-arms itself every 30 seconds
          // and notifies again each time it comes back.
          {
            const active = new Set(derived.map((x) => x.key));
            for (const key of ['disconnect', 'dtc', 'enginehot', 'charging', 'overcharge', 'lowfuel', 'lowbatt', 'rpm', 'speedwarn', 'overspeed-hard']) {
              const sig = `dv:${d.id}:${key}`;
              const goneKey = `dvgone:${d.id}:${key}`;
              if (active.has(key)) {
                // back (or never left) — cancel any pending re-arm
                if (rec.sigs[goneKey]) { delete rec.sigs[goneKey]; changed = true; }
              } else if (rec.sigs[sig] !== undefined) {
                const since = Number(rec.sigs[goneKey] || 0);
                if (!since) { rec.sigs[goneKey] = String(Date.now()); changed = true; }
                else if (Date.now() - since > REARM_AFTER_MS) {
                  delete rec.sigs[sig]; delete rec.sigs[goneKey];
                  delete rec.sigs[`dvat:${d.id}:${key}`];
                  changed = true;
                }
              }
            }
          }

          // tow / theft: moving with the ignition off. Debounced, because at
          // startup the tracker briefly reports motion=true while ignition is
          // still false — that transient was firing a false tow alert right
          // before every legitimate "vehicle turned on". We now require real
          // road speed AND the condition to hold for ~90s before alerting.
          {
            const pa = (pos && pos.attributes) || {};
            const towMph = liveMph(pos);
            const pendKey = `towpend:${d.id}`;
            const towKey = `tow:${d.id}`;
            const suspicious = pa.motion === true && pa.ignition === false && towMph >= 4;
            if (suspicious) {
              const since = Number(rec.sigs[pendKey] || 0);
              if (!since) {
                rec.sigs[pendKey] = String(Date.now()); changed = true;
              } else if (Date.now() - since > 90 * 1000 && rec.sigs[towKey] !== 'on') {
                rec.sigs[towKey] = 'on';
                toSend.push({ title: `🪝 ${NAMED(d)} — moving while off`, body: `Your parked car is moving at ${towMph} mph with the engine off — possible tow or theft.` });
              }
            } else {
              if (rec.sigs[pendKey]) { delete rec.sigs[pendKey]; changed = true; }
              if (rec.sigs[towKey]) { delete rec.sigs[towKey]; changed = true; }
            }
          }

          // VIN change: the tracker is reporting a different vehicle than before.
          // Means it was moved to another car — or tampered with. The first VIN
          // we ever see is learned silently, same as the app does.
          {
            const pa = (pos && pos.attributes) || {};
            const vin = String(pa.vin || '').trim();
            const vinKey = `vin:${d.id}`;
            if (vin.length >= 8) {
              const known = rec.sigs[vinKey];
              if (!known) {
                rec.sigs[vinKey] = vin; changed = true;   // learn quietly
              } else if (known !== vin) {
                rec.sigs[vinKey] = vin; changed = true;
                toSend.push({
                  title: `🆔 ${NAMED(d)} — VIN changed`,
                  body: `This tracker now reports a different vehicle (${vin}). It may have been moved or tampered with.`,
                });
              }
            }
          }

          // Stopped on the highway: stationary for a long stretch ON a motorway
          // or trunk road. Genuine emergency signal (breakdown, crash, running
          // out of fuel) as opposed to simply being parked somewhere.
          {
            const pa = (pos && pos.attributes) || {};
            const stopMph = liveMph(pos);
            const stopMin = Number((d.attributes || {}).highwayStopMin) > 0 ? Number((d.attributes || {}).highwayStopMin) : 17;
            const pend = `hwpend:${d.id}`, fired = `hwstop:${d.id}`;
            const stopped = stopMph < 2 && pos && pos.latitude != null;
            if (stopped) {
              const since = Number(rec.sigs[pend] || 0);
              if (!since) {
                rec.sigs[pend] = String(Date.now()); changed = true;
              } else if (Date.now() - since > stopMin * 60 * 1000 && rec.sigs[fired] !== 'on') {
                // only now do we pay for the road lookup
                if (await onHighway(pos.latitude, pos.longitude)) {
                  rec.sigs[fired] = 'on'; changed = true;
                  toSend.push({
                    title: `🛑 ${NAMED(d)} — stopped on the highway`,
                    body: `Stationary for over ${stopMin} minutes on a highway. This could be a breakdown or a crash.`,
                  });
                } else {
                  rec.sigs[fired] = 'off'; changed = true; // parked normally; stop re-checking
                }
              }
            } else if (rec.sigs[pend] || rec.sigs[fired]) {
              delete rec.sigs[pend]; delete rec.sigs[fired]; changed = true;
            }
          }

          // idling too long: engine running while parked. Needs a timer, so it
          // lives here rather than in derivedAlerts. Threshold per car via
          // idleAlertMin (default 15 minutes).
          {
            const pa = (pos && pos.attributes) || {};
            const idleMph = liveMph(pos);
            const idleMin = Number((d.attributes || {}).idleAlertMin) > 0 ? Number((d.attributes || {}).idleAlertMin) : 15;
            const pend = `idlepend:${d.id}`, fired = `idle:${d.id}`;
            if (pa.ignition === true && idleMph < 2) {
              const since = Number(rec.sigs[pend] || 0);
              if (!since) {
                rec.sigs[pend] = String(Date.now()); changed = true;
              } else if (Date.now() - since > idleMin * 60 * 1000 && rec.sigs[fired] !== 'on') {
                rec.sigs[fired] = 'on';
                toSend.push({ title: `⏱️ ${NAMED(d)} — idling ${idleMin}+ min`, body: `The engine has been running parked for over ${idleMin} minutes.` });
              }
            } else {
              if (rec.sigs[pend]) { delete rec.sigs[pend]; changed = true; }
              if (rec.sigs[fired]) { delete rec.sigs[fired]; changed = true; }
            }
          }

          // speed-limit-aware alert (opt-in per car via taSpeedLimitAlert). Only
          // when moving with real speed; alert once per over-limit episode.
          if ((d.attributes || {}).taSpeedLimitAlert && pos && pos.latitude != null) {
            const mph = liveMph(pos);
            const sig = `spd:${d.id}`;
            // per-car tolerance; default 7 mph over the posted limit
            const over = Number((d.attributes || {}).taSpeedLimitOver) > 0
              ? Number((d.attributes || {}).taSpeedLimitOver) : 7;
            if (mph >= 20) {
              const limit = await roadSpeedLimit(pos.latitude, pos.longitude);
              console.log(`[push] speed-limit check ${NAMED(d)}: ${mph} mph, limit ${limit == null ? 'unknown' : limit} (needs > ${limit == null ? '—' : limit + over})`);
              if (limit && mph > limit + over) {
                if (rec.sigs[sig] !== 'over') {
                  rec.sigs[sig] = 'over';
                  toSend.push({ title: `🚧 ${NAMED(d)} — ${mph} in a ${limit}`, body: `Going ${mph} mph in a ${limit} mph zone.` });
                }
              } else if (limit && mph <= limit + 3 && rec.sigs[sig] === 'over') {
                rec.sigs[sig] = 'ok'; changed = true; // back under → re-arm
              }
            } else if (rec.sigs[sig] === 'over') {
              rec.sigs[sig] = 'ok'; changed = true; // slowed/stopped → re-arm
            }
          }

          for (const a of toSend) {
            changed = true;
            console.log(`[push]   SENDING "${a.title}" → ${tokenRecs.length} device token(s)`);
            // carry where/when it happened so tapping the notification can open
            // the full alert detail screen instead of just the map
            const alertData = {
              deviceId: d.id,
              path: `/map?device=${d.id}`,
              alert: 1,
              car: NAMED(d),
              atitle: a.title,
              lat: pos && pos.latitude != null ? pos.latitude : null,
              lng: pos && pos.longitude != null ? pos.longitude : null,
              spd: pos ? Math.round((pos.speed || 0) * KNOTS_TO_MPH) : null,
              ts: Date.now(),
              imei: d.uniqueId || '',
            };
            // record it in the server-side history so the Alerts tab is complete
            // even for alerts that fired while the app was closed
            await appendLog(uid, {
              t: new Date().toISOString(),
              title: a.title,
              body: a.body,
              car: NAMED(d),
              deviceId: d.id,
              imei: d.uniqueId || '',
              lat: alertData.lat, lng: alertData.lng, spd: alertData.spd,
              sev: /crash|tow|theft|check engine|overheat|jam|VIN|highway|power cut/i.test(a.title) ? 'bad' : 'warn',
              // frozen snapshot of the car's readings at the instant this fired,
              // so the alert-detail screen shows what was true THEN, not now
              vitals: (() => {
                const at = (pos && pos.attributes) || {};
                const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
                return {
                  speed: alertData.spd,
                  ignition: at.ignition == null ? null : !!at.ignition,
                  fuel: num(at.io48 != null ? at.io48 : at.fuel),
                  coolant: num(at.io32),
                  rpm: num(at.io36),
                  battery: num(at.io113 != null ? at.io113 : (at.io67 != null ? at.io67 : at.power)),
                  faults: num(at.io30),
                  codes: at.dtcs || at.io281 || '',
                  odometer: num(at.odometer != null ? at.odometer : at.totalDistance),
                  sats: num(at.sat),
                  fixTime: (pos && pos.fixTime) || null,
                };
              })(),
            });

            const dead = await sendToTokens(tokenRecs, { title: a.title, body: a.body, data: alertData });
            if (dead.length) { console.log(`[push]   pruned ${dead.length} dead token(s)`); rec.tokens = (rec.tokens || []).filter((t) => !dead.includes(t.token)); devChanged = true; }
          }
        }
        // Keep the sigs map from growing forever — but ONLY evict one-shot
        // `ev:<id>` keys. The old trim dropped the oldest keys wholesale, which
        // meant long-lived state (fault flags, tow timers, re-arm clocks) got
        // wiped once enough events had streamed through, resetting conditions
        // and re-alerting things the owner had already been told about.
        const evKeys = Object.keys(rec.sigs).filter((k) => k.startsWith('ev:'));
        if (evKeys.length > 300) {
          for (const k of evKeys.slice(0, evKeys.length - 150)) delete rec.sigs[k];
          changed = true;
        }
      }
      // sigs → local file (cheap, churns constantly); tokens → Traccar (rare)
      if (changed) await writeSigs();
      if (devChanged) await writeStore(store);
    } catch (e) {
      console.error('[push] poll error:', e.message);
    }
    lastCheck = now;
    await saveLastCheck(now);
    maybeWeeklyDigest().catch(() => {}); // Sunday-night summary, once per week
  }

  if (enabled) {
    setInterval(() => { poll().catch(() => {}); }, 30 * 1000);
    console.log(`[push] APNs enabled v21 (${USE_DB ? 'Postgres-backed state — durable across deploys' : 'file/Traccar fallback — no DATABASE_URL'}) — polling every 30s.`);
  }

  return { enabled, sendToTokens };
}

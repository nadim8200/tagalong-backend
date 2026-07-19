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

const KNOTS_TO_MPH = 1.15078;

export function initPush(app, { TRACCAR_URL, traccarHeaders, requireAuth, env }) {
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
  async function readStore() {
    const host = await hostDevice();
    return { host, store: (host.attributes || {}).taPush || {} };
  }
  async function writeStore(store) {
    const host = await hostDevice();
    const attributes = { ...(host.attributes || {}), taPush: store };
    await fetch(`${TRACCAR_URL}/api/devices/${host.id}`, {
      method: 'PUT',
      headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...host, attributes }),
    });
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
        return { key: `alarm-${al}`, title: `🔔 ${car} — alarm`, body: `Alarm: ${al}` };
      }
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
    // tracker disconnected — no report for a while
    const last = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : (d.lastUpdate ? new Date(d.lastUpdate).getTime() : 0);
    if (last && Date.now() - last > 20 * 60 * 1000) {
      out.push({ key: 'disconnect', val: 'off', title: `🔌 ${car} — tracker disconnected`, body: 'The tracker went silent — it may be unplugged or lost power.' });
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
      const q = `[out:json][timeout:8];way(around:35,${lat},${lng})[highway][maxspeed];out tags 3;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (r.ok) {
        const j = await r.json();
        for (const el of (j.elements || [])) {
          const v = parseMaxspeed((el.tags || {}).maxspeed);
          if (v) { mph = v; break; }
        }
      }
    } catch { /* leave null */ }
    speedLimitCache.set(key, { mph, at: Date.now() });
    if (speedLimitCache.size > 3000) speedLimitCache.clear();
    return mph;
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
  let lastCheck = Date.now() - 5 * 60 * 1000;
  async function poll() {
    if (!enabled) return;
    const now = Date.now();
    const fromISO = new Date(lastCheck).toISOString();
    const toISO = new Date(now).toISOString();
    try {
      const { store } = await readStore();
      const fleet = await allDevices();
      const positions = await allPositions();
      const geoNames = await geofenceNames();
      let changed = false;
      for (const rec of Object.values(store)) {
        const tokenRecs = rec.tokens || [];
        if (!tokenRecs.length) continue;
        rec.sigs = rec.sigs || {};
        const devices = scopeDevices(fleet, rec);
        if (!devices.length) continue;

        for (const d of devices) {
          const pos = positions[d.id];
          const toSend = [];

          // event-based (crash, geofence, overspeed, ignition, fuel drop…)
          const events = await recentEvents(d.id, fromISO, toISO);
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
            rec.sigs[sig] = da.val;
            toSend.push(da);
          }
          // RE-ARM: any derived condition that is no longer present gets its
          // remembered state cleared, so if the SAME fault returns later (e.g. a
          // check-engine code cleared at the shop that comes back) it alerts
          // again instead of being suppressed by the stale signature.
          {
            const active = new Set(derived.map((x) => x.key));
            for (const key of ['disconnect', 'dtc', 'enginehot', 'charging', 'overcharge', 'lowfuel', 'lowbatt']) {
              const sig = `dv:${d.id}:${key}`;
              if (!active.has(key) && rec.sigs[sig] !== undefined) { delete rec.sigs[sig]; changed = true; }
            }
          }

          // tow / theft: moving with the ignition off. Debounced, because at
          // startup the tracker briefly reports motion=true while ignition is
          // still false — that transient was firing a false tow alert right
          // before every legitimate "vehicle turned on". We now require real
          // road speed AND the condition to hold for ~90s before alerting.
          {
            const pa = (pos && pos.attributes) || {};
            const towMph = Math.round(((pos && pos.speed) || 0) * KNOTS_TO_MPH);
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

          // speed-limit-aware alert (opt-in per car via taSpeedLimitAlert). Only
          // when moving with real speed; alert once per over-limit episode.
          if ((d.attributes || {}).taSpeedLimitAlert && pos && pos.latitude != null) {
            const mph = Math.round((pos.speed || 0) * KNOTS_TO_MPH);
            const sig = `spd:${d.id}`;
            if (mph >= 25) {
              const limit = await roadSpeedLimit(pos.latitude, pos.longitude);
              if (limit && mph > limit + 8) {
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
            const dead = await sendToTokens(tokenRecs, { title: a.title, body: a.body, data: alertData });
            if (dead.length) { console.log(`[push]   pruned ${dead.length} dead token(s)`); rec.tokens = (rec.tokens || []).filter((t) => !dead.includes(t.token)); }
          }
        }
        // keep the sigs map from growing forever
        const keys = Object.keys(rec.sigs);
        if (keys.length > 400) { rec.sigs = Object.fromEntries(keys.slice(-200).map((k) => [k, rec.sigs[k]])); changed = true; }
      }
      if (changed) await writeStore(store);
    } catch (e) {
      console.error('[push] poll error:', e.message);
    }
    lastCheck = now;
    maybeWeeklyDigest().catch(() => {}); // Sunday-night summary, once per week
  }

  if (enabled) {
    setInterval(() => { poll().catch(() => {}); }, 30 * 1000);
    console.log('[push] APNs enabled v7 (tappable alert detail, temp thresholds, tow debounced, re-arm on) — polling every 30s.');
  }

  return { enabled, sendToTokens };
}

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
  function eventToPush(d, ev) {
    const car = NAMED(d);
    const a = ev.attributes || {};
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
        return { key: `geo-in-${ev.geofenceId}`, title: `📍 ${car} arrived`, body: 'Your car arrived at a saved place.' };
      case 'geofenceExit':
        return { key: `geo-out-${ev.geofenceId}`, title: `📍 ${car} left`, body: 'Your car left a saved place.' };
      case 'deviceFuelDrop':
        return { key: 'fueldrop', title: `⛽ ${car} — fuel drop`, body: 'A sudden fuel drop was detected.' };
      case 'ignitionOn':
        return { key: 'ign-on', title: `🚗 ${car} started`, body: 'The engine was turned on.' };
      case 'ignitionOff':
        return { key: 'ign-off', title: `🅿️ ${car} stopped`, body: 'The engine was turned off.' };
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
    // check-engine
    const dtc = a.dtcs || (a.io30 != null ? a.io30 : 0);
    if (dtc && (typeof dtc === 'string' ? dtc.length : dtc > 0)) {
      out.push({ key: 'dtc', val: String(dtc), title: `🔧 ${car} — check engine`, body: typeof dtc === 'string' ? `Fault code ${dtc}.` : 'A check-engine code is active.' });
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
    // movement while ignition off (tow)
    if (a.motion === true && a.ignition === false) {
      out.push({ key: 'towing', val: '1', title: `🪝 ${car} — moving while off`, body: 'Your parked car is moving — possible tow/theft.' });
    }
    return out;
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
            const p = eventToPush(d, ev);
            if (!p) continue;
            const sig = `ev:${ev.id}`;
            if (rec.sigs[sig]) continue;
            rec.sigs[sig] = 1;
            toSend.push(p);
          }
          // derived (disconnect, dtc, low fuel/battery, tow)
          for (const da of derivedAlerts(d, pos)) {
            const sig = `dv:${d.id}:${da.key}`;
            if (rec.sigs[sig] === da.val) continue; // same state already notified
            rec.sigs[sig] = da.val;
            toSend.push(da);
          }

          for (const a of toSend) {
            changed = true;
            console.log(`[push]   SENDING "${a.title}" → ${tokenRecs.length} device token(s)`);
            const dead = await sendToTokens(tokenRecs, { title: a.title, body: a.body, data: { deviceId: d.id, path: `/map?device=${d.id}` } });
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
  }

  if (enabled) {
    setInterval(() => { poll().catch(() => {}); }, 30 * 1000);
    console.log('[push] APNs enabled — polling every 30s for locked-phone alerts.');
  }

  return { enabled, sendToTokens };
}

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

  const key = (APNS_KEY || '').replace(/\\n/g, '\n');
  const enabled = !!(key && APNS_KEY_ID && APNS_TEAM_ID);
  const apnsHost = APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';

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
  const sendOne = (token, payload) => new Promise((resolve) => {
    let client;
    let jwtToken;
    try {
      jwtToken = providerJwt(); // throws if the .p8 key is malformed
    } catch (e) {
      console.log('[push] JWT sign FAILED — check APNS_KEY / KEY_ID / TEAM_ID:', e.message);
      return resolve({ ok: false, status: 0 });
    }
    try {
      client = http2.connect(`https://${apnsHost}`);
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

  // returns the list of tokens Apple says are dead (410/BadDeviceToken) to prune
  async function sendToTokens(tokens, { title, body, data }) {
    if (!enabled || !tokens || !tokens.length) return [];
    const payload = {
      aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'time-sensitive' },
      ...(data || {}),
    };
    const dead = [];
    for (const t of tokens) {
      const r = await sendOne(t, payload);
      console.log(`[push]   APNs → ${r.ok ? 'OK 200' : `FAIL ${r.status}`} (${apnsHost})`);
      if (!r.ok && (r.status === 410 || r.status === 400)) dead.push(t);
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
    const { token, platform = 'ios', account = '', cid = '' } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const { store } = await readStore();
      const uidKey = String(req.user.id);
      const rec = store[uidKey] || { role: req.user.role, email: req.user.email, tokens: [], sigs: {} };
      if (!rec.tokens.some((t) => t.token === token)) {
        rec.tokens.push({ token, platform, ts: Date.now() });
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

  // TEMP diagnostic: open this URL in a browser to fire a test push to EVERY
  // registered device right now (no waiting on a car event). The detailed APNs
  // result is printed to the logs. Remove once push is confirmed working.
  app.get('/push/test', async (_req, res) => {
    try {
      const { store } = await readStore();
      const tokens = [];
      for (const rec of Object.values(store)) (rec.tokens || []).forEach((t) => tokens.push(t.token));
      console.log(`[push] /push/test — firing to ${tokens.length} token(s), apns ${enabled}, host ${apnsHost}`);
      if (!tokens.length) return res.json({ ok: false, reason: 'no registered tokens', enabled });
      await sendToTokens(tokens, { title: '🔔 TagAlong test', body: 'Push is working! 🎉', data: {} });
      res.json({ ok: true, sentTo: tokens.length, enabled, host: apnsHost });
    } catch (e) { console.log('[push] /push/test error:', e.message); res.status(500).json({ error: e.message }); }
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
      const regCount = Object.values(store).filter((r) => (r.tokens || []).length).length;
      console.log(`[push] poll tick — ${regCount} registered user(s), ${fleet.length} devices, window ${fromISO}..${toISO}`);
      let changed = false;
      for (const rec of Object.values(store)) {
        const tokens = (rec.tokens || []).map((t) => t.token);
        if (!tokens.length) continue;
        rec.sigs = rec.sigs || {};
        const devices = scopeDevices(fleet, rec);
        console.log(`[push]   user ${rec.email || '?'} account=${rec.account || '-'} cid=${rec.cid || '-'} → ${devices.length} car(s) in scope`);
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
            console.log(`[push]   SENDING "${a.title}" → ${tokens.length} device token(s)`);
            const dead = await sendToTokens(tokens, { title: a.title, body: a.body, data: { deviceId: d.id, path: `/map?device=${d.id}` } });
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

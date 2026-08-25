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
// A stale re-read from a sleeping tracker sits around this speed, and GPS noise
// on a stationary car rarely exceeds it. Above it, a FRESH fix is real motion
// no matter what the ignition/motion flags say — you can't do 30 mph parked.
const TRUST_SPEED_MPH = 20;
function liveMph(pos) {
  if (!pos) return 0;
  const at = pos.attributes || {};
  const fix = pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
  // Freshness is non-negotiable: a stale fix, even at 80 mph, means the tracker
  // stopped reporting mid-drive (that's the disconnect alert's job, not this).
  if (!fix || Date.now() - fix > FRESH_FIX_MS) return 0;

  const mph = Math.round((pos.speed || 0) * KNOTS_TO_MPH);

  // A fresh fix showing real highway speed is trusted on its own. This is the
  // fix for "did a whole highway trip over the limit, got no alert": many
  // GPS/OBD trackers don't report ignition, or report it false when they can't
  // detect it, and the old `ignition === false → 0` swallowed every speeding
  // alert on those devices.
  if (mph >= TRUST_SPEED_MPH) return mph;

  // Only for LOW, ambiguous speeds do the motion/ignition flags get a vote —
  // this is what keeps a parked car's stale 9-mph re-read from reading as
  // motion. That was the gate's original and only real purpose.
  if (at.motion === false || at.ignition === false) return 0;
  return mph;
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
      let r = await sendOne(token, payload, host); // eslint-disable-line no-await-in-loop
      console.log(`[push]   APNs → ${r.ok ? 'OK 200' : `FAIL ${r.status}`} (${host})`);
      // A 400 is almost always BadDeviceToken = the token was sent to the WRONG
      // Apple environment (a production/TestFlight token hitting the sandbox host,
      // or vice-versa). That's the #1 reason pushes silently vanish while in-app
      // alerts still show. Instead of pruning it, retry the OTHER host — this
      // self-heals a mis-detected sandbox/production environment.
      if (!r.ok && r.status === 400) {
        const alt = host.includes('sandbox') ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
        r = await sendOne(token, payload, alt); // eslint-disable-line no-await-in-loop
        console.log(`[push]   APNs retry → ${r.ok ? 'OK 200' : `FAIL ${r.status}`} (${alt})`);
      }
      // Only prune a token that's truly gone (410) or still bad on both hosts.
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
      // Which cars does the SERVER think belong to this signed-in account? If the
      // car you expect alerts from isn't in this list, it's assigned to a
      // different account (or not assigned) — that's why its alerts never arrive.
      let scopedCars = []; let blockedCars = [];
      try {
        const fleet = await allDevices();
        const uid = String(req.user.id);
        const nameOf = (d) => ((d.attributes || {}).displayName || d.name);
        const users = await allUsers();
        const rec2 = withUserIdentity(rec || {}, uid, users);
        const permitted = await permittedDeviceIds(uid, rec2);
        const assigned = fleet.filter((d) => deviceOwnedBy(d, rec2, uid) || (permitted && permitted.has(String(d.id))));
        scopedCars = assigned.filter((d) => membershipLive(d)).map(nameOf);
        // assigned to you but SILENCED because membership is expired/stopped
        blockedCars = assigned.filter((d) => !membershipLive(d)).map(nameOf);
      } catch { /* ignore */ }
      if (!enabled) return res.json({ ok: false, reason: 'apns-not-configured', scopedCars, blockedCars });
      if (!tokenRecs.length) return res.json({ ok: false, reason: 'no-tokens', scopedCars, blockedCars });
      const dead = await sendToTokens(tokenRecs, {
        title: '🔔 TagAlong test alert',
        body: 'Your alerts are working. You can lock your phone.',
        data: { path: '/car?tagalong' },
      });
      if (dead.length && rec) {
        rec.tokens = tokenRecs.filter((t) => !dead.includes(t.token));
        await writeStore(store);
      }
      res.json({ ok: true, sent: tokenRecs.length - dead.length, scopedCars, blockedCars });
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
  // Every Traccar user (admin token). Used to resolve a registered phone's REAL
  // account number / customer id from the SERVER, instead of trusting whatever
  // the phone sent at registration — the phone's local customer list can be
  // empty or stale, which left cars linked only by account/customerId (like a
  // freshly-added one) unmatched and silent. The Traccar user's own attributes
  // are the same on every device, so this makes scoping reliable for everyone.
  async function allUsers() {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/users`, { headers: traccarHeaders });
      if (!r.ok) return [];
      const a = await r.json();
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }
  // Fill in a registration record's account / customer id from the authoritative
  // Traccar user, so scoping doesn't depend on what the phone happened to send.
  function withUserIdentity(rec, uid, users) {
    const u = (users || []).find((x) => String(x.id) === String(uid));
    const ua = (u && u.attributes) || {};
    return {
      ...rec,
      account: ua.account || rec.account || '',
      cid: rec.cid || ua.customerId || '',
    };
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
  // Membership gate (mirrors the frontend traccar.js): a device whose paid
  // membership has lapsed (expiration date reached) or was manually stopped by an
  // admin goes FULLY dark — no push alerts fire for it to anyone, including the
  // admin monitor — until it's renewed on the Devices page.
  const ymdToday = () => { const x = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
  function membershipLive(d) {
    const m = (d.attributes || {}).membership || {};
    if (m.suspended) return false;                       // manually stopped
    if (m.expiresAt && ymdToday() >= String(m.expiresAt)) return false; // expired
    return true;                                         // active / no membership set
  }

  // Which cars belong to this registered user. `uid` is the Traccar user id (the
  // push store is keyed by it). We match the SAME ownership signals the app's
  // getDevices() uses, so any account a device is assigned to on the Devices tab
  // gets alerts — whether it's the primary owner, one of several owners, or a
  // shared/family link, and even when the account/customer NUMBER isn't set.
  // Is this device ASSIGNED to this user? (Ownership only — ignores membership.)
  function deviceOwnedBy(d, rec, uid) {
    const a = d.attributes || {};
    if (rec.role === 'admin') return String(a.account || '') !== 'TA';
    const uidStr = uid != null ? String(uid) : '';
    const memberId = uidStr ? `u${uidStr}` : '';
    // 1) assigned by USER ID — primary owner, any entry in owners[], or an approved memberLink.
    if (uidStr) {
      if (a.ownerUserId != null && String(a.ownerUserId) === uidStr) return true;
      if (Array.isArray(a.owners) && a.owners.some((o) => o && String(o.userId) === uidStr)) return true;
      if (Array.isArray(a.memberLinks) && a.memberLinks.some((m) => m && m.memberId === memberId && m.status === 'approved')) return true;
    }
    // 1b) a SECONDARY owner may be recorded with only a customer id / account number (no user id).
    if (Array.isArray(a.owners) && a.owners.some((o) => o
      && ((rec.cid && String(o.customerId) === String(rec.cid))
        || (rec.account && o.account && String(o.account) === String(rec.account))))) return true;
    // 2) legacy attribute match by customer id / account number
    if (rec.cid && String(a.customerId) === String(rec.cid)) return true;
    if (rec.account && String(a.account) === String(rec.account)) return true;
    return false;
  }
  // The APP shows a customer their cars using Traccar's user↔device PERMISSIONS.
  // The attribute matching above is a second, independent source of truth — so a
  // newly-added car the app shows can be missed by push if its attributes don't
  // also carry the owner's id/account. To guarantee parity ("if it's in my app,
  // I get its alerts"), for a real owner login we ALSO pull the exact device list
  // Traccar grants that user and treat those as owned. Admin/broker/family keep
  // the attribute / member-link path (their uid isn't a Traccar user id).
  const OWNER_ROLES = new Set(['owner', 'customer', 'user', '']);
  async function permittedDeviceIds(uid, rec) {
    if (rec && rec.role && !OWNER_ROLES.has(rec.role)) return null;
    if (!/^\d+$/.test(String(uid))) return null; // Traccar user ids are numeric
    try {
      const r = await fetch(`${TRACCAR_URL}/api/devices?userId=${encodeURIComponent(uid)}`, { headers: traccarHeaders });
      if (!r.ok) return null;
      const arr = await r.json();
      return Array.isArray(arr) ? new Set(arr.map((d) => String(d.id))) : null;
    } catch { return null; }
  }
  // Cars this user actually gets alerts for = (assigned by attribute OR granted by
  // Traccar permission) AND membership live.
  function scopeDevices(devices, rec, uid, permittedIds) {
    return devices.filter((d) =>
      (deviceOwnedBy(d, rec, uid) || (permittedIds && permittedIds.has(String(d.id))))
      && membershipLive(d));
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

  // Every GPS fix the device logged in the window (not just the latest). The
  // tracker reports many fixes between our 30s polls, so this history is what
  // lets us catch a hard brake / hard acceleration that happened between polls.
  async function recentRoute(deviceId, fromISO, toISO) {
    try {
      const r = await fetch(`${TRACCAR_URL}/api/reports/route?deviceId=${deviceId}&from=${fromISO}&to=${toISO}`, {
        headers: { ...traccarHeaders, Accept: 'application/json' },
      });
      if (!r.ok) return [];
      const arr = await r.json();
      return Array.isArray(arr) ? arr : [];
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
        if (/hardAcc|harshAcc|accel|rapidAccel/i.test(al)) return { key: 'harsh-accel', title: `🏎️ ${car} — hard acceleration`, body: 'A sudden hard acceleration was detected.' };
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

  // Read a paired Teltonika EYE Sensor (BLE) from a position's attributes. The
  // exact field names vary by firmware/preset, so we try the common named keys
  // first (temp1.., humidity1.., bleTemp1..) then raw AVL ids. Mirrors the app's
  // src/eyeSensor.js so phone alerts and the on-screen readings agree.
  function readEyeAttrs(a = {}) {
    const numFrom = (keys) => {
      for (const k of keys) {
        const v = a[k];
        if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
      }
      return null;
    };
    for (const s of [1, 2, 3, 4]) {
      const temperature = numFrom([`temp${s}`, `bleTemp${s}`, `temperature${s}`, `bleTemperature${s}`, `io${24 + s}`]);
      const humRaw = { 1: 'io86', 2: 'io104', 3: 'io106', 4: 'io108' }[s];
      const humidity = numFrom([`humidity${s}`, `bleHumidity${s}`, `hum${s}`, humRaw]);
      const battery = numFrom([`bleBattery${s}`, `bleBatt${s}`, `bleVoltage${s}`, `sensorBattery${s}`]);
      const mv = [`bleMovement${s}`, `movement${s}`, `bleMotion${s}`, `bleTilt${s}`].map((k) => a[k]).find((v) => v != null);
      if (temperature == null && humidity == null && battery == null && mv == null) continue;
      const moved = mv === true || mv === 1 || mv === '1' || (Number.isFinite(Number(mv)) && Math.abs(Number(mv)) > 0);
      return { slot: s, temperature, humidity, battery, moved };
    }
    return null;
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
    // "Unplugged mid-drive" only if it went dark at a REAL driving speed AND the
    // device still reported it was in MOTION. A car that just slowed, parked and
    // let the tracker sleep often sends a last record with a residual speed
    // (e.g. 16 mph) and ignition still latched on — that was firing this alert on
    // every normal park and reading like a disconnect. Requiring motion≠false and
    // a genuine speed (default 25 mph, per-car taDisconnectMinMph) fixes that; a
    // real unplug/power-cut is also caught directly by the device's power alarm.
    const minRunMph = Number((d.attributes || {}).taDisconnectMinMph) > 0
      ? Number((d.attributes || {}).taDisconnectMinMph) : 25;
    const wasRunning = a.ignition === true && a.motion !== false && lastMph >= minRunMph;
    // per-car override, in hours, for the parked case
    const parkedHrs = Number((d.attributes || {}).taOfflineHours) > 0
      ? Number((d.attributes || {}).taOfflineHours) : 24;
    if (last && wasRunning && silentMs > 30 * 60 * 1000) {
      out.push({
        key: 'disconnect', val: 'running',
        title: `🔌 ${car} — tracker stopped reporting`,
        body: `It went silent while driving at ${lastMph} mph and hasn't checked in since. It may have been unplugged or lost power.`,
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
    // low fuel — PARITY WITH THE APP so the phone gets what the web shows.
    // The app warns two ways: by RANGE (estimated miles of fuel left) and by
    // LEVEL (%), each with per-car thresholds. We mirror both here.
    //
    // The old version used a fixed val:'1', so after the FIRST low-fuel push it
    // deduped itself into permanent silence while the tank stayed low — which is
    // why the web (whose state resets each session) kept firing but the phone
    // never did. val now carries the severity BUCKET, so a worsening tank
    // (e.g. 14% → 9% → 4%) notifies again as it drops, while a steady level only
    // pings once (with the 6-hour repeat floor still guarding against spam).
    const fuelPct = a.io48 != null ? Number(a.io48) : (a.fuel != null ? Number(a.fuel) : null);
    if (fuelPct != null && fuelPct > 0) {
      const tankRange = Number((d.attributes || {}).tankRangeMiles) > 0 ? Number((d.attributes || {}).tankRangeMiles) : 300;
      const lowRangeMi = Number((d.attributes || {}).lowRangeMiles) > 0 ? Number((d.attributes || {}).lowRangeMiles) : 50;
      const lowFuelPct = Number((d.attributes || {}).lowFuelPct) > 0 ? Number((d.attributes || {}).lowFuelPct) : 15;
      const rangeMi = Math.round((fuelPct / 100) * tankRange);
      if (rangeMi < lowRangeMi) {
        out.push({ key: 'lowrange', val: String(Math.floor(rangeMi / 10) * 10), title: `⛽ ${car} — low fuel`, body: `About ${rangeMi} miles of range left (under ${lowRangeMi}).` });
      }
      if (fuelPct <= lowFuelPct) {
        out.push({ key: 'lowfuel', val: String(Math.floor(fuelPct / 5) * 5), title: `⛽ ${car} — low fuel`, body: `Fuel is at ${Math.round(fuelPct)}%.` });
      }
    }
    // low tracker battery
    const bl = a.batteryLevel;
    if (bl != null && bl <= 15) {
      out.push({ key: 'lowbatt', val: '1', title: `🔋 ${car} — low battery`, body: `Tracker battery at ${Math.round(bl)}%.` });
    }
    // ---- Teltonika EYE Sensor (BLE): cargo temperature / humidity / movement ----
    // The paired tag's readings arrive on the vehicle's own attributes. Thresholds
    // are per-vehicle (eyeTempMinC / eyeTempMaxC / eyeHumidityMax / eyeAlertMovement).
    {
      const eye = readEyeAttrs(a);
      const da = d.attributes || {};
      if (eye) {
        const tMin = Number(da.eyeTempMinC);
        const tMax = Number(da.eyeTempMaxC);
        if (eye.temperature != null) {
          const t = eye.temperature;
          if (Number.isFinite(tMax) && t > tMax) {
            out.push({ key: 'eyetemp', val: `hi${Math.round(t)}`, title: `🌡️ ${car} — cargo too warm`, body: `Sensor reads ${t.toFixed(1)}°C (above the ${tMax}°C limit).` });
          } else if (Number.isFinite(tMin) && t < tMin) {
            out.push({ key: 'eyetemp', val: `lo${Math.round(t)}`, title: `🥶 ${car} — cargo too cold`, body: `Sensor reads ${t.toFixed(1)}°C (below the ${tMin}°C limit).` });
          }
        }
        const hMax = Number(da.eyeHumidityMax);
        if (eye.humidity != null && Number.isFinite(hMax) && eye.humidity > hMax) {
          out.push({ key: 'eyehumidity', val: String(Math.round(eye.humidity / 5) * 5), title: `💧 ${car} — high humidity`, body: `Cargo humidity is ${Math.round(eye.humidity)}% (above ${hMax}%).` });
        }
        if (da.eyeAlertMovement === true && eye.moved) {
          out.push({ key: 'eyemove', val: '1', title: `📦 ${car} — sensor moved`, body: 'The EYE-tagged item was moved or tilted.' });
        }
      }
    }
    // aggressive revving — threshold per car via rpmAlertRpm, default 4000
    const rpm = Number(a.io36 != null ? a.io36 : a.rpm);
    const rpmLimit = Number((d.attributes || {}).rpmAlertRpm) > 0 ? Number((d.attributes || {}).rpmAlertRpm) : 4000;
    if (!isNaN(rpm) && rpm > rpmLimit) {
      const revMph = liveMph(pos); // current speed, as a reference for the rev
      out.push({ key: 'rpm', val: 'on', title: `🏎️ ${car} — hard revving`, body: `Engine hit ${Math.round(rpm)} RPM (over the ${rpmLimit} limit) at ${revMph} mph.` });
    }

    // speeding — warning threshold and the hard over-speed limit, per car.
    // val is 'on' so it fires once on crossing and re-arms when back under.
    const mph = liveMph(pos);
    const warnAt = Number((d.attributes || {}).speedWarnMph) > 0 ? Number((d.attributes || {}).speedWarnMph) : 70;
    const maxAt = Number((d.attributes || {}).speedMaxMph) > 0 ? Number((d.attributes || {}).speedMaxMph) : 85;

    // DIAGNOSTIC — why did / didn't speeding fire? liveMph() has three gates
    // (fresh fix, motion≠false, ignition≠false) and returning 0 on any of them
    // silently swallows a speeding alert. Raw speed comes straight from the
    // position so we can see whether the tracker reported motion at all versus
    // a gate closing. Only logs when the tracker's OWN raw speed suggests
    // movement, so a parked fleet doesn't fill the log.
    {
      const at = (pos && pos.attributes) || {};
      const rawMph = pos ? Math.round((pos.speed || 0) * KNOTS_TO_MPH) : 0;
      const fixMs = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
      const ageSec = fixMs ? Math.round((Date.now() - fixMs) / 1000) : null;
      if (rawMph >= 15 || mph >= 15) {
        console.log(`[push] speed ${car}: raw ${rawMph} mph → live ${mph} mph `
          + `| warn ${warnAt} max ${maxAt} `
          + `| fixAge ${ageSec == null ? 'no-fix' : ageSec + 's'}${fixMs && Date.now() - fixMs > FRESH_FIX_MS ? ' STALE' : ''} `
          + `| motion=${at.motion} ignition=${at.ignition}`
          + `${mph === 0 && rawMph >= 15 ? '  <-- live=0 while raw moving: a gate is swallowing it' : ''}`);
      }
    }

    // Speeding is NOT emitted here any more. It moved to a dedicated block in
    // the poll loop so it can REPEAT while you stay over the limit and stop the
    // moment you drop under — behaviour the once-and-done derived machinery
    // (with its 6-hour repeat floor) actively fought.

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
    if (c) {
      // A real answer is good for a day — speed limits don't move. A FAILURE
      // must expire quickly: caching null for 24h meant one rate-limited moment
      // blinded us to that whole stretch of road until tomorrow.
      const ttl = c.mph != null ? 24 * 3600 * 1000 : 10 * 60 * 1000;
      if (Date.now() - c.at < ttl) return c.mph;
    }
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
      if (!r.ok) {
        // The public Overpass endpoint rate-limits hard (429) and sheds load
        // (504) — worth naming, because silent nulls look identical to "this
        // street has no speed limit on record".
        console.log(`[push] overpass ${r.status}${r.status === 429 ? ' (rate limited)' : ''} — no speed limit available`);
      }
      if (r.ok) {
        const j = await r.json();
        const els = (j.elements || []).filter((e) => (e.tags || {}).highway);
        if (!els.length) console.log(`[push] overpass returned ${(j.elements || []).length} element(s), none with a highway tag, at ${lat.toFixed(4)},${lng.toFixed(4)}`);
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
    } catch (e) {
      // A timeout here is normal under load; log it so "limit unknown" is never
      // mistaken for "we checked and the road has no limit".
      console.log('[push] overpass lookup failed:', e.message);
    }
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
    const users = await allUsers();
    for (const [uid, rec] of Object.entries(store)) {
      const tokenRecs = rec.tokens || [];
      if (!tokenRecs.length) continue;
      const rec2 = withUserIdentity(rec, uid, users);
      const permitted = await permittedDeviceIds(uid, rec2);
      const devs = scopeDevices(fleet, rec2, uid, permitted);
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

  // Make Traccar evaluate speeding on EVERY GPS record (not just our ~30s poll
  // snapshot, which misses brief bursts). We set the device's speedLimit (knots)
  // from its speedMaxMph; Traccar then emits a deviceOverspeed event on any
  // over-limit position, which the event loop already turns into an alert.
  const MPH_TO_KNOTS = 1 / 1.15078;
  async function ensureSpeedLimit(dev) {
    const a = dev.attributes || {};
    const hardMph = Number(a.speedMaxMph) > 0 ? Number(a.speedMaxMph) : 85;
    const wantKnots = Math.round((hardMph * MPH_TO_KNOTS) * 100) / 100;
    if (Math.abs(Number(a.speedLimit || 0) - wantKnots) <= 0.5) return; // already set
    const body = JSON.stringify({ ...dev, attributes: { ...a, speedLimit: wantKnots } });
    const r = await fetch(`${TRACCAR_URL}/api/devices/${dev.id}`, {
      method: 'PUT', headers: { ...traccarHeaders, 'Content-Type': 'application/json' }, body,
    });
    if (r.ok) { dev.attributes = { ...a, speedLimit: wantKnots }; console.log(`[push] speedLimit set on ${(a.displayName || dev.name)}: ${hardMph} mph`); }
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
      const users = await allUsers(); // resolve each phone's real account server-side
      // Ensure each car's Traccar speed limit is set so overspeed events fire on
      // every record (catches bursts our 30s snapshot would miss). Runs once per
      // car (skips when already set).
      for (const dev of fleet) { try { await ensureSpeedLimit(dev); } catch { /* best effort */ } }
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
        const rec2 = withUserIdentity(rec, uid, users);
        const permitted = await permittedDeviceIds(uid, rec2);
        const devices = scopeDevices(fleet, rec2, uid, permitted);
        if (!devices.length) continue;

        for (const d of devices) {
          const pos = positions[d.id];
          const toSend = [];

          // DIAGNOSTIC — which raw field is this tracker's ignition?
          //
          // Different tracker models report the ACC/ignition wire under
          // different names. When a device reports a fresh fix but has NO clean
          // `ignition` attribute, dump every attribute key so we can see what
          // it DOES send (in1 / di1 / acc / input / power / charge…) and map
          // that field to ignition. This is why the VW alerts and the C300
          // doesn't — same app, different tracker, different field name.
          {
            const at = (pos && pos.attributes) || {};
            const fixMs = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const fresh = fixMs && (Date.now() - fixMs) <= FRESH_FIX_MS;
            if (fresh && at.ignition == null) {
              console.log(`[push] IGN-DIAG ${NAMED(d)}: no 'ignition' attr. keys=[${Object.keys(at).join(', ')}] `
                + `| candidates: ${['in1', 'di1', 'acc', 'input', 'power', 'charge', 'ignition']
                  .filter((k) => at[k] !== undefined).map((k) => `${k}=${at[k]}`).join(' ') || 'none of the usual'}`);
            }
          }

          // event-based (crash, geofence, overspeed, ignition, fuel drop…)
          const events = await recentEvents(d.id, fromISO, toISO);
          if (events.length) {
            console.log(`[push] ${NAMED(d)}: ${events.length} event(s) — ${events.map((e) => e.type).join(', ')}`);
          }
          for (const ev of events) {
            const p = eventToPush(d, ev, geoNames);
            if (!p) {
              // DIAGNOSTIC — the tracker sent an event we don't turn into an
              // alert. This is how we find the native hard-acceleration event
              // (the other platform reads the tracker's G-sensor). If one shows
              // up here — type or alarm containing accel/harsh/shock/impact —
              // send the line back and we map it, same as we did for ignition.
              const alarm = (ev.attributes || {}).alarm;
              console.log(`[push] EVT-DIAG ${NAMED(d)}: unhandled event type="${ev.type}"${alarm ? ` alarm="${alarm}"` : ''}`);
              continue;
            }
            const sig = `ev:${ev.id}`;
            if (rec.sigs[sig]) continue;
            rec.sigs[sig] = 1;
            // Modern cars (Mercedes / VW / BMW especially) DE-ENERGIZE the OBD
            // port when they sleep, to stop the tracker draining the battery. The
            // tracker's external voltage falls toward 0 and it fires a power-cut /
            // "battery disconnected" alarm — even though nothing was unplugged and
            // it's still reporting on a healthy internal battery. Suppress that
            // false alarm when the car is PARKED and the tracker is clearly fine.
            // A genuine unplug WHILE DRIVING is still caught by the disconnect
            // logic (which watches for the tracker going silent at speed).
            if (p.key === 'alarm-power') {
              const pa = (pos && pos.attributes) || {};
              const internal = Number(pa.batteryLevel);
              const parked = liveMph(pos) < 3;
              const trackerHealthy = !Number.isFinite(internal) || internal >= 20;
              if (parked && trackerHealthy) {
                console.log(`[push] SLEEP-SUPPRESS ${NAMED(d)}: OBD port de-energized while parked (internal batt ${Number.isFinite(internal) ? `${internal}%` : 'n/a'}) — car asleep, not unplugged`);
                continue;
              }
            }
            // If the tracker DID report ignition, mark the shared guard so the
            // motion-derived "car started" below doesn't fire a second time.
            if (ev.type === 'ignitionOn' || p.key === 'ign-on') rec.sigs[`startedat:${d.id}`] = String(Date.now());
            toSend.push(p);
          }

          // ---- hard acceleration / braking / cornering ----
          //
          // SOURCE: the tracker's ACCELEROMETER (Teltonika "Green Driving"). That
          // is the accurate g-force source — it distinguishes a hard launch from a
          // normal one, which GPS speed CANNOT. We scan the whole fix HISTORY since
          // the last poll (not just the latest fix) so a quick event between 30s
          // polls isn't missed. The GPS speed-delta estimate below is OFF by
          // default (it flooded on normal driving) and only used if a car opts in
          // with harshFromGps:true.
          {
            // SCALING: the per-device route report is the single biggest cost
            // each poll cycle. Harsh driving can only happen on a car that's
            // actually running/moving, so skip the fetch entirely for parked or
            // asleep cars — the majority most of the time. This keeps memory and
            // Traccar load roughly flat as the fleet grows instead of linear.
            const fixMs = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const freshPos = fixMs && (Date.now() - fixMs) <= FRESH_FIX_MS;
            const activeNow = freshPos && (liveMph(pos) >= 3
              || (pos && (pos.attributes || {}).ignition === true)
              || rec.sigs[`tripon:${d.id}`] === 'on');
            const route = activeNow ? await recentRoute(d.id, fromISO, toISO) : [];
            const pts = route
              .map((p) => ({ mph: Math.round((p.speed || 0) * KNOTS_TO_MPH), t: p.fixTime ? new Date(p.fixTime).getTime() : 0, a: p.attributes || {} }))
              .filter((p) => p.t)
              .sort((a, b) => a.t - b.t);

            let accelDone = false; let brakeDone = false;

            // ---- accelerometer / Green Driving event on any fix (PRIMARY) ----
            for (const pt of pts) {
              const al = String(pt.a.alarm || '').toLowerCase();
              const gdt = pt.a.greenDrivingType != null ? Number(pt.a.greenDrivingType)
                : (pt.a.io253 != null ? Number(pt.a.io253) : null);
              let kind = null;
              if (/hardacc|harshacc|rapidaccel|accel/.test(al) || gdt === 1) kind = 'accel';
              else if (/hardbrak|harshbrak|braking/.test(al) || gdt === 2) kind = 'brake';
              else if (/corner/.test(al) || gdt === 3) kind = 'corner';
              if (!kind) continue;
              const seen = `gd-${kind}:${d.id}`;
              if (pt.t <= Number(rec.sigs[seen] || 0)) continue;
              rec.sigs[seen] = String(pt.t); changed = true;
              const M = { accel: ['🏎️', 'hard acceleration'], brake: ['🛑', 'hard braking'], corner: ['↩️', 'hard cornering'] };
              toSend.push({ title: `${M[kind][0]} ${NAMED(d)} — ${M[kind][1]}`, body: "Detected by the vehicle's sensor." });
              if (kind === 'accel') accelDone = true;
              if (kind === 'brake') brakeDone = true;
            }

            // DIAGNOSTIC: surface any green-driving-ish attribute keys on the fixes
            // so we can confirm exactly what Traccar names the accelerometer event
            // (io253 / greenDrivingType / alarm / axis…) and map it precisely.
            const gdKeys = pts.length ? Object.keys(pts[pts.length - 1].a).filter((k) => /green|harsh|accel|brak|corner|eco|axis|io25[0-9]/i.test(k)) : [];
            if (gdKeys.length) console.log(`[push] GD-DIAG ${NAMED(d)}: ${gdKeys.map((k) => `${k}=${pts[pts.length - 1].a[k]}`).join(' ')}`);

            // ---- GPS speed-delta estimate (OPT-IN ONLY: harshFromGps:true) ----
            // Disabled by default. GPS can't tell a hard launch from a brisk normal
            // one at our sampling, so it flooded ("Sped up 16 mph to 28 mph"). Kept
            // only as a fallback for a car that has no working accelerometer.
            if (((d.attributes || {}).harshFromGps === true)) {
              const jumpMph = Number((d.attributes || {}).accelJumpMph) > 0 ? Number((d.attributes || {}).accelJumpMph) : 22;
              const dropMph = Number((d.attributes || {}).brakeDropMph) > 0 ? Number((d.attributes || {}).brakeDropMph) : 22;
              const winSec = Number((d.attributes || {}).harshWindowSec) > 0 ? Number((d.attributes || {}).harshWindowSec) : 5;
              let bestAccel = 0; let accelTo = 0; let accelAt = 0;
              let bestBrake = 0; let brakeFrom = 0; let brakeAt = 0;
              for (let i = 1; i < pts.length; i++) {
                for (let j = i - 1; j >= 0 && (pts[i].t - pts[j].t) / 1000 <= winSec; j--) {
                  const dMph = pts[i].mph - pts[j].mph;
                  if (dMph > bestAccel && pts[i].mph >= 25) { bestAccel = dMph; accelTo = pts[i].mph; accelAt = pts[i].t; }
                  const drop = -dMph;
                  if (drop > bestBrake && pts[j].mph >= 25) { bestBrake = drop; brakeFrom = pts[j].mph; brakeAt = pts[i].t; }
                }
              }
              if (!accelDone && bestAccel >= jumpMph && accelAt > Number(rec.sigs[`accelat:${d.id}`] || 0)) {
                rec.sigs[`accelat:${d.id}`] = String(accelAt); changed = true;
                toSend.push({ title: `🏎️ ${NAMED(d)} — hard acceleration`, body: `Sped up ${Math.round(bestAccel)} mph (to ${accelTo} mph).` });
              }
              if (!brakeDone && bestBrake >= dropMph && brakeAt > Number(rec.sigs[`brakeat:${d.id}`] || 0)) {
                rec.sigs[`brakeat:${d.id}`] = String(brakeAt); changed = true;
                toSend.push({ title: `🛑 ${NAMED(d)} — hard braking`, body: `Slowed ${Math.round(bestBrake)} mph (from ${brakeFrom} mph).` });
              }
            }
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
            for (const key of ['disconnect', 'dtc', 'enginehot', 'charging', 'overcharge', 'lowfuel', 'lowrange', 'lowbatt', 'rpm', 'eyetemp', 'eyehumidity', 'eyemove']) {
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

            // The fix must be FRESH. A parked car that goes quiet keeps its last
            // reported ignition=true forever, and without this the timer counted
            // that stale value as "still running" — firing "idling 15 min" on a
            // car that had been off the whole time. Same 7-minute freshness gate
            // liveMph() already uses everywhere else. A genuinely idling car
            // reports fresh fixes; a silent one is parked, not idling.
            const fixMs = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const fixFresh = fixMs && (Date.now() - fixMs) <= FRESH_FIX_MS;

            // "Idling" means the ENGINE IS ACTUALLY RUNNING while parked. Many OBD
            // units report ignition=true whenever the port has power (accessory /
            // just plugged in), which fired "idling" on cars that were simply OFF.
            // So when the device reports RPM, trust that: RPM>200 = running, RPM≈0
            // = engine off (no idle). Only fall back to the ignition flag when the
            // device sends no RPM at all.
            const idleRpm = Number(pa.io36 != null ? pa.io36 : pa.rpm);
            const engineRunning = !isNaN(idleRpm) ? idleRpm > 200 : (pa.ignition === true);

            // After the first heads-up, the alert REPEATS every hour and carries a
            // running total so you know how long it's been sitting there running.
            // Repeat interval is per car via idleRepeatMin (default 60 minutes).
            const lastKey = `idlelast:${d.id}`;  // when we last notified
            const repeatMs = (Number((d.attributes || {}).idleRepeatMin) > 0
              ? Number((d.attributes || {}).idleRepeatMin) : 60) * 60 * 1000;
            const fmtDur = (ms) => {
              const m = Math.round(ms / 60000);
              const h = Math.floor(m / 60);
              return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
            };

            if (fixFresh && engineRunning && idleMph < 2) {
              const since = Number(rec.sigs[pend] || 0);
              if (!since) {
                rec.sigs[pend] = String(Date.now()); changed = true;
              } else {
                const elapsed = Date.now() - since;
                const lastNotify = Number(rec.sigs[lastKey] || 0);
                if (rec.sigs[fired] !== 'on' && elapsed > idleMin * 60 * 1000) {
                  // first heads-up at idleMin
                  rec.sigs[fired] = 'on';
                  rec.sigs[lastKey] = String(Date.now());
                  changed = true;
                  toSend.push({ title: `⏱️ ${NAMED(d)} — idling ${idleMin}+ min`, body: `The engine has been running parked for over ${idleMin} minutes.` });
                } else if (rec.sigs[fired] === 'on' && Date.now() - lastNotify >= repeatMs) {
                  // hourly repeat with the running total
                  rec.sigs[lastKey] = String(Date.now());
                  changed = true;
                  const dur = fmtDur(elapsed);
                  toSend.push({ title: `⏱️ ${NAMED(d)} — still idling (${dur})`, body: `The engine has been running parked and not moving for ${dur}.` });
                }
              }
            } else {
              if (rec.sigs[pend]) { delete rec.sigs[pend]; changed = true; }
              if (rec.sigs[fired]) { delete rec.sigs[fired]; changed = true; }
              if (rec.sigs[lastKey]) { delete rec.sigs[lastKey]; changed = true; }
            }
          }

          // ---- speeding: fires immediately and REPEATS while over ----
          //
          // Unlike a fault alert, this is meant to nag: the moment live speed
          // crosses the set limit it notifies, and it keeps re-notifying on
          // every poll while the car stays over, then goes quiet the instant it
          // drops back under. Interval is per car via speedRepeatSec.
          //
          // Honest ceiling: the alert can't repeat faster than the poll runs
          // (15s) or than the tracker reports a new position. Asking for 4s
          // won't produce 4s alerts if the device only sends a fix every 20s —
          // there's no new data to alert on. So the effective cadence is
          // max(speedRepeatSec, pollInterval, trackerReportInterval).
          {
            const spMph = liveMph(pos); // fresh-gated, unit-correct
            const warn = Number((d.attributes || {}).speedWarnMph) > 0 ? Number((d.attributes || {}).speedWarnMph) : 70;
            const hard = Number((d.attributes || {}).speedMaxMph) > 0 ? Number((d.attributes || {}).speedMaxMph) : 85;
            const repeatMs = Math.max(4, Number((d.attributes || {}).speedRepeatSec) > 0
              ? Number((d.attributes || {}).speedRepeatSec) : 30) * 1000;
            const lastKey = `spdlast:${d.id}`;   // when we last notified
            const overKey = `spdover:${d.id}`;    // which band we're in: 'hard' | 'warn' | absent

            const band = spMph >= hard ? 'hard' : (spMph >= warn ? 'warn' : null);
            if (band) {
              const lastNotify = Number(rec.sigs[lastKey] || 0);
              const bandChanged = rec.sigs[overKey] !== band; // warn→hard escalation fires at once
              if (bandChanged || Date.now() - lastNotify >= repeatMs) {
                rec.sigs[lastKey] = String(Date.now());
                rec.sigs[overKey] = band;
                changed = true;
                toSend.push(band === 'hard'
                  ? { title: `🚨 ${NAMED(d)} — over ${hard} mph`, body: `Travelling at ${spMph} mph.` }
                  : { title: `⏩ ${NAMED(d)} — speeding`, body: `Travelling at ${spMph} mph (over your ${warn} mph limit).` });
              }
            } else if (rec.sigs[overKey]) {
              // Dropped back under — go quiet and reset so the next episode
              // fires immediately rather than waiting out the interval.
              delete rec.sigs[overKey]; delete rec.sigs[lastKey]; changed = true;
            }
          }

          // ---- car started / ignition-on, derived from motion ----
          //
          // Traccar's ignitionOn event only fires when the tracker reports the
          // ignition flag — and these OBD units don't report it reliably (the
          // same gap that broke speeding). So derive "the car started" from the
          // car beginning to move after a real park.
          //
          // The trick is not firing at every stoplight. A trip has "started"
          // only when the car moves after being stationary for a while, so a
          // 30-second wait at a red light isn't a new trip but a 10-minute stop
          // at the store is. Default gap 5 min, per car via tripGapMin.
          //
          // If the tracker DOES report ignition, the event path above still
          // fires; the shared guard below stops the two from double-notifying.
          {
            const nowMs = Date.now();
            const curFix = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const fresh = curFix && (nowMs - curFix) <= FRESH_FIX_MS;
            const moving = fresh && liveMph(pos) >= 6;
            const gapMs = (Number((d.attributes || {}).tripGapMin) > 0
              ? Number((d.attributes || {}).tripGapMin) : 5) * 60 * 1000;

            const lastMoveKey = `lastmove:${d.id}`;
            const tripKey = `tripon:${d.id}`;
            const startGuard = `startedat:${d.id}`; // shared with the ignitionOn event

            // ---- QUIET → parked reset (fixes "no more 'started' alerts") ----
            // OBD units SLEEP when parked and stop reporting, so the fresh-fix
            // "engine off" resets below never run — tripKey/rpmon/accvibon stay
            // stuck 'on' after the first drive and suppress every later start.
            // If the tracker has been silent longer than the trip gap AND its last
            // report wasn't at driving speed (so a mid-drive signal drop can't
            // re-arm a phantom start), consider the car parked and re-arm the
            // engine-off signals so the next movement fires a fresh "started".
            {
              const lastFixMs = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
              const lastMph = Math.round(((pos && pos.speed) || 0) * KNOTS_TO_MPH);
              if (lastFixMs && (nowMs - lastFixMs) >= gapMs && lastMph < 6) {
                if (rec.sigs[tripKey] === 'on') { rec.sigs[tripKey] = 'off'; changed = true; }
                if (rec.sigs[`rpmon:${d.id}`] === 'on') { rec.sigs[`rpmon:${d.id}`] = 'off'; changed = true; }
                if (rec.sigs[`accvibon:${d.id}`] === 'on') { rec.sigs[`accvibon:${d.id}`] = 'off'; changed = true; }
                if (rec.sigs[`ignflag:${d.id}`] && rec.sigs[`ignflag:${d.id}`] !== 'off') { rec.sigs[`ignflag:${d.id}`] = 'off'; changed = true; }
              }
            }

            // ---- ENGINE-ON is decided by RPM, NOT the ignition flag ----
            // On these OBD cars the ignition flag and system voltage LIE: a parked
            // Mercedes reads "ignition on" at ~12.8V while the engine is off, which
            // fired phantom "started" alerts. RPM can't lie — an OBD tracker only
            // sees engine RPM when the engine is actually turning. So the RPM path
            // just below is the SOLE standstill "started" trigger; the ignition
            // flag is no longer used to alert at all (motion stays as the fallback
            // for any car that doesn't stream RPM). Diagnostic: log what a parked,
            // fresh-fix car actually reports, so we can confirm this tracker sends
            // RPM (io36) — grep Render logs for "ENGINE-DIAG".
            if (fresh && liveMph(pos) < 3) {
              const ia = (pos && pos.attributes) || {};
              const rpmSeen = ia.io36 != null ? ia.io36 : ia.rpm;
              console.log(`[push] ENGINE-DIAG ${NAMED(d)} parked: rpm=${rpmSeen != null ? rpmSeen : 'n/a'} volts=${ia.power != null ? ia.power : 'n/a'} ignitionFlag=${ia.ignition}`);
            }

            // ---- RPM says the engine is running — the most DIRECT "car is on"
            // signal, and it works on cars the motion path misses (the C300 idles
            // before it rolls, and GPS speed lags). The instant an OBD reports RPM
            // after reading none/zero, the engine just cranked. Fires once per
            // start via the same shared guard, so it never doubles up with the
            // motion- or event-derived start.
            if (fresh) {
              const ra = (pos && pos.attributes) || {};
              const rpmVal = Number(ra.io36 != null ? ra.io36 : ra.rpm);
              const rpmKey = `rpmon:${d.id}`;
              if (!isNaN(rpmVal)) {
                if (rpmVal > 200) { // running (idle is ~600+); >200 = cranked
                  if (rec.sigs[rpmKey] === 'off') { // real off→on transition = a start
                    const lastStart = Number(rec.sigs[startGuard] || 0);
                    if (nowMs - lastStart > gapMs) {
                      rec.sigs[startGuard] = String(nowMs);
                      rec.sigs[tripKey] = 'on'; // keep the motion path in sync
                      toSend.push({ title: `🚗 ${NAMED(d)} started`, body: 'The engine was turned on.' });
                    }
                  }
                  rec.sigs[rpmKey] = 'on'; changed = true;
                } else if (rpmVal <= 100 && !moving && rec.sigs[rpmKey] !== 'off') { // clearly off (hysteresis) — but a MOVING car is never off, so a dropped/garbled OBD frame (RPM 0) mid-drive can't re-arm a phantom "started"
                  rec.sigs[rpmKey] = 'off'; changed = true;
                }
              }
            }

            // ---- ACCELEROMETER engine-on: works on any unit that streams the
            // 3-axis accelerometer (FMM00A and family, fields axisX/Y/Z or the
            // raw Teltonika IDs io17/18/19). Parked, the reading is constant; the
            // moment the engine cranks, vibration makes the vector jitter. A
            // change bigger than accelVibMg (default 12 mG) after being still =
            // engine started — caught before the car even rolls, so it beats the
            // GPS-motion path. Same shared guard, so no double "started".
            if (fresh) {
              const aa = (pos && pos.attributes) || {};
              const ax = Number(aa.axisX != null ? aa.axisX : aa.io17);
              const ay = Number(aa.axisY != null ? aa.axisY : aa.io18);
              const az = Number(aa.axisZ != null ? aa.axisZ : aa.io19);
              if (!isNaN(ax) && !isNaN(ay) && !isNaN(az)) {
                const accPrevKey = `accvibprev:${d.id}`, accOnKey = `accvibon:${d.id}`, accCntKey = `accvibcnt:${d.id}`;
                const prev = rec.sigs[accPrevKey] ? String(rec.sigs[accPrevKey]).split('|').map(Number) : null;
                if (prev && prev.length === 3) {
                  const dMag = Math.sqrt((ax - prev[0]) ** 2 + (ay - prev[1]) ** 2 + (az - prev[2]) ** 2);
                  const vibMg = Number((d.attributes || {}).accelVibMg) > 0 ? Number((d.attributes || {}).accelVibMg) : 12;
                  // Sustained vibration required: an engine shakes continuously, so
                  // it trips on consecutive reads; a bump / someone rocking the car
                  // is a single spike that never reaches the streak. Tunable via
                  // accelVibStreak (default 2 consecutive reads ≈ 30-60s).
                  const streakNeed = Number((d.attributes || {}).accelVibStreak) > 0 ? Number((d.attributes || {}).accelVibStreak) : 2;
                  if (dMag >= 6) console.log(`[push] ACCEL-VIB ${NAMED(d)}: Δ${Math.round(dMag)} mG (${prev.join(',')} → ${ax},${ay},${az}) | on≥${vibMg} streak≥${streakNeed}`);
                  if (dMag >= vibMg) {
                    const cnt = Number(rec.sigs[accCntKey] || 0) + 1;
                    rec.sigs[accCntKey] = String(cnt);
                    if (cnt >= streakNeed && rec.sigs[accOnKey] !== 'on') { // sustained = a real start
                      const lastStart = Number(rec.sigs[startGuard] || 0);
                      if (nowMs - lastStart > gapMs) {
                        rec.sigs[startGuard] = String(nowMs);
                        rec.sigs[tripKey] = 'on';
                        toSend.push({ title: `🚗 ${NAMED(d)} started`, body: 'The engine was turned on.' });
                      }
                      rec.sigs[accOnKey] = 'on';
                    }
                    changed = true;
                  } else if (dMag <= 2 && !moving) { // steady AND stopped → engine considered off. A moving car is never off (even a smooth-road lull), so cruising can't re-arm a phantom "started".
                    if (rec.sigs[accCntKey] && rec.sigs[accCntKey] !== '0') { rec.sigs[accCntKey] = '0'; changed = true; }
                    if (rec.sigs[accOnKey] !== 'off') { rec.sigs[accOnKey] = 'off'; changed = true; }
                  }
                }
                rec.sigs[accPrevKey] = `${ax}|${ay}|${az}`;
                changed = true;
              }
            }

            if (fresh) {
              const lastMove = Number(rec.sigs[lastMoveKey] || 0);
              if (moving) {
                const gap = lastMove ? nowMs - lastMove : Infinity;
                if (rec.sigs[tripKey] !== 'on' && gap >= gapMs) {
                  // A real trip start. Suppress if a start was already announced
                  // very recently (e.g. the ignitionOn event beat us to it).
                  const lastStart = Number(rec.sigs[startGuard] || 0);
                  if (nowMs - lastStart > gapMs) {
                    rec.sigs[startGuard] = String(nowMs);
                    // Same wording as the real ignitionOn event, so both paths
                    // read identically and the customer can't tell which fired.
                    toSend.push({ title: `🚗 ${NAMED(d)} started`, body: 'The engine was turned on.' });
                  }
                  rec.sigs[tripKey] = 'on';
                }
                rec.sigs[lastMoveKey] = String(nowMs);
                changed = true;
              } else if (rec.sigs[tripKey] === 'on') {
                // Stationary long enough → the trip has ended, so the next move
                // counts as a fresh start — BUT only if the engine is actually
                // OFF. A car idling in place (sitting with the engine running for
                // a while) has NOT ended its trip; ending it here made the next
                // roll fire a false "car turned on" even though it never shut off.
                const ra2 = (pos && pos.attributes) || {};
                const rpm2 = Number(ra2.io36 != null ? ra2.io36 : ra2.rpm);
                const engineRunning = (!isNaN(rpm2) && rpm2 > 200)
                  || ra2.ignition === true
                  || rec.sigs[`rpmon:${d.id}`] === 'on'
                  || rec.sigs[`accvibon:${d.id}`] === 'on';
                if (lastMove && nowMs - lastMove >= gapMs && !engineRunning) {
                  rec.sigs[tripKey] = 'off'; changed = true;
                }
              }
            }
          }

          // ---- jumpy / aggressive acceleration (GPS-derived) ----
          //
          // ON by default (opt out per car with accelFromGps=false). This is the
          // same speed-delta method that cleanly separates acceleration from
          // braking and reliably delivered the hard-braking alert in testing.
          // Threshold lowered to +15 mph after a real launch logged +17.
          //
          // Works on ANY tracker that reports speed — no accelerometer needed.
          //
          // We can't measure instantaneous g-force from GPS that only updates
          // every 15-30s: a violent 4-second launch gets averaged over the whole
          // reporting gap and looks gentle. So instead of a per-second RATE (the
          // old approach, which never fired because the math is diluted at coarse
          // sampling), we watch the SPEED JUMP between two consecutive reports.
          // Gaining a lot of speed since the last check IS hard acceleration,
          // however the tracker happened to sample it.
          //
          // Default: +18 mph gained between two fixes no more than 30s apart.
          // Tunable per car via accelJumpMph and accelWindowSec. A fine-sampling
          // device that reports every few seconds will still trip it on a real
          // launch; a coarse one catches the whole burst in one interval.
          {
            const nowMs = Date.now();
            const curMph = liveMph(pos); // fresh-gated and unit-correct
            const curFix = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const prevKey = `accelprev:${d.id}`;
            const firedKey = `accel:${d.id}`;
            const jumpMph = Number((d.attributes || {}).accelJumpMph) > 0
              ? Number((d.attributes || {}).accelJumpMph) : 18;
            // SHORT window on purpose: only two fixes close in time count, so a
            // real hard launch (big speed jump in a few seconds) fires but a
            // gentle green-light pull-away spread over many seconds does not.
            const windowSec = Number((d.attributes || {}).accelWindowSec) > 0
              ? Number((d.attributes || {}).accelWindowSec) : 8;

            if (curFix && nowMs - curFix <= FRESH_FIX_MS) {
              const prev = rec.sigs[prevKey] ? String(rec.sigs[prevKey]).split('|') : null;
              const prevMph = prev ? Number(prev[0]) : null;
              const prevFix = prev ? Number(prev[1]) : null;

              if (prevMph != null && prevFix && curFix > prevFix) {
                const dSec = (curFix - prevFix) / 1000;
                const dMph = curMph - prevMph;

                // DIAGNOSTIC — every speed-increasing sample, so the thresholds
                // can be tuned to what these trackers actually report.
                if (dMph >= 6) {
                  console.log(`[push] ACCEL-DIAG ${NAMED(d)}: +${Math.round(dMph)} mph in ${dSec.toFixed(0)}s `
                    + `(${prevMph}→${curMph}) | needs +${jumpMph} within ${windowSec}s`);
                }

                // OFF by default: the accelerometer's Green Driving event
                // (io253/io254) is the accurate source and the app reads it
                // directly, so this GPS-math estimate is only a fallback for
                // trackers WITHOUT Green Driving. It was the cause of the
                // city-driving false alarms, so it stays off unless a car opts
                // in with accelFromGps:true.
                const gpsAccelOn = ((d.attributes || {}).accelFromGps === true);
                if (gpsAccelOn && dSec <= windowSec && dMph >= jumpMph && curMph >= 20) {
                  // One alert per burst: hold until the car stops gaining, then
                  // re-arm so the next launch fires fresh.
                  if (rec.sigs[firedKey] !== 'on') {
                    rec.sigs[firedKey] = 'on';
                    toSend.push({
                      title: `🏎️ ${NAMED(d)} — hard acceleration`,
                      body: `Sped up ${Math.round(dMph)} mph to ${curMph} mph.`,
                    });
                  }
                } else if (dMph <= 2 && rec.sigs[firedKey] === 'on') {
                  rec.sigs[firedKey] = 'off'; changed = true; // no longer gaining → re-arm
                }
              }
              // Remember this sample for the next poll.
              rec.sigs[prevKey] = `${curMph}|${curFix}`;
              changed = true;
            }
          }

          // ---- hard / sudden braking ----
          //
          // The mirror of hard acceleration: a big DROP in speed between two
          // consecutive fixes is a hard brake, on any tracker that reports speed
          // (no accelerometer needed). Same coarse-sampling reasoning — we watch
          // the speed CHANGE between reports, not an instantaneous g-force GPS
          // can't measure.
          //
          // Default: 18 mph shed between two fixes ≤30s apart, and the car must
          // have been moving to begin with (prev ≥ 20 mph) so easing to a normal
          // stop doesn't count. Tunable per car via brakeDropMph / brakeWindowSec.
          {
            const nowMs = Date.now();
            const curMph = liveMph(pos);
            const curFix = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const prevKey = `brakeprev:${d.id}`;
            const firedKey = `brake:${d.id}`;
            const dropMph = Number((d.attributes || {}).brakeDropMph) > 0
              ? Number((d.attributes || {}).brakeDropMph) : 20;
            // SHORT window (like acceleration): only a fast drop over a couple of
            // seconds counts, so slamming the brakes fires but easing to a normal
            // stop over several seconds does not.
            const windowSec = Number((d.attributes || {}).brakeWindowSec) > 0
              ? Number((d.attributes || {}).brakeWindowSec) : 8;

            if (curFix && nowMs - curFix <= FRESH_FIX_MS) {
              const prev = rec.sigs[prevKey] ? String(rec.sigs[prevKey]).split('|') : null;
              const prevMph = prev ? Number(prev[0]) : null;
              const prevFix = prev ? Number(prev[1]) : null;

              if (prevMph != null && prevFix && curFix > prevFix) {
                const dSec = (curFix - prevFix) / 1000;
                const drop = prevMph - curMph; // positive = slowing down

                if (drop >= 6) {
                  console.log(`[push] BRAKE-DIAG ${NAMED(d)}: -${Math.round(drop)} mph in ${dSec.toFixed(0)}s `
                    + `(${prevMph}→${curMph}) | needs -${dropMph} within ${windowSec}s from ≥20mph`);
                }

                // OFF by default: the accelerometer's Green Driving brake event
                // (io253=2) is the accurate source the app reads directly. This
                // GPS-math estimate is only a fallback for trackers without
                // Green Driving, and was the source of the false city brakes, so
                // it stays off unless a car opts in with brakeFromGps:true.
                const gpsBrakeOn = ((d.attributes || {}).brakeFromGps === true);
                if (gpsBrakeOn && dSec <= windowSec && drop >= dropMph && prevMph >= 20) {
                  // One alert per brake event: hold until speed steadies, then
                  // re-arm so the next hard brake fires fresh.
                  if (rec.sigs[firedKey] !== 'on') {
                    rec.sigs[firedKey] = 'on';
                    toSend.push({
                      title: `🛑 ${NAMED(d)} — hard braking`,
                      body: `Slowed ${Math.round(drop)} mph, from ${prevMph} to ${curMph} mph.`,
                    });
                  }
                } else if (drop <= 2 && rec.sigs[firedKey] === 'on') {
                  rec.sigs[firedKey] = 'off'; changed = true; // no longer dropping → re-arm
                }
              }
              rec.sigs[prevKey] = `${curMph}|${curFix}`;
              changed = true;
            }
          }

          // ---- native accelerometer events (Teltonika "Green Driving" + crash) ----
          //
          // Devices with a real accelerometer (FMM00A and family) detect harsh
          // accel/brake/cornering and crashes far more precisely than GPS speed
          // deltas. When the "Green Driving" and "Crash" scenarios are enabled on
          // the device, Traccar usually decodes them as an `alarm`/event (already
          // handled in eventToPush). But some firmware/decoder combos surface them
          // as raw AVL IDs on the position instead:
          //   io253 = green-driving type (1=accel, 2=brake, 3=cornering)
          //   io247 = crash detection
          // We map those here too, so the accelerometer is used no matter how the
          // event arrives. Each distinct reading fires once (keyed to its fix).
          {
            const ga = (pos && pos.attributes) || {};
            const fixSig = pos && pos.fixTime ? new Date(pos.fixTime).getTime() : 0;
            const gType = Number(ga.greenDrivingType != null ? ga.greenDrivingType : ga.io253);
            const crash = ga.crash != null ? ga.crash : ga.io247;
            // Green Driving VALUE (io254) is the intensity ×100 (m/s²). Show it as
            // g when present, plus the current speed, as a reference.
            const gVal = Number(ga.greenDrivingValue != null ? ga.greenDrivingValue : ga.io254);
            const gForce = !isNaN(gVal) && gVal > 0 ? ` (${(gVal / 100 / 9.81).toFixed(1)}g)` : '';
            const gMph = liveMph(pos);
            const eco = { 1: { key: 'harsh-accel', title: `🏎️ ${NAMED(d)} — hard acceleration`, body: `The accelerometer detected a hard acceleration${gForce} at ${gMph} mph.` },
                          2: { key: 'harsh-brake', title: `🛑 ${NAMED(d)} — hard braking`, body: `The accelerometer detected a hard brake${gForce} at ${gMph} mph.` },
                          3: { key: 'harsh-corner', title: `↩️ ${NAMED(d)} — hard cornering`, body: `The accelerometer detected a sharp turn${gForce} at ${gMph} mph.` } };
            if (!isNaN(gType) && eco[gType] && fixSig) {
              console.log(`[push] GREEN-DRIVING ${NAMED(d)}: type ${gType} (${gType === 1 ? 'accel' : gType === 2 ? 'brake' : 'corner'})${gForce} @ ${gMph}mph`);
              const sig = `green:${d.id}:${gType}:${fixSig}`;
              if (!rec.sigs[sig]) { rec.sigs[sig] = 1; toSend.push(eco[gType]); }
            }
            if (crash && Number(crash) > 0 && fixSig) {
              const sig = `crash:${d.id}:${fixSig}`;
              if (!rec.sigs[sig]) { rec.sigs[sig] = 1; toSend.push({ key: 'crash', title: `🚨 ${NAMED(d)} — possible crash`, body: 'The accelerometer reported a crash/impact. Tap to see where.' }); }
            }
            // DIAGNOSTIC — if this device carries any accelerometer-ish field we do
            // NOT recognise, dump the keys once so we can map its exact format.
            const accelKeys = Object.keys(ga).filter((k) => /green|accel|brak|corner|gforce|g_force|axis|shock|impact|crash|io2(4[0-9]|5[0-9])/i.test(k));
            if (accelKeys.length && isNaN(gType) && !crash) {
              console.log(`[push] ACCEL-FIELD-DIAG ${NAMED(d)}: possible accelerometer fields = ${accelKeys.map((k) => `${k}=${ga[k]}`).join(', ')}`);
            }
          }

          // ---- refuelled: report the level it filled to ----
          //
          // Fuel readings are noisy. A float sender swings with slope, braking
          // and a sloshing tank, so a naive "level went up" fires constantly on
          // a hilly road. Two guards make it trustworthy:
          //   1. the jump must exceed a real threshold (default 8 points), and
          //   2. the level must SETTLE — we wait for a second reading that
          //      confirms it, so we report the finished fill, not a reading
          //      taken mid-pump.
          // That second guard is also why the alert says the final level: it
          // has one, whereas an alert fired the instant the level moved would
          // be quoting a number still climbing.
          {
            const pa = (pos && pos.attributes) || {};
            const rawFuel = pa.io48 != null ? Number(pa.io48) : (pa.fuel != null ? Number(pa.fuel) : null);

            // A fuel sender only reports a trustworthy level while the ECU is
            // powered and settled. A reading taken with the engine OFF — or on the
            // first beat as the tracker wakes — is garbage: it comes back low or
            // zero, becomes the baseline, and then the next NORMAL reading looks
            // like a big "fill". That's exactly the fake refuel we kept seeing
            // (Matt especially). So we ONLY sample fuel while the engine is running,
            // using the same engine-on signals the rest of the poller uses. That
            // keeps baselines solid (last real driving level) and the post-fill
            // reading solid (engine on as you pull away), while dropping the
            // off/at-wake garbage that caused the false alerts.
            const fRpm = Number(pa.io36 != null ? pa.io36 : pa.rpm);
            const engineOnNow = (!isNaN(fRpm) && fRpm > 200) || pa.ignition === true
              || rec.sigs[`rpmon:${d.id}`] === 'on' || rec.sigs[`accvibon:${d.id}`] === 'on'
              || rec.sigs[`tripon:${d.id}`] === 'on';

            // Only a plausible reading counts (0/negative/over-100 = sensor junk).
            const fuelNow = (rawFuel != null && Number.isFinite(rawFuel) && rawFuel > 0 && rawFuel <= 100)
              ? rawFuel : null;

            // per-car off switch for a hopelessly noisy sender
            const refuelOff = (d.attributes || {}).refuelAlerts === false;
            if (fuelNow != null && engineOnNow && !refuelOff) {
              const nowMs2 = Date.now();
              // Real fills are big (a quarter tank or more). Small moves are noise,
              // so the bar is 20 points by default — lower it per car if needed.
              const minJump = Number((d.attributes || {}).refuelMinPct) > 0
                ? Number((d.attributes || {}).refuelMinPct) : 20;
              const lastKey = `fuel:${d.id}`;
              const pendKey = `fuelpend:${d.id}`;
              const histKey = `fuelhist:${d.id}`;
              const doneKey = `fueldone:${d.id}`;
              const prev = rec.sigs[lastKey] != null ? Number(rec.sigs[lastKey]) : null;
              const pending = rec.sigs[pendKey] != null ? Number(rec.sigs[pendKey]) : null;

              // Rolling window of recent engine-on readings (value + time). The
              // KEY discriminator between a real fill and a garbage sender: a real
              // tank sits STEADY for a while and then jumps once at the pump. A bad
              // sender (Matt) bounces 20-40 points every reading and never settles.
              // So we only trust a rise when the readings BEFORE it were stable.
              let hist = [];
              try { hist = JSON.parse(rec.sigs[histKey] || '[]'); } catch { hist = []; }
              hist.push({ v: fuelNow, t: nowMs2 });
              hist = hist.filter((h) => nowMs2 - h.t <= 30 * 60000).slice(-8);
              rec.sigs[histKey] = JSON.stringify(hist); changed = true;

              const prior = hist.slice(0, -1);                    // readings before this one
              const pv = prior.map((h) => h.v);
              const spread = pv.length ? Math.max(...pv) - Math.min(...pv) : 999;
              const stable = pv.length >= 3 && spread <= 8 && (nowMs2 - prior[0].t) >= 3 * 60000;
              const fromLevel = pv.length ? pv.slice().sort((a, b) => a - b)[Math.floor(pv.length / 2)] : prev; // steady pre-fill level (median)

              // Cooldown: a vehicle physically can't refuel twice in a few hours,
              // so at most one refuel alert per 4h. This alone caps any residual noise.
              const lastDone = Number(rec.sigs[doneKey] || 0);
              const cooled = !lastDone || (nowMs2 - lastDone) >= 4 * 60 * 60000;

              if (pending != null) {
                // We saw a stable-then-jump last poll — confirm only if it HELD.
                if (fuelNow >= pending - 5) {
                  const from = rec.sigs[`fuelfrom:${d.id}`];
                  toSend.push({
                    title: `⛽ ${NAMED(d)} — refuelled`,
                    body: from != null
                      ? `Filled from ${Math.round(Number(from))}% to ${Math.round(fuelNow)}%.`
                      : `Fuel now at ${Math.round(fuelNow)}%.`,
                  });
                  rec.sigs[lastKey] = String(fuelNow);   // confirmed → raise baseline
                  rec.sigs[doneKey] = String(nowMs2);    // start the cooldown
                  rec.sigs[histKey] = JSON.stringify([{ v: fuelNow, t: nowMs2 }]); // reset window
                }
                delete rec.sigs[pendKey];
                delete rec.sigs[`fuelfrom:${d.id}`];
                changed = true;
              } else if (stable && cooled && fromLevel != null && fuelNow - fromLevel >= minJump) {
                // Candidate fill — steady beforehand, big jump, cooldown clear.
                // Hold one more reading before telling anyone so a single sample
                // can't fire and the number we report is where it settled.
                rec.sigs[pendKey] = String(fuelNow);
                rec.sigs[`fuelfrom:${d.id}`] = String(fromLevel);
                changed = true;
              }

              // Track the baseline: move it DOWN freely (burning fuel), never up
              // except on a confirmed fill above — otherwise slow upward noise
              // would quietly raise the bar and mask a real fill.
              if (prev == null || fuelNow < prev) {
                rec.sigs[lastKey] = String(fuelNow);
                changed = true;
              }
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
      // Name the subsystem, so a database problem doesn't read like a Traccar
      // problem (or vice versa) and send us hunting in the wrong place.
      const where = /ENOTFOUND|ECONNREFUSED|password|role .* does not exist|database .* does not exist|timeout expired/i.test(e.message)
        ? 'DATABASE' : 'TRACCAR/logic';
      console.error(`[push] poll error [${where}]:`, e.message);
    }
    lastCheck = now;
    await saveLastCheck(now);
    maybeWeeklyDigest().catch(() => {}); // Sunday-night summary, once per week
  }

  if (enabled) {
    // 15s so the repeating speeding alert can keep reasonable pace. Overridable
    // via PUSH_POLL_SEC if load ever becomes a concern. Going much lower mostly
    // adds Traccar/APNs load without more alerts — the tracker's own report
    // rate is the real floor.
    const pollSec = Number(env.PUSH_POLL_SEC) > 0 ? Number(env.PUSH_POLL_SEC) : 15;
    setInterval(() => { poll().catch(() => {}); }, pollSec * 1000);
    console.log(`[push] APNs enabled v25 (${USE_DB ? 'Postgres-backed state' : 'file/Traccar fallback'}; repeating speeding alert) — polling every ${pollSec}s.`);
  }

  return { enabled, sendToTokens };
}

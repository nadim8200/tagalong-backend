// ---------------------------------------------------------------
// TruckMate connection — config, probe, reads, and the connector ingest.
//
// Self-contained: the Trimble/ART adapter that was in ./tms/truckmate.js is
// inlined below, so this file has NO local imports and drops straight into the
// backend root. The credential lives server-side, is never returned to the
// browser, and is verified against the live endpoint before it replaces a
// working config.
// ---------------------------------------------------------------

// ===============================================================
// Trimble TruckMate adapter (inlined). ALL PATHS/FIELDS ARE GUESSES until a
// real payload corrects them — every `??` chain is an admission of that.
// ===============================================================
const TRIMBLE_ID = 'https://id.trimble.com/oauth/token';
const tokens = new Map(); // cacheKey -> { token, expiresAt }

function cacheKey(config) {
  return `${config.mode || 'trimble-id'}:${config.clientId || config.username}:${config.baseUrl}`;
}

async function trimbleIdToken(config) {
  const { clientId, clientSecret, clientName } = config;
  if (!clientId || !clientSecret) throw new Error('TruckMate: clientId and clientSecret are required for Trimble ID auth.');
  if (!clientName) throw new Error('TruckMate: clientName is required — Trimble ID uses the application name as the OAuth scope.');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: clientName });
  const r = await fetch(TRIMBLE_ID, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    let detail = ''; try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Trimble ID ${r.status} — ${detail}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error('Trimble ID returned no access_token.');
  return { token: j.access_token, expiresIn: Number(j.expires_in) || 3600 };
}

async function accessToken(config) {
  const mode = config.mode || 'trimble-id';
  if (mode === 'basic') {
    if (!config.username || !config.password) throw new Error('TruckMate: username and password are required for basic auth.');
    return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  const key = cacheKey(config);
  const hit = tokens.get(key);
  if (hit && hit.expiresAt - 60000 > Date.now()) return `Bearer ${hit.token}`;
  const { token, expiresIn } = await trimbleIdToken(config);
  tokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return `Bearer ${token}`;
}

async function call(config, path, init = {}) {
  if (!config || !config.baseUrl) throw new Error('TruckMate: baseUrl (the ART Server address) is not configured.');
  const auth = await accessToken(config);
  const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (r.status === 401) { tokens.delete(cacheKey(config)); throw new Error('TruckMate 401 — credentials rejected or token revoked.'); }
  if (!r.ok) { let detail = ''; try { detail = (await r.text()).slice(0, 400); } catch { /* ignore */ } throw new Error(`TruckMate ${r.status} on ${path} — ${detail}`); }
  return r.json();
}

async function probe(config) {
  const out = { auth: null, endpoint: null, sample: null };
  try { await accessToken(config); out.auth = { ok: true }; }
  catch (e) { out.auth = { ok: false, error: String(e.message || e) }; return out; }
  const candidates = ['/trips', '/api/trips', '/tm/trips', '/freightbills', '/customers'];
  for (const p of candidates) {
    try {
      const j = await call(config, `${p}?limit=1`);
      out.endpoint = { ok: true, path: p }; out.sample = j; return out;
    } catch (e) {
      const msg = String(e.message || e);
      if (/\b401\b/.test(msg)) { out.auth = { ok: false, error: msg, at: p }; out.endpoint = { ok: true, path: p, note: 'Endpoint responded — it rejected the credential, so ART Server is reachable.' }; return out; }
      if (/\b403\b/.test(msg)) { out.auth = { ok: true, forbidden: true, error: msg, at: p }; out.endpoint = { ok: true, path: p, note: 'Authenticated, but this user is not permitted this resource.' }; return out; }
      out.endpoint = { ok: false, tried: p, error: msg };
    }
  }
  return out;
}

async function listTrips(config, { since, until, limit = 100 } = {}) {
  const q = new URLSearchParams();
  if (since) q.set('startDate', since);
  if (until) q.set('endDate', until);
  q.set('limit', String(limit));
  const j = await call(config, `/trips?${q}`);
  const rows = Array.isArray(j) ? j : (j.data || j.trips || j.items || []);
  return rows.map(normalizeTrip);
}

async function listCustomers(config, { limit = 500 } = {}) {
  const j = await call(config, `/customers?limit=${limit}`);
  const rows = Array.isArray(j) ? j : (j.data || j.clients || j.items || []);
  return rows.map(normalizeCustomer);
}

function normalizeTrip(t) {
  if (!t) return null;
  const stops = (t.stops || t.legs || t.details || []).map(normalizeStop);
  return {
    source: 'truckmate',
    reference: String(t.tripNumber ?? t.trip_number ?? t.id ?? ''),
    status: t.status ?? t.tripStatus ?? null,
    driverCode: t.driverId ?? t.driver ?? null,
    truck: t.powerUnit ?? t.tractor ?? t.unit ?? null,
    trailer: t.trailer ?? null,
    startedAt: t.startDate ?? t.actualStart ?? null,
    stops, stopCount: stops.length, raw: t,
  };
}

function normalizeStop(s, i) {
  if (!s) return null;
  return {
    sequence: s.sequence ?? s.stopNumber ?? i + 1,
    type: s.stopType ?? s.type ?? null,
    customerCode: s.customerId ?? s.clientId ?? null,
    customer: s.customerName ?? s.clientName ?? s.name ?? null,
    address: s.address ?? s.address1 ?? null,
    city: s.city ?? null,
    state: s.province ?? s.state ?? null,
    zip: s.postalCode ?? s.zip ?? null,
    appointmentAt: s.appointmentDate ?? s.apptDate ?? null,
    arrivedAt: s.actualArrival ?? null,
    departedAt: s.actualDeparture ?? null,
    notes: s.instructions ?? s.comments ?? s.notes ?? null,
    bills: (s.freightBills || s.bills || []).map((b) => String(b.billNumber ?? b.id ?? b)),
    raw: s,
  };
}

function normalizeCustomer(c) {
  if (!c) return null;
  return {
    source: 'truckmate',
    code: String(c.clientId ?? c.customerId ?? c.id ?? ''),
    name: c.name ?? c.clientName ?? null,
    address: c.address1 ?? c.address ?? null,
    city: c.city ?? null,
    state: c.province ?? c.state ?? null,
    zip: c.postalCode ?? c.zip ?? null,
    phone: c.phone ?? c.businessPhone ?? null,
    raw: c,
  };
}

// ===============================================================
// Routes
// ===============================================================
export function initTruckMate(app, { requireAuth, db }) {
  const cfgKey = 'taTruckMate';

  async function configFor(owner) {
    if (!db || !db.enabled) return null;
    const all = await db.get(cfgKey, {});
    return all[owner] || null;
  }
  async function saveConfig(owner, cfg) {
    const all = await db.get(cfgKey, {});
    all[owner] = cfg;
    await db.set(cfgKey, all);
  }
  function maskUser(u) { const s = String(u); return s.length <= 2 ? '••' : `${s[0]}${'•'.repeat(Math.max(1, s.length - 2))}${s[s.length - 1]}`; }
  function safe(cfg) {
    if (!cfg) return { connected: false };
    return {
      connected: true, mode: cfg.mode || 'trimble-id', baseUrl: cfg.baseUrl || null,
      username: cfg.username ? maskUser(cfg.username) : null, clientName: cfg.clientName || null,
      hasSecret: Boolean(cfg.clientSecret || cfg.password), verifiedAt: cfg.verifiedAt || null, verifiedPath: cfg.verifiedPath || null,
    };
  }

  app.put('/truckmate/config', requireAuth, async (req, res) => {
    try {
      const owner = req.auth.owner;
      const b = req.body || {};
      const mode = b.mode === 'basic' ? 'basic' : 'trimble-id';
      const next = { mode, baseUrl: String(b.baseUrl || '').trim() };
      if (!next.baseUrl) return res.status(400).json({ error: 'baseUrl is required — the address of the ART Server hosting the TruckMate REST API.' });
      if (mode === 'basic') {
        if (!b.username || !b.password) return res.status(400).json({ error: 'username and password are required for basic auth.' });
        next.username = String(b.username); next.password = String(b.password);
      } else {
        if (!b.clientId || !b.clientSecret || !b.clientName) return res.status(400).json({ error: 'clientId, clientSecret and clientName are required for Trimble ID auth.' });
        next.clientId = String(b.clientId); next.clientSecret = String(b.clientSecret); next.clientName = String(b.clientName);
      }
      const result = await probe(next);
      if (!result.auth || !result.auth.ok) {
        return res.status(400).json({ error: 'Credentials were rejected.', stage: 'auth', detail: result.auth && result.auth.error,
          hint: mode === 'basic' ? 'ART Server has to grant this user access to the web service — a TruckMate-side setting.' : 'Check that scope is the application CLIENT NAME and the token endpoint is /oauth/token.' });
      }
      if (result.auth.forbidden) {
        return res.status(400).json({ error: 'The credential is valid, but this user is not permitted to read the API.', stage: 'permissions', detail: result.auth.error,
          hint: 'Ask whoever administers TruckMate to grant this user access to the REST resources.', authOk: true });
      }
      if (!result.endpoint || !result.endpoint.ok) {
        return res.status(400).json({ error: 'Authenticated, but no TruckMate API responded at that address.', stage: 'endpoint', detail: result.endpoint && result.endpoint.error,
          hint: 'Either ART Server is not deployed, or it is under a path prefix we have not been told.', authOk: true });
      }
      next.verifiedAt = new Date().toISOString(); next.verifiedPath = result.endpoint.path;
      await saveConfig(owner, next);
      res.json({ ok: true, config: safe(next), discovered: { path: result.endpoint.path, topLevelKeys: result.sample && typeof result.sample === 'object' ? Object.keys(result.sample).slice(0, 25) : null, sample: result.sample } });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/truckmate/config', requireAuth, async (req, res) => {
    try { res.json(safe(await configFor(req.auth.owner))); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/truckmate/probe', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const result = await probe(cfg);
      res.json({ auth: result.auth, endpoint: result.endpoint, sample: result.sample });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/truckmate/trips', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const trips = await listTrips(cfg, { since: req.query.since, until: req.query.until, limit: Math.min(Number(req.query.limit) || 100, 500) });
      res.json({ trips, count: trips.length, unverifiedMapping: true });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  app.get('/truckmate/customers', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const customers = await listCustomers(cfg, { limit: Math.min(Number(req.query.limit) || 500, 2000) });
      res.json({ customers, count: customers.length, unverifiedMapping: true });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  // ---- INGEST — where the on-premise connector delivers (the only route it uses) ----
  const INGEST_KEY = process.env.TRUCKMATE_INGEST_KEY || '';
  app.post('/truckmate/ingest', async (req, res) => {
    try {
      if (!INGEST_KEY) return res.status(503).json({ error: 'Ingest is not enabled — TRUCKMATE_INGEST_KEY is not set.' });
      const key = req.get('X-Connector-Key') || '';
      if (key.length !== INGEST_KEY.length || key !== INGEST_KEY) return res.status(401).json({ error: 'Bad connector key.' });

      const body = req.body || {};
      const site = String(body.site || 'unknown');
      // v2 connector sends { trips, rosters }; older shape used { data }. Keep whatever came.
      const payload = body.data || { trips: body.trips || [], rosters: body.rosters || null, baseline: body.baseline };

      const key2 = `taTruckMateIngest:${site}`;
      const prior = (db && db.enabled) ? await db.get(key2, { deliveries: [] }) : { deliveries: [] };
      const deliveries = [
        { receivedAt: new Date().toISOString(), collectedAt: body.collectedAt || null, connectorVersion: body.connectorVersion || null,
          tripCount: Array.isArray(body.trips) ? body.trips.length : null, paths: Object.keys(payload), errors: body.errors || [], data: payload },
        ...(prior.deliveries || []).slice(0, 4),
      ];
      if (db && db.enabled) await db.set(key2, { deliveries });

      // ---- delivered-trip transitions ----
      // The connector flags a trip _event:'delivered' the one time it flips from
      // live to DELIVERED, then drops it. We capture those here: record each into
      // a delivered queue (deduped), so the dispatcher / AI can act on it and send
      // the customer/dispatcher communication.
      const deliveredNow = await recordDelivered(site, Array.isArray(payload.trips) ? payload.trips : []);

      res.json({
        ok: true,
        receivedTrips: Array.isArray(body.trips) ? body.trips.length : 0,
        hasRosters: Boolean(body.rosters),
        delivered: deliveredNow.length,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Pull the freight-bill (B) numbers off an enriched trip, whatever shape it is.
  function billNumbersOf(trip) {
    const fb = (trip && (trip.freightBills || trip.orders)) || [];
    const arr = Array.isArray(fb) ? fb : (fb && Array.isArray(fb.orders) ? fb.orders : []);
    return arr.map((o) => o && (o.billNumber || o.billNo || o.bill)).filter(Boolean);
  }
  // Persist the trips that just flipped to delivered into a queue the dispatcher/
  // AI reads. Deduped by trip number so a resend can't double-post. NOTE: the
  // actual notification CHANNEL (SMS / call / dispatcher ping) is intentionally a
  // hook below — wire it to notify.js / RingCentral when you decide the channel.
  async function recordDelivered(site, trips) {
    const delivered = (trips || []).filter((t) => t && t._event === 'delivered');
    if (!delivered.length || !(db && db.enabled)) return delivered;
    const qKey = `taTruckMateDelivered:${site}`;
    const store = await db.get(qKey, { items: [], seen: {} });
    store.items = store.items || []; store.seen = store.seen || {};
    const added = [];
    for (const t of delivered) {
      const trip = t.trip || t;
      const id = String(t._id || trip.tripNumber || '');
      if (!id || store.seen[id]) continue; // already recorded this delivery
      const item = {
        tripNumber: trip.tripNumber || id,
        status: trip.status || 'DELVD',
        billNumbers: billNumbersOf(t),
        destinationZone: trip.destZoneDesc || trip.destinationZone || '',
        driver: trip.driver || '',
        deliveredAt: new Date().toISOString(),
        acknowledged: false,
      };
      store.items.unshift(item);
      store.seen[id] = Date.now();
      added.push(item);
      console.log(`[truckmate] DELIVERED trip ${item.tripNumber} — bills [${item.billNumbers.join(', ')}] → queued for dispatcher notify`);
      // HOOK: send the delivery communication here once the channel is decided,
      // e.g. await notifyDelivered(item);  (SMS/call via notify.js / RingCentral)
    }
    // keep the queue and the dedup map from growing forever
    store.items = store.items.slice(0, 500);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(store.seen)) { if (store.seen[k] < cutoff) delete store.seen[k]; }
    await db.set(qKey, store);
    return added;
  }

  // Dispatcher / AI reads the delivered queue (newest first). ?unacked=1 for only
  // the ones not yet handled.
  app.get('/truckmate/delivered', requireAuth, async (req, res) => {
    try {
      const site = String(req.query.site || 'florida-beauty');
      const store = (db && db.enabled) ? await db.get(`taTruckMateDelivered:${site}`, { items: [] }) : { items: [] };
      let items = store.items || [];
      if (String(req.query.unacked || '') === '1') items = items.filter((x) => !x.acknowledged);
      res.json({ site, count: items.length, items });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Mark a delivered trip handled (so it drops out of the unacked list) once the
  // dispatcher/AI has sent the communication and closed it.
  app.post('/truckmate/delivered/ack', requireAuth, async (req, res) => {
    try {
      const site = String((req.body && req.body.site) || 'florida-beauty');
      const tripNumber = String((req.body && req.body.tripNumber) || '');
      if (!tripNumber) return res.status(400).json({ error: 'tripNumber required' });
      if (!(db && db.enabled)) return res.status(503).json({ error: 'db not enabled' });
      const qKey = `taTruckMateDelivered:${site}`;
      const store = await db.get(qKey, { items: [], seen: {} });
      let hit = false;
      (store.items || []).forEach((x) => { if (String(x.tripNumber) === tripNumber) { x.acknowledged = true; hit = true; } });
      if (hit) await db.set(qKey, store);
      res.json({ ok: hit });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/truckmate/ingest/latest', requireAuth, async (req, res) => {
    try {
      const site = String(req.query.site || 'florida-beauty');
      const store = (db && db.enabled) ? await db.get(`taTruckMateIngest:${site}`, { deliveries: [] }) : { deliveries: [] };
      const latest = (store.deliveries || [])[0] || null;
      if (!latest) return res.json({ site, latest: null, note: 'No delivery received yet.' });
      res.json({ site, receivedAt: latest.receivedAt, collectedAt: latest.collectedAt, tripCount: latest.tripCount, paths: latest.paths, errors: latest.errors,
        ageMinutes: Math.round((Date.now() - Date.parse(latest.receivedAt)) / 60000), data: latest.data });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}

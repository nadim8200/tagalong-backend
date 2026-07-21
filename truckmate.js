// ---------------------------------------------------------------
// TruckMate connection — config, probe, and reads.
//
// Same discipline as Samsara and RingCentral: the credential lives server-side
// in the database, is never returned to the browser, and is verified against
// the live endpoint BEFORE it replaces a working config. A credential that
// only reveals itself as broken when a dispatcher needs a trip is worse than
// one that fails at save time.
//
// The adapter (tms/truckmate.js) holds the protocol. This holds the routes,
// the per-company storage, and the diagnosis.
// ---------------------------------------------------------------

import * as tm from './tms/truckmate.js';

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

  // Never leak the secret back out. The browser gets to know THAT a connection
  // exists and how it's authenticating — not what the password is.
  function safe(cfg) {
    if (!cfg) return { connected: false };
    return {
      connected: true,
      mode: cfg.mode || 'trimble-id',
      baseUrl: cfg.baseUrl || null,
      username: cfg.username ? maskUser(cfg.username) : null,
      clientName: cfg.clientName || null,
      hasSecret: Boolean(cfg.clientSecret || cfg.password),
      verifiedAt: cfg.verifiedAt || null,
      verifiedPath: cfg.verifiedPath || null,
    };
  }

  function maskUser(u) {
    const s = String(u);
    return s.length <= 2 ? '••' : `${s[0]}${'•'.repeat(Math.max(1, s.length - 2))}${s[s.length - 1]}`;
  }

  // ---- save + verify ----
  //
  // Verification is not optional here. TruckMate has two independent failure
  // modes that look identical from the outside — a credential ART won't accept,
  // and an ART Server that isn't deployed or reachable. Telling them apart at
  // save time decides WHO gets the phone call: Florida Beauty's IT, or Trimble.
  app.put('/truckmate/config', requireAuth, async (req, res) => {
    try {
      const owner = req.auth.owner;
      const b = req.body || {};
      const mode = b.mode === 'basic' ? 'basic' : 'trimble-id';

      const next = { mode, baseUrl: String(b.baseUrl || '').trim() };
      if (!next.baseUrl) return res.status(400).json({ error: 'baseUrl is required — the address of the ART Server hosting the TruckMate REST API.' });

      if (mode === 'basic') {
        if (!b.username || !b.password) return res.status(400).json({ error: 'username and password are required for basic auth.' });
        next.username = String(b.username);
        next.password = String(b.password);
      } else {
        if (!b.clientId || !b.clientSecret || !b.clientName) {
          return res.status(400).json({ error: 'clientId, clientSecret and clientName are required for Trimble ID auth. clientName is the application name — Trimble uses it as the OAuth scope.' });
        }
        next.clientId = String(b.clientId);
        next.clientSecret = String(b.clientSecret);
        next.clientName = String(b.clientName);
      }

      const result = await tm.probe(next);

      if (!result.auth || !result.auth.ok) {
        return res.status(400).json({
          error: 'Credentials were rejected.',
          stage: 'auth',
          detail: result.auth && result.auth.error,
          // Point at the likely cause rather than leaving them to guess.
          hint: mode === 'basic'
            ? 'A TruckMate client login is not automatically a REST API login. ART Server has to grant this user access to the web service — that is a setting on the TruckMate side.'
            : 'Check that scope is set to the application CLIENT NAME, and that the token endpoint is /oauth/token (not /token).',
        });
      }

      // Valid credential, insufficient rights. Distinct from both failures
      // above and fixed by a different person — TruckMate security, not a
      // password reset and not Trimble.
      if (result.auth.forbidden) {
        return res.status(400).json({
          error: 'The credential is valid, but this user is not permitted to read the API.',
          stage: 'permissions',
          detail: result.auth.error,
          hint: 'Ask whoever administers TruckMate to grant this user access to the REST resources (trips, freight bills, customers). The login itself is fine.',
          authOk: true,
        });
      }

      if (!result.endpoint || !result.endpoint.ok) {
        return res.status(400).json({
          error: 'Authenticated, but no TruckMate API responded at that address.',
          stage: 'endpoint',
          detail: result.endpoint && result.endpoint.error,
          hint: 'Either ART Server is not deployed, or it is mounted under a path prefix we have not been told. Ask for the exact base URL of a working REST call.',
          // The credential is good — that's real progress and worth saying.
          authOk: true,
        });
      }

      next.verifiedAt = new Date().toISOString();
      next.verifiedPath = result.endpoint.path;
      await saveConfig(owner, next);

      // Return the SHAPE of what came back, not just "ok". Every field mapping
      // in the adapter is a guess until a real payload corrects it, and this is
      // the first real payload.
      res.json({
        ok: true,
        config: safe(next),
        discovered: {
          path: result.endpoint.path,
          topLevelKeys: result.sample && typeof result.sample === 'object' ? Object.keys(result.sample).slice(0, 25) : null,
          sample: result.sample,
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.get('/truckmate/config', requireAuth, async (req, res) => {
    try {
      res.json(safe(await configFor(req.auth.owner)));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Re-run the probe against the SAVED config. Useful when a connection that
  // worked stops working — it says which half broke.
  app.get('/truckmate/probe', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const result = await tm.probe(cfg);
      res.json({ auth: result.auth, endpoint: result.endpoint, sample: result.sample });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.get('/truckmate/trips', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const trips = await tm.listTrips(cfg, {
        since: req.query.since,
        until: req.query.until,
        limit: Math.min(Number(req.query.limit) || 100, 500),
      });
      res.json({ trips, count: trips.length, unverifiedMapping: true });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/truckmate/customers', requireAuth, async (req, res) => {
    try {
      const cfg = await configFor(req.auth.owner);
      if (!cfg) return res.status(404).json({ error: 'TruckMate is not configured for this account.' });
      const customers = await tm.listCustomers(cfg, { limit: Math.min(Number(req.query.limit) || 500, 2000) });
      res.json({ customers, count: customers.length, unverifiedMapping: true });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // No write routes. Read has to work first, and a wrong write into a TMS
  // becomes a wrong invoice.
}

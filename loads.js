// ---------------------------------------------------------------
// Loads — the dispatch record, server-side.
//
// WHY THIS EXISTS
// Loads used to live in IndexedDB, meaning they existed only inside one
// dispatcher's browser tab. Nothing else could see them: no API for a partner
// TMS, no AI reasoning over the board, no second dispatcher, and a cleared
// browser profile lost the lot. This moves loads to Postgres and puts a real
// API in front of them.
//
// TMS INTEGRATION
// A load can originate here (typed into the dispatch board) or be mirrored from
// a partner's TMS. `source` records which, and `externalId` is that partner's
// own id — so we can sync a load back without creating duplicates. Adapters
// live in ./tms/ and all implement the same small interface (see tms/README).
//
// The API is deliberately boring REST: a partner integrating against it should
// not have to read our source to guess what a field means.
// ---------------------------------------------------------------

// Statuses mirror the dispatch board exactly (src/loadStore.js LOAD_STATUSES).
export const LOAD_STATUSES = [
  'Available', 'Dispatched', 'At Pickup', 'Loaded', 'In Transit',
  'At Delivery', 'Delivered', 'Complete', 'Invoiced', 'Cancelled',
];

// ---- the two kinds of work, which behave very differently ----
//
// 'ltl'      Outbound distribution of the carrier's OWN freight. Many drops
//            (12+ is normal), several bills per drop, no per-load rate — the
//            revenue is the product, not the haul. Success = everything
//            delivered, nothing skipped, appointments met.
//
// 'brokered' Bought freight, usually one pick and one drop, with a rate.
//            Typically the BACKHAUL: the truck has finished its outbound run
//            in another state and needs paying freight to get home. Success =
//            margin per mile and getting back in position.
//
// Conflating the two is the mistake to avoid. An empty return leg is the single
// biggest controllable cost in this operation, so the model has to know which
// leg it's looking at.
export const LOAD_TYPES = ['ltl', 'brokered'];

// ---- domain facts that change the maths (see tms/DOMAIN-florida-beauty.md) ----
//
// CAPACITY IS CUBES. Trailers are measured in cubic feet (a full outbound is
// ~2,600 cu ft), not pounds. Flowers are bulky and light, so weight-based
// capacity logic is meaningless here.
export const TRAILER_CUBES = 2600;
//
// TEAM DRIVERS. Trip sheets list two drivers on the long lanes. A team runs
// roughly 20 hours a day against a solo driver's 11, so any ETA or "can they
// make it" check must know which it is — assuming solo makes the system reject
// loads a team could comfortably run.
export const DRIVE_HOURS_PER_DAY = { solo: 11, team: 20 };
export const AVG_MPH = 50;

// Miles a truck can cover in a day, by crew type.
export const dailyMiles = (crew = 'solo') => (DRIVE_HOURS_PER_DAY[crew] || 11) * AVG_MPH;

// MIAMI IS THE HUB, and the only one that counts for repositioning.
//
// Memphis and Ventura exist, but they receive trucks and turn them straight
// back out to Miami — a truck sitting in Memphis is not home, it still has to
// get to Miami. Scoring against "nearest terminal" therefore OVERSTATES a load
// that ends at a satellite: it looks like the truck is in position when it
// isn't. Distance to Miami is the honest measure.
export const HUB = { code: 'MIA', name: 'Miami FL', lat: 25.8206, lng: -80.3186 }; // 3400 NW 74th Ave

// Kept for reference (they matter for transfers and driver changes), but
// deliberately NOT used to score repositioning — trucks often never reach them.
// Addresses confirmed by the operator; coordinates from the street address.
export const SATELLITE_TERMINALS = [
  {
    code: 'MEM', name: 'Memphis FBF Terminal',
    address: '11153 Hwy 178, Olive Branch, MS 38654',
    lat: 34.9607, lng: -89.8290,
  },
  {
    code: 'VTA', name: 'Florida Beauty Produce California',
    address: '6205 Ventura Boulevard, Ventura, CA 93003',
    lat: 34.2783, lng: -119.2264,
  },
];

export function initLoads(app, { requireAuth, db, pool }) {
  // ---- schema ----
  let ready = null;
  async function ensureReady() {
    if (!db || !db.enabled) return false;
    if (ready) return ready;
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_loads (
          id           text PRIMARY KEY,
          owner_key    text NOT NULL,
          status       text NOT NULL DEFAULT 'Available',
          load_type    text NOT NULL DEFAULT 'brokered',
          source       text NOT NULL DEFAULT 'tagalong',
          external_id  text,
          device_id    integer,
          driver_id    text,
          -- where the truck ENDS this load, and when. This is what makes
          -- backhaul matching possible: to find freight home you first have to
          -- know where the truck will be free and at what time.
          ends_lat     double precision,
          ends_lng     double precision,
          ends_at      timestamptz,
          rate_usd     numeric(10,2),
          data         jsonb NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Older deployments won't have the newer columns; add them idempotently
      // rather than requiring a migration step.
      for (const [col, type] of [
        ['load_type', "text NOT NULL DEFAULT 'brokered'"],
        ['ends_lat', 'double precision'], ['ends_lng', 'double precision'],
        ['ends_at', 'timestamptz'], ['rate_usd', 'numeric(10,2)'],
      ]) {
        await pool.query(`ALTER TABLE ta_loads ADD COLUMN IF NOT EXISTS ${col} ${type}`);
      }
      await pool.query('CREATE INDEX IF NOT EXISTS ta_loads_ends ON ta_loads (owner_key, ends_at)');
      await pool.query('CREATE INDEX IF NOT EXISTS ta_loads_owner ON ta_loads (owner_key, status)');
      // One row per (source, externalId) so re-syncing a partner TMS updates
      // rather than duplicating — the single most common integration bug.
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ta_loads_external
        ON ta_loads (owner_key, source, external_id) WHERE external_id IS NOT NULL`);
      // Every status change is kept: an AI dispatcher is only as good as the
      // history it can learn from, and disputes are settled with timestamps.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_load_events (
          id        bigserial PRIMARY KEY,
          load_id   text NOT NULL,
          at        timestamptz NOT NULL DEFAULT now(),
          kind      text NOT NULL,
          actor     text,
          detail    jsonb
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS ta_load_events_load ON ta_load_events (load_id, at DESC)');
      return true;
    })();
    return ready;
  }

  const ownerOf = (user) => String(user.company || user.id);

  async function logEvent(loadId, kind, actor, detail) {
    try {
      await pool.query('INSERT INTO ta_load_events (load_id, kind, actor, detail) VALUES ($1,$2,$3,$4)',
        [loadId, kind, actor || null, detail ? JSON.stringify(detail) : null]);
    } catch (e) { console.error('[loads] event log failed:', e.message); }
  }

  const rowToLoad = (r) => ({
    ...r.data,
    id: r.id,
    status: r.status,
    source: r.source,
    externalId: r.external_id,
    deviceId: r.device_id,
    driverId: r.driver_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  function guard(res) {
    if (!db || !db.enabled) {
      res.status(503).json({ error: 'Loads API needs DATABASE_URL configured.' });
      return false;
    }
    return true;
  }

  // ---- list ----
  app.get('/loads', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      const owner = ownerOf(req.user);
      const { status, since } = req.query;
      const where = ['owner_key = $1'];
      const args = [owner];
      if (status) { args.push(String(status)); where.push(`status = $${args.length}`); }
      if (since) { args.push(new Date(since).toISOString()); where.push(`updated_at >= $${args.length}`); }
      const { rows } = await pool.query(
        `SELECT * FROM ta_loads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`, args,
      );
      res.json({ loads: rows.map(rowToLoad) });
    } catch (e) { console.error('[loads] list failed:', e.message); res.status(502).json({ error: e.message }); }
  });

  // ---- one ----
  app.get('/loads/:id', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      const { rows } = await pool.query('SELECT * FROM ta_loads WHERE id = $1 AND owner_key = $2',
        [req.params.id, ownerOf(req.user)]);
      if (!rows.length) return res.status(404).json({ error: 'Load not found.' });
      const { rows: ev } = await pool.query(
        'SELECT at, kind, actor, detail FROM ta_load_events WHERE load_id = $1 ORDER BY at DESC LIMIT 200',
        [req.params.id]);
      res.json({ ...rowToLoad(rows[0]), events: ev });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- create / update (upsert on externalId when syncing from a TMS) ----
  app.put('/loads/:id', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    const body = req.body || {};
    if (body.status && !LOAD_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Unknown status. One of: ${LOAD_STATUSES.join(', ')}` });
    }
    try {
      await ensureReady();
      const owner = ownerOf(req.user);
      const id = String(req.params.id);
      const { rows: existing } = await pool.query('SELECT status FROM ta_loads WHERE id = $1 AND owner_key = $2', [id, owner]);
      const prevStatus = existing.length ? existing[0].status : null;

      const { rows } = await pool.query(
        `INSERT INTO ta_loads (id, owner_key, status, source, external_id, device_id, driver_id, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, source = EXCLUDED.source, external_id = EXCLUDED.external_id,
           device_id = EXCLUDED.device_id, driver_id = EXCLUDED.driver_id,
           data = EXCLUDED.data, updated_at = now()
         WHERE ta_loads.owner_key = $2
         RETURNING *`,
        [id, owner, body.status || prevStatus || 'Available', body.source || 'tagalong',
          body.externalId || null, body.deviceId || null, body.driverId || null, JSON.stringify(body)],
      );
      if (!rows.length) return res.status(403).json({ error: 'That load belongs to another account.' });

      if (!existing.length) await logEvent(id, 'created', req.user.email, { source: body.source || 'tagalong' });
      else if (body.status && body.status !== prevStatus) {
        await logEvent(id, 'status', req.user.email, { from: prevStatus, to: body.status });
      }
      res.json(rowToLoad(rows[0]));
    } catch (e) { console.error('[loads] save failed:', e.message); res.status(502).json({ error: e.message }); }
  });

  // ---- status change (the endpoint automation and the AI will use most) ----
  app.post('/loads/:id/status', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    const { status, note, actor } = req.body || {};
    if (!LOAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown status. One of: ${LOAD_STATUSES.join(', ')}` });
    }
    try {
      await ensureReady();
      const owner = ownerOf(req.user);
      const { rows } = await pool.query(
        'UPDATE ta_loads SET status = $1, updated_at = now() WHERE id = $2 AND owner_key = $3 RETURNING *',
        [status, req.params.id, owner]);
      if (!rows.length) return res.status(404).json({ error: 'Load not found.' });
      await logEvent(req.params.id, 'status', actor || req.user.email, { to: status, note: note || '' });
      res.json(rowToLoad(rows[0]));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.delete('/loads/:id', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      await pool.query('DELETE FROM ta_loads WHERE id = $1 AND owner_key = $2', [req.params.id, ownerOf(req.user)]);
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- bulk sync from a partner TMS ----
  // Adapters call this with whatever they pulled; matching on externalId means
  // running it twice is harmless, which matters when a sync is retried.
  app.post('/loads/sync', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    const { source, loads } = req.body || {};
    if (!source || !Array.isArray(loads)) return res.status(400).json({ error: 'source and loads[] required.' });
    try {
      await ensureReady();
      const owner = ownerOf(req.user);
      let created = 0, updated = 0;
      for (const l of loads) {
        if (!l.externalId) continue; // an external load without its own id can't be synced safely
        const { rows } = await pool.query(
          'SELECT id FROM ta_loads WHERE owner_key = $1 AND source = $2 AND external_id = $3',
          [owner, source, String(l.externalId)]);
        const id = rows.length ? rows[0].id : `L${Date.now()}${Math.floor(Math.random() * 1000)}`;
        await pool.query(
          `INSERT INTO ta_loads (id, owner_key, status, source, external_id, device_id, driver_id, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data,
             device_id = EXCLUDED.device_id, driver_id = EXCLUDED.driver_id, updated_at = now()`,
          [id, owner, l.status || 'Available', source, String(l.externalId),
            l.deviceId || null, l.driverId || null, JSON.stringify(l)]);
        if (rows.length) updated++; else { created++; await logEvent(id, 'synced', source, { externalId: l.externalId }); }
      }
      res.json({ ok: true, created, updated });
    } catch (e) { console.error('[loads] sync failed:', e.message); res.status(502).json({ error: e.message }); }
  });

  // ---- backhaul: what should this truck haul home? ----
  //
  // The highest-value decision in this operation. A truck finishes its outbound
  // LTL run in another state; every mile home without freight is pure loss.
  // The dispatcher has to answer, under time pressure: of the brokered loads
  // available near where I'm about to be free, which one pays best AND puts me
  // back in position — while being legal on hours.
  //
  // This endpoint does the arithmetic and RANKS options. It does not book
  // anything. A human accepts, and that accept/reject is the signal we learn
  // from later.

  const R_MILES = 3958.8;
  function haversineMiles(aLat, aLng, bLat, bLng) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_MILES * Math.asin(Math.sqrt(s));
  }

  // Scores a candidate backhaul for a truck that will be free at (lat,lng).
  // `homeLat/homeLng` is the terminal — freight that pays well but strands the
  // truck further from home is usually a bad trade, and a naive rate-per-mile
  // ranking misses that entirely.
  // Scored in DOLLARS, not an abstract number.
  //
  // An earlier version ranked on rate-per-mile plus adjustments, and it sent
  // the truck the wrong way: a 98-mile run paying $1,400 is $14/mile and beat
  // everything, even though it ended further from home with the truck still
  // needing freight. Rate-per-mile is unbounded; the correction terms weren't.
  //
  // So: estimate the actual economics. Margin on the haul, plus the empty miles
  // it saves you (miles toward home you'd otherwise drive for nothing). Both in
  // dollars, so they're comparable and a dispatcher can check the arithmetic.
  const COST_PER_MILE = 1.8; // fuel, wear, driver — override per carrier later

  function scoreBackhaul(load, {
    lat, lng, hoursAvailable,
    hub = HUB, // Miami. Satellites don't count — trucks often never reach them.
    costPerMile = COST_PER_MILE,
    crew = 'solo', // read this off the trip — crew size varies, see DOMAIN notes
  }) {
    const s = (load.data && load.data.stops) || [];
    const pick = s[0] || {};
    const drop = s[s.length - 1] || {};
    if (pick.lat == null || drop.lat == null) return null; // can't reason without geography

    const deadhead = haversineMiles(lat, lng, pick.lat, pick.lng);
    const loaded = haversineMiles(pick.lat, pick.lng, drop.lat, drop.lng);
    const rate = Number(load.rate_usd || 0);
    const totalMiles = deadhead + loaded;
    if (!totalMiles) return null;

    // Distance to Miami, before and after. Every truck is ultimately heading
    // back to the hub, so this is the only repositioning measure that's honest.
    const hubBefore = haversineMiles(lat, lng, hub.lat, hub.lng);
    const hubAfter = haversineMiles(drop.lat, drop.lng, hub.lat, hub.lng);
    const progressHome = hubBefore - hubAfter; // positive = closer to Miami

    const cost = totalMiles * costPerMile;
    const margin = rate - cost;
    // Miles carried toward home are miles you don't have to run empty later,
    // so they're worth what they'd otherwise have cost. Negative when the load
    // drags the truck further out — which is exactly the case the old scoring
    // failed to punish.
    const repositionValue = progressHome * costPerMile;
    const netValue = margin + repositionValue;

    // Hours: only the IMMEDIATE leg is bounded by today's remaining hours. A
    // 1,200-mile run is a multi-day trip, not an illegal one — the old check
    // called every long haul illegal, which would have hidden the best loads.
    const deadheadHours = deadhead / AVG_MPH;
    const reachablePickupToday = hoursAvailable == null ? null : deadheadHours <= hoursAvailable;

    return {
      loadId: load.id,
      reference: (load.data && load.data.reference) || load.external_id,
      rate,
      deadheadMiles: Math.round(deadhead),
      loadedMiles: Math.round(loaded),
      ratePerMile: Number((rate / totalMiles).toFixed(2)),
      estimatedCost: Math.round(cost),
      margin: Math.round(margin),
      milesCloserToHome: Math.round(progressHome),
      repositionValue: Math.round(repositionValue),
      netValue: Math.round(netValue),
      crew,
      tripDays: Number((totalMiles / dailyMiles(crew)).toFixed(1)),
      milesFromHubAfter: Math.round(hubAfter),
      reachablePickupToday,
      score: Math.round(netValue), // dollars — sortable and explainable
      why: [
        `$${rate.toFixed(0)} − $${Math.round(cost)} cost over ${Math.round(totalMiles)} mi = $${Math.round(margin)} margin`,
        progressHome > 0
          ? `saves ~$${Math.round(repositionValue)} of empty miles — ends ${Math.round(hubAfter)} mi from Miami`
          : `costs ~$${Math.abs(Math.round(repositionValue))} — ends ${Math.round(hubAfter)} mi from Miami, further out than now`,
        deadhead > 50 ? `${Math.round(deadhead)} mi deadhead to reach the pickup` : null,
        reachablePickupToday === false
          ? `can't reach the pickup today (${deadheadHours.toFixed(1)}h drive, ${hoursAvailable}h left)`
          : null,
      ].filter(Boolean),
    };
  }

  app.post('/loads/backhaul', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    const { lat, lng, hoursAvailable, radiusMiles = 250, costPerMile, crew } = req.body || {};
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng (where the truck comes free) are required.' });
    try {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT * FROM ta_loads
         WHERE owner_key = $1 AND load_type = 'brokered' AND status = 'Available'
         ORDER BY updated_at DESC LIMIT 500`, [ownerOf(req.user)]);

      const scored = rows
        .map((r) => scoreBackhaul(r, {
          lat, lng, hoursAvailable, crew,
          // Operating cost is per-carrier and changes with fuel — always
          // overridable rather than a constant baked into the ranking.
          ...(costPerMile ? { costPerMile: Number(costPerMile) } : {}),
          ...(req.body && req.body.hub ? { hub: req.body.hub } : {}),
        }))
        .filter(Boolean)
        .filter((c) => c.deadheadMiles <= radiusMiles)
        .sort((a, b) => b.score - a.score);

      res.json({
        ok: true,
        candidates: scored.slice(0, 20),
        considered: rows.length,
        note: scored.length ? null
          : 'No brokered loads available to score. Broker freight has to be in the system before it can be matched — see the load-board question in server/tms/README.md.',
      });
    } catch (e) { console.error('[loads] backhaul failed:', e.message); res.status(502).json({ error: e.message }); }
  });

  console.log('[loads] dispatch API ready — GET/PUT /loads, POST /loads/:id/status, POST /loads/sync, POST /loads/backhaul');
  return { ensureReady, LOAD_STATUSES, LOAD_TYPES, scoreBackhaul, haversineMiles };
}

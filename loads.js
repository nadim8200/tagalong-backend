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
          source       text NOT NULL DEFAULT 'tagalong',
          external_id  text,
          device_id    integer,
          driver_id    text,
          data         jsonb NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
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

  console.log('[loads] dispatch API ready — GET/PUT /loads, POST /loads/:id/status, POST /loads/sync');
  return { ensureReady, LOAD_STATUSES };
}

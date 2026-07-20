// ---------------------------------------------------------------
// Durable storage for TagAlong.
//
// WHY THIS EXISTS
// Everything the backend needed to remember — broker/family accounts, push
// tokens, alert de-dupe state, shop products, orders — used to live in the
// `attributes` JSON of a Traccar device. Postgres caps that column at 4000
// characters for the WHOLE blob, shared across every one of those stores. Once
// full, writes are rejected: push alerts repeated forever because the "already
// notified" flag could never be saved, and account signups would have started
// failing outright ("account save failed").
//
// So state now lives in a real table. Traccar goes back to doing what it's good
// at — devices and positions.
//
// DESIGN
// A single `ta_kv` table, one row per store, keeping the exact JSON shapes the
// rest of the code already expects. That's deliberate: it removes the size
// ceiling without rewriting working auth logic, which is where bugs would hide.
// Individual stores can be normalised into proper tables later, one at a time.
//
// SAFETY
// • No DATABASE_URL → transparently falls back to the old Traccar attributes,
//   so nothing breaks in local dev or if the database is ever unreachable.
// • On first boot with a database, existing Traccar data is copied across
//   automatically. The Traccar copy is LEFT IN PLACE as a backup — nothing is
//   deleted, so a rollback is just removing DATABASE_URL.
// ---------------------------------------------------------------
import pg from 'pg';

const { Pool } = pg;

export function initDb({ TRACCAR_URL, traccarHeaders, DATABASE_URL }) {
  const enabled = !!DATABASE_URL;
  let pool = null;
  let ready = null;

  if (enabled) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Render's managed Postgres requires TLS but uses a cert chain Node
      // doesn't ship a root for.
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  } else {
    console.warn('[db] DATABASE_URL not set — falling back to Traccar device attributes '
      + '(4000-char cap; fine for local dev, NOT for production).');
  }

  // ---- Traccar fallback (the old storage) ----
  async function hostDevice() {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    if (!r.ok) throw new Error('devices fetch failed');
    const all = await r.json();
    if (!all.length) throw new Error('no devices');
    return all.reduce((min, d) => (!min || d.id < min.id ? d : min), null);
  }
  async function traccarGet(key) {
    const host = await hostDevice();
    return (host.attributes || {})[key];
  }
  async function traccarSet(key, value) {
    const host = await hostDevice();
    const attributes = { ...(host.attributes || {}), [key]: value };
    const r = await fetch(`${TRACCAR_URL}/api/devices/${host.id}`, {
      method: 'PUT',
      headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Traccar write failed ${r.status} — ${detail}`);
    }
    return value;
  }

  // ---- schema + one-time migration ----
  const MIGRATE_KEYS = ['taAccounts', 'taPush', 'taShop', 'taOrders', 'taCommunity'];

  async function ensureReady() {
    if (!enabled) return;
    if (ready) return ready;
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_kv (
          key        text PRIMARY KEY,
          value      jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Alert history gets its own table — it's append-only and grows without
      // bound, so it shouldn't be rewritten as one big blob on every insert.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_alert_log (
          id       bigserial PRIMARY KEY,
          user_key text NOT NULL,
          at       timestamptz NOT NULL DEFAULT now(),
          entry    jsonb NOT NULL
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS ta_alert_log_user_at ON ta_alert_log (user_key, at DESC)');

      // First boot: copy whatever is still in Traccar into the database.
      const { rows } = await pool.query('SELECT 1 FROM ta_kv LIMIT 1');
      if (!rows.length) {
        try {
          const host = await hostDevice();
          const attrs = host.attributes || {};
          const moved = [];
          for (const k of MIGRATE_KEYS) {
            if (attrs[k] === undefined) continue;
            await pool.query(
              'INSERT INTO ta_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
              [k, JSON.stringify(attrs[k])],
            );
            moved.push(`${k} (${JSON.stringify(attrs[k]).length} chars)`);
          }
          console.log(moved.length
            ? `[db] migrated ${moved.length} store(s) out of Traccar attributes: ${moved.join(', ')}`
            : '[db] nothing to migrate — no existing stores found in Traccar attributes.');
          console.log('[db] the Traccar copy was left in place as a backup — safe to roll back by unsetting DATABASE_URL.');
        } catch (e) {
          console.warn('[db] migration from Traccar skipped:', e.message);
        }
      }
    })();
    return ready;
  }

  // ---- public API (same shapes the app already uses) ----
  async function get(key, fallback = {}) {
    if (!enabled) {
      const v = await traccarGet(key);
      return v === undefined ? fallback : v;
    }
    await ensureReady();
    const { rows } = await pool.query('SELECT value FROM ta_kv WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  async function set(key, value) {
    if (!enabled) return traccarSet(key, value);
    await ensureReady();
    await pool.query(
      `INSERT INTO ta_kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    return value;
  }

  // Read-modify-write under a row lock, so two concurrent signups can't clobber
  // each other. The old Traccar version had this race too — it just never
  // surfaced because writes were failing anyway.
  async function update(key, mutator, fallback = {}) {
    if (!enabled) {
      const cur = await get(key, fallback);
      return traccarSet(key, mutator(cur));
    }
    await ensureReady();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT value FROM ta_kv WHERE key = $1 FOR UPDATE', [key]);
      const cur = rows.length ? rows[0].value : fallback;
      const next = mutator(cur);
      await client.query(
        `INSERT INTO ta_kv (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(next)],
      );
      await client.query('COMMIT');
      return next;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- alert history ----
  async function appendAlert(userKey, entry) {
    if (!enabled) return; // falls back to the file-based log in push.js
    await ensureReady();
    await pool.query('INSERT INTO ta_alert_log (user_key, entry) VALUES ($1, $2)', [String(userKey), JSON.stringify(entry)]);
    // keep it bounded per user
    await pool.query(
      `DELETE FROM ta_alert_log WHERE user_key = $1 AND id NOT IN (
         SELECT id FROM ta_alert_log WHERE user_key = $1 ORDER BY at DESC LIMIT 500)`,
      [String(userKey)],
    );
  }

  async function readAlerts(userKey, limit = 400) {
    if (!enabled) return null; // null = "use the file fallback"
    await ensureReady();
    const { rows } = await pool.query(
      'SELECT entry FROM ta_alert_log WHERE user_key = $1 ORDER BY at DESC LIMIT $2',
      [String(userKey), limit],
    );
    return rows.map((r) => r.entry);
  }

  return { enabled, get, set, update, appendAlert, readAlerts, ensureReady };
}

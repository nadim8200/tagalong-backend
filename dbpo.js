// ---------------------------------------------------------------
// Dynamic BPO portal — live call workspace store.
//
// The dashboard seeds its roster from a CSV in the app's /public folder. This
// module holds the MUTABLE layer on top of that roster: as callers work the
// list, their updates (contact result, aptitud, cita, notes) and their lead
// "claims" are saved here so every agent sees the same live state.
//
// STORAGE
// One JSON document in the existing Postgres key/value table (db.js → ta_kv),
// under the key `dbpoRegistros`. Shape:
//   { [documento]: {
//       data:   { estado_contacto, aptitud, modalidad, cita_fecha, ... },  // only changed fields
//       claim:  { by, at } | null,        // who is currently calling this lead
//       updatedBy, updatedAt,             // last edit
//       historial: [{ at, by, estado, nota }]   // capped call log
//   } }
//
// Writes go through db.update() — a SELECT ... FOR UPDATE transaction — so two
// agents saving or claiming at the same instant can't clobber each other.
//
// AUTH
// These endpoints are NOT behind the TagAlong JWT (callers aren't app users).
// If DBPO_TOKEN is set they require a matching `x-dbpo-token` header; combined
// with CORS this is a light barrier, not strong auth. For sensitive health data,
// per-agent logins would need a real auth layer — a later step.
// ---------------------------------------------------------------

const KEY = 'dbpoRegistros';
const CLAIM_TTL_MS = 15 * 60 * 1000;   // a claim goes stale after 15 min of no save
const HIST_MAX = 50;

// Only these fields may be written from the browser — everything else in the
// body is ignored, so a caller can't inject arbitrary keys into the record.
const CAMPOS = new Set([
  'estado_contacto', 'fecha_gestion', 'aptitud', 'motivo_no_elegible', 'modalidad',
  'cita_fecha', 'cita_texto', 'estado_tamizaje', 'telefono', 'correo',
  'observaciones', 'edad', 'nombre', 'zona', 'municipio', 'agente',
]);

const clean = (v) => (v === undefined ? undefined : (v === '' ? null : v));

export function initDbpo(app, { db }) {
  const TOKEN = String(process.env.DBPO_TOKEN || '').trim();

  // token gate for every /dbpo route
  function gate(req, res, next) {
    if (!TOKEN) return next();
    if (String(req.headers['x-dbpo-token'] || '') === TOKEN) return next();
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const doc = (req) => String(req.params.doc || '').trim();

  // ---- whole live overlay + server clock (so clients can judge claim age) ----
  app.get('/dbpo/state', gate, async (_req, res) => {
    try {
      const records = await db.get(KEY, {});
      res.json({ now: Date.now(), records });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- save the call outcome for one lead ----
  app.post('/dbpo/record/:doc', gate, async (req, res) => {
    const d = doc(req);
    if (!d) return res.status(400).json({ error: 'Falta el documento.' });
    const agent = String(req.body?.agent || '').trim() || 'Agente';
    const fields = req.body?.fields || {};
    const nota = clean(req.body?.nota);

    // keep only whitelisted, defined fields
    const data = {};
    for (const k of Object.keys(fields)) {
      if (CAMPOS.has(k)) { const v = clean(fields[k]); if (v !== undefined) data[k] = v; }
    }

    try {
      const next = await db.update(KEY, (cur) => {
        const map = { ...(cur || {}) };
        const prev = map[d] || {};
        const merged = { ...(prev.data || {}), ...data };
        const hist = Array.isArray(prev.historial) ? prev.historial.slice() : [];
        if (nota || data.estado_contacto) {
          hist.unshift({ at: Date.now(), by: agent, estado: data.estado_contacto ?? prev.data?.estado_contacto ?? null, nota: nota || null });
        }
        map[d] = {
          ...prev,
          data: merged,
          updatedBy: agent,
          updatedAt: Date.now(),
          // saving keeps the lead claimed by whoever just worked it
          claim: { by: agent, at: Date.now() },
          historial: hist.slice(0, HIST_MAX),
        };
        return map;
      }, {});
      res.json({ ok: true, record: next[d] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- claim a lead (lock it to this agent while calling) ----
  app.post('/dbpo/claim/:doc', gate, async (req, res) => {
    const d = doc(req);
    const agent = String(req.body?.agent || '').trim();
    const force = !!req.body?.force;
    if (!d || !agent) return res.status(400).json({ error: 'Falta documento o agente.' });

    let conflict = null;
    try {
      const next = await db.update(KEY, (cur) => {
        const map = { ...(cur || {}) };
        const prev = map[d] || {};
        const c = prev.claim;
        const fresh = c && (Date.now() - (c.at || 0) < CLAIM_TTL_MS);
        if (c && c.by !== agent && fresh && !force) { conflict = c; return map; } // no-op, report below
        map[d] = { ...prev, claim: { by: agent, at: Date.now() } };
        return map;
      }, {});
      if (conflict) return res.status(409).json({ error: 'Ya la está gestionando otro agente.', claim: conflict });
      res.json({ ok: true, record: next[d] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- release a lead ----
  app.post('/dbpo/release/:doc', gate, async (req, res) => {
    const d = doc(req);
    const agent = String(req.body?.agent || '').trim();
    if (!d) return res.status(400).json({ error: 'Falta el documento.' });
    try {
      const next = await db.update(KEY, (cur) => {
        const map = { ...(cur || {}) };
        const prev = map[d];
        if (prev && prev.claim && (!agent || prev.claim.by === agent || req.body?.force)) {
          map[d] = { ...prev, claim: null };
        }
        return map;
      }, {});
      res.json({ ok: true, record: next[d] || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[dbpo] call workspace routes ready' + (TOKEN ? ' (token-gated)' : ' (open — set DBPO_TOKEN to gate)'));
}

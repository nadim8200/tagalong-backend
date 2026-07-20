// ---------------------------------------------------------------
// Proof of delivery — what the driver sends back from every LTL drop.
//
// TODAY (paper): the driver carries a printed manifest and a blank "Customer
// Unloading Sheet" (Pallet | Pallet Count | Notes). At the stop they hand-write
// the counts, get the BOL signed, photograph the pallets, and send pictures of
// all of it. Someone at the office reads the handwriting.
//
// THE ONE DECISION THAT MATTERS HERE:
// The count sheet must be captured as STRUCTURED DATA, not as another photo.
//
// A photo of a handwritten count sheet is an image — a human still has to read
// it, and nothing can be checked automatically. If the driver instead types the
// count per pallet, the system can compare it against what was loaded and
// detect a shortage AT THE STOP, while the driver is still standing there and
// the receiver can still be asked about it. That is the difference between
// "we discovered a claim three days later" and "we caught it at the dock".
//
// Photos are still captured — the signed BOL and the pallet pictures are the
// evidence, and they're required for the claim. But the COUNT is data.
//
// Everything then forwards to Transflo, which is where this carrier's documents
// already live (see tms/transflo.js).
// ---------------------------------------------------------------

// What a complete delivery packet requires, from the printed instructions:
//   "READ LABELS, COUNT, VERIFY AMOUNTS"
//   "GET THE RECEIVER'S SIGNATURE IF ABLE"
//   "ALWAYS TAKE A PHOTO OF TWO SIDES OF THE PALLET"
export const POD_REQUIREMENTS = {
  counts: { required: true, label: 'Pallet counts' },
  bolPhoto: { required: true, label: 'Photo of the signed BOL' },
  palletPhotos: { required: true, min: 2, label: 'Pallet photos (two sides)' },
  signature: { required: false, label: "Receiver's signature" }, // "if able"
};

export function initPod(app, { requireAuth, db, pool }) {
  let ready = null;
  async function ensureReady() {
    if (!db || !db.enabled) return false;
    if (ready) return ready;
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_pod (
          id            text PRIMARY KEY,
          owner_key     text NOT NULL,
          load_id       text,
          stop_id       text,
          bill_number   text,
          driver_id     text,
          -- structured counts: [{ pallet, expected, counted, notes }]
          counts        jsonb NOT NULL DEFAULT '[]',
          expected_total integer,
          counted_total  integer,
          -- overage / shortage / damage, derived not typed
          osd           text,
          osd_delta     integer,
          receiver_name text,
          signature_png text,
          temperature_f numeric(5,1),
          seal_number   text,
          notes         text,
          lat           double precision,
          lng           double precision,
          captured_at   timestamptz NOT NULL DEFAULT now(),
          transflo_status text NOT NULL DEFAULT 'pending',
          transflo_ref  text,
          created_at    timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS ta_pod_load ON ta_pod (owner_key, load_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS ta_pod_tf ON ta_pod (transflo_status) WHERE transflo_status <> \'sent\'');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_pod_files (
          id         bigserial PRIMARY KEY,
          pod_id     text NOT NULL,
          kind       text NOT NULL,          -- 'bol' | 'pallet' | 'countsheet' | 'other'
          mime       text NOT NULL,
          bytes      bytea NOT NULL,
          taken_at   timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS ta_pod_files_pod ON ta_pod_files (pod_id)');
      return true;
    })();
    return ready;
  }

  const ownerOf = (user) => String(user.company || user.id);
  const guard = (res) => {
    if (!db || !db.enabled) { res.status(503).json({ error: 'POD needs DATABASE_URL configured.' }); return false; }
    return true;
  };

  // ---- the check that makes this worth doing ----
  // Compare what was counted against what was loaded, per pallet and in total.
  // Returns the discrepancy in the language the paperwork uses (OSD).
  function checkCounts(counts = []) {
    let expected = 0, counted = 0;
    const perPallet = [];
    for (const c of counts) {
      const e = Number(c.expected);
      const n = Number(c.counted);
      const hasE = Number.isFinite(e), hasN = Number.isFinite(n);
      if (hasE) expected += e;
      if (hasN) counted += n;
      if (hasE && hasN && e !== n) {
        perPallet.push({ pallet: c.pallet, expected: e, counted: n, delta: n - e });
      }
    }
    const delta = counted - expected;
    let osd = null;
    if (delta < 0) osd = 'shortage';
    else if (delta > 0) osd = 'overage';
    if (counts.some((c) => c.damaged)) osd = osd ? `${osd}+damage` : 'damage';
    return { expected, counted, delta, osd, perPallet };
  }

  function missingItems(body, files = []) {
    const missing = [];
    if (!Array.isArray(body.counts) || !body.counts.length) missing.push(POD_REQUIREMENTS.counts.label);
    if (!files.some((f) => f.kind === 'bol')) missing.push(POD_REQUIREMENTS.bolPhoto.label);
    const pallets = files.filter((f) => f.kind === 'pallet').length;
    if (pallets < POD_REQUIREMENTS.palletPhotos.min) {
      missing.push(`${POD_REQUIREMENTS.palletPhotos.label} — ${pallets} of ${POD_REQUIREMENTS.palletPhotos.min}`);
    }
    return missing;
  }

  // ---- submit a delivery packet ----
  // Files arrive as base64 in the JSON body: [{ kind, mime, data }]. That keeps
  // the driver client trivial (no multipart, works offline-then-sync) at the
  // cost of ~33% size overhead, which is fine for a handful of phone photos.
  app.post('/pod', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    const b = req.body || {};
    try {
      await ensureReady();
      const files = Array.isArray(b.files) ? b.files : [];
      const missing = missingItems(b, files);

      // A packet can be saved INCOMPLETE — a driver at a dock with no signal or
      // a receiver who won't sign still needs to record what happened. It's
      // flagged rather than rejected, because losing the count entirely is far
      // worse than storing a partial one.
      const counts = Array.isArray(b.counts) ? b.counts : [];
      const chk = checkCounts(counts);
      const id = `POD${Date.now()}${Math.floor(Math.random() * 1000)}`;

      await pool.query(
        `INSERT INTO ta_pod (id, owner_key, load_id, stop_id, bill_number, driver_id,
           counts, expected_total, counted_total, osd, osd_delta, receiver_name,
           signature_png, temperature_f, seal_number, notes, lat, lng, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, ownerOf(req.user), b.loadId || null, b.stopId || null, b.billNumber || null,
          b.driverId || null, JSON.stringify(counts), chk.expected, chk.counted,
          chk.osd, chk.delta, b.receiverName || null, b.signaturePng || null,
          b.temperatureF != null ? b.temperatureF : null, b.sealNumber || null,
          b.notes || null, b.lat != null ? b.lat : null, b.lng != null ? b.lng : null,
          b.capturedAt || new Date().toISOString()],
      );

      for (const f of files) {
        if (!f || !f.data) continue;
        const buf = Buffer.from(String(f.data).replace(/^data:[^,]+,/, ''), 'base64');
        await pool.query(
          'INSERT INTO ta_pod_files (pod_id, kind, mime, bytes, taken_at) VALUES ($1,$2,$3,$4,$5)',
          [id, f.kind || 'other', f.mime || 'image/jpeg', buf, f.takenAt || null],
        );
      }

      res.json({
        ok: true,
        id,
        complete: missing.length === 0,
        missing,
        counts: chk,
        // The dispatcher-facing headline. Said plainly so a driver reading it
        // on a phone at a dock knows whether to go back inside and ask.
        alert: chk.osd
          ? `${chk.osd.toUpperCase()}: counted ${chk.counted} against ${chk.expected} expected (${chk.delta > 0 ? '+' : ''}${chk.delta}). Report before leaving.`
          : null,
      });
    } catch (e) {
      console.error('[pod] submit failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- what the office / AI sees ----
  app.get('/pod', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      const args = [ownerOf(req.user)];
      const where = ['owner_key = $1'];
      if (req.query.loadId) { args.push(req.query.loadId); where.push(`load_id = $${args.length}`); }
      if (req.query.osdOnly === '1') where.push('osd IS NOT NULL');
      const { rows } = await pool.query(
        `SELECT id, load_id, stop_id, bill_number, driver_id, expected_total, counted_total,
                osd, osd_delta, receiver_name, temperature_f, seal_number, notes,
                captured_at, transflo_status, transflo_ref
         FROM ta_pod WHERE ${where.join(' AND ')} ORDER BY captured_at DESC LIMIT 200`, args);
      res.json({ pods: rows });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/pod/:id/files', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT f.id, f.kind, f.mime, f.taken_at, octet_length(f.bytes) AS size
         FROM ta_pod_files f JOIN ta_pod p ON p.id = f.pod_id
         WHERE f.pod_id = $1 AND p.owner_key = $2 ORDER BY f.id`,
        [req.params.id, ownerOf(req.user)]);
      res.json({ files: rows });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/pod/:id/file/:fileId', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT f.mime, f.bytes FROM ta_pod_files f JOIN ta_pod p ON p.id = f.pod_id
         WHERE f.id = $1 AND f.pod_id = $2 AND p.owner_key = $3`,
        [req.params.fileId, req.params.id, ownerOf(req.user)]);
      if (!rows.length) return res.status(404).json({ error: 'Not found.' });
      res.type(rows[0].mime).send(rows[0].bytes);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  console.log('[pod] proof-of-delivery API ready — POST /pod, GET /pod, GET /pod/:id/files');
  return { ensureReady, checkCounts, missingItems, POD_REQUIREMENTS };
}

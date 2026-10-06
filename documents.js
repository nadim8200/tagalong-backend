// ---------------------------------------------------------------
// Original document storage for the dispatcher (trip sheets, rate cons).
//
// The AI readers keep the EXTRACTED data; this keeps the ORIGINAL bytes so a
// dispatcher can always open what was actually uploaded ("View PDF" / "View
// original") and compare it with what the AI read. Files live in Postgres
// (private, behind the same login as everything else) — never in a public
// bucket, and no storage secret ever reaches the browser.
//
//   POST /truckmate/docs              { kind, trip?, batchId?, files:[{dataBase64, mediaType, filename}] }
//   GET  /truckmate/docs?trip=&kind=  → metadata list (newest first, every version)
//   GET  /truckmate/docs/:id/file     → the original bytes (auth required)
//
// Every upload is a new VERSION; replacing a document keeps the older ones
// (lineage), and the newest is what the trip shows by default.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

const KINDS = new Set(['ratecon', 'tripsheet', 'packet', 'driverdoc', 'rundown', 'email']);   // email = attachment received by Jarvis   // rundown = the load's full PDF report   // driverdoc = POD / BOL sent by the driver
const MAX_FILE_BYTES = 14 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif|gif))$/i;

export const docMeta = (r) => ({
  id: String(r.id),
  kind: r.kind,
  site: r.site,
  trips: r.trips || [],
  batchId: r.batch_id || null,
  page: r.page != null ? Number(r.page) : null,
  filename: r.filename || null,
  mediaType: r.media_type,
  isPdf: /pdf/i.test(r.media_type || ''),
  bytes: Number(r.size_bytes) || 0,
  sha256: r.sha256,
  version: r.version != null ? Number(r.version) : null,
  uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : r.uploaded_at,
  uploadedBy: r.uploaded_by || null,
  docType: r.doc_type || null,          // manifest, bol, pod, email, driver_id, carrier_confirmation, …
  restricted: !!r.restricted,           // driver IDs and whole packets that contain them
  packetId: r.packet_id ? String(r.packet_id) : null,
});

export function initDocuments(app, { requireAuth, db }) {
  const pool = db && db.pool;
  const enabled = !!(db && db.enabled && pool);
  let ready = null;
  function ensureTable() {
    if (!enabled) return Promise.resolve();
    if (!ready) {
      ready = (async () => {
        await db.ensureReady();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ta_docs (
            id BIGSERIAL PRIMARY KEY,
            site TEXT NOT NULL,
            kind TEXT NOT NULL,
            trips TEXT[] NOT NULL DEFAULT '{}',
            batch_id TEXT,
            page INTEGER,
            filename TEXT,
            media_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            version INTEGER,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            uploaded_by TEXT,
            data BYTEA NOT NULL
          )`);
        await pool.query('CREATE INDEX IF NOT EXISTS ta_docs_trips ON ta_docs USING GIN (trips)');
        await pool.query('CREATE INDEX IF NOT EXISTS ta_docs_batch ON ta_docs (batch_id)');
        await pool.query('ALTER TABLE ta_docs ADD COLUMN IF NOT EXISTS doc_type TEXT');
        await pool.query('ALTER TABLE ta_docs ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT false');
        await pool.query('ALTER TABLE ta_docs ADD COLUMN IF NOT EXISTS packet_id BIGINT');
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');

  // Store originals. Used by the rate-con reader (same request) and by the
  // trip-sheet upload (one file per request, before extraction).
  async function insertOne({ site, kind, trip, batchId, page, filename, mediaType, buf, version, by, restricted = false, packetId = null }) {
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const { rows } = await pool.query(
      `INSERT INTO ta_docs (site, kind, trips, batch_id, page, filename, media_type, size_bytes, sha256, version, uploaded_by, data, restricted, packet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, site, kind, trips, batch_id, page, filename, media_type, size_bytes, sha256, version, uploaded_at, uploaded_by, doc_type, restricted, packet_id`,
      [site, kind, trip ? [String(trip)] : [], batchId, page, filename, mediaType, buf.length, sha256, version, by || null, buf, restricted, packetId],
    );
    return docMeta(rows[0]);
  }

  // A scanned multi-page PDF (a "trip packet") is kept whole — restricted,
  // because packets can include a driver's ID — and also split into one stored
  // document per page, so each page can be attached to its own trip, opened on
  // its own, and a driver-ID page locked without hiding the rest.
  async function storePacketPdf({ site, batchId, buf, filename, by }) {
    let src;
    try { src = await PDFDocument.load(buf, { ignoreEncryption: true }); } catch { return null; }
    const n = src.getPageCount();
    if (n < 2) return null;
    const packet = await insertOne({ site, kind: 'packet', trip: null, batchId, page: null, filename, mediaType: 'application/pdf', buf, version: null, by, restricted: true });
    const pages = [];
    for (let i = 0; i < n; i++) {
      const one = await PDFDocument.create(); // eslint-disable-line no-await-in-loop
      const [pg] = await one.copyPages(src, [i]); // eslint-disable-line no-await-in-loop
      one.addPage(pg);
      const bytes = Buffer.from(await one.save()); // eslint-disable-line no-await-in-loop
      pages.push(await insertOne({ site, kind: 'tripsheet', trip: null, batchId, page: i + 1, filename: `${filename || 'packet.pdf'} · page ${i + 1}`, mediaType: 'application/pdf', buf: bytes, version: null, by, packetId: packet.id })); // eslint-disable-line no-await-in-loop
    }
    return { packet, pages };
  }

  async function storeDocs({ site, kind, trip = null, batchId = null, files, by }) {
    if (!enabled) return [];
    if (!KINDS.has(kind)) throw new Error('Unknown document kind.');
    await ensureTable();
    let version = null;
    if (trip) {
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(version), 0) AS v FROM ta_docs WHERE site = $1 AND kind = $2 AND $3 = ANY(trips)',
        [site, kind, String(trip)],
      );
      version = Number(rows[0].v) + 1;
    }
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {};
      const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
      if (!buf.length) throw new Error(`File ${i + 1} is empty.`);
      if (buf.length > MAX_FILE_BYTES) throw new Error(`${f.filename || `File ${i + 1}`} is larger than 14 MB.`);
      const mediaType = String(f.mediaType || '').toLowerCase() || (/\.pdf$/i.test(f.filename || '') ? 'application/pdf' : '');
      if (!OK_TYPES.test(mediaType)) throw new Error(`${f.filename || `File ${i + 1}`}: only PDF or image files can be stored.`);
      if (kind === 'tripsheet' && /pdf/i.test(mediaType)) {
        const split = await storePacketPdf({ site, batchId, buf, filename: String(f.filename || '').slice(0, 200) || null, by }); // eslint-disable-line no-await-in-loop
        if (split) { out.push(...split.pages.map((pg) => ({ ...pg, fileIndex: i }))); continue; }
      }
      const one = await insertOne({ site, kind, trip, batchId, page: f.page != null ? Number(f.page) : i + 1, filename: String(f.filename || '').slice(0, 240) || null, mediaType, buf, version, by }); // eslint-disable-line no-await-in-loop
      out.push({ ...one, fileIndex: i });
    }
    return out;
  }

  // After the trip-sheet reader splits a batch into trips, attach each stored
  // page to the trips the AI found on it (a page can belong to only one trip,
  // but a re-read can re-link it). Version = per trip, per upload.
  async function linkDocs({ site, kind, links }) {
    if (!enabled || !links.length) return;
    await ensureTable();
    for (const { docId, trips } of links) {
      await pool.query( // eslint-disable-line no-await-in-loop
        'UPDATE ta_docs SET trips = $1 WHERE id = $2 AND site = $3 AND kind = $4',
        [trips.map(String), docId, site, kind],
      );
      // the whole packet this page came from belongs to every trip found in it
      await pool.query( // eslint-disable-line no-await-in-loop
        `UPDATE ta_docs p SET trips = ARRAY(SELECT DISTINCT x FROM unnest(p.trips || $1::text[]) x)
           FROM ta_docs c WHERE c.id = $2 AND c.site = $3 AND p.id = c.packet_id`,
        [trips.map(String), docId, site],
      );
    }
  }

  async function markDocs({ site, ids, docType = null, restricted = null }) {
    if (!enabled || !ids.length) return;
    await ensureTable();
    await pool.query(
      `UPDATE ta_docs SET doc_type = COALESCE($1, doc_type), restricted = COALESCE($2, restricted) WHERE site = $3 AND id = ANY($4::bigint[])`,
      [docType, restricted, site, ids.map(Number)],
    );
  }

  async function listDocs({ site, trips = null, kind = null, batchId = null }) {
    if (!enabled) return [];
    await ensureTable();
    const where = ['site = $1']; const args = [site];
    if (trips && trips.length) { args.push(trips.map(String)); where.push(`trips && $${args.length}`); }
    if (kind) { args.push(kind); where.push(`kind = $${args.length}`); }
    if (batchId) { args.push(batchId); where.push(`batch_id = $${args.length}`); }
    const { rows } = await pool.query(
      `SELECT id, site, kind, trips, batch_id, page, filename, media_type, size_bytes, sha256, version, uploaded_at, uploaded_by, doc_type, restricted, packet_id
         FROM ta_docs WHERE ${where.join(' AND ')} ORDER BY uploaded_at DESC, page ASC LIMIT 2000`, args,
    );
    return rows.map(docMeta);
  }

  app.post('/truckmate/docs', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Document storage needs the database (DATABASE_URL).' });
    const b = req.body || {};
    try {
      const files = Array.isArray(b.files) ? b.files : [];
      if (!files.length) return res.status(400).json({ error: 'No files.' });
      const docs = await storeDocs({ site: siteOf(req), kind: String(b.kind || ''), trip: b.trip ? String(b.trip) : null, batchId: b.batchId ? String(b.batchId) : null, files, by: who(req) });
      res.json({ docs });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/truckmate/docs', requireAuth, async (req, res) => {
    try {
      const trips = req.query.trip ? String(req.query.trip).split(',').filter(Boolean) : null;
      res.json(await listDocs({ site: siteOf(req), trips, kind: req.query.kind ? String(req.query.kind) : null }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/truckmate/docs/:id/file', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Document storage is not configured.' });
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'Bad document id.' });
    try {
      await ensureTable();
      const { rows } = await pool.query('SELECT filename, media_type, data, restricted, doc_type FROM ta_docs WHERE id = $1 AND site = $2', [req.params.id, siteOf(req)]);
      if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
      const r = rows[0];
      // Restricted (driver ID, or a whole packet containing one): only opened
      // on an explicit reveal, and every reveal is logged with who and when.
      if (r.restricted) {
        if (String(req.query.reveal || '') !== '1') return res.status(403).json({ error: 'Restricted document — confirm to view.', restricted: true, docType: r.doc_type || null });
        try {
          await db.update(`taDocAccess:${siteOf(req)}`, (cur) => {
            const list = Array.isArray(cur) ? cur : [];
            list.unshift({ id: String(req.params.id), by: who(req), at: new Date().toISOString(), docType: r.doc_type || null });
            return list.slice(0, 500);
          }, []);
        } catch { /* logging must not block viewing */ }
      }
      const name = String(r.filename || `document-${req.params.id}`).replace(/[^\w.\- ]+/g, '_');
      res.setHeader('Content-Type', r.media_type);
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(r.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Several stored pages as ONE PDF, in the order given — e.g. a trip's manifest
  // (page 1 + its continuation page). PDFs keep their pages; photos become pages.
  // Restricted pages (driver IDs) are never merged.
  app.get('/truckmate/docs/merged', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Document storage is not configured.' });
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 12);
    if (!ids.length) return res.status(400).json({ error: 'No documents asked for.' });
    try {
      await ensureTable();
      const { rows } = await pool.query('SELECT id, media_type, data, restricted FROM ta_docs WHERE site = $1 AND id = ANY($2::bigint[])', [siteOf(req), ids]);
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const out = await PDFDocument.create();
      let added = 0;
      for (const id of ids) {
        const r = byId.get(id);
        if (!r || r.restricted) continue;
        const buf = Buffer.from(r.data);
        try {
          if (/pdf/i.test(r.media_type)) {
            const src = await PDFDocument.load(buf, { ignoreEncryption: true }); // eslint-disable-line no-await-in-loop
            const pages = await out.copyPages(src, src.getPageIndices()); // eslint-disable-line no-await-in-loop
            pages.forEach((pg) => out.addPage(pg)); added += pages.length;
          } else if (/png|jpe?g/i.test(r.media_type)) {
            const img = /png/i.test(r.media_type) ? await out.embedPng(buf) : await out.embedJpg(buf); // eslint-disable-line no-await-in-loop
            const pg = out.addPage([img.width, img.height]);
            pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height }); added += 1;
          }
        } catch (e) { console.warn('[docs] merge skipped', id, e.message); }
      }
      if (!added) return res.status(404).json({ error: 'These pages are not stored as PDF or photos.' });
      const bytes = await out.save();
      const name = String(req.query.name || 'trip-sheet').replace(/[^\w.\- ]+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(bytes));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log(`[docs] original document storage ${enabled ? 'ready (Postgres)' : 'OFF — needs DATABASE_URL'}`);
  // Bytes of stored documents (for the load rundown). Restricted pages are never returned.
  async function readDocs({ site, ids }) {
    if (!enabled || !ids.length) return [];
    await ensureTable();
    const { rows } = await pool.query('SELECT id, media_type, data, restricted, kind, doc_type, page FROM ta_docs WHERE site = $1 AND id = ANY($2::bigint[])', [site, ids.map(Number)]);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    return ids.map((id) => byId.get(String(id))).filter((r) => r && !r.restricted).map((r) => ({ id: String(r.id), mediaType: r.media_type, data: Buffer.from(r.data), kind: r.kind, docType: r.doc_type, page: r.page }));
  }

  // Drop packet pages we don't keep (only the trip sheets stay) and the whole
  // scanned packet of that batch (it holds the BOLs / PODs / IDs we skip).
  async function deleteDocs({ site, ids = [], packetBatch = null }) {
    if (!enabled) return 0;
    await ensureTable();
    let n = 0;
    if (ids.length) n += (await pool.query("DELETE FROM ta_docs WHERE site = $1 AND kind = 'tripsheet' AND id = ANY($2::bigint[])", [site, ids.map(Number)])).rowCount;
    if (packetBatch) n += (await pool.query("DELETE FROM ta_docs WHERE site = $1 AND kind = 'packet' AND batch_id = $2", [site, String(packetBatch)])).rowCount;
    return n;
  }

  return { storeDocs, linkDocs, listDocs, markDocs, readDocs, deleteDocs, enabled };
}

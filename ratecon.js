// ---------------------------------------------------------------
// Rate-confirmation reader for the AI dispatcher.
//
// A dispatcher uploads the broker's rate con (PDF or image). We send it to
// Claude, which reads it natively (no OCR library needed) and returns the key
// fields — rate, stops, appointment times, reference numbers, and especially the
// SPECIAL INSTRUCTIONS — as structured JSON. The result is stored per trip so it
// shows on the TruckMate trip card and the crew can follow it.
//
//   POST /truckmate/ratecon/:trip   { dataBase64, mediaType, filename }
//   GET  /truckmate/ratecon/:trip
//
// Key lives server-side (ANTHROPIC_API_KEY); the file never leaves our backend.
// ---------------------------------------------------------------
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PROMPT = [
  'You are a freight dispatch assistant. Read this rate confirmation (rate con) and extract its details.',
  'Return ONLY a JSON object (no prose, no markdown fences) with these keys:',
  '{',
  '  "broker": string|null, "brokerPhone": string|null, "brokerEmail": string|null,',
  '  "loadNumber": string|null, "referenceNumbers": string[],',
  '  "rate": number|null, "rateText": string|null, "currency": string|null,',
  '  "equipment": string|null, "commodity": string|null, "weight": string|null,',
  '  "tempSetting": string|null,',
  '  "pickups": [{"name":string|null,"city":string|null,"state":string|null,"zip":string|null,"date":string|null,"time":string|null,"appointment":string|null,"refs":string|null}],',
  '  "deliveries": [{"name":string|null,"city":string|null,"state":string|null,"zip":string|null,"date":string|null,"time":string|null,"appointment":string|null,"refs":string|null}],',
  '  "accessorials": string[],',
  '  "specialInstructions": string[],',
  '  "detention": string|null, "lumper": string|null,',
  '  "summary": string',
  '}',
  'For "specialInstructions" capture every must-follow requirement a driver/dispatcher needs: appointment/FCFS rules, check-in steps, lumper/pallet exchange, temperature/continuous-cool, load locks, seals, PODs required, no-touch, detention terms, driver requirements, penalties, TONU, etc. Be thorough and quote the con.',
  'Use null when a field is absent. Do not invent values. "summary" is one short sentence.',
].join('\n');

export function initRateCon(app, { requireAuth, db, env = process.env, docs = null }) {
  const key = env.ANTHROPIC_API_KEY || '';
  const model = env.RATECON_MODEL || env.CAR_CHAT_MODEL || 'claude-haiku-4-5-20251001';
  const storeKey = (site) => `taTruckMateRateCon:${site}`;
  // Handling-instruction checklist lives in its OWN store so re-uploading the rate
  // con never wipes the dispatcher's sign-offs. Keyed by the instruction text so it
  // survives re-ordering. Must match the key used by the active-board overlay.
  const checkKey = (site) => `taTruckMateRcCheck:${site}`;
  const whoAmI = (req) => (req.user && (req.user.name || (req.user.email || '').split('@')[0])) || 'Dispatcher';

  app.get('/truckmate/ratecon/:trip', requireAuth, async (req, res) => {
    try {
      const site = String(req.query.site || 'florida-beauty');
      const all = (db && db.enabled) ? await db.get(storeKey(site), {}) : {};
      const checks = (db && db.enabled) ? await db.get(checkKey(site), {}) : {};
      const rec = all[String(req.params.trip)] || null;
      res.json(rec ? { ...rec, _check: checks[String(req.params.trip)] || {} } : null);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Check / uncheck one handling instruction. Records WHO signed it off and WHEN
  // as proof; unchecking clears the sign-off.
  app.post('/truckmate/ratecon/:trip/check', requireAuth, async (req, res) => {
    try {
      const site = String(req.query.site || 'florida-beauty');
      const trip = String(req.params.trip || '').trim();
      const { instruction, done } = req.body || {};
      if (!trip || !instruction) return res.status(400).json({ error: 'Missing trip or instruction.' });
      if (!(db && db.enabled)) return res.status(503).json({ error: 'No store configured.' });
      const by = whoAmI(req);
      const byEmail = (req.user && req.user.email) || null;
      const at = new Date().toISOString();
      const next = await db.update(checkKey(site), (cur) => {
        const all = { ...(cur || {}) };
        const t = { ...(all[trip] || {}) };
        if (done) t[String(instruction)] = { done: true, by, byEmail, at };
        else delete t[String(instruction)];
        all[trip] = t;
        return all;
      }, {});
      res.json(next[trip] || {});
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.post('/truckmate/ratecon/:trip', requireAuth, async (req, res) => {
    try {
      if (!key) return res.status(503).json({ error: 'AI reader not configured (ANTHROPIC_API_KEY).' });
      const trip = String(req.params.trip || '').trim();
      if (!trip) return res.status(400).json({ error: 'Missing trip.' });
      const body = req.body || {};
      // Accept a list of pages (multi-page rate cons) OR a single file (legacy).
      const pages = Array.isArray(body.pages) && body.pages.length
        ? body.pages
        : (body.dataBase64 ? [{ dataBase64: body.dataBase64, mediaType: body.mediaType, filename: body.filename }] : []);
      if (!pages.length) return res.status(400).json({ error: 'No file data.' });

      const pageIsPdf = (p) => /pdf/i.test(p.mediaType || '') || /\.pdf$/i.test(p.filename || '');
      const anyPdf = pages.some(pageIsPdf);
      // One content block per page, in order, then the extraction prompt. Claude
      // reads every page together and returns a single merged extraction.
      const content = [];
      pages.forEach((p, i) => {
        if (pages.length > 1) content.push({ type: 'text', text: `--- Page ${i + 1} of ${pages.length}${p.filename ? ` (${p.filename})` : ''} ---` });
        content.push(pageIsPdf(p)
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.dataBase64 } }
          : { type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/jpeg', data: p.dataBase64 } });
      });
      content.push({ type: 'text', text: PROMPT });

      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          ...(anyPdf ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model, max_tokens: 2200,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.error('[ratecon] anthropic', r.status, detail.slice(0, 200));
        return res.status(502).json({ error: `AI error (${r.status})` });
      }
      const j = await r.json();
      const text = (j.content || []).map((c) => c.text || '').join('').trim();
      let parsed = null;
      try {
        const m = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : text);
      } catch { parsed = { summary: 'Could not auto-parse — raw text stored.', raw: text, specialInstructions: [] }; }

      const names = pages.map((p) => p.filename).filter(Boolean);
      const filename = names.length ? (names.length > 1 ? `${names[0]} +${names.length - 1} more` : names[0]) : null;
      const site = String(req.query.site || 'florida-beauty');
      const record = { ...parsed, filename, pageCount: pages.length, uploadedAt: new Date().toISOString(), uploadedBy: whoAmI(req) };
      // Keep the ORIGINAL files (bytes, name, type) so "View PDF" opens exactly
      // what was uploaded. Each upload is a new version; older ones stay.
      if (docs && docs.enabled) {
        try {
          const stored = await docs.storeDocs({ site, kind: 'ratecon', trip, files: pages, by: whoAmI(req) });
          record.docIds = stored.map((d) => d.id);
          record.version = stored.length ? stored[0].version : null;
        } catch (e) { record.docError = `Original not stored: ${e.message}`; }
      }
      if (db && db.enabled) {
        await db.update(storeKey(site), (cur) => ({ ...(cur || {}), [trip]: record }), {});
      }
      res.json(record);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  console.log('[ratecon] rate-confirmation reader ready' + (key ? '' : ' (no ANTHROPIC_API_KEY — uploads will 503)'));
}

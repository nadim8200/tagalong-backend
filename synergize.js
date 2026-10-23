// ---------------------------------------------------------------
// ARTIS Synergize documents (POD, BOL, invoice, rate con, manifest) — looked up by BILL NUMBER, any bill type.
// Scans come as TIFF (or PDF); TIFFs are turned into a PDF so they open anywhere, then kept on the trip
// (kind "artisdoc"). Read-only, same ARTIS web login.
//  • twice a day (11 AM / 5 PM Miami) for loads with a few bills (broker / produce loads) — while active and for
//    5 days after they leave the board (documents arrive after delivery);
//  • on demand for a stop's bills (LTL runs have 100+ bills — too many to poll) and for Jarvis.
// ---------------------------------------------------------------
import UTIF from 'utif2';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';
import { pageVar } from './artisreports.js';

const { PNG } = pngjs;
const SITE = 'florida-beauty';
const KEY = `taSynergize:${SITE}`;
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const MAX_BILLS_AUTO = 12;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
export const DOC_TYPES = ['POD', 'BOL', 'Invoice', 'Rate Confirmation', 'Manifest'];
const CUSTOMER_OK = new Set(['POD', 'BOL']);   // what a customer / broker may receive (dispatch approves the email)

// "Rate Confirmation" + B180474 → "RateCon-B180474.pdf". Pure.
export function docFileName(d) {
  const t = { 'Rate Confirmation': 'RateCon', Invoice: 'Invoice', POD: 'POD', BOL: 'BOL', Manifest: 'Manifest' }[d.In_DocTypeName] || String(d.In_DocTypeName || 'Document').replace(/\W+/g, '');
  return `${t}-${String(d.Bill_Number || 'bill').trim()}-${String(d.In_DocId || '').replace(/\W+/g, '')}.pdf`;
}
// One scanned page, made small enough to keep: at most ~150 dpi on a letter page (1275 px wide); fax scans
// (CCITT, black & white) as a grayscale PNG, photos / colour scans as a JPEG. Pure.
export function pagePixels(rgba, w, h, compression = null, maxW = 1275) {
  const k = Math.max(1, w / maxW);
  const W = Math.max(1, Math.round(w / k)); const H = Math.max(1, Math.round(h / k));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(h - 1, Math.floor(y * k));
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(w - 1, Math.floor(x * k)); const i = (sy * w + sx) * 4; const o = (y * W + x) * 4;
      out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; out[o + 3] = 255;
    }
  }
  if (compression === 2 || compression === 3 || compression === 4) {   // CCITT fax → grayscale PNG (tiny)
    const png = new PNG({ width: W, height: H, colorType: 0, inputColorType: 6 });
    png.data = out;
    return { w: W, h: H, jpeg: false, bytes: PNG.sync.write(png, { colorType: 0, inputColorType: 6 }) };
  }
  return { w: W, h: H, jpeg: true, bytes: Buffer.from(jpeg.encode({ data: out, width: W, height: H }, 72).data) };
}
// a scan from ARTIS → a PDF (TIFF pages → PDF pages; JPEG / PNG → one page; PDF as is; zip etc. → null)
export async function toPdf(buf, type = '') {
  const head = buf.slice(0, 4).toString('latin1');
  if (head === '%PDF' || /pdf/.test(type)) return buf;
  const pdf = await PDFDocument.create();
  if (head === 'II*\u0000' || head === 'MM\u0000*' || /tif/.test(type)) {
    const ifds = UTIF.decode(buf);
    for (const ifd of ifds.slice(0, 60)) {
      UTIF.decodeImage(buf, ifd);
      const w = ifd.width; const h = ifd.height;
      if (!w || !h) continue;
      const page = pagePixels(UTIF.toRGBA8(ifd), w, h, ifd.t259 && ifd.t259[0]);
      const bytes = Uint8Array.from(page.bytes);   // its own memory — pdf-lib reads the whole underlying buffer
      const img = page.jpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
      const s = Math.min(612 / page.w, 792 / page.h);   // fit to a letter page
      const p = pdf.addPage([page.w * s, page.h * s]);
      p.drawImage(img, { x: 0, y: 0, width: page.w * s, height: page.h * s });
    }
  } else if (head.startsWith('ÿØ') || /jpe?g/.test(type)) {
    const img = await pdf.embedJpg(Uint8Array.from(buf)); const page = pdf.addPage([img.width, img.height]); page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  } else if (head.startsWith('\u0089PNG') || /png/.test(type)) {
    const img = await pdf.embedPng(Uint8Array.from(buf)); const page = pdf.addPage([img.width, img.height]); page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  } else return null;
  return pdf.getPageCount() ? Buffer.from(await pdf.save()) : null;
}
// When the twice-a-day check is due (11 AM / 5 PM Miami). Pure.
export function syncSlotDue(state = {}, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const slot = Number(p.hour) >= 17 ? 'pm' : Number(p.hour) >= 11 ? 'am' : null;
  const k = slot ? `${p.year}-${p.month}-${p.day}|${slot}` : null;
  return k && !(state.done || {})[k] ? k : null;
}

export function initSynergize(app, { requireAuth, requireAdmin = null, db, docs, artisWeb, getBoard = null, nameFits = null, now = () => Date.now() }) {
  const enabled = () => !!(db && db.enabled && artisWeb && artisWeb.ready && artisWeb.ready() && docs && docs.storeDocs);
  const st = async () => (await db.get(KEY, null)) || { trips: {}, docs: {}, watch: {}, done: {} };

  async function listDocs(bill) {
    const list = pageVar(await artisWeb.fetchText(`/shipDocs/listDocs?billNumber=${encodeURIComponent(bill)}`), 'documents');
    if (!Array.isArray(list)) throw new Error('ARTIS documents page had no data (session?)');
    return list;
  }
  // check these bills of a trip; store any document not stored yet → the trip's ARTIS documents
  async function checkBills(trip, bills, by = 'Jarvis (ARTIS)') {
    const s = await st();
    const known = s.docs || {};
    const found = [];
    for (const bill of [...new Set(bills.map(String).filter(Boolean))]) {
      let list = [];
      try { list = await listDocs(bill); } catch (e) { if (/session|sign-in/i.test(e.message)) throw e; continue; } // eslint-disable-line no-await-in-loop
      for (const d of list) {
        const id = String(d.In_DocId || d.In_DocIdentifier || '');
        if (!id) continue;
        if (known[id]) { found.push(known[id]); continue; }
        // ARTIS pads some bill numbers with a space
        const meta = { artisId: id, bill: String(d.Bill_Number || bill).trim(), type: d.In_DocTypeName || 'Document', created: d.In_DocCreated || null, createdMs: d.In_DocCreatedTs || null, billTo: d.BILL_TO_NAME || null, original: d.In_DocName || null };
        try {
          const q = new URLSearchParams(Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)));
          const raw = await artisWeb.fetchBuffer(`/shipDocs/getDoc?${q}`); // eslint-disable-line no-await-in-loop
          const pdf = await toPdf(raw.buf, raw.type); // eslint-disable-line no-await-in-loop
          if (!pdf) { known[id] = { ...meta, docId: null, note: `${String(d.In_DocName || '').split('.').pop() || 'file'} — open it in ARTIS` }; found.push(known[id]); continue; }
          const [stored] = await docs.storeDocs({ site: SITE, kind: 'artisdoc', trip, files: [{ filename: docFileName(d), mediaType: 'application/pdf', dataBase64: pdf.toString('base64') }], by }); // eslint-disable-line no-await-in-loop
          known[id] = { ...meta, docId: String(stored.id), name: docFileName(d) };
          found.push(known[id]);
        } catch (e) { console.warn('[synergize]', bill, e.message); }
      }
    }
    await db.update(KEY, (cur) => {
      const c = cur || { trips: {}, docs: {}, watch: {}, done: {} };
      const mine = new Map(((c.trips || {})[trip] || []).map((x) => [x.artisId, x]));
      for (const f of found) mine.set(f.artisId, f);
      return { ...c, docs: { ...(c.docs || {}), ...known }, trips: { ...(c.trips || {}), [trip]: [...mine.values()] } };
    }, {});
    return found;
  }

  // twice a day: loads with a few bills, while on the board and 5 days after
  async function sync() {
    const items = getBoard ? (((await getBoard(SITE)) || {}).trips || []) : [];
    const s = await st();
    const watch = { ...(s.watch || {}) };
    for (const it of items) {
      const b = billsOf(it).map((x) => x.billNumber).filter(Boolean);
      if (b.length && b.length <= MAX_BILLS_AUTO) watch[tripNo(it)] = { bills: b, until: now() + 5 * DAY };
    }
    let checked = 0; let found = 0;
    for (const [trip, w] of Object.entries(watch)) {
      if (w.until < now()) { delete watch[trip]; continue; }
      const f = await checkBills(trip, w.bills); checked += 1; found += f.length; // eslint-disable-line no-await-in-loop
    }
    await db.update(KEY, (cur) => ({ ...(cur || {}), watch }), {});
    return { trips: checked, documents: found };
  }
  async function overlay(site, trips) {
    if (!(db && db.enabled)) return;
    const s = await st();
    for (const it of trips) { const d = (s.trips || {})[tripNo(it)]; if (d && d.length) it._artisDocs = d; }
  }
  // Jarvis / email: a load's documents (optionally one type), checked now. customer: only POD / BOL, only their load
  async function forTrip({ item, bills = null, type = null, customer = null }) {
    const trip = tripNo(item);
    let list = billsOf(item);
    if (customer && nameFits) list = list.filter((b) => nameFits(customer, b.billToName || '') || nameFits(customer, (b.consignee && (b.consignee.name || b.consignee.clientName)) || ''));
    if (customer && !list.length) return { allowed: false, documents: [] };
    const want = bills && bills.length ? bills : list.map((b) => b.billNumber).filter(Boolean).slice(0, 40);
    const found = await checkBills(trip, want);
    const wanted = new Set(want.map((b) => String(b).trim().toUpperCase()));
    const docsOut = found.filter((d) => (!type || new RegExp(type, 'i').test(d.type)) && (!customer || CUSTOMER_OK.has(d.type)) && wanted.has(String(d.bill).trim().toUpperCase()));
    return { allowed: true, documents: docsOut, checkedBills: want.length };
  }

  if (enabled()) {
    const t = setInterval(async () => {
      try {
        const s = await st(); const k = syncSlotDue(s, now()); if (!k) return;
        await db.update(KEY, (cur) => ({ ...(cur || {}), done: Object.fromEntries([...Object.entries(((cur && cur.done) || {})), [k, new Date(now()).toISOString()]].slice(-20)) }), {});
        const r = await sync(); console.log(`[synergize] ${k}: ${r.trips} loads checked, ${r.documents} documents`);
      } catch (e) { console.warn('[synergize]', e.message); }
    }, 10 * MIN);
    if (t.unref) t.unref();
  }

  // the console: check a stop's bills (or the whole small load) now
  app.post('/truckmate/artis/documents/:trip', requireAuth, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'ARTIS web login is not set up.' });
    try {
      const trip = String(req.params.trip || '').replace(/\D/g, '');
      const bills = (Array.isArray(req.body && req.body.bills) ? req.body.bills : []).map((b) => String(b).replace(/[^\w-]/g, '')).filter(Boolean).slice(0, 60);
      const item = (((getBoard ? await getBoard(SITE) : null) || {}).trips || []).find((x) => tripNo(x) === trip) || null;
      const use = bills.length ? bills : (item ? billsOf(item).map((b) => b.billNumber).filter(Boolean).slice(0, 60) : []);
      if (!use.length) return res.status(400).json({ error: 'Which bills?' });
      const by = (req.user && (req.user.name || req.user.email)) || 'dispatcher';
      return res.json({ documents: await checkBills(trip, use, `${by} (ARTIS)`), checkedBills: use.length });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  });
  app.post('/truckmate/artis/documents-sync', requireAdmin || requireAuth, async (req, res) => { try { res.json(await sync()); } catch (e) { res.status(502).json({ error: e.message }); } });

  return { checkBills, sync, overlay, forTrip };
}

// ---------------------------------------------------------------
// ARTIS Synergize documents (POD, BOL, invoice, rate con, manifest) — looked up by BILL NUMBER, any bill type.
// Scans come as TIFF (or PDF); TIFFs are turned into a PDF so they open anywhere, then kept on the trip
// (kind "artisdoc"). Read-only, same ARTIS web login.
//  • twice a day (11 AM / 5 PM Miami) for loads with a few bills (broker / produce loads) — while active and for
//    5 days after they leave the board (documents arrive after delivery);
//  • BROKER loads (B bills) every 2 hours 6 AM–10 PM while on the board (first check right when they show up);
//    a rate con found there is read and put on the load when it has none (dispatch's upload always wins);
//  • on demand for a stop's bills (LTL runs have 100+ bills — too many to poll) and for Jarvis.
// ---------------------------------------------------------------
import UTIF from 'utif2';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';
import { pageVar } from './artisreports.js';
import { brokerLoad } from './watchtower.js';
import { TRAINING_SLOT } from './latemail.js';

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

// Broker loads to check now: never checked, or last checked 2+ h ago — only 6 AM–10 PM Miami. Pure.
export function brokerDue(items = [], checked = {}, now = Date.now(), every = 2 * 60 * MIN) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
  if (h < 6 || h >= 22) return [];
  return items.filter((it) => brokerLoad(it) && !it._oc && now - (checked[tripNo(it)] || 0) >= every);
}

// Billing gets the paperwork: one email per load with the POD / BOL Jarvis just found in Synergize (attached).
// Pure — returns { subject, html }. docs: [{ type, bill, created, name }]; rc: the load's rate con (optional).
export const BILLING_TYPES = /^(POD|BOL|Bill of Lading|Proof of Delivery)/i;
const escB = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function billingEmail({ trip, docs = [], item = null, rc = null, note = null, fallback = null }) {
  const C = { text: '#172538', muted: '#596A7F', line: '#E2E8F0', blue: '#1D4ED8', blueBg: '#EFF6FF', blueLine: '#BFDBFE', amber: '#B7791F', amberText: '#754C12', amberBg: '#FFF7E7', amberLine: '#F3D9A4', white: '#FFFFFF', page: '#F4F6F9', red: '#DC2626' };
  const FONT = 'Arial, Helvetica, sans-serif';
  const t = tripOf(item);
  const bills = [...new Set(docs.map((d) => d.bill).filter(Boolean))];
  const billTo = [...new Set([...docs.map((d) => d.billTo), ...billsOf(item).filter((b) => bills.includes(String(b.billNumber))).map((b) => b.billToName)].filter(Boolean).map((x) => String(x).replace(/\s*[*>]+\s*$/, '').trim()))];
  const kindOf = (d) => (/^POD|Proof/i.test(d.type) ? 'POD' : 'BOL');
  const kindList = [...new Set(docs.map(kindOf))];
  const kinds = kindList.join(' + ');
  const delivered = billsOf(item).filter((b) => bills.includes(String(b.billNumber)) && b.actualDelivery).map((b) => b.actualDelivery).sort().pop() || null;
  // TruckMate / Synergize times as written (no timezone given) → "Oct 24, 2026 · 8:07 PM". Pure.
  const when = (v) => {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return v ? String(v) : null;
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
    const day = `${mon} ${Number(m[3])}, ${m[1]}`;
    if (m[4] == null) return day;
    const h = Number(m[4]);
    return `${day} · ${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const size = (n) => (n == null ? null : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const subject = `${kinds} for billing — Trip ${trip}${bills.length ? ` · ${bills.join(', ')}` : ''}${billTo.length ? ` · ${billTo[0]}` : ''}`;
  const attached = docs.filter((d) => d.attached !== false);
  const missing = docs.filter((d) => d.attached === false);
  const label = kindList.length === 1 ? (kindList[0] === 'POD' ? 'Proof of delivery received' : 'Bill of lading received') : 'Delivery paperwork received';
  const what = (list) => { const k = [...new Set(list.map(kindOf))]; return `${k.join(' and ')}${list.length > 1 && k.length === 1 ? 's' : ''}`; };
  const bolOnly = kindList.length === 1 && kindList[0] === 'BOL';
  const notMarked = !delivered && !!item;   // on the board, TruckMate hasn't marked it delivered (≠ not delivered)
  const bolIntro = () => {
    const many = docs.length > 1;
    const head = many ? 'Bills of lading were received through Synergize.' : 'A bill of lading was received through Synergize.';
    if (!missing.length) return `${head} ${many ? 'The documents are' : 'The document is'} attached for billing review.`;
    if (!attached.length) return `${head} ${many ? 'They were' : 'It was'} too large to attach — open ${many ? 'them' : 'it'} on the trip in the console.`;
    return `${head} ${attached.length} ${attached.length > 1 ? 'are' : 'is'} attached for billing review; ${missing.length} ${missing.length > 1 ? 'were' : 'was'} too large to attach — open ${missing.length > 1 ? 'them' : 'it'} on the trip in the console.`;
  };
  const intro = `New delivery paperwork was received through Synergize.${attached.length ? ` The ${what(attached)} ${attached.length > 1 ? 'are' : 'is'} attached for billing review.` : ''}${missing.length ? ` The ${what(missing)} ${missing.length > 1 ? 'were' : 'was'} too large to attach — open ${missing.length > 1 ? 'them' : 'it'} on the trip in the console.` : ''}`;
  const next = bolOnly
    ? `${attached.length ? `Review the attached ${what(attached)}.` : `Review the ${what(docs)} on the trip in the console.`}${notMarked ? ' Delivery is not yet marked in TruckMate.' : ''}`
    : attached.length ? `Review the attached ${what(attached)} for billing.` : `Review the ${what(docs)} on the trip in the console for billing.`;
  const deliveredText = delivered ? when(delivered) : (item ? 'Not marked delivered in TruckMate yet' : null);
  const rows = [
    ['Trip', String(trip)],
    [bills.length > 1 ? 'Bills' : 'Bill', bills.join(', ') || null],
    ['Bill to', billTo.join(', ') || null],
    ['Truck', t.powerUnit || null],
    ['Trailer', t.trailer || null],
    bolOnly ? ['Delivery status', delivered ? `Delivered · ${when(delivered)}` : item ? 'Not marked delivered in TruckMate' : 'Unavailable — the load is no longer on the board', !delivered, notMarked ? 'amber' : null] : ['Delivered', deliveredText, !delivered],
    rc ? ['Broker', [rc.broker, rc.loadNumber && `load ${rc.loadNumber}`].filter(Boolean).join(' · ') || null] : null,
    rc ? ['Rate (rate con)', rc.rateText || (rc.rate != null ? `$${rc.rate}` : null)] : null,
    rc && (rc.accessorials || []).length ? ['Extras on the rate con', rc.accessorials.join('; ')] : null,
  ].filter((r) => r && r[1]);
  const showFallback = fallback != null ? fallback : !!note;

  // ---- plain text (same order) ----
  const text = [
    'FLORIDA BEAUTY FLORA — Dispatch notifications', '',
    label.toUpperCase(),
    billTo.join(', ') || null,
    `Trip ${trip}${bills.length ? ` · ${bills.length > 1 ? 'Bills' : 'Bill'} ${bills.join(', ')}` : ''}`, '',
    bolOnly ? bolIntro() : intro, '',
    'SHIPMENT DETAILS', ...rows.map(([k, v]) => `${k}: ${v}`), '',
    docs.length > 1 ? `ATTACHED DOCUMENTS · ${docs.length}` : 'ATTACHED DOCUMENT',
    ...docs.map((d) => [`${d.type} · Bill ${d.bill || '—'}`, d.name || null, ['PDF', d.attached === false ? null : size(d.bytes && d.bytes.length)].filter(Boolean).join(' · '), d.created ? `Scanned ${when(d.created)}` : null, d.attached === false ? 'Too large to attach — open it on the trip in the console' : null].filter(Boolean).join('\n  ')), '',
    'NEXT STEP', next, '',
    showFallback ? 'ROUTING NOTICE\nThe Accounting email group is not configured. Dispatch is the designated fallback recipient.\n(Add Accounting\'s email under Employees → Email groups.)\n' : null,
    'Jarvis', 'AI Dispatcher · Florida Beauty Flora', 'Document source: Synergize',
  ].filter((l) => l != null).join('\n');

  // ---- HTML ----
  const lbl = (x, color = C.muted) => `<div style="font-family:${FONT};font-size:11px;line-height:1.5;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${x}</div>`;
  const section = (inner, pad = '16px 24px') => `<tr><td style="padding:${pad};background:${C.white};">${inner}</td></tr>`;
  const divider = `<tr><td style="padding:0 24px;background:${C.white};"><div style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;
  const h2 = (x) => `<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};margin-bottom:8px;">${x}</div>`;
  const rowsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:6px;">${rows.map(([k, v, muted, tone], i) => `<tr><td class="bm-k" valign="top" width="150" style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.muted};padding:8px 12px;${i ? `border-top:1px solid ${C.line};` : ''}">${escB(k)}</td><td valign="top" style="font-family:${FONT};font-size:15px;line-height:1.5;color:${muted ? C.muted : C.text};padding:8px 12px;${i ? `border-top:1px solid ${C.line};` : ''}word-break:break-word;overflow-wrap:anywhere;">${tone === 'amber' ? `<span style="display:inline-block;background:${C.amberBg};border:1px solid ${C.amberLine};border-radius:4px;padding:1px 8px;color:${C.amberText};font-size:14px;">${escB(v)}</span>` : escB(v)}</td></tr>`).join('')}</table>`;
  const card = (d) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:6px;margin-bottom:8px;"><tr>
<td valign="top" width="52" style="padding:12px 0 12px 12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="38" height="44" bgcolor="${C.red}" style="background:${C.red};border-radius:4px;font-family:${FONT};font-size:11px;font-weight:bold;color:#FFFFFF;">PDF</td></tr></table></td>
<td valign="top" style="padding:12px 12px 12px 10px;font-family:${FONT};word-break:break-word;overflow-wrap:anywhere;">
<div style="font-size:15px;line-height:1.4;font-weight:bold;color:${C.text};">${escB(d.type)} · Bill ${escB(d.bill || '—')}</div>
${d.name ? `<div style="font-size:13px;line-height:1.5;color:${C.text};">${escB(d.name)}</div>` : ''}
<div style="font-size:13px;line-height:1.5;color:${C.muted};">${escB(['PDF', d.attached === false ? null : size(d.bytes && d.bytes.length)].filter(Boolean).join(' · '))}</div>
${d.created ? `<div style="font-size:13px;line-height:1.5;color:${C.muted};">Scanned ${escB(when(d.created))}</div>` : ''}
${d.attached === false ? `<div style="font-size:13px;line-height:1.5;color:${C.amberText};font-weight:bold;">Too large to attach — open it on the trip in the console</div>` : ''}
</td></tr></table>`;
  const html = `<style>@media only screen and (max-width:620px){.bm-wrap{padding:10px !important;}.bm-k{width:92px !important;padding-right:6px !important;}}</style>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td class="bm-wrap" align="center" style="padding:20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.white}" style="max-width:600px;width:100%;background:${C.white};border:1px solid ${C.line};border-radius:8px;">
${section(`<div style="font-family:${FONT};font-size:15px;line-height:1.3;font-weight:bold;letter-spacing:0.12em;color:${C.text};">FLORIDA BEAUTY FLORA</div><div style="font-family:${FONT};font-size:12px;line-height:1.4;color:${C.muted};">Dispatch notifications</div>`, '18px 24px 6px')}
${TRAINING_SLOT}
${section(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding:2px 10px 0 0;"><div style="width:22px;height:26px;border:2px solid ${C.blue};border-radius:3px;font-family:${FONT};font-size:10px;line-height:26px;text-align:center;color:${C.blue};font-weight:bold;">&#8801;</div></td><td valign="top">
${lbl(escB(label), C.blue)}
${billTo.length ? `<div style="font-family:${FONT};font-size:24px;line-height:1.25;font-weight:bold;color:${C.text};margin:4px 0;word-break:break-word;overflow-wrap:anywhere;">${escB(billTo.join(', '))}</div>` : ''}
<div style="font-family:${FONT};font-size:16px;line-height:1.5;color:${C.text};">Trip ${escB(trip)}${bills.length ? ` · ${bills.length > 1 ? 'Bills' : 'Bill'} ${escB(bills.join(', '))}` : ''}</div>
</td></tr></table>
<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.text};margin-top:12px;">${escB(bolOnly ? bolIntro() : intro)}</div>`, '16px 24px 14px')}
${section(`${h2('Shipment details')}${rowsHtml}`)}
${section(`${h2(docs.length > 1 ? `Attached documents · ${docs.length}` : 'Attached document')}${docs.map(card).join('')}`, '6px 24px 10px')}
${section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.blueBg}" style="background:${C.blueBg};border:1px solid ${C.blueLine};border-left:4px solid ${C.blue};border-radius:6px;padding:12px 16px;">
${lbl('Next step', C.blue)}<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.text};">${escB(next)}</div></td></tr></table>`, '6px 24px 14px')}
${showFallback ? section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.amberBg}" style="background:${C.amberBg};border:1px solid ${C.amberLine};border-left:4px solid ${C.amber};border-radius:6px;padding:12px 16px;">
${lbl('Routing notice', C.amberText)}<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.amberText};">The Accounting email group is not configured. Dispatch is the designated fallback recipient.</div>
<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.amberText};margin-top:4px;">Add Accounting's email under Employees → Email groups.</div></td></tr></table>`, '0 24px 14px') : ''}
${divider}
${section(`<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};">Jarvis</div>
<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">AI Dispatcher · Florida Beauty Flora</div>
<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">Document source: Synergize</div>`, '14px 24px 22px')}
</table>
</td></tr></table>`;
  return { subject, html, text };
}

export function initSynergize(app, { requireAuth, requireAdmin = null, db, docs, artisWeb, getBoard = null, nameFits = null, onRateCon = null, onBillingDocs = null, now = () => Date.now() }) {
  const enabled = () => !!(db && db.enabled && artisWeb && artisWeb.ready && artisWeb.ready() && docs && docs.storeDocs);
  const st = async () => (await db.get(KEY, null)) || { trips: {}, docs: {}, watch: {}, done: {} };

  async function listDocs(bill) {
    const list = pageVar(await artisWeb.fetchText(`/shipDocs/listDocs?billNumber=${encodeURIComponent(bill)}`), 'documents');
    if (!Array.isArray(list)) throw new Error('ARTIS documents page had no data (session?)');
    return list;
  }
  // check these bills of a trip; store any document not stored yet → the trip's ARTIS documents
  async function checkBills(trip, bills, by = 'Jarvis (Synergize)') {
    const s = await st();
    const known = s.docs || {};
    const found = [];
    const forBilling = [];   // new POD / BOL found this time → billing
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
          if (!pdf) { known[id] = { ...meta, docId: null, note: `${String(d.In_DocName || '').split('.').pop() || 'file'} — open it in Synergize` }; found.push(known[id]); continue; }
          const [stored] = await docs.storeDocs({ site: SITE, kind: 'artisdoc', trip, files: [{ filename: docFileName(d), mediaType: 'application/pdf', dataBase64: pdf.toString('base64') }], by }); // eslint-disable-line no-await-in-loop
          known[id] = { ...meta, docId: String(stored.id), name: docFileName(d) };
          found.push(known[id]);
          if (BILLING_TYPES.test(meta.type)) forBilling.push({ ...known[id], bytes: pdf });
          // a rate con in ARTIS → on the load when dispatch hasn't put one there
          if (onRateCon && /rate/i.test(meta.type)) await onRateCon(trip, { filename: docFileName(d), dataBase64: pdf.toString('base64') }).catch((e) => console.warn('[synergize] rate con:', e.message)); // eslint-disable-line no-await-in-loop
        } catch (e) { console.warn('[synergize]', bill, e.message); }
      }
    }
    if (forBilling.length && onBillingDocs) await onBillingDocs(trip, forBilling).catch((e) => console.warn('[synergize] billing email:', e.message));
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
        const s = await st(); const k = syncSlotDue(s, now());
        if (k) {
        await db.update(KEY, (cur) => ({ ...(cur || {}), done: Object.fromEntries([...Object.entries(((cur && cur.done) || {})), [k, new Date(now()).toISOString()]].slice(-20)) }), {});
        const r = await sync(); console.log(`[synergize] ${k}: ${r.trips} loads checked, ${r.documents} documents`);
        }
      } catch (e) { console.warn('[synergize]', e.message); }
      // broker loads: every 2 hours (and right when they show up)
      try {
        const items = getBoard ? (((await getBoard(SITE)) || {}).trips || []) : [];
        const s = await st();
        const due = brokerDue(items, s.brokerChecked || {}, now()).slice(0, 15);
        for (const it of due) {
          const b = billsOf(it).map((x) => x.billNumber).filter(Boolean);
          await checkBills(tripNo(it), b); // eslint-disable-line no-await-in-loop
          await db.update(KEY, (cur) => ({ ...(cur || {}), brokerChecked: Object.fromEntries(Object.entries({ ...((cur && cur.brokerChecked) || {}), [tripNo(it)]: now() }).slice(-300)) }), {}); // eslint-disable-line no-await-in-loop
        }
        if (due.length) console.log(`[synergize] broker loads: ${due.length} checked`);
      } catch (e) { console.warn('[synergize] broker:', e.message); }
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

  // an example of the billing email from documents already found (a given trip, else the latest with a POD / BOL)
  async function billingExample(trip = null) {
    if (!onBillingDocs) return { ok: false, error: 'Billing email is not wired.' };
    const s0 = await st();
    const want = trip ? String(trip).replace(/\D/g, '') : null;
    const pick = Object.entries(s0.trips || {})
      .map(([n, list]) => [n, (list || []).filter((d) => d && d.docId && BILLING_TYPES.test(d.type || ''))])
      .filter(([n, l]) => l.length && (!want || n === want))
      .sort((a, b) => Math.max(...b[1].map((d) => Number(d.createdMs) || 0)) - Math.max(...a[1].map((d) => Number(d.createdMs) || 0)))[0];
    if (!pick) return { ok: false, error: want ? `No POD / BOL from Synergize stored for trip ${want}.` : 'No POD / BOL from Synergize stored yet.' };
    const [n, list] = pick;
    const files = await docs.readDocs({ site: SITE, ids: list.map((d) => String(d.docId)) });
    const byId = new Map(files.map((f) => [String(f.id), f]));
    const found = list.map((d) => ({ ...d, bytes: (byId.get(String(d.docId)) || {}).data || null })).filter((d) => d.bytes);
    if (!found.length) return { ok: false, error: `Trip ${n}'s documents could not be read.` };
    await onBillingDocs(n, found);
    return { ok: true, trip: n, documents: found.map((d) => `${d.type} ${d.bill}`) };
  }

  return { billingExample, checkBills, sync, overlay, forTrip };
}

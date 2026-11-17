// ---------------------------------------------------------------
// Driver Release Form (the company's own form — RELEASE B180942.xlsx): the Release button on a load card opens it filled
// from what Jarvis knows (TruckMate: FB#, truck, trailer, drivers + IDs, trip; the rate con: broker, shipper, temperature,
// commodity, up to 4 deliveries with consignee, address, date, time, lumper), the dispatcher checks it and submits, and it is
// emailed as a PDF laid out like the form (FBF logo + truck banner) with the rate con attached. Who it goes to is typed on the
// form: the two dispatch inboxes are on it every time it opens (one can be taken off for a release), plus any added (the last extra list used is remembered). A record of every release stays on the load.
// ---------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const SITE = 'florida-beauty';
const SENT = (site) => `taReleases:${site}`;     // trip → [{ at, by, to, fields }]
const LAST_TO = 'taReleaseTo';                   // the extra recipients used last time
export const ALWAYS_TO = ['yard_dispatch@floridabeauty.us', 'inbound-dispatch@floridabeauty.us'];   // on every release form when it opens
const ASSET = (f) => { try { return readFileSync(new URL(`./assets/release/${f}`, import.meta.url)); } catch { return null; } };
const LOGO = ASSET('fbf-logo.png');
const BANNER = ASSET('driver-release-banner.png');
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const clean = (x, n = 120) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_STOPS = 4;
const ET = 'America/New_York';
const nowDate = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: ET, month: '2-digit', day: '2-digit', year: 'numeric' });
const nowTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).replace(' ', '');

// The form filled from the load (every field stays editable on the console). Pure.
export function releaseDraft(item, { by = '', now = Date.now() } = {}) {
  const t = tripOf(item); const s = (item && item._samsara) || {};
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  const bills = ((item && item.freightBills) || []).map((b) => b || {});
  const fb = (bills.find((b) => /^B\d/i.test(String(b.billNumber || ''))) || bills[0] || {}).billNumber || rc.fbfBillNumber || '';
  const temps = [...new Set(bills.map((b) => b.temperature).filter((v) => v != null && v !== ''))];
  const pu = (rc.pickups || [])[0] || {};
  const place = (x) => [x.city, [x.state, x.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const stops = (rc.deliveries || []).slice(0, MAX_STOPS).map((d) => ({
    date: clean(d.date, 20), time: clean(d.time || d.appointment, 30), consignee: clean(d.name, 80), address: clean(d.address, 100),
    city: clean(d.city, 40), state: clean(d.state, 2).toUpperCase(), zip: clean(d.zip, 10), cityStateZip: clean(place(d), 60), lumper: '', signSlc: true,
  }));
  return {
    approvedBy: clean(by, 60), signature: clean(by, 60), date: nowDate(now), time: nowTime(now),
    fb: clean(fb, 20), truck: clean(t.powerUnit, 12), trailer: clean(t.trailer, 16), trip: tripNo(item),
    driver1: clean(s.driver1, 50), driver1Id: clean(t.driver, 12), driver2: clean(s.driver2, 50), driver2Id: clean(t.driver2, 12),
    broker: clean(rc.broker, 60), shipper: clean(pu.name, 60),
    temp: clean(rc.tempSetting || (temps.length === 1 ? `${temps[0]}F` : temps.map((x) => `${x}F`).join(' / ')), 30),
    commodity: clean(rc.commodity || (bills[0] || {}).commodity, 80), comments: '',
    stops: stops.length ? stops : [{ date: '', time: '', consignee: '', address: '', city: '', state: '', zip: '', cityStateZip: '', lumper: '', signSlc: true }],
  };
}

// What the dispatcher sent, made safe: plain text, capped, at most 4 deliveries. Pure.
export function cleanForm(f = {}) {
  const k = (n, m) => clean(f[n], m);
  return {
    approvedBy: k('approvedBy', 60), signature: k('signature', 60), date: k('date', 20), time: k('time', 20), fb: k('fb', 20), truck: k('truck', 12), trailer: k('trailer', 16), trip: k('trip', 12),
    driver1: k('driver1', 50), driver1Id: k('driver1Id', 12), driver2: k('driver2', 50), driver2Id: k('driver2Id', 12), broker: k('broker', 60), shipper: k('shipper', 60),
    temp: k('temp', 30), commodity: k('commodity', 80), comments: clean(f.comments, 400),
    stops: (Array.isArray(f.stops) ? f.stops : []).slice(0, MAX_STOPS).map((x) => {
      // the console edits city, state and ZIP separately; the PDF line is "CITY, ST ZIP" (an older form's one-line value still works)
      const city = clean(x.city, 40); const st = clean(x.state, 2).toUpperCase(); const zip = clean(x.zip, 10);
      const line = city || st || zip ? [city, [st, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : clean(x.cityStateZip, 60);
      return { date: clean(x.date, 20), time: clean(x.time, 30), consignee: clean(x.consignee, 80), address: clean(x.address, 100), city, state: st, zip, cityStateZip: line, lumper: clean(x.lumper, 40), signSlc: x.signSlc !== false };
    }),
  };
}

// The PDF, laid out like the company's Driver Release Form. → Uint8Array
export async function releasePdf(f) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);   // US letter
  const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.13, 0.24); const line = rgb(0.6, 0.65, 0.72); const red = rgb(0.55, 0.05, 0.12);
  // pdf-lib's standard fonts take WinAnsi only: anything else becomes '?'
  const safe = (x) => String(x == null ? '' : x).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const text = (x, at, y, { size = 9.5, f: fn = font, color = ink } = {}) => page.drawText(safe(x), { x: at, y, size, font: fn, color });
  const field = (label, value, x, y, w) => {
    text(label, x, y, { size: 8.5, f: bold });
    const lx = x + bold.widthOfTextAtSize(label, 8.5) + 4;
    page.drawLine({ start: { x: lx, y: y - 2 }, end: { x: x + w, y: y - 2 }, thickness: 0.6, color: line });
    if (value) text(value, lx + 2, y, { size: 9.5 });
  };
  let y = 752;
  if (LOGO) { const img = await pdf.embedPng(LOGO); page.drawImage(img, { x: 36, y: y - 36, width: 72, height: 43 }); }
  if (BANNER) { const img = await pdf.embedPng(BANNER); page.drawImage(img, { x: 130, y: y - 30, width: 440, height: 57 }); }
  y -= 64;
  field('APPROVED BY:', f.approvedBy, 36, y, 300); field('SIGNATURE:', f.signature, 330, y, 246); y -= 22;
  field('DATE:', f.date, 36, y, 110); field('TIME:', f.time, 152, y, 80); field('FB:', f.fb, 238, y, 90); field('TRUCK#', f.truck, 334, y, 104); field('TRAILER#', f.trailer, 444, y, 132); y -= 22;
  field('DRIVER:', f.driver1, 36, y, 230); field('ID:', f.driver1Id, 270, y, 60); field('DRIVER:', f.driver2, 336, y, 180); field('ID:', f.driver2Id, 520, y, 56); y -= 22;
  field('BROKER:', f.broker, 36, y, 290); field('SHIPPER:', f.shipper, 330, y, 246); y -= 26;
  field('TEMP:', f.temp, 36, y, 90); field('COMMENTS:', f.comments.slice(0, 70), 132, y, 330); field('TRIP#', f.trip, 468, y, 108); y -= 22;
  if (f.comments.length > 70) { text(f.comments.slice(70, 160), 182, y + 8, { size: 8.5 }); y -= 6; }
  field('COMMODITY:', f.commodity, 36, y, 540); y -= 18;
  const names = ['1ST', '2ND', '3RD', '4TH'];
  for (let i = 0; i < MAX_STOPS; i += 1) {
    const s = f.stops[i] || {};
    y -= 8;
    page.drawRectangle({ x: 32, y: y - 92, width: 548, height: 100, borderColor: line, borderWidth: 0.6 });
    text(`${names[i]} DELIVERY`, 40, y - 4, { size: 10, f: bold, color: red });
    text(s.signSlc !== false && (s.consignee || s.address) ? 'SIGN BILLS  S.L.C' : '', 200, y - 4, { size: 9, f: bold });
    field('DELIVERY DATE:', s.date, 40, y - 22, 220); field('TIME:', s.time, 380, y - 22, 190);
    field('LUMPER:', s.lumper, 380, y - 40, 190);
    field('CONSIGNEE:', s.consignee, 40, y - 40, 330);
    field('ADDRESS:', s.address, 40, y - 58, 330);
    field('', s.cityStateZip, 96, y - 76, 274);
    text('IN TIME _____________', 390, y - 62, { size: 8.5, f: bold }); text('OUT TIME ___________', 390, y - 80, { size: 8.5, f: bold });
    y -= 100;
  }
  y -= 10;
  text('BILLS MUST BE SIGNED S L C', 200, y, { size: 11, f: bold, color: red }); y -= 24;
  field('DRIVER NAME:', '', 36, y, 300); field('ID#', '', 344, y, 100); field('TK#:', '', 452, y, 124);
  return pdf.save();
}

// The email: a short summary; the form as a PDF and the rate con attached. Pure.
export function releaseEmail(f) {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const subject = `DRIVER RELEASE — FB ${f.fb || '—'} · Trip ${f.trip} · Truck ${f.truck || '—'} · Trailer ${f.trailer || '—'}`;
  const rows = [['FB#', f.fb], ['Trip#', f.trip], ['Truck#', f.truck], ['Trailer#', f.trailer], ['Driver', [f.driver1, f.driver1Id && `ID ${f.driver1Id}`].filter(Boolean).join(' · ')], ...(f.driver2 ? [['Driver 2', [f.driver2, f.driver2Id && `ID ${f.driver2Id}`].filter(Boolean).join(' · ')]] : []), ['Broker', f.broker], ['Shipper', f.shipper], ['Temp', f.temp], ['Commodity', f.commodity], ...(f.comments ? [['Comments', f.comments]] : [])];
  const stops = f.stops.filter((s) => s.consignee || s.address).map((s, i) => `<li><b>${esc(s.consignee || `Delivery ${i + 1}`)}</b> — ${esc([s.address, s.cityStateZip].filter(Boolean).join(', '))}${s.date || s.time ? ` · ${esc([s.date, s.time].filter(Boolean).join(' '))}` : ''}${s.lumper ? ` · Lumper: ${esc(s.lumper)}` : ''}${s.signSlc ? ' · <b>Sign bills S.L.C</b>' : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14213d"><p>Good day,</p><p>Driver release for trip <b>${esc(f.trip)}</b>. The release form is attached (PDF), with the rate confirmation.</p>
<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#5b6778"><b>${esc(k)}</b></td><td style="padding:3px 0">${esc(v || '—')}</td></tr>`).join('')}</table>
${stops ? `<p style="margin-bottom:4px"><b>Deliveries</b></p><ol style="margin-top:0">${stops}</ol>` : ''}<p><b>Bills must be signed S.L.C.</b></p>
<p>Approved by ${esc(f.approvedBy || '—')} · ${esc(f.date)} ${esc(f.time)}</p><p>Florida Beauty Flora · Dispatch</p></div>`;
  const text = [`Driver release for trip ${f.trip} (form attached as PDF, with the rate con).`, ...rows.map(([k, v]) => `${k}: ${v || '—'}`), ...f.stops.filter((s) => s.consignee || s.address).map((s, i) => `Delivery ${i + 1}: ${[s.consignee, s.address, s.cityStateZip, [s.date, s.time].filter(Boolean).join(' '), s.lumper && `Lumper ${s.lumper}`].filter(Boolean).join(' · ')}`), 'Bills must be signed S.L.C.', `Approved by ${f.approvedBy || '—'} · ${f.date} ${f.time}`].join('\n');
  return { subject, html, text };
}

export function initRelease(app, { requireAuth, db, docs = null, getBoard, sendMail, log = null, trainingActive = async () => null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const itemOf = async (trip) => ((((await getBoard(SITE)) || {}).trips) || []).find((x) => tripNo(x) === String(trip)) || null;
  // the form filled from the load, the recipients used last time, and earlier releases on this load
  app.get('/truckmate/release/:trip', requireAuth, async (req, res) => {
    const it = await itemOf(req.params.trip);
    if (!it) return res.status(404).json({ error: 'That load is not on the board.' });
    const sent = enabled ? (((await db.get(SENT(SITE), {})) || {})[String(req.params.trip)] || []) : [];
    const tr = await trainingActive().catch(() => null);
    res.json({ form: releaseDraft(it, { by: who(req), now: now() }), always: ALWAYS_TO, to: enabled ? ((await db.get(LAST_TO, [])) || []).filter((x) => !ALWAYS_TO.includes(x)) : [], hasRateCon: !!(it._ratecon && (it._ratecon.docIds || []).length), sent: sent.map(({ fields, ...x }) => x), training: tr ? { on: true, to: tr.to || [] } : null });
  });
  // the PDF only (the console's "Preview PDF")
  app.post('/truckmate/release/:trip/pdf', requireAuth, async (req, res) => {
    const f = cleanForm({ ...((req.body || {}).form || {}), trip: String(req.params.trip) });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Driver-Release-${f.trip}.pdf"` });
    res.end(Buffer.from(await releasePdf(f)));
  });
  // submit: email the form (PDF) + the rate con to the recipients on it
  app.post('/truckmate/release/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const b = req.body || {}; const trip = String(req.params.trip);
    const to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => EMAIL.test(x)))].slice(0, 12);
    if (!to.length) return res.status(400).json({ error: 'Add who gets the release (an email).' });
    const it = await itemOf(trip);
    const f = cleanForm({ ...(b.form || {}), trip });
    if (!f.truck || !f.trailer) return res.status(400).json({ error: 'Truck and trailer are needed on the release.' });
    const pdf = Buffer.from(await releasePdf(f));
    const ids = ((it && it._ratecon && it._ratecon.docIds) || []).slice(0, 3);
    const rc = docs && docs.readDocs && ids.length ? await docs.readDocs({ site: SITE, ids }).catch(() => []) : [];
    const m = releaseEmail(f);
    try {
      await sendMail({ to, subject: m.subject, html: m.html, attachments: [{ name: `Driver-Release-${trip}.pdf`, contentType: 'application/pdf', bytes: pdf },
        ...rc.map((x, i) => ({ name: `Rate-Con-${trip}${rc.length > 1 ? `-${i + 1}` : ''}.${/pdf/.test(x.mediaType) ? 'pdf' : 'jpg'}`, contentType: x.mediaType, bytes: x.data }))] });
    } catch (e) { return res.status(502).json({ error: e.message }); }
    const at = new Date(now()).toISOString();
    await db.set(LAST_TO, to.filter((x) => !ALWAYS_TO.includes(x)));
    await db.update(SENT(SITE), (cur) => ({ ...(cur || {}), [trip]: [...((cur || {})[trip] || []), { at, by: who(req), to, fields: f }].slice(-10) }), {});
    if (log) await log(SITE, trip, { type: 'note', kind: 'release', text: `Driver release sent to ${to.join(', ')} (truck ${f.truck}, trailer ${f.trailer})`, by: who(req), noThread: true }).catch(() => {});
    res.json({ ok: true, at, to, rateCon: rc.length > 0 });
  });
  return {};
}

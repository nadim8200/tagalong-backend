// ---------------------------------------------------------------
// The driver's trip log as a PDF that looks like the paper "On the Road Trip Log" (Nov 21, 2026): the same header boxes
// (driver, co-driver, IDs, truck, trailer, both signatures, odometers), the FBE mark, the company block, the 13 printed
// columns, the "Important" lines at the bottom. What the driver wrote is in blue, like the pen on the paper: the date once per
// day (MM-DD-YY), ditto marks (") for the same trip and trailer, "90 B." / "3 Pallets", an LTL pickup's bills as "LTL · 15 bills",
// the note to payroll in the margin. 18 lines a page, like the paper. A last page has what the app adds (miles ZIP to ZIP, wait,
// bonus, expenses, the odometer check) and payroll's checks once it's reviewed.
// ---------------------------------------------------------------
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const INK = rgb(0.08, 0.13, 0.24);        // the printed form
const PEN = rgb(0.1, 0.23, 0.6);          // what the driver wrote
const GRAY = rgb(0.45, 0.5, 0.58);
const GREEN = rgb(0.08, 0.5, 0.24);
const RED = rgb(0.72, 0.1, 0.1);
const ROWS = 18;
const COLS = [   // [title, width] — the paper's 13 columns
  ['Date', 50], ['Trip #', 50], ['Zip Code', 46], ['Pick Up - Location', 88], ['Drop Off Place - Location', 118], ['Full or\nEmpty', 36], ['Boxes\nor\nPallets', 44],
  ['Short or\nOver', 40], ['Ref # or\nLumper\nAmount', 46], ['Driver/\nTruck # (If\nTransfer)', 50], ['Trailer #', 46], ['Bill #', 56], ['Driver Reimbursement', 80],
];
const ACT = { PU: 'P/U', DEL: 'Del', DROP: 'Drop', EMPTY: 'Empty', CM: '' };
const BONUS = { dispatch: 'Bonus (dispatch)', holiday: 'Holiday', weekend: 'Weekend', extraPU: 'Extra pickup', extraDel: 'Extra delivery', fuelTr: 'Fueled trailer', other: 'Bonus' };
const EXP = { lumper: 'Lumper', fuel: 'Fuel / DEF', scale: 'Scale', tolls: 'Tolls', parking: 'Parking', washout: 'Washout', repair: 'Repair', other: 'Other' };

// the standard PDF fonts only know Latin-1: everything else is said plainly. Pure.
export const plain = (s) => String(s == null ? '' : s).replace(/[·•]/g, '-').replace(/[→⇒]/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();
// "11/17" + the line's moment → "11-17-26". Pure.
export function paperDate(r) {
  const ms = Date.parse(r.at || '');
  if (Number.isFinite(ms)) { const [y, m, d] = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).split('-'); return `${m}-${d}-${y.slice(2)}`; }
  return String(r.date || '').replace('/', '-');
}
// what goes in "Boxes or Pallets": "90 B.", "3 Pallets", "90 B. + 1 Pallet", or what the driver did there. Pure.
export function boxesCell(r) {
  const n = String(r.boxes || '').trim(); const p = Number(r.pallets) || 0;
  const b = /^\d+$/.test(n) ? `${n} B.` : n;
  const pal = p ? `${p} Pallet${p === 1 ? '' : 's'}` : '';
  return [b, pal].filter(Boolean).join(' + ') || (r.act === 'CM' ? '' : ACT[r.act] || '');
}
// a pickup carrying many LTL bills: "LTL - 15 bills"; one or two bills as they are. Pure.
export function billCell(r) {
  const bills = String(r.bill || '').split(/\s*\/\s*/).filter(Boolean);
  return bills.length > 2 ? `LTL - ${bills.length} bills` : bills.join(' / ');
}
// the paper's rows: the date once per day, ditto (") for the same trip and trailer as the line above. Pure.
export function paperRows(lines = []) {
  let lastDate = null; let lastTrip = null; let lastTrl = null;
  return lines.map((r) => {
    const date = paperDate(r); const trip = String(r.trip || ''); const trl = String(r.trl || '');
    const row = {
      date: date && date !== lastDate ? date : (date ? '"' : ''),
      trip: trip && trip === lastTrip ? '"' : trip,
      zip: r.zip || '',
      pick: r.act === 'PU' ? r.place : '',
      drop: r.act === 'CM' ? [r.place, r.comment].filter(Boolean).join(' - ') : r.act !== 'PU' ? r.place : '',
      // like the paper: a pickup row says "Full" (leaving loaded); other rows how the truck got there
      fe: r.act === 'CM' ? '' : r.act === 'PU' ? 'Full' : r.fe === 'F' ? 'Full' : r.fe === 'E' ? 'Empty' : '',
      boxes: boxesCell(r), so: r.so || '', ref: r.ref || '',
      trf: r.trf || '', trl: trl && trl === lastTrl ? '"' : trl, bill: billCell(r), reimb: Number(r.reimb) > 0 ? `$${Number(r.reimb).toFixed(2)}` : '',
    };
    if (date) lastDate = date; if (trip) lastTrip = trip; if (trl) lastTrl = trl;
    return row;
  });
}
export const pdfName = (log) => `Trip-Log-${plain((log.head || {}).name || 'driver').replace(/\s+/g, '-')}-${(log.period && log.period.start) || 'sheet'}.pdf`;

export async function tripLogPdf(log, { signature = null, coSignature = null } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`On the Road Trip Log - ${plain((log.head || {}).name)}`); doc.setCreator('TagAlong · Florida Beauty Flora');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pen = await doc.embedFont(StandardFonts.HelveticaOblique);
  const png = async (d) => { try { return d ? await doc.embedPng(Buffer.from(String(d).split(',')[1] || '', 'base64')) : null; } catch { return null; } };
  const [sigImg, coImg] = await Promise.all([png(signature), png(coSignature)]);
  const h = log.head || {}; const W = 792; const H = 612; const M = 21;

  // text that fits its box: smaller down to 5.5 pt, then cut
  const fit = (pg, txt, x, y, w, { f = pen, size = 9, color = PEN } = {}) => {
    let t = plain(txt); if (!t) return; let s = size;
    while (s > 5.5 && f.widthOfTextAtSize(t, s) > w) s -= 0.5;
    while (t.length > 1 && f.widthOfTextAtSize(t, s) > w) t = t.slice(0, -1);
    pg.drawText(t, { x, y, size: s, font: f, color });
  };
  // a cell's text on up to two lines (the place columns)
  const two = (pg, txt, x, yTop, w, rowH, opt = {}) => {
    const t = plain(txt); const f = opt.f || pen; let s = opt.size || 8.5;
    if (f.widthOfTextAtSize(t, s) <= w) { fit(pg, t, x, yTop - rowH / 2 - 3, w, opt); return; }
    const words = t.split(' '); let a = ''; let i = 0;
    while (i < words.length && f.widthOfTextAtSize(`${a} ${words[i]}`.trim(), s) <= w) { a = `${a} ${words[i]}`.trim(); i += 1; }
    if (!a) { fit(pg, t, x, yTop - rowH / 2 - 3, w, opt); return; }
    s = Math.min(s, 7.5);
    fit(pg, a, x, yTop - rowH / 2 + 2, w, { ...opt, size: s }); fit(pg, words.slice(i).join(' '), x, yTop - rowH / 2 - 7, w, { ...opt, size: s });
  };
  const rows = paperRows(log.lines || []);
  const pages = Math.max(1, Math.ceil(rows.length / ROWS));
  for (let p = 0; p < pages; p += 1) {
    const pg = doc.addPage([W, H]);
    const line = (x1, y1, x2, y2, t = 0.8) => pg.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: INK });
    const box = (x, y, w, hh, t = 0.8) => pg.drawRectangle({ x, y, width: w, height: hh, borderColor: INK, borderWidth: t });
    // outer frame
    box(M, M + 6, W - 2 * M, H - 2 * M - 6, 1.4);
    // header boxes (left): 5 rows × 2 columns
    const hx = M + 10; const hy = H - M - 12; const hw = 440; const rh = 19;
    const cells = [[["Driver's Name:", h.name], ['ID #:', h.id]], [['Co-Driver Name:', h.co], ['ID #:', h.coid]], [['Truck #:', h.truck], ['Trailer #:', h.trailer]], [['Driver Signature:', null, 'sig'], ['Co-Driver Signature:', null, 'co']], [['Begining Odometer', h.bod], ['Ending Odometer:', h.eod]]];
    box(hx, hy - rh * 5, hw, rh * 5, 1.1);
    for (let i = 1; i < 5; i += 1) line(hx, hy - rh * i, hx + hw, hy - rh * i);
    line(hx + 250, hy, hx + 250, hy - rh * 5);
    cells.forEach((row, i) => row.forEach(([label, val, kind], j) => {
      const x = hx + (j ? 254 : 4); const y = hy - rh * (i + 1) + 6; const w = j ? hw - 258 : 242;
      pg.drawText(label, { x, y, size: 8.5, font, color: INK });
      const lw = font.widthOfTextAtSize(label, 8.5) + 4;
      if (kind === 'sig' && sigImg) { const d = sigImg.scaleToFit(w - lw, rh - 3); pg.drawImage(sigImg, { x: x + lw, y: y - 4, width: d.width, height: d.height }); }
      else if (kind === 'co' && coImg) { const d = coImg.scaleToFit(w - lw, rh - 3); pg.drawImage(coImg, { x: x + lw, y: y - 4, width: d.width, height: d.height }); }
      else if (val) fit(pg, val, x + lw, y, w - lw, { size: 10.5 });
    }));
    // the FBE mark and the title band
    pg.drawEllipse({ x: hx + hw + 66, y: hy - 30, xScale: 52, yScale: 23, borderColor: INK, borderWidth: 2 });
    pg.drawText('FBE', { x: hx + hw + 42, y: hy - 38, size: 22, font: bold, color: INK });
    pg.drawText('Transportation', { x: hx + hw + 40, y: hy - 49, size: 6.5, font, color: INK });
    pg.drawRectangle({ x: hx + hw + 12, y: hy - rh * 5 + 2, width: 136, height: 17, color: INK });
    pg.drawText('On the Road Trip Log', { x: hx + hw + 18, y: hy - rh * 5 + 7, size: 11, font: bold, color: rgb(1, 1, 1) });
    // company block (right)
    const cx = W - M - 168; let cy = hy - 6;
    pg.drawText('Florida Beauty Flora', { x: cx, y: cy, size: 12, font: bold, color: INK }); line(cx, cy - 2, cx + bold.widthOfTextAtSize('Florida Beauty Flora', 12), cy - 2, 0.7);
    for (const t of ['1351 NW 78 Ave.', 'Miami, FL 33126', 'Phone: 305-503-1200', 'Fax: 305-477-7611']) { cy -= 13; pg.drawText(t, { x: cx, y: cy, size: 9.5, font: bold, color: INK }); }
    if (pages > 1) pg.drawText(`Page ${p + 1} of ${pages}`, { x: cx, y: cy - 14, size: 8, font, color: GRAY });
    // the table
    const tx = M + 10; const top = hy - rh * 5 - 12; const headH = 36; const bottom = M + 44;
    const rowH = (top - headH - bottom) / ROWS;
    const scale = (W - 2 * M - 20) / COLS.reduce((a, c) => a + c[1], 0); const cw = COLS.map((c) => c[1] * scale); const tw = W - 2 * M - 20;
    box(tx, bottom, tw, top - bottom, 1.1);
    line(tx, top - headH, tx + tw, top - headH, 1.1);
    let x = tx;
    COLS.forEach(([title], i) => {
      const w = cw[i];
      if (i) line(x, top, x, bottom);
      const parts = title.split('\n');
      parts.forEach((t, k) => { const tw2 = font.widthOfTextAtSize(t, 7.5); pg.drawText(t, { x: x + (w - tw2) / 2, y: top - headH + 5 + (parts.length - 1 - k) * 9, size: 7.5, font, color: INK }); });
      x += w;
    });
    for (let r = 1; r < ROWS; r += 1) line(tx, top - headH - rowH * r, tx + tw, top - headH - rowH * r, 0.5);
    rows.slice(p * ROWS, (p + 1) * ROWS).forEach((row, k) => {
      const yTop = top - headH - rowH * k; const yMid = yTop - rowH / 2 - 3;
      const vals = [row.date, row.trip, row.zip, row.pick, row.drop, row.fe, row.boxes, row.so, row.ref, row.trf, row.trl, row.bill, row.reimb];
      let cx2 = tx;
      vals.forEach((v, i) => {
        const w = cw[i];
        if (i === 3 || i === 4) two(pg, v, cx2 + 2, yTop, w - 4, rowH);
        else fit(pg, v, cx2 + 2, yMid, w - 4, { size: 9 });
        cx2 += w;
      });
    });
    // the "Important" lines
    line(tx, bottom - 1, tx + tw, bottom - 1, 0.5);
    pg.drawText('Important: Driver log sheets must be processed with your trip paperwork to avoid additional charges.', { x: tx + 4, y: bottom - 14, size: 9.5, font, color: INK });
    pg.drawText('Por favor recuerde entregar sus LOGS juntos con al tarea para evitar cargos al chofer.', { x: tx + 110, y: bottom - 27, size: 9.5, font, color: INK });
    // the note to payroll, written at the top beside the title like the paper's margin note
    if (p === 0 && h.note) {
      const words = plain(h.note).split(' '); const out = []; let cur = '';
      for (const w of words) { if (pen.widthOfTextAtSize(`${cur} ${w}`.trim(), 10) > (W - M - 8) - (hx + hw + 158)) { out.push(cur); cur = w; } else cur = `${cur} ${w}`.trim(); }
      if (cur) out.push(cur);
      out.slice(0, 3).forEach((t, i) => pg.drawText(t, { x: hx + hw + 158, y: hy - rh * 5 + 26 - i * 12, size: 10, font: pen, color: PEN }));
    }
  }
  // the last page: what the app adds (not on the paper), and payroll's checks
  const pg = doc.addPage([W, H]); let y = H - M - 24;
  const say = (t, { f = font, size = 9, color = INK, x = M + 14 } = {}) => { pg.drawText(plain(t), { x, y, size, font: f, color }); };
  say(`On the Road Trip Log - ${plain(h.name)} (ID ${plain(h.id)})${h.co ? ` with ${plain(h.co)} (ID ${plain(h.coid)})` : ''}`, { f: bold, size: 13 }); y -= 15;
  say(`${(log.period && log.period.start) || ''} to ${(log.period && log.period.end) || ''} - added by the TagAlong app (not on the paper sheet)${log.submittedAt ? ` - turned in ${new Date(log.submittedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`, { color: GRAY }); y -= 20;
  const cols = [['#', 22], ['Date', 46], ['Trip #', 50], ['From ZIP -> To ZIP', 104], ['Miles', 44], ['F/E', 34], ['Wait (starts 3 h after the appointment)', 190], ['Bonus', 120], ['Payroll', 70]];
  let x = M + 14; for (const [t, w] of cols) { pg.drawText(t, { x, y, size: 8, font: bold, color: INK }); x += w; }
  y -= 4; pg.drawLine({ start: { x: M + 14, y }, end: { x: W - M - 14, y }, thickness: 0.8, color: INK }); y -= 12;
  const mi = log.miles || []; const pay = (log.review && log.review.pay && log.review.pay.lines) || null;
  let prev = null; let lo = 0; let em = 0; let wait = 0;
  (log.lines || []).forEach((r, i) => {
    if (y < M + 120) return;
    const m = mi[i]; if (m != null && r.act !== 'CM') { if (r.fe === 'F') lo += m; else em += m; }
    wait += r.wait || 0;
    const p2 = pay ? pay[i] || {} : null;
    const paidBits = p2 ? [m && r.act !== 'CM' ? (p2.move ? 'mi Y' : 'mi N') : '', r.wait ? (p2.wait ? 'wait Y' : 'wait N') : '', r.bonus && r.bonus !== 'none' ? (p2.bonus ? 'bonus Y' : 'bonus N') : ''].filter(Boolean).join(' ') : '';
    const vals = [String(i + 1), paperDate(r), r.trip || '', `${prev || '-'} -> ${r.zip || '-'}`, m != null && r.act !== 'CM' ? String(m) : '', r.fe || '', r.wait ? `${Math.floor(r.wait / 60)} h ${r.wait % 60} min${r.waitFrom ? ` from ${new Date(r.waitFrom).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}` : '', r.bonus && r.bonus !== 'none' ? `${BONUS[r.bonus] || 'Bonus'}${r.bonusAmt ? ` $${r.bonusAmt}` : ''}` : '', paidBits];
    let xx = M + 14; vals.forEach((v, k) => { fit(pg, v, xx, y, cols[k][1] - 4, { f: k === 8 ? bold : font, size: 8.5, color: k === 8 ? (/N/.test(v) ? RED : GREEN) : INK }); xx += cols[k][1]; });
    if (r.zip) prev = r.zip; y -= 12;
  });
  y -= 6; say(`Miles ZIP to ZIP: ${lo + em} (${lo} loaded, ${em} empty) - Wait: ${Math.floor(wait / 60)} h ${wait % 60} min`, { f: bold }); y -= 13;
  const odo = Number(String(h.eod || '').replace(/\D/g, '')) - Number(String(h.bod || '').replace(/\D/g, ''));
  if (odo > 0) { say(`Odometer: ${h.bod} -> ${h.eod} = ${odo} mi${log.odometer && log.odometer.source ? ` (${log.odometer.source})` : ''}`); y -= 13; }
  const ex = log.expenses || [];
  if (ex.length) {
    y -= 6; say('Expenses the driver paid', { f: bold }); y -= 12;
    ex.forEach((e, i) => { if (y < M + 30) return; const ok = log.review && log.review.pay ? ((log.review.pay.expenses || [])[i] ? ' - paid Y' : ' - not paid') : ''; say(`${e.date || ''}  ${EXP[e.kind] || e.kind}  $${Number(e.amount || 0).toFixed(2)}${e.trip ? `  trip ${e.trip}` : ''}${e.note ? `  ${e.note}` : ''}  ${(e.receipts || []).length ? `${e.receipts.length} receipt(s)` : 'no receipt'}${ok}`); y -= 12; });
    say(`Expenses total: $${ex.reduce((a, e) => a + (Number(e.amount) || 0), 0).toFixed(2)}`, { f: bold }); y -= 13;
  }
  if (log.review) { y -= 6; say(`Reviewed by ${log.review.by} ${new Date(log.review.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: Y = paid, N = not paid${log.review.note ? ` - ${log.review.note}` : ''}`, { color: GRAY }); }
  return doc.save();
}

// ---------------------------------------------------------------
// The driver's paperwork, to Accounting as soon as it comes in: what the paper is, the freight bill number and box count the driver gave,
// what TruckMate has for that bill, and the load's information, with the files attached. The same paperwork goes in the load report when
// the load finishes (rundown.js). Internal only.
// ---------------------------------------------------------------
import { loadRows } from './breakdownreport.js';

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];

// What TruckMate has for the bill the driver gave. Pure. → { onLoad, pieces, to, billTo }
export function billOnLoad(item, bill) {
  const b = billsOf(item).find((x) => String(x.billNumber || '').toUpperCase() === String(bill || '').toUpperCase());
  return b ? { onLoad: true, pieces: b.pieces != null ? Number(b.pieces) : null, to: b.endZoneDescription || null, billTo: b.billToName || null } : { onLoad: false, pieces: null, to: null, billTo: null };
}

// Pure. → { subject, html, text }
export function renderPaperworkEmail({ label, bill = null, boxes = null, confirmation = null, by, files = 0, item = null, trip, at = Date.now() }) {
  const t = tripOf(item); const tm = billOnLoad(item, bill);
  const ids = [t.powerUnit && `TK ${t.powerUnit}`, t.trailer && `TL ${t.trailer}`, `TO ${trip}`].filter(Boolean).join(' ');
  const subject = [String(label).toUpperCase(), ids, bill && `BILL ${bill}`].filter(Boolean).join(' // ');
  const count = boxes == null ? null : tm.pieces == null ? `${boxes}` : boxes === tm.pieces ? `${boxes}, matches TruckMate` : `${boxes}, TruckMate has ${tm.pieces}`;
  const paper = [['Paper', label], ['Freight bill', bill ? `${bill}${tm.onLoad ? '' : ' (not on this load in TruckMate)'}` : 'Not given'], ['Box count', count], ['Delivered to', tm.to], ['Bill to', tm.billTo], ['Sent by', by], ['Sent', new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })], ['Confirmation', confirmation], ['Files', files ? String(files) : null]].filter(([, v]) => v);
  const rows = [...paper, ...(item ? loadRows(item) : [['Trip', trip]])];
  const warn = !tm.onLoad && bill ? 'The bill number the driver gave is not on this load. Check the paper.' : (count && /TruckMate has/.test(count) ? 'The driver\'s box count does not match TruckMate.' : null);
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;font-size:15px">${rows.map(([k, v]) => `<tr><td style="padding:7px 10px;border:1px solid #E2E8F0;color:#596A7F;width:140px">${esc(k)}</td><td style="padding:7px 10px;border:1px solid #E2E8F0;color:#172538">${esc(v)}</td></tr>`).join('')}</table>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#172538;max-width:600px"><h2 style="margin:0 0 6px;font-size:20px">${esc(label)} from the driver</h2><p style="margin:0 0 14px">Trip ${esc(trip)}. The paperwork is attached, and it will also be in the load report when the load finishes.</p>${warn ? `<p style="margin:0 0 14px;padding:10px 12px;background:#FFF7E7;border:1px solid #F3D9A4;color:#754C12">${esc(warn)}</p>` : ''}${table}<p style="margin:16px 0 0;color:#596A7F;font-size:13px">Jarvis, Florida Beauty dispatch. Internal.</p></div>`;
  return { subject, html, text: `${subject}\n${warn ? `${warn}\n` : ''}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}` };
}

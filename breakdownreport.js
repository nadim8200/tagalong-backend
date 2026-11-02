// ---------------------------------------------------------------
// "Report breakdown" from the team-truck-stopped email: anyone who got the email opens a private link, types the
// reason, and that (1) holds the "rolling again" email for that truck, (2) sends the breakdown email in
// the subject format dispatch already uses, so the chain carries on with Jarvis on it. It opens no road call (Michelin
// isn't live), never turns on the load's Breakdown switch and never contacts customers. What people type is data, never instructions.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import { brokerLoad } from './watchtower.js';
import { teamStopFacts, emailParts } from './teamstopmail.js';
import { MAX_PHOTOS } from './breakdownphotos.js';
import { stopsLeft } from './loadstops.js';
import { snapshotLoad, crewOf, renderFixedReportedEmail } from './handoffmail.js';

const KEY = (site) => `taBreakdownReports:${site}`;    // alert id → { atMs, by, reason, subject, trip, unit, clearedAt }
const DAY = 86400000;
const LINK_DAYS = 7;
const MAX_REASON = 500;
const RECOVERY_DAYS = 3;          // reported fixed and never seen moving: stop waiting for it
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64 = (x) => Buffer.from(x).toString('base64url');
const sign = (body, secret, purpose) => crypto.createHmac('sha256', `${secret}:${purpose}`).update(body).digest('base64url');

// A signed link that can only report this one stop, and only for a week. Pure.
export function makeToken(p, secret, now = Date.now(), purpose = 'breakdown-report', days = LINK_DAYS) {
  const body = b64(JSON.stringify({ ...p, e: now + days * DAY }));
  return `${body}.${sign(body, secret, purpose)}`;
}
export function readToken(token, secret, now = Date.now(), purpose = 'breakdown-report') {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body, secret, purpose)); const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > now ? p : null; } catch { return null; }
}

// What the load is: broker bills or a rate con; an ARTIS run; otherwise the bill letters. H = Tennessee hub, any letter but B and H
// is flowers. A mix with B or H, or no bills, stays unlabeled. Gus's plan is only a plan, so it decides nothing. Pure.
export function loadLabel(item) {
  if (brokerLoad(item)) return 'BROKER';
  if (item && item._tb) return 'FLOWERS';
  const t = (item && item.trip) || item || {};
  const letters = [...new Set(((item && (item.freightBills || item.orders)) || t.freightBills || []).map((b) => String(b.billNumber || '').trim().charAt(0).toUpperCase()).filter(Boolean))];
  if (!letters.length) return null;
  if (letters.every((l) => l !== 'B' && l !== 'H')) return 'FLOWERS';
  if (letters.every((l) => l === 'H')) return 'TENNESSEE HUB';
  return null;
}
// What to call the load wherever it's shown: the label, or both kinds on a mixed load. Null only with no bills at all. Pure.
export function loadType(item) {
  const one = loadLabel(item);
  if (one) return one;
  const t = (item && item.trip) || item || {};
  const letters = [...new Set(((item && (item.freightBills || item.orders)) || t.freightBills || []).map((b) => String(b.billNumber || '').trim().charAt(0).toUpperCase()).filter(Boolean))];
  if (!letters.length) return null;
  return [...new Set(letters.map((l) => (l === 'B' ? 'BROKER' : l === 'H' ? 'TENNESSEE HUB' : 'FLOWERS')))].join(' + ');
}
const oneLine = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Same shape dispatch writes: "BREAKDOWN TRAILER 2029 // TK 2008 TL 2029 TO 626143", with the kind of load in front. What broke and the numbers
// only: the story goes in the email. Names the truck or the trailer when the reason says which, otherwise both. Pure.
export function breakdownSubject(item, reason, { unit = null, trip = null, part = null } = {}) {
  const t = (item && item.trip) || {};
  const tk = unit || t.powerUnit || 'N/A'; const tl = t.trailer || 'N/A';
  const r = oneLine(reason, 500);
  const trailer = /\b(trailers?|reefers?|remolques?|cajas?|thermo ?king|carrier unit|landing gear|mud ?flaps?)\b/i.test(r);
  const truck = /\b(trucks?|tractors?|cami[oó]n|engine|motor)\b/i.test(r);
  const says = part === 'truck' || part === 'trailer' ? part : trailer === truck ? null : trailer ? 'trailer' : 'truck';
  const what = !says ? `TRUCK ${tk} TRAILER ${tl}` : says === 'trailer' ? `TRAILER ${tl}` : `TRUCK ${tk}`;
  const kind = loadType(item);
  return `${kind ? `${kind} ` : ''}BREAKDOWN ${what} // TK ${tk} TL ${tl} TO ${trip || t.tripNumber || 'N/A'}`;
}

// "2 of 3: Bristol Farms, Carson, CA; Sample Co, Reno, NV". Pure.
const stopsText = (item) => { const s = stopsLeft(item); return s.total ? `${s.count} of ${s.total}${s.count ? `: ${s.stops.slice(0, 6).map((x) => [x.customer, x.place].filter(Boolean).join(', ')).join('; ')}${s.count > 6 ? ` and ${s.count - 6} more` : ''}` : ''}` : null; };
// The load, in full, for the email. Only what's on record. Pure.
export function loadRows(item, now = Date.now()) {
  const s = snapshotLoad(item, null, now); const t = (item && item.trip) || {};
  const bills = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  const temps = [...new Set(bills.map((b) => b.temperature).filter((v) => v != null))];
  const names = s.customers.slice(0, 8).join(', ') + (s.customers.length > 8 ? ` and ${s.customers.length - 8} more` : '');
  return [['Load type', loadType(item) || 'Not on file'], ['Truck', s.unit || 'Not on file'], ['Trailer', s.trailer || 'Not on file'], ['Trip', s.trip || 'Not on file'], ['Broker', s.broker], ['Customers', names], ['Stops left', stopsText(item)], ['Freight bills', s.bills.length ? String(s.bills.length) : null], ['Boxes', s.pieces != null ? s.pieces.toLocaleString('en-US') : null], ['Temperature', temps.length ? temps.map((v) => `${v}°F`).join(', ') : null], ['Commodity', s.commodity], ['From', t.origZoneDesc], ['To', t.destZoneDesc]].filter(([, v]) => v);
}

// The photos, full width, one under the other. Pure.
const photoBlock = (cids, note) => {
  const { heading, FONT, MUTED } = emailParts;
  if (!cids.length && !note) return '';
  return `${heading('Photos')}${cids.map((c, i) => `<tr><td style="padding:0 24px 10px;"><img src="cid:${esc(c)}" width="592" alt="Breakdown photo ${i + 1}" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></td></tr>`).join('')}${note ? `<tr><td style="padding:0 24px 8px;font-family:${FONT};font-size:14px;color:${MUTED};">${esc(note)}</td></tr>` : ''}`;
};
// More photos on an open breakdown. Pure.
export function renderBreakdownPhotosEmail({ report, item = null, by, count, subject, photoCids = [], photosNote = null, now = Date.now() }) {
  const { heading, FONT, NAVY, TEXT, MUTED, RED, kv, et, TRAINING_SLOT } = emailParts;
  const rows = loadRows(item || { trip: { powerUnit: report.unit, tripNumber: report.trip } }, now);
  const title = 'NEW BREAKDOWN PHOTOS';
  const line = `${count} new photo${count === 1 ? '' : 's'} from ${by}.`;
  const color = RED;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#F1F5F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
${TRAINING_SLOT}
<tr><td bgcolor="${color}" style="padding:18px 24px;background:${color};font-family:${FONT};font-size:26px;font-weight:bold;color:#FFFFFF;">${title}<div style="padding-top:4px;font-size:15px;font-weight:normal;color:#FFFFFF;">${esc(line)}</div></td></tr>
<tr><td style="padding:14px 24px 0;font-family:${FONT};font-size:24px;font-weight:bold;color:${NAVY};">Truck ${esc(report.unit || 'not recorded')}<div style="font-size:15px;font-weight:normal;color:${MUTED};">Trip ${esc(report.trip)}</div></td></tr>
<tr><td style="padding:14px 24px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${NAVY};">Reason on file</b><br>${esc(report.reason)}<div style="font-size:13px;color:${MUTED};">Received ${esc(et(now) || '')}</div></td></tr>
${photoBlock(photoCids, photosNote)}
${heading('Load')}
<tr><td style="padding:0 24px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map(([k, v]) => kv(k, v)).join('')}</table></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text: [title, line, `Reason on file: ${report.reason}`, ...(photosNote ? [photosNote] : []), '', ...rows.map(([k, v]) => `${k}: ${v}`), '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n') };
}

// The dispatcher corrected the truck or trailer on the report: the email goes by that, TruckMate isn't touched. A different truck never
// shows this load's truck's location: it takes that truck's own, or none. Pure.
export function correctedLoad(item, board = [], { truck = null, trailer = null } = {}) {
  const t = (item && item.trip) || {};
  const newTruck = truck && String(truck) !== String(t.powerUnit || '') ? String(truck) : null;
  const newTrailer = trailer && String(trailer) !== String(t.trailer || '') ? String(trailer) : null;
  if (!newTruck && !newTrailer) return item;
  const { _samsara, ...rest } = item;
  const live = newTruck ? (board.find((it) => String(((it && it.trip) || {}).powerUnit) === newTruck) || {})._samsara : _samsara;
  return { ...rest, trip: { ...t, ...(newTruck ? { powerUnit: newTruck } : {}), ...(newTrailer ? { trailer: newTrailer } : {}) }, ...(live ? { _samsara: live } : {}) };
}

// The email that opens the chain. Pure.
export function renderBreakdownEmail({ item, report, etas = null, now = Date.now(), showPhones = true, mapCid = null, sheetNote = null, sheetAttached = false, photoCids = [], photosNote = null, update = null, earlier = [] }) {
  const a = { unit: report.unit, trip: report.trip, ack: null };
  const f = teamStopFacts(a, item, { etas, now, showPhones, mapCid });
  const { liveUrl, heading, button, kv, driverCard, FONT, NAVY, TEXT, MUTED, LINE, RED, et, TRAINING_SLOT } = emailParts;
  const kind = loadType(item);
  const title = `${kind === 'FLOWERS' ? 'FLOWER ' : kind ? `${kind} ` : ''}BREAKDOWN${update ? ' UPDATE' : kind ? '' : ' REPORTED'}`;
  const label = update ? `Update from ${update.by}` : kind ? 'Breakdown reported' : 'Load type not confirmed. Check the load.';
  const banner = update ? '#B45309' : RED;
  const consoleUrl = liveUrl(report.trip);
  const many = f.drivers.length > 1;
  const reported = `${report.by} · ${et(report.atMs) || ''}`;
  const rc = 'Road service has NOT been called. Call Michelin or the shop the usual way.';
  const next = 'Use Notify customers on the load if they need to be told. It shows you who gets notified before anything goes out.';
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const subject = breakdownSubject(item, report.reason, { unit: report.unit, trip: report.trip, part: report.part });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"></head><body style="margin:0;padding:0;background:#F1F5F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">Florida Beauty</td></tr>
<tr><td style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td bgcolor="${banner}" style="padding:20px 24px;background:${banner};font-family:${FONT};font-size:32px;line-height:1.15;font-weight:bold;color:#FFFFFF;">${title}<div style="padding-top:4px;font-size:16px;font-weight:normal;color:#FFFFFF;">${label}</div></td></tr>
<tr><td style="padding:16px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || 'not recorded')}</td></tr>
<tr><td style="padding:0 24px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(f.trip || 'not recorded')}${f.trailer ? ` · Trailer ${esc(f.trailer)}` : ''}</td></tr>
${sheetAttached ? `<tr><td style="padding:0 24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NAVY}" style="background:${NAVY};border-radius:8px;"><tr><td style="padding:12px 16px;font-family:${FONT};font-size:17px;font-weight:bold;color:#FFFFFF;">&#128206; ${esc(sheetNote)}</td></tr></table></td></tr>` : ''}
${update ? `<tr><td style="padding:0 24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFF7E7" style="background:#FFF7E7;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:#92400E;">Update</b><div style="font-size:24px;line-height:1.25;font-weight:bold;padding:4px 0 8px;word-break:break-word;">${esc(update.message)}</div>From: <b>${esc(update.by)} · ${esc(et(now) || '')}</b>${earlier.length ? `<div style="padding-top:10px;font-size:13px;color:${MUTED};"><b>Earlier updates</b>${earlier.map((u) => `<div style="padding-top:4px;word-break:break-word;">${esc(u.message)} (${esc(u.by)} · ${esc(et(u.atMs) || '')})</div>`).join('')}</div>` : ''}</td></tr></table></td></tr>` : ''}
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFF1F2" style="background:#FFF1F2;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${RED};">Reason</b><div style="font-size:24px;line-height:1.25;font-weight:bold;padding:4px 0 8px;word-break:break-word;">${esc(report.reason)}</div>${report.driverSays ? `<div style="padding:0 0 8px;"><b style="color:${RED};">What the driver says</b><br>${esc(report.driverSays)}</div>` : ''}Reported by: <b>${esc(reported)}</b></td></tr></table></td></tr>
${update ? '' : `<tr><td style="padding:12px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${NAVY};">Next step for dispatch</b><br>${esc(rc)}<br>${esc(next)}<div>${button(consoleUrl, 'Open the load')}</div></td></tr></table></td></tr>`}
${photoBlock(photoCids, photosNote)}
${heading('Load')}
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${loadRows(item, now).map(([k, v]) => kv(k, v)).join('')}</table></td></tr>
${heading('Last reported location')}
${f.mapCid ? `<tr><td style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck's last reported location" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b>${mapUrl ? `<div>${button(mapUrl, 'Open map')}</div>` : ''}</td></tr>
${heading(many ? 'Driver team' : 'Driver')}
<tr><td style="padding:0 24px;">${f.drivers.length ? f.drivers.map((d, i) => driverCard(d, i, many)).join('') : `<div style="font-family:${FONT};font-size:15px;color:${TEXT};">No driver reported.</div>`}</td></tr>
${heading('Delivery impact')}
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${kv('Next stop', f.next)}${kv('Appointment', f.appt)}${kv('Estimated arrival', f.eta)}${kv('Distance remaining', f.miles != null ? `${f.miles.toLocaleString('en-US')} mi` : null)}</table></td></tr>
<tr><td style="padding:18px 24px 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">Reply on this email to keep everyone on the chain. Jarvis keeps it on the load.<br><b style="color:${NAVY};">Jarvis · AI Dispatcher</b> · Florida Beauty</td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, label, `Truck ${f.unit || 'not recorded'}`, `Trip ${f.trip || 'not recorded'}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, ...(sheetNote ? [sheetNote] : []), '', ...(update ? [`Update: ${update.message}`, ...earlier.map((u) => `Earlier: ${u.message} (${u.by})`), ''] : []), `Reason: ${report.reason}`, ...(report.driverSays ? [`What the driver says: ${report.driverSays}`] : []), `Reported by: ${reported}`, ...(photoCids.length ? ['', `${photoCids.length} photo${photoCids.length === 1 ? '' : 's'} in this email.`] : []), ...(photosNote ? [photosNote] : []), '', 'LOAD', ...loadRows(item, now).map(([k, v]) => `${k}: ${v}`), '', 'NEXT STEP FOR DISPATCH', rc, next, consoleUrl, '', f.location || 'Location not reported', ...(mapUrl ? [mapUrl] : []), '', `Next stop: ${f.next || 'Not available'}`, `Estimated arrival: ${f.eta || 'Not available'}`, '', 'Reply on this email to keep everyone on the chain.', 'Jarvis · AI Dispatcher · Florida Beauty'].join('\n');
  return { subject, html, text };
}

const unitKey = (x) => String(x || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();

export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;color:#1F2937}main{max-width:520px;margin:0 auto;padding:16px}.c{background:#fff;border-radius:10px;padding:20px}h1{margin:0 0 2px;font-size:24px;color:#13325B}.s{margin:0 0 16px;color:#5B6778}label{display:block;font-weight:bold;margin:14px 0 6px;color:#13325B}textarea,input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border:1px solid #B8C3D3;border-radius:8px}textarea{min-height:120px}button{width:100%;margin-top:16px;min-height:48px;font:inherit;font-weight:bold;font-size:16px;color:#fff;background:#C62828;border:0;border-radius:8px}button:disabled{opacity:.6}.n{font-size:14px;color:#5B6778;margin-top:12px}.e{color:#C62828;margin-top:10px}</style></head><body><main><div class="c">${body}</div></main></body></html>`;

// The page behind the button. Pure.
export function reportPage(p, token, earlier = null) {
  if (!p) return page('Link not valid', '<h1>This link has expired</h1><p class="s">Report the breakdown from the load in the console, or reply to the email.</p>');
  if (earlier) return page('Already reported', `<h1>Already reported</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}</p><p><b>${esc(earlier.by)}</b> reported: ${esc(earlier.reason)}</p>`);
  return page(`Report breakdown, truck ${p.u}`, `<h1>Report breakdown</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}</p><form id="f"><label for="r">What happened?</label><textarea id="r" maxlength="${MAX_REASON}" required placeholder="For example: truck air leak, shop is 5 miles away"></textarea><label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name"><button id="b" type="submit">Report breakdown</button><div class="e" id="e" role="alert"></div></form><p class="n">This emails the team. It does not call road service or contact customers.</p><script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;e.textContent='';try{var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:document.getElementById('r').value,name:document.getElementById('n').value})});var j=await r.json();if(!r.ok)throw new Error(j.error||'Could not send.');document.querySelector('.c').innerHTML='<h1>Reported</h1><p class="s">The team has the email. Road service has not been called. You can close this page.</p>';}catch(x){e.textContent=x.message;b.disabled=false;}});</script>`);
}

export function initBreakdownReport(app, { db, secret, getBoard, send, sendChain = async () => {}, onTruckMateMove = async () => {}, fixedDetails = async () => ({}), etasFor = async () => null, otherHolds = async () => false, sendPhotos = async () => {}, textedPhotos = async () => [], requireAuth = null, storePhotos = async () => [], baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const site = 'florida-beauty';
  const all = async () => (await db.get(KEY(site), {})) || {};
  const link = (a) => `${baseUrl}/br/${makeToken({ a: a.id, t: a.trip, u: a.unit }, secret, now())}`;
  const forTrip = async (trip) => Object.values(await all()).filter((r) => String(r.trip) === String(trip)).sort((x, y) => y.atMs - x.atMs)[0] || null;

  async function submit(p, { reason, name }) {
    const clean = oneLine(reason, MAX_REASON); const by = oneLine(name, 80);
    if (clean.length < 3) return { code: 400, error: 'Write what happened.' };
    if (!by) return { code: 400, error: 'Add your name.' };
    let first = false;
    const at = now();
    await db.update(KEY(site), (cur) => { const c = { ...(cur || {}) }; if (!c[p.a]) { first = true; c[p.a] = { atMs: at, by, reason: clean, trip: p.t, unit: p.u }; } return c; }, {});
    if (!first) return { code: 409, error: 'This stop was already reported.' };
    const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(p.t)) || null;
    const report = { atMs: at, by, reason: clean, trip: p.t, unit: p.u, photos: await textedPhotos(p.t).catch(() => []) };
    const before = item ? { before: snapshotLoad(item, await etasFor(p.t).catch(() => null), at), crew: crewOf(item, at) } : {};   // what the load looked like, for a later transfer
    await db.update(KEY(site), (cur) => ({ ...(cur || {}), [p.a]: { ...report, ...before, subject: breakdownSubject(item, clean, { unit: p.u, trip: p.t }) } }), {});
    await send(report, item);
    return { code: 200, ok: true };
  }

  // Staff emailed Jarvis that a truck broke down: same breakdown email, to everyone of ours on their email plus the usual list.
  // One per load until Breakdown is turned off; the first report stands, later ones just say so.
  async function fromEmail({ trip, reason, by, emailId, to = [], photos = [], driverSays = null, part = null, truck = null, trailer = null }) {
    const clean = oneLine(reason, MAX_REASON);
    if (clean.length < 3) return { ok: false, error: 'What happened? Reply with the reason.' };
    const open = await forTrip(trip);
    if (open && !open.clearedAt && now() - open.atMs < DAY) { if (photos.length) await addPhotos({ trip, photos, by }); return { ok: false, duplicate: true, error: `Already reported by ${open.by}.` }; }
    const board = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []);
    const onLoad = board.find((it) => String(((it && it.trip) || {}).tripNumber) === String(trip)) || null;
    if (!onLoad) return { ok: false, error: `Trip ${trip} is not on the board.` };
    const item = correctedLoad(onLoad, board, { truck, trailer });
    const unit = (item.trip || {}).powerUnit || null;
    const texted = await textedPhotos(trip).catch(() => []);
    const report = { atMs: now(), by: oneLine(by, 80) || 'Dispatch', reason: clean, trip: String(trip), unit, ...(driverSays ? { driverSays: oneLine(driverSays, MAX_REASON) } : {}), ...(part ? { part } : {}), photos: [...photos, ...texted.filter((x) => !photos.some((y) => y.docId === x.docId))] };
    const subject = breakdownSubject(item, clean, { unit, trip, part });
    const before = { before: snapshotLoad(item, await etasFor(trip).catch(() => null), report.atMs), crew: crewOf(item, report.atMs) };
    await db.update(KEY(site), (cur) => ({ ...(cur || {}), [`email:${emailId}`]: { ...report, ...before, subject } }), {});
    await send(report, item, to);
    return { ok: true, subject };
  }

  // Photos that came in after the report: kept on it, and the chain sees them. Each one once. Nothing open → nothing to add to.
  async function addPhotos({ trip, photos = [], by }) {
    const k = await keyFor(trip);
    if (!k || !photos.length) return { ok: false, added: 0 };
    let fresh = [];
    await db.update(KEY(site), (cur) => { const r = (cur || {})[k]; const have = (r.photos || []).map((x) => x.docId); fresh = photos.filter((x) => !have.includes(x.docId)); return { ...(cur || {}), [k]: { ...r, photos: [...(r.photos || []), ...fresh] } }; }, {});
    if (!fresh.length) return { ok: true, added: 0 };
    const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(trip)) || null;
    await sendPhotos((await all())[k], item, fresh, oneLine(by, 80) || 'Dispatch');
    return { ok: true, added: fresh.length };
  }

  // A dispatcher's update on an open breakdown: where the repair stands, what the tech or driver said. It stays on the record and goes out on the chain.
  async function addUpdate({ trip, message, by, photos = [] }) {
    const text = oneLine(message, MAX_REASON); const who = oneLine(by, 80) || 'Dispatch';
    if (text.length < 3) return { ok: false, error: 'Write the update.' };
    const k = await keyFor(trip);
    if (!k) return { ok: false, error: `No open breakdown on trip ${trip}.` };
    let fresh = [];
    await db.update(KEY(site), (cur) => { const r = (cur || {})[k]; const have = (r.photos || []).map((x) => x.docId); fresh = photos.filter((x) => !have.includes(x.docId)); return { ...(cur || {}), [k]: { ...r, photos: [...(r.photos || []), ...fresh], updates: [...(r.updates || []), { atMs: now(), by: who, message: text }] } }; }, {});
    const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(trip)) || null;
    await sendPhotos((await all())[k], item, fresh, who, text);
    return { ok: true };
  }
  const openFor = async (trip) => { const k = await keyFor(trip); if (!k) return null; const { by, reason, atMs, part, updates = [] } = (await all())[k]; return { by, reason, atMs, part: part || null, updates }; };

  const keyFor = async (trip) => { const c = await all(); return Object.keys(c).filter((k) => String(c[k].trip) === String(trip) && !c[k].clearedAt).sort((x, y) => c[y].atMs - c[x].atMs)[0] || null; };
  const patch = (k, fields) => db.update(KEY(site), (cur) => ({ ...(cur || {}), [k]: { ...(cur || {})[k], ...fields } }), {});

  // Trucks and trips reported down: team-stop and rolling emails wait until someone says it's fixed or the load moved to another truck.
  const held = async () => Object.values(await all()).filter((r) => !r.clearedAt).flatMap((r) => [String(r.trip), String(r.unit || '').trim().toLowerCase().replace(/^0+(?=\d)/, '')]).filter(Boolean);
  const clear = (trip) => db.update(KEY(site), (cur) => Object.fromEntries(Object.entries(cur || {}).map(([k, r]) => [k, String(r.trip) === String(trip) && !r.clearedAt ? { ...r, clearedAt: now() } : r])), {});

  // the truck left this load on a transfer but was never reported repaired: it can still be reported fixed
  const movedKey = async (trip) => { const c = await all(); return Object.keys(c).filter((k) => String(c[k].trip) === String(trip) && c[k].transferredTo && !c[k].fixedAt && now() - c[k].atMs < 7 * DAY).sort((x, y) => c[y].atMs - c[x].atMs)[0] || null; };

  // Staff say it's fixed: the hold lifts and the chain hears it. A repair alone is not movement, so that part waits for the truck.
  async function fixed(trip, by, { repair = null, provider = null, notes = null, repairTime = null } = {}) {
    const k = (await keyFor(trip)) || (await movedKey(trip));
    if (!k) return { ok: false, error: `No open breakdown on trip ${trip}.` };
    const r = (await all())[k];
    const at = now();
    await patch(k, { clearedAt: r.clearedAt || at, fixedAt: at, fixedBy: by, repair: repair ? oneLine(repair, 300) : null, provider: provider ? oneLine(provider, 120) : null, repairNotes: notes ? oneLine(notes, 300) : null, repairTime: repairTime ? oneLine(repairTime, 60) : null });
    const held2 = await otherHolds(r).catch(() => true);
    if (r.subject) {
      const saved = (await all())[k];
      const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => unitKey((it && it.trip && it.trip.powerUnit)) === unitKey(r.unit)) || null;
      const more = await fixedDetails(saved, item).catch(() => ({}));   // what only the app knows: etas, off-board GPS, the map, open alerts
      await sendChain(r, { ...renderFixedReportedEmail({ report: saved, item, now: at, held: held2, subject: `Re: ${r.subject}`, ...more, attachments: undefined }), ...(more.attachments ? { attachments: more.attachments } : {}) });
    }
    return { ok: true, held: held2 };
  }

  // Reported fixed and no confirmed movement yet: the watchtower follows these trucks. Old reports never had fixedAt, so nothing past is sent.
  const fixedWaiting = async () => Object.entries(await all()).filter(([, r]) => r.fixedAt && !r.recoverySentAt && r.unit && now() - r.fixedAt < RECOVERY_DAYS * DAY).map(([key, r]) => ({ key, ...r }));
  const recoveryFor = async (unit) => (await fixedWaiting()).filter((r) => unitKey(r.unit) === unitKey(unit)).sort((x, y) => y.fixedAt - x.fixedAt)[0] || null;
  // One per breakdown: claimed before the email goes. A failed send gives the claim back.
  async function claimRecovery(key) {
    let won = false;
    await db.update(KEY(site), (cur) => { const r = (cur || {})[key]; if (!r || r.recoverySentAt) return cur; won = true; return { ...cur, [key]: { ...r, recoverySentAt: now() } }; }, {});
    return won;
  }
  const releaseRecovery = (key) => patch(key, { recoverySentAt: null });

  // Staff sent the rescue plan: follow it on the same chain.
  async function rescuePlan(trip, { to, by, place = null }) {
    const k = await keyFor(trip);
    if (!k) return { ok: false, error: `No open breakdown on trip ${trip}.` };
    const r = (await all())[k];
    if (!/\d/.test(String(to || ''))) return { ok: false, error: 'Which truck number is the rescue truck?' };
    const spot = place ? oneLine(place, 160) : null;
    if (unitKey(r.rescue && r.rescue.to) === unitKey(to)) { if (spot) await patch(k, { rescue: { ...r.rescue, place: spot } }); return { ok: true, already: !spot }; }
    await patch(k, { rescue: { to: String(to), by, at: now(), place: spot } });
    return { ok: true };
  }

  // after each board refresh: the load on another truck in TruckMate = the transfer is done. "Transfer completed" goes out from the handoff record.
  async function process(site0, board) {
    const reports = await all();
    for (const [k, r] of Object.entries(reports)) {
      if (r.clearedAt || !r.unit) continue;
      const item = ((board && board.trips) || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(r.trip));
      const pu = item && item.trip && item.trip.powerUnit;
      if (!pu || unitKey(pu) === unitKey(r.unit)) continue;
      await patch(k, { clearedAt: now(), transferredTo: String(pu), rescue: r.rescue || { to: String(pu), by: 'TruckMate', at: now() } }); // eslint-disable-line no-await-in-loop
      await onTruckMateMove({ trip: String(r.trip), from: String(r.unit), to: String(pu), board }).catch((e) => console.warn('[breakdown-report] transfer:', e.message)); // eslint-disable-line no-await-in-loop
    }
  }

  // on the board: a rescue plan feeds the transfer watch until TruckMate moves the load
  async function overlay(site0, trips) {
    const records = Object.values(await all()).filter((r) => !r.clearedAt);
    const open = records.filter((r) => r.rescue);
    for (const it of trips) if (records.some((r) => String(r.trip) === String(((it && it.trip) || {}).tripNumber))) it._bdOpen = true;
    for (const it of trips) { const r = open.find((x) => String(x.trip) === String(((it && it.trip) || {}).tripNumber)); if (r) it._rescue = { from: r.unit, to: r.rescue.to, subject: r.subject, ...(r.rescue.place ? { place: r.rescue.place } : {}) }; }
  }

  if (app) {
    // A dispatcher reports it from the load's card: what broke, what the driver says, and pictures. Same email as any other report.
    if (requireAuth) app.post('/truckmate/breakdown/report', requireAuth, async (req, res) => {
      const b = req.body || {}; const by = (req.user && (req.user.name || req.user.email)) || 'Dispatch';
      if (oneLine(b.problem, MAX_REASON).length < 3) return res.status(400).json({ error: 'Write what the breakdown is.' });
      const files = (Array.isArray(b.photos) ? b.photos : []).filter((f) => f && f.dataBase64 && /^image\//i.test(f.mediaType || '')).slice(0, MAX_PHOTOS);
      let photos = []; let photosFailed = false;
      try { photos = files.length ? await storePhotos(String(b.trip), files, by) : []; } catch (e) { console.warn('[breakdown-report] photos:', e.message); photosFailed = true; }
      try {
        const r = await fromEmail({ trip: String(b.trip), reason: b.problem, driverSays: b.driverSays, part: ['truck', 'trailer'].includes(b.part) ? b.part : null, truck: oneLine(b.truck, 20) || null, trailer: oneLine(b.trailer, 20) || null, by, emailId: `console:${b.trip}:${now()}`, photos });
        if (r.duplicate) return res.status(409).json({ error: `${r.error}${photos.length ? ' Your photos went out on that email chain.' : ''}` });
        return r.ok ? res.json({ ok: true, subject: r.subject, photosFailed }) : res.status(400).json({ error: r.error });
      } catch (e) { console.warn('[breakdown-report]', e.message); return res.status(502).json({ error: 'The breakdown email did not go out. Try again or call dispatch.' }); }
    });
    if (requireAuth) {
      app.get('/truckmate/breakdown/open/:trip', requireAuth, async (req, res) => { try { res.json({ open: await openFor(req.params.trip) }); } catch (e) { res.status(500).json({ error: e.message }); } });
      app.post('/truckmate/breakdown/update', requireAuth, async (req, res) => {
        const b = req.body || {}; const by = (req.user && (req.user.name || req.user.email)) || 'Dispatch';
        if (oneLine(b.message, MAX_REASON).length < 3) return res.status(400).json({ error: 'Write the update.' });
        const files = (Array.isArray(b.photos) ? b.photos : []).filter((f) => f && f.dataBase64 && /^image\//i.test(f.mediaType || '')).slice(0, MAX_PHOTOS);
        let photos = []; let photosFailed = false;
        try { photos = files.length ? await storePhotos(String(b.trip), files, by) : []; } catch (e) { console.warn('[breakdown-report] photos:', e.message); photosFailed = true; }
        try {
          const r = await addUpdate({ trip: String(b.trip), message: b.message, by, photos });
          return r.ok ? res.json({ ok: true, photosFailed }) : res.status(409).json({ error: r.error });
        } catch (e) { console.warn('[breakdown-report]', e.message); return res.status(502).json({ error: 'The update saved, but the email did not go out. Tell the team.' }); }
      });
    }
    app.get('/br/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now());
      res.set('Cache-Control', 'no-store').type('html').send(reportPage(p, req.params.token, p ? (await all())[p.a] : null));
    });
    app.post('/br/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now());
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      try { const r = await submit(p, req.body || {}); return res.status(r.code).json(r); } catch (e) { console.warn('[breakdown-report]', e.message); return res.status(500).json({ error: 'Could not send. Call dispatch.' }); }
    });
  }
  return { link, forTrip, submit, fromEmail, addPhotos, addUpdate, openFor, held, clear, fixed, rescuePlan, process, overlay, fixedWaiting, recoveryFor, claimRecovery, releaseRecovery };
}

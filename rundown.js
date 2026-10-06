// ---------------------------------------------------------------
// Load rundown: when a load finishes, one PDF with everything that happened —
// timeline, stops, bills, rate con + handling sign-offs, outside carrier,
// Watchtower alerts and who handled them, check-ins, every call / text /
// driver reply — followed by the original trip sheet, rate con and the
// driver's POD / BOL pages. Stored on the load and emailed through Outlook.
//
//   GET  /truckmate/rundown/:trip/pdf      → the PDF (any load, live or finished)
//   POST /truckmate/rundown/:trip/send     → build + email it now
//   GET  /truckmate/rundowns               → recent rundowns and their email status
//   GET/PUT /truckmate/rundown/settings    → recipients, on/off, Outlook status
//   POST /truckmate/rundown/test-email     → test message to the recipients
// ---------------------------------------------------------------

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { tripTimes } from './triptimes.js';
import { tripHistory } from './driverlink.js';
import { ocFor } from './carriers.js';
import { sendMail, mailConfig } from './mailer.js';

const TZ = 'America/New_York';
const MAX_MAIL_BYTES = 2.8 * 1024 * 1024;   // Outlook sendMail limit is ~3 MB per attachment
const fmt = (v) => {
  if (v == null || v === '') return '—';
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(t)) return String(v);
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t));
};
// Helvetica only has the Windows-1252 characters — swap the rest.
const SAFE = { '→': '->', '←': '<-', '✓': 'OK', '✗': 'x', '·': '-', '≥': '>=', '≤': '<=', '°': ' deg', ' ': ' ' };
export const pdfSafe = (s) => String(s == null ? '' : s).replace(/[→←✓✗·≥≤° ]/g, (c) => SAFE[c]).replace(/[^\x09\x0a\x0d\x20-\x7e¡-ÿ–—‘’“”•…€]/g, '');

// ---- gather everything known about one load (pure given the stores) ----
export function buildRundown({ trip, rec, stores, finishedAt = null, reason = null }) {
  const item = (rec && rec.item) || {};
  const t = item.trip || item;
  const bills = Array.isArray(item.freightBills || item.orders) ? (item.freightBills || item.orders) : [];
  const s = stores;
  const oc = ocFor(item, s.carriers || { carriers: {}, codes: {}, marks: {} });
  const link = s.link || null;
  const track = s.track && s.track.length ? tripHistory(s.track) : null;
  const alerts = [...Object.values((s.watch && s.watch.alerts) || {}).filter((a) => String(a.trip) === trip), ...(s.watchArchive || [])]
    .filter((a, i, arr) => arr.findIndex((b) => b.id === a.id && b.openedAt === a.openedAt) === i)
    .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
  return {
    trip,
    reason,
    finishedAt,
    truck: t.powerUnit || null,
    trailer: t.trailer || null,
    drivers: [t.driver, t.driver2].filter(Boolean),
    origin: t.origZoneDesc || null,
    destination: t.destZoneDesc || null,
    status: [t.status, t.statusDesc].filter(Boolean).join(' - ') || null,
    times: rec ? tripTimes(rec) : null,
    bills: bills.map((b) => ({ number: b.billNumber, billTo: b.billToName || b.billTo || null, to: b.endZoneDescription || b.endZone || null, pieces: b.pieces || null, deliveredAt: b.actualDelivery || null, createdBy: b.createdBy || null })),
    manifest: s.manifest || null,
    ratecon: s.ratecon || null,
    rcChecks: s.rcChecks || {},
    visits: s.visits || {},
    oc,
    checkins: s.checkins || [],
    comms: (s.comms || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at))),
    stopConfirm: s.stopConfirm || {},
    link,
    track,
    alerts,
    docs: s.docs || [],
  };
}

// ---- PDF ----
export async function renderRundownPdf(r, { originals = [] } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612; const H = 792; const M = 48;
  let page = null; let y = 0;
  const NAVY = rgb(0.07, 0.2, 0.29); const MUTED = rgb(0.36, 0.4, 0.47); const LINE = rgb(0.86, 0.88, 0.92);
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const need = (h) => { if (!page || y - h < M + 20) newPage(); };
  const wrap = (text, f, size, width) => {
    const out = [];
    for (const para of pdfSafe(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(tryLine, size) > width && line) { out.push(line); line = word; } else line = tryLine;
      }
      out.push(line);
    }
    return out;
  };
  const text = (str, { size = 10, f = font, color = rgb(0.1, 0.12, 0.16), indent = 0, gap = 3 } = {}) => {
    for (const ln of wrap(str, f, size, W - 2 * M - indent)) {
      need(size + gap);
      page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };
  const h1 = (str) => { text(str, { size: 18, f: bold, color: NAVY, gap: 6 }); };
  const h2 = (str) => {
    need(40); y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: LINE }); y -= 6;
    text(str, { size: 12.5, f: bold, color: NAVY, gap: 5 });
  };
  const kv = (k, v) => {
    const lines = wrap(v == null || v === '' ? '—' : String(v), font, 10, W - 2 * M - 150);
    need(13 * lines.length);
    page.drawText(pdfSafe(k), { x: M, y: y - 10, size: 9.5, font: bold, color: MUTED });
    lines.forEach((ln, i) => page.drawText(ln, { x: M + 150, y: y - 10 - i * 13, size: 10, font }));
    y -= 13 * lines.length + 2;
  };
  const bullet = (str, opts = {}) => text(`- ${str}`, { indent: 8, ...opts });
  const none = (str) => text(str, { color: MUTED, size: 9.5 });

  newPage();
  text('FLORIDA BEAUTY FLORA - LOAD RUNDOWN', { size: 9, f: bold, color: MUTED });
  h1(`Trip ${r.trip}${r.truck ? ` - Truck ${r.truck}` : ''}${r.oc ? ` (outside carrier: ${(r.oc.carrier && r.oc.carrier.name) || 'unknown'})` : ''}`);
  text(`${r.origin || '?'} -> ${r.destination || '?'}`, { size: 11 });
  text(`Finished ${fmt(r.finishedAt)}${r.reason ? ` (${r.reason})` : ''} - report made ${fmt(Date.now())} by AI Dispatcher`, { size: 9, color: MUTED });
  y -= 4;
  kv('Trailer', r.trailer); kv('Driver ID(s)', r.drivers.join(', ')); kv('TruckMate status', r.status); kv('Freight bills', String(r.bills.length));

  h2('Timeline');
  const tm = r.times || {};
  kv('Created in TruckMate', tm.createdAt ? `${fmt(tm.createdAt)}${tm.createdBy ? ` by ${tm.createdBy}` : ''}` : null);
  kv('Added to AI Dispatcher', tm.addedAt ? `${tm.addedBefore ? 'before ' : ''}${fmt(tm.addedAt)}` : null);
  kv('Dispatched', tm.dispatchedAt ? fmt(tm.dispatchedAt) : tm.dispatchedBefore ? `before ${fmt(tm.dispatchedBefore)}` : (tm.noTruck ? 'No truck assigned' : null));
  kv('Finished', fmt(r.finishedAt));
  if (tm.statusHistory && tm.statusHistory.length) { text('Status changes:', { size: 9.5, f: bold, color: MUTED }); tm.statusHistory.forEach((h) => bullet(`${fmt(h.at)} - ${h.status}${h.desc ? ` (${h.desc})` : ''}`, { size: 9.5 })); }

  h2('Stops');
  const stops = (r.manifest && r.manifest.stops) || [];
  if (stops.length) {
    stops.forEach((st) => {
      const v = st.key && r.visits[st.key];
      const conf = st.key && r.stopConfirm[st.key];
      text(`${st.stopNumber != null ? `Stop ${st.stopNumber}` : 'Stop'}${st.subStop ? ' (+same stop)' : ''} - ${st.action || ''} - ${st.customer || ''} - ${[st.city, st.state].filter(Boolean).join(', ')}`, { f: bold, size: 10 });
      const bits = [];
      if (st.apptDate || st.apptTime) bits.push(`Appointment ${[st.apptDate, st.apptTime].filter(Boolean).join(' ')}${st.apptSource === 'handwritten' ? ' (handwritten)' : ''}`);
      if (st.piecesText || st.pieces) bits.push(`Quantity ${st.piecesText || `${st.pieces} pcs`}`);
      if (v) bits.push(`Geofence: ${v.state}${v.enteredAt ? `, arrived ${fmt(v.enteredAt)}` : ''}${v.exitedAt ? `, left ${fmt(v.exitedAt)}` : ''}${v.dwellMin != null ? `, ${v.dwellMin} min on site` : ''}`);
      if (conf) bits.push(`Driver confirmed delivered by text ${fmt(conf.at)}: "${conf.text}"`);
      (st.callAhead || []).forEach((c) => bits.push(`Call-ahead: ${[c.contact, c.phone].filter(Boolean).join(' ')}`));
      bits.forEach((b) => bullet(b, { size: 9.5 }));
    });
    text(`Trip sheet version ${r.manifest.version || 1}, uploaded ${fmt(r.manifest.uploadedAt)}${r.manifest.uploadedBy ? ` by ${r.manifest.uploadedBy}` : ''}.`, { size: 9, color: MUTED });
    (r.manifest.diffs || []).forEach((d) => bullet(`Sheet vs TruckMate: ${d.msg}`, { size: 9, color: MUTED }));
  } else none('No trip sheet was uploaded — stop order from TruckMate bills below.');

  h2('Freight bills');
  if (r.bills.length) r.bills.forEach((b) => bullet(`${b.number} - ${b.billTo || ''} -> ${b.to || ''}${b.pieces ? ` - ${b.pieces} pcs` : ''} - ${b.deliveredAt ? `delivered ${fmt(b.deliveredAt)}` : 'no delivery time in TruckMate'}`, { size: 9.5 }));
  else none('No bills on the load.');

  h2('Rate confirmation & handling instructions');
  if (r.ratecon) {
    const rc = r.ratecon;
    kv('Broker', rc.broker || rc.brokerName); kv('Load #', rc.loadNumber); kv('Rate', rc.rate != null ? String(rc.rate) : null);
    kv('Uploaded', `${fmt(rc.uploadedAt)}${rc.uploadedBy ? ` by ${rc.uploadedBy}` : ''}`);
    (rc.specialInstructions || []).forEach((ins) => {
      const c = r.rcChecks[ins];
      bullet(`${ins} - ${c && c.done ? `signed off by ${c.by} ${fmt(c.at)}` : 'NOT signed off'}`, { size: 9.5 });
    });
  } else none('No rate confirmation uploaded.');

  if (r.oc) {
    h2('Outside carrier');
    const c = r.oc.carrier || {};
    kv('Carrier', c.name); kv('Main phone', c.dispatchPhone); kv('MC / DOT', [c.mc && `MC ${c.mc}`, c.dot && `DOT ${c.dot}`].filter(Boolean).join(' - '));
    kv('Crew', r.oc.crew === 'team' ? 'Team - 2 drivers' : 'Solo');
    kv('Driver 1', [r.oc.driverName, r.oc.driverPhone].filter(Boolean).join(' - '));
    if (r.oc.crew === 'team') kv('Driver 2', [r.oc.driver2Name, r.oc.driver2Phone].filter(Boolean).join(' - '));
    kv('Truck / trailer', `${r.oc.truck || '—'} / ${r.oc.trailer || '—'}`);
    kv('Texts consent', r.oc.smsConsent ? `recorded by ${r.oc.smsConsent.by} ${fmt(r.oc.smsConsent.at)}` : 'not recorded');
    if (r.link) kv('Tracking link', `created ${fmt(r.link.createdAt)} by ${r.link.createdBy || '—'}; sent ${fmt(r.link.sentAt)}; opened ${r.link.openedAt ? `${fmt(r.link.openedAt)} (${r.link.openedVia || ''})` : 'never'}; ${r.link.points || 0} GPS points`);
    if (r.track) kv('Driver phone GPS', `${r.track.miles} mi tracked, ${r.track.stops.length} stop(s) of 10+ min, ${fmt(r.track.startedAt)} -> ${fmt(r.track.lastAt)}`);
    if (r.track) r.track.stops.forEach((st) => bullet(`Parked ${st.minutes} min at ${st.lat.toFixed(4)}, ${st.lng.toFixed(4)} (${fmt(st.from)} - ${fmt(st.to)})`, { size: 9 }));
  }

  h2('Watchtower alerts and who handled them');
  if (r.alerts.length) {
    r.alerts.forEach((a) => {
      text(`${String(a.severity || '').toUpperCase()} - ${a.title}`, { f: bold, size: 10 });
      bullet(`Opened ${fmt(a.openedAt)}${a.pushes ? ` - pushed ${a.pushes}x` : ''}`, { size: 9.5 });
      if (a.ack) bullet(`Owned by ${a.ack.by} ${fmt(a.ack.at)}`, { size: 9.5 });
      if (a.resolvedAt) bullet(`Resolved ${fmt(a.resolvedAt)} ${a.resolvedBy === 'auto' ? '(cleared automatically)' : `by ${a.resolvedBy}`}${a.note ? ` - "${a.note}"` : ''}`, { size: 9.5 });
      else bullet('Still open when the load finished', { size: 9.5 });
    });
  } else none('No alerts were raised on this load.');

  h2('Check-ins & driver updates');
  if (r.checkins.length) r.checkins.slice().reverse().forEach((c) => bullet(`${fmt(c.at)} - ${c.source}${c.by ? ` (${c.by})` : ''}${c.from ? ` from ${c.from}` : ''}: ${c.location ? `${c.location} - ` : ''}${c.text}${c.issue ? ' [PROBLEM]' : ''}`, { size: 9.5 }));
  else none('No check-ins.');

  h2('Calls & text conversations');
  if (r.comms.length) {
    r.comms.forEach((c) => {
      if (c.type === 'call') bullet(`${fmt(c.at)} - CALL by ${c.by || 'dispatch'} to ${c.label || c.to}`, { size: 9.5 });
      else if (c.type === 'reply') bullet(`${fmt(c.at)} - DRIVER (${c.from}): "${c.text}"`, { size: 9.5 });
      else bullet(`${fmt(c.at)} - TEXT by ${c.by || 'dispatch'} to ${c.to}: "${c.text}"`, { size: 9.5 });
    });
  } else none('No calls or texts from AI Dispatcher.');

  h2('Documents on file');
  if (r.docs.length) r.docs.forEach((d) => bullet(`${d.kind}${d.docType ? ` / ${d.docType}` : ''} - ${d.filename || `page ${d.page || ''}`} - ${fmt(d.uploadedAt)}${d.uploadedBy ? ` by ${d.uploadedBy}` : ''}${d.restricted ? ' (restricted - not attached)' : ''}`, { size: 9.5 }));
  else none('No documents stored.');
  if (originals.length) text(`Attached after this page: ${originals.length} original page(s) - trip sheet, rate confirmation, POD / BOL.`, { size: 9.5, color: MUTED });

  // the originals, in order
  for (const o of originals) {
    try {
      if (/pdf/i.test(o.mediaType)) {
        const src = await PDFDocument.load(o.data, { ignoreEncryption: true }); // eslint-disable-line no-await-in-loop
        (await pdf.copyPages(src, src.getPageIndices())).forEach((p) => pdf.addPage(p)); // eslint-disable-line no-await-in-loop
      } else if (/png|jpe?g/i.test(o.mediaType)) {
        const img = /png/i.test(o.mediaType) ? await pdf.embedPng(o.data) : await pdf.embedJpg(o.data); // eslint-disable-line no-await-in-loop
        const k = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height, 1);
        const p = pdf.addPage([W, H]);
        p.drawImage(img, { x: (W - img.width * k) / 2, y: (H - img.height * k) / 2, width: img.width * k, height: img.height * k });
      }
    } catch { /* skip a page we can't read */ }
  }
  // page numbers
  const pages = pdf.getPages();
  pages.forEach((p, i) => p.drawText(`Trip ${r.trip} rundown - page ${i + 1} of ${pages.length}`, { x: M, y: 24, size: 8, font, color: MUTED }));
  return pdf.save();
}

export function initRundowns(app, { requireAuth, db, docs = null, env = process.env, fetchFn = globalThis.fetch }) {
  const enabled = !!(db && db.enabled);
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const cfgKey = 'taRundownCfg';
  const finishedKey = (site) => `taRundowns:${site}`;      // trip → { rec, finishedAt, reason, status, … }

  async function gather(site, trip, rec) {
    const g = (k, fb) => db.get(k, fb);
    const [manifests, rcs, checks, visits, carriers, checkins, comms, confirms, links, watch, archive] = await Promise.all([
      g(`taTruckMateManifest:${site}`, {}), g(`taTruckMateRateCon:${site}`, {}), g(`taTruckMateRcCheck:${site}`, {}),
      g(`taStopVisits:${site}`, {}), g(`taCarriers:${site}`, { carriers: {}, codes: {}, marks: {} }), g(`taCarrierCheckins:${site}`, {}),
      g(`taTripComms:${site}`, {}), g(`taStopConfirm:${site}`, {}), g(`taDriverLinks:${site}`, { byTrip: {} }),
      g(`taWatch:${site}`, { alerts: {} }), g(`taWatchArchive:${site}`, {}),
    ]);
    const tok = (links.byTrip || {})[trip];
    const link = tok ? await g(`taDriverLink:${tok}`, null) : null;
    const track = await g(`taDriverPos:${site}:${trip}`, []);
    const docList = docs && docs.enabled ? await docs.listDocs({ site, trips: [trip] }) : [];
    const manifest = manifests[trip] || null;
    // the manifest needs the item for ocFor's trip-sheet carrier
    if (rec && rec.item && manifest) rec.item._manifest = manifest;
    return {
      manifest, ratecon: rcs[trip] || null, rcChecks: checks[trip] || {}, visits: visits[trip] || {}, carriers, checkins: checkins[trip] || [],
      comms: comms[trip] || [], stopConfirm: confirms[trip] || {}, link, track, watch, watchArchive: archive[trip] || [], docs: docList.filter((d) => d.kind !== 'rundown'),
    };
  }

  // which stored pages go at the back: trip sheet, rate con, driver POD/BOL, packet BOL/POD pages
  function originalIds(stores) {
    const want = (d) => !d.restricted && (d.kind === 'ratecon' || d.kind === 'driverdoc' || (d.kind === 'tripsheet' && /^(manifest|bill_of_lading|proof_of_delivery|packing_slip|shipping_ticket)/.test(d.docType || 'manifest')));
    return stores.docs.filter(want).sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)) || (a.page || 0) - (b.page || 0)).map((d) => d.id);
  }

  async function recFor(site, trip) {
    const active = await db.get(`taTruckMateActive:${site}`, { trips: {} });
    if (active.trips && active.trips[trip]) return { rec: active.trips[trip], finishedAt: null, reason: 'still active' };
    const done = (await db.get(finishedKey(site), {}))[trip];
    return done ? { rec: done.rec, finishedAt: done.finishedAt, reason: done.reason } : null;
  }

  async function makePdf(site, trip, { withOriginals = true } = {}) {
    const found = await recFor(site, trip);
    if (!found) return null;
    const rec = JSON.parse(JSON.stringify(found.rec || {}));
    const stores = await gather(site, trip, rec);
    const data = buildRundown({ trip, rec, stores, finishedAt: found.finishedAt, reason: found.reason });
    const originals = withOriginals && docs && docs.readDocs ? await docs.readDocs({ site, ids: originalIds(stores) }) : [];
    const bytes = await renderRundownPdf(data, { originals });
    return { bytes, data, originals: originals.length };
  }

  async function settings() { return { to: [], enabled: true, ...(await db.get(cfgKey, {})) }; }

  async function deliver(site, trip, { to = null, by = 'AI Dispatcher' } = {}) {
    const cfg = await settings();
    const rcpts = to || cfg.to || [];
    let made = await makePdf(site, trip);
    if (!made) throw new Error('No record of that load.');
    let note = '';
    if (made.bytes.length > MAX_MAIL_BYTES) { made = await makePdf(site, trip, { withOriginals: false }); note = 'The original pages were too large to email — open the full rundown in AI Dispatcher.'; }
    const d = made.data;
    // keep a copy on the load
    let docId = null;
    if (docs && docs.enabled) {
      try { const [doc] = await docs.storeDocs({ site, kind: 'rundown', trip, files: [{ filename: `Rundown ${trip}.pdf`, mediaType: 'application/pdf', dataBase64: Buffer.from(made.bytes).toString('base64') }], by }); docId = doc && doc.id; } catch (e) { console.warn('[rundown] store:', e.message); }
    }
    let status = 'saved'; let error = null; let sentTo = null;
    if (!rcpts.length) status = 'saved — no recipients set';
    else if (!mailConfig(env).ready) status = 'saved — Outlook not connected yet';
    else {
      try {
        const r = await sendMail({
          to: rcpts,
          subject: `Load ${trip} ${d.reason === 'delivered' ? 'delivered' : 'finished'} — rundown${d.truck ? ` (Truck ${d.truck}` : ''}${d.destination ? ` → ${d.destination})` : d.truck ? ')' : ''}`,
          html: `<p><b>Trip ${trip}</b>${d.truck ? ` · Truck ${d.truck}` : ''}${d.oc ? ` · Outside carrier ${(d.oc.carrier && d.oc.carrier.name) || ''}` : ''}<br>${d.origin || ''} → ${d.destination || ''}<br>Finished ${fmt(d.finishedAt)}</p>
<p>${d.bills.length} bill(s) · ${d.alerts.length} alert(s) · ${d.comms.length} call/text(s) · ${d.checkins.length} check-in(s)</p>
<p>The full rundown — timeline, stops, alerts and who handled them, every call and text, and the original paperwork — is attached as a PDF.${note ? ` ${note}` : ''}</p>
<p style="color:#667">Sent automatically by AI Dispatcher.</p>`,
          attachments: [{ name: `Rundown ${trip}.pdf`, contentType: 'application/pdf', bytes: made.bytes }],
        }, { env, fetchFn });
        status = 'emailed'; sentTo = r.to;
      } catch (e) { status = 'email failed'; error = e.message; }
    }
    await db.update(finishedKey(site), (cur) => {
      const all = { ...(cur || {}) };
      if (all[trip]) all[trip] = { ...all[trip], status, error, sentTo, docId, madeAt: new Date().toISOString(), attempts: (all[trip].attempts || 0) + 1 };
      return all;
    }, {});
    return { status, error, sentTo, docId, pages: made.originals };
  }

  // Called by the TruckMate board when a load is delivered / leaves the board.
  async function onFinished(site, rec, reason) {
    if (!enabled || !rec) return;
    const t = (rec.item && (rec.item.trip || rec.item)) || {};
    const trip = String((rec.item && rec.item._id) || t.tripNumber || '');
    if (!trip) return;
    const fresh = await db.update(finishedKey(site), (cur) => {
      const all = { ...(cur || {}) };
      if (all[trip] && all[trip].finishedAt) return all;            // already done
      all[trip] = { rec, finishedAt: new Date().toISOString(), reason, status: 'pending', attempts: 0 };
      // keep 60 days
      const cutoff = Date.now() - 60 * 24 * 3600000;
      for (const [k, v] of Object.entries(all)) if (Date.parse(v.finishedAt || 0) < cutoff) delete all[k];
      return all;
    }, {});
    if (fresh[trip] && fresh[trip].status === 'pending' && (await settings()).enabled !== false) {
      deliver(site, trip).catch((e) => console.warn('[rundown]', trip, e.message));
    }
  }

  // retry failed / pending ones every 10 minutes (max 3 tries)
  if (enabled && env.NODE_ENV !== 'test') {
    const tick = setInterval(async () => {
      try {
        const all = await db.get(finishedKey('florida-beauty'), {});
        for (const [trip, v] of Object.entries(all)) {
          if ((v.status === 'pending' || v.status === 'email failed') && (v.attempts || 0) < 3) await deliver('florida-beauty', trip); // eslint-disable-line no-await-in-loop
        }
      } catch (e) { console.warn('[rundown] retry:', e.message); }
    }, 10 * 60000);
    if (tick.unref) tick.unref();
  }

  app.get('/truckmate/rundown/:trip/pdf', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      const made = await makePdf(siteOf(req), String(req.params.trip), { withOriginals: req.query.originals !== '0' });
      if (!made) return res.status(404).json({ error: 'No record of that load.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Rundown ${String(req.params.trip).replace(/[^\w-]/g, '')}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(made.bytes));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/truckmate/rundown/:trip/send', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const site = siteOf(req); const trip = String(req.params.trip);
    try {
      const has = (await db.get(finishedKey(site), {}))[trip];
      if (!has) { const found = await recFor(site, trip); if (!found) return res.status(404).json({ error: 'No record of that load.' }); await db.update(finishedKey(site), (cur) => ({ ...(cur || {}), [trip]: { rec: found.rec, finishedAt: null, reason: 'sent while active', status: 'pending', attempts: 0 } }), {}); }
      const to = req.body && req.body.to ? String(req.body.to).split(/[,;\s]+/).filter((x) => /@/.test(x)) : null;
      res.json(await deliver(site, trip, { to, by: who(req) }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/truckmate/rundowns', requireAuth, async (req, res) => {
    if (!enabled) return res.json([]);
    const all = await db.get(finishedKey(siteOf(req)), {});
    res.json(Object.entries(all).map(([trip, v]) => ({ trip, finishedAt: v.finishedAt, reason: v.reason, status: v.status, error: v.error || null, sentTo: v.sentTo || null, docId: v.docId || null, madeAt: v.madeAt || null }))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt))).slice(0, 200));
  });
  app.get('/truckmate/rundown/settings', requireAuth, async (req, res) => {
    const c = mailConfig(env);
    res.json({ ...(enabled ? await settings() : { to: [], enabled: true }), outlook: { connected: c.ready, from: c.from || null, missing: c.missing } });
  });
  app.put('/truckmate/rundown/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 20);
    const next = await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, enabled: b.enabled !== false, updatedBy: who(req), updatedAt: new Date().toISOString() }), {});
    res.json(next);
  });
  app.post('/truckmate/rundown/test-email', requireAuth, async (req, res) => {
    try {
      const cfg = await settings();
      const r = await sendMail({ to: cfg.to, subject: 'AI Dispatcher — test email', html: `<p>This is a test from AI Dispatcher. Load rundowns will be sent to: ${(cfg.to || []).join(', ')}</p><p>Sent by ${who(req)}.</p>` }, { env, fetchFn });
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log(`[rundown] load rundowns ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'} · Outlook ${mailConfig(env).ready ? 'connected' : 'not connected'}`);
  return { onFinished, makePdf, deliver };
}

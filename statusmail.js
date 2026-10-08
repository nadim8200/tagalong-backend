// ---------------------------------------------------------------
// Customer status emails for B and R loads (bill numbers starting B / R),
// sent automatically from Jarvis (the Outlook mailbox, see mailer.js):
//
//   1. Truck assigned   — truck, trailer, driver name + phone, current location, ETA to pickup
//   2. Picked up        — load picked up, driver departed the shipper
//   3. Location update  — every 3 hours while in transit (location + ETA to the next stop)
//   4. Arrived at stop  — "at the receiver" / stop 1, 2, 3 of N
//   5. Delivered        — the whole load delivered
//
// Events come from TruckMate statuses (DEPSHIP, ARRCONS…), the stop geofence
// visits, bill delivery times and the live GPS. Runs after every Watchtower
// cycle. Each email goes out once per load; when several happen at once (a load
// we first see already rolling) only the newest one is sent. Every email is
// logged on the load (conversation history + rundown PDF).
//
// Recipients: emails saved per bill-to customer, a per-load list, and
// (optionally) the broker email read from the rate con.
// ---------------------------------------------------------------
import { sendMail, mailConfig } from './mailer.js';
import { haversineMi, estimateArrival, MIAMI_TERMINAL } from './watchtower.js';
import { fmtLocal } from './localtime.js';

const H = 3600000;
const PICKED = /^(depship|depshp|loaded|pickd|intran|enroute|enrt|arrcons|arrcon|depcons|depcon|delvd|deliv|cmplt|complete)/i;
const ARRIVE = /^arrcon/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete)/i;
const DEAD = /^(canc|void)/i;
export const DEFAULTS = { enabled: true, prefixes: ['B', 'R'], everyHours: 3, useBroker: true, customers: {}, trips: {} };
const MAX_PER_DAY = 15;

const tripOf = (item) => (item && item.trip) || item || {};
export const custKey = (name) => String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
const zipOf = (s) => { const m = String(s || '').match(/\b(\d{5})(?:-\d{4})?\b/); return m ? m[1] : null; };
const cityOf = (s) => String(s || '').replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim();
export const emailList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];

const phone10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : null; };
const fmtPhone = (d) => (d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null);

// Pull email / phone out of a TruckMate client record (bill-to, caller,
// consignee) without knowing its exact field names.
export function tmContact(rec) {
  if (!rec || typeof rec !== 'object') return null;
  let email = null; let phone = null; let name = null;
  for (const [k, v] of Object.entries(rec)) {
    if (v == null || typeof v === 'object') continue;
    if (!email && /e-?mail/i.test(k) && /@/.test(String(v))) email = String(v).trim();
    else if (!phone && /(phone|cell|mobile|tel)/i.test(k) && !/fax|ext/i.test(k) && phone10(v)) phone = phone10(v);
    else if (!name && /^(contact|contactname|attention)$/i.test(k)) name = String(v).trim() || null;
  }
  const company = rec.name || rec.clientName || rec.customerName || rec.companyName || null;
  return email || phone ? { company: company ? String(company).trim() : null, name, email, phone } : null;
}

// Everyone to update on a load, from the trip sheet (incl. its rate con /
// emails), TruckMate's bill-to / caller / consignee records and the rate con —
// merged by email (or phone), with where each came from. "verified" = the trip
// sheet and TruckMate agree; a company whose email differs between them is
// flagged. A dispatcher's edit for the load replaces the whole list. Pure.
export function contactsFor(item, { customers = {}, edit = null, prefixes = DEFAULTS.prefixes } = {}) {
  const list = [];
  const add = (c, source) => {
    const email = c.email && emailList(c.email)[0];
    const phone = phone10(c.phone);
    if (!email && !phone) return;
    const same = list.find((x) => (email && x.email === email) || (!email && phone && !x.email && x.phone === phone));
    if (same) {
      if (!same.sources.includes(source)) same.sources.push(source);
      if (!same.phone && phone) same.phone = phone;
      if (!same.company && c.company) same.company = c.company;
      if (!same.name && c.name) same.name = c.name;
      if (same.role === 'other' && c.role) same.role = c.role;
      return;
    }
    list.push({ role: c.role || 'other', company: c.company || null, name: c.name || null, email: email || null, phone: phone || null, sources: [source] });
  };
  const sheet = (item && item._manifest) || {};
  (sheet.contacts || []).forEach((c) => add(c, 'trip sheet'));
  (sheet.stops || []).forEach((st) => (st.callAhead || []).forEach((c) => add({ role: 'receiver', company: st.customer, name: c.contact, phone: c.phone }, 'trip sheet')));
  const p = prefixes.map((x) => String(x).toUpperCase());
  for (const b of billsOf(item)) {
    const br = p.includes(String(b.billNumber || '').charAt(0).toUpperCase());
    [['billToCustomer', 'customer'], ['caller', br ? 'broker' : 'customer'], ['consignee', 'receiver']].forEach(([k, role]) => {
      const c = tmContact(b[k]);
      if (c) add({ ...c, role, company: c.company || (k === 'billToCustomer' ? b.billToName : null) }, 'TruckMate');
    });
    for (const e of customers[custKey(b.billToName)] || []) add({ role: 'customer', company: b.billToName, email: e }, 'saved for customer');
  }
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  if (rc.brokerEmail || rc.brokerPhone) add({ role: 'broker', company: rc.broker, email: rc.brokerEmail, phone: rc.brokerPhone }, 'rate con');
  const RC_ROLE = { broker_rep: 'broker', after_hours: 'broker', dispatch: 'broker', tracking: 'broker', billing: 'other', shipper: 'shipper', receiver: 'receiver', other: 'other' };
  for (const c of rc.contacts || []) if (c && (c.email || c.phone)) add({ role: RC_ROLE[c.role] || 'other', company: c.company || (RC_ROLE[c.role] === 'broker' ? rc.broker : null), name: c.name, email: c.email, phone: c.phone }, 'rate con');
  // customer / broker profiles (Customers tab): contacts marked "Status emails"
  for (const pr of (item && item._profiles) || []) for (const c of pr.contacts || []) if (c.statusEmails && (c.email || c.phone)) add({ role: pr.type === 'broker' ? 'broker' : 'customer', company: pr.name, name: c.name, email: c.email, phone: c.phone }, 'customer profile');
  // trip sheet vs TruckMate
  for (const c of list) {
    c.verified = c.sources.includes('trip sheet') && c.sources.includes('TruckMate');
    const key = custKey(c.company);
    if (key && c.email) {
      const other = list.find((x) => x !== c && x.email && custKey(x.company) === key && x.sources.some((z) => !c.sources.includes(z)) && ((c.sources.includes('trip sheet') && x.sources.includes('TruckMate')) || (c.sources.includes('TruckMate') && x.sources.includes('trip sheet'))));
      if (other) c.differs = other.email;
    }
    c.phoneLabel = fmtPhone(c.phone);
  }
  if (edit && ((edit.emails || []).length || (edit.phones || []).length)) {
    return {
      edited: true, found: list,
      contacts: [...(edit.emails || []).map((e) => ({ role: 'edited', email: e, phone: null, sources: ['edited by dispatch'] })), ...(edit.phones || []).map((ph) => ({ role: 'edited', email: null, phone: phone10(ph), phoneLabel: fmtPhone(phone10(ph)), sources: ['edited by dispatch'] }))],
    };
  }
  return { edited: false, contacts: list, found: list };
}

export function billsOf(item) { return (item && (item.freightBills || item.orders)) || tripOf(item).freightBills || []; }

// B / R loads only (the prefixes are a setting). Pure.
export function qualifies(item, prefixes = DEFAULTS.prefixes) {
  const p = prefixes.map((x) => String(x).toUpperCase());
  return billsOf(item).some((b) => p.includes(String(b.billNumber || '').charAt(0).toUpperCase()));
}

// Physical delivery stops in driving order: the trip sheet's order when there
// is one, else the order TruckMate lists the bills. Pure.
export function stopsOf(item) {
  const map = new Map();
  for (const b of billsOf(item)) {
    const label = b.endZoneDescription || b.endZone || '';
    if (!label) continue;
    const st = map.get(label) || { key: label, place: cityOf(label), zip: zipOf(label), customers: [], delivered: true, deliveredAt: null };
    if (b.billToName && !st.customers.includes(b.billToName)) st.customers.push(b.billToName);
    if (!b.actualDelivery) st.delivered = false;
    else if (!st.deliveredAt || String(b.actualDelivery) > st.deliveredAt) st.deliveredAt = String(b.actualDelivery);
    map.set(label, st);
  }
  const stops = [...map.values()];
  const sheet = (item && item._manifest && Array.isArray(item._manifest.stops)) ? item._manifest.stops.filter((s) => /DELIVER/i.test(s.action || '')) : [];
  const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
  for (const st of stops) {
    const city = norm(st.place.split(',')[0]);
    const hit = sheet.find((s) => norm(s.city) === city || norm(String(s.tmPlace || '').split(',')[0]) === city);
    if (hit) { st.seq = hit.stopNumber != null ? hit.stopNumber : 999; st.sheetKey = hit.key || null; if (hit.customer) st.name = hit.customer; }
  }
  stops.sort((a, b) => (a.seq != null ? a.seq : 999) - (b.seq != null ? b.seq : 999));
  stops.forEach((s, i) => { s.number = i + 1; });
  return stops;
}

function driversOf(item) {
  const oc = item && item._oc;
  const s = (item && item._samsara) || {};
  const t = tripOf(item);
  if (oc) return [{ name: oc.driverName, phone: oc.driverPhone }, oc.driver2Name || oc.driver2Phone ? { name: oc.driver2Name, phone: oc.driver2Phone } : null].filter((d) => d && (d.name || d.phone));
  const list = [s.driver1Info || (t.driver ? { name: t.driver } : null), s.driver2Info || (t.driver2 ? { name: t.driver2 } : null)];
  return list.filter((d) => d && (d.name || d.phone)).map((d) => ({ name: d.name || null, phone: d.phone || null }));
}

function whereNow(item, now) {
  const s = (item && item._samsara) || {};
  if (s.lat != null && s.gpsAt && now - Date.parse(s.gpsAt) < 2 * H) return { place: s.location || null, lat: s.lat, lng: s.lng, at: s.gpsAt, mph: s.speedMph };
  const c = ((item && item._checkins) || []).find((x) => x.location);
  if (c) return { place: c.location, at: c.at, lat: null, lng: null };
  if (s.location) return { place: s.location, at: s.gpsAt || null, lat: s.lat, lng: s.lng, stale: true };
  return null;
}

function etaTo(item, here, zip, { geo, now }) {
  if (!here || here.lat == null) return null;
  const g = zip ? geo(zip) : null;
  if (!g) return null;
  const miles = haversineMi(here.lat, here.lng, g.lat, g.lng) * 1.2;
  if (miles < 3) return { miles: 0, atMs: now, here: true };
  const hos = ((item && item._samsara) || {}).hos || {};
  const team = !!(tripOf(item).driver2);
  return { miles: Math.round(miles), atMs: estimateArrival(miles, { team, driveLeftMin: hos.driveLeftMin, shiftLeftMin: hos.shiftLeftMin, now }) };
}

// What has happened on the load that the customer hasn't been told yet. Pure.
// sent: { assigned, pickedUp, stops: {key: at}, delivered, lastLocationAt }
export function pendingEvents(item, sent = {}, { now = Date.now(), everyHours = 3 } = {}) {
  const t = tripOf(item);
  const status = String(t.status || '');
  if (DEAD.test(status)) return [];
  const stops = stopsOf(item);
  const hist = (item && item._times && item._times.statusHistory) || [];
  const everPicked = PICKED.test(status) || hist.some((h) => PICKED.test(h.status)) || stops.some((s) => s.delivered);
  const allDelivered = stops.length > 0 && stops.every((s) => s.delivered);
  const delivered = allDelivered || DONE.test(status);
  const truck = t.powerUnit || (item && item._oc && item._oc.truck);
  const out = [];
  const sentStops = sent.stops || {};
  if (!sent.assigned && truck && (driversOf(item).length || item._oc)) out.push({ kind: 'assigned' });
  if (!sent.pickedUp && everPicked) out.push({ kind: 'picked-up' });
  // arrivals: geofence visit, a TruckMate "arrived consignee", or the stop's bills delivered
  const visits = (item && item._visits) || {};
  const arrCount = hist.filter((h) => ARRIVE.test(h.status)).length + (ARRIVE.test(status) && !hist.some((h) => ARRIVE.test(h.status)) ? 1 : 0);
  stops.forEach((st, i) => {
    if (sentStops[st.key]) return;
    const v = st.sheetKey ? visits[st.sheetKey] : null;
    const atStop = v && ['at_stop', 'departing', 'completed'].includes(v.state);
    const byStatus = i < arrCount;
    if (atStop || byStatus || st.delivered) out.push({ kind: 'arrived', stop: st.key, number: st.number, of: stops.length, delivered: st.delivered && !atStop && !byStatus });
  });
  if (!sent.delivered && delivered) out.push({ kind: 'delivered' });
  const lastLoc = sent.lastLocationAt || sent.pickedUp;
  // the 3-hour location email, only when nothing bigger is going out
  if (!out.length && !delivered && everPicked && sent.pickedUp && lastLoc && now - Date.parse(lastLoc) >= everyHours * H) out.push({ kind: 'location' });
  return out;
}

const fmtTime = (ms) => (ms == null ? null : `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The email for one event. Pure (given geo).
export function renderEvent(ev, item, { geo = () => null, now = Date.now() } = {}) {
  const t = tripOf(item);
  const stops = stopsOf(item);
  const bills = billsOf(item).map((b) => b.billNumber).filter(Boolean);
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  const truck = t.powerUnit || (item._oc && item._oc.truck) || '—';
  const trailer = t.trailer || (item._oc && item._oc.trailer) || '—';
  const here = whereNow(item, now);
  const next = stops.find((s) => !s.delivered);
  const ref = rc.loadNumber ? `Load ${rc.loadNumber} · ` : '';
  const head = `${ref}Trip ${t.tripNumber}${bills.length ? ` · Bill ${bills.slice(0, 3).join(', ')}${bills.length > 3 ? '…' : ''}` : ''}`;
  const rows = [];
  const row = (k, v) => { if (v) rows.push([k, v]); };
  let title; let lead;
  const loc = here ? `${here.place || 'Location on file'}${here.stale ? ' (last known)' : ''}${here.at ? ` · ${fmtTime(Date.parse(here.at))}` : ''}` : 'Not available yet';
  const stopName = (s) => `${s.name || (s.customers || [])[0] || 'Receiver'} — ${s.place}`;
  if (ev.kind === 'assigned') {
    title = 'Truck assigned';
    lead = 'A truck and driver have been assigned to your load.';
    row('Truck', truck); row('Trailer', trailer);
    driversOf(item).forEach((d, i, a) => row(a.length > 1 ? `Driver ${i + 1}` : 'Driver', [d.name, d.phone].filter(Boolean).join(' · ')));
    row('Current location', loc);
    const pz = zipOf(t.origZoneDesc);
    const pickupGeo = pz ? null : (/MIAMI/i.test(t.origZoneDesc || '') ? MIAMI_TERMINAL : null);
    const eta = pickupGeo && here && here.lat != null
      ? (() => { const m = haversineMi(here.lat, here.lng, pickupGeo.lat, pickupGeo.lng) * 1.2; return m < 3 ? { here: true } : { miles: Math.round(m), atMs: estimateArrival(m, { now }) }; })()
      : etaTo(item, here, pz, { geo, now });
    row('Pickup', cityOf(t.origZoneDesc) || null);
    row('ETA to pickup', eta ? (eta.here ? 'At the pickup now' : `${fmtLocal(eta.atMs, t.origZoneDesc)} (~${eta.miles} mi)`) : 'To follow');
  } else if (ev.kind === 'picked-up') {
    title = 'Load picked up — driver departed shipper';
    lead = 'Your load has been picked up and the driver has departed the shipper.';
    row('Truck / trailer', `${truck} / ${trailer}`);
    row('Current location', loc);
    if (next) { const e = etaTo(item, here, next.zip, { geo, now }); row(`Next stop (${next.number} of ${stops.length})`, stopName(next)); row('ETA', e ? (e.here ? 'Arriving now' : `${fmtLocal(e.atMs, next.key || next.place)} (~${e.miles} mi)`) : 'To follow'); }
  } else if (ev.kind === 'location') {
    title = 'Location update';
    lead = 'Here is the current location of your load.';
    row('Current location', loc);
    if (here && here.mph != null) row('Status', here.mph > 5 ? `Moving · ${Math.round(here.mph)} mph` : 'Stopped');
    if (next) { const e = etaTo(item, here, next.zip, { geo, now }); row(`Next stop (${next.number} of ${stops.length})`, stopName(next)); row('ETA', e ? (e.here ? 'Arriving now' : `${fmtLocal(e.atMs, next.key || next.place)} (~${e.miles} mi)`) : 'To follow'); }
    row('Truck / trailer', `${truck} / ${trailer}`);
  } else if (ev.kind === 'arrived') {
    const st = stops.find((s) => s.key === ev.stop) || { place: ev.stop, number: ev.number };
    const final = ev.of === 1 || ev.number === ev.of;
    title = ev.of > 1 ? `Arrived at stop ${ev.number} of ${ev.of}` : 'Arrived at the receiver';
    lead = ev.delivered ? `Stop ${ev.number} of ${ev.of} has been delivered.` : `The driver has arrived at ${ev.of > 1 ? `stop ${ev.number} of ${ev.of}` : 'the receiver'}${final && ev.of > 1 ? ' (final stop)' : ''}.`;
    if (ev.delivered) title = ev.of > 1 ? `Stop ${ev.number} of ${ev.of} delivered` : 'Delivered at the receiver';
    row('Stop', stopName(st));
    if (st.deliveredAt) row('Delivered', `${st.deliveredAt.replace('T', ' ').slice(0, 16)} (local)`);
    row('Truck / trailer', `${truck} / ${trailer}`);
  } else if (ev.kind === 'delivered') {
    title = 'Load delivered';
    lead = 'Your load has been delivered.';
    stops.forEach((s) => row(`Stop ${s.number}`, `${stopName(s)}${s.deliveredAt ? ` · ${s.deliveredAt.replace('T', ' ').slice(0, 16)}` : ''}`));
    row('Truck / trailer', `${truck} / ${trailer}`);
  } else if (ev.kind === 'breakdown') {
    title = 'Delay notice — truck breakdown';
    lead = 'The truck carrying your load has had a breakdown. The ETA will be impacted. We are working on it and will get back to you as soon as we have a better update.';
    if (ev.note) row('Update', ev.note);
    row('Last location', loc);
    row('Truck / trailer', `${truck} / ${trailer}`);
    if (next) row('Next stop', stopName(next));
  } else if (ev.kind === 'resumed') {
    title = 'Back on the road';
    lead = 'The truck carrying your load has been repaired and is back on the road. Thank you for your patience.';
    if (ev.note) row('Update', ev.note);
    row('Current location', loc);
    if (next) { const e = etaTo(item, here, next.zip, { geo, now }); row(`Next stop (${next.number} of ${stops.length})`, stopName(next)); row('New ETA', e ? (e.here ? 'Arriving now' : `${fmtLocal(e.atMs, next.key || next.place)} (~${e.miles} mi)`) : 'To follow shortly'); }
    row('Truck / trailer', `${truck} / ${trailer}`);
  } else return null;
  const subject = `${title} — ${head}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1d2433">
<p style="margin:0 0 4px;color:#667085">${esc(head)}</p>
<h2 style="margin:0 0 10px;font-size:18px">${esc(title)}</h2>
<p>${esc(lead)}</p>
<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#667085;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p style="margin-top:14px">Questions? Just reply to this email.</p>
<p style="color:#667085">Florida Beauty Flora Dispatch · sent by Jarvis</p></div>`;
  const text = `${title}. ${lead} ${rows.map(([k, v]) => `${k}: ${v}`).join(' · ')}`;
  return { subject, html, text };
}

export function initStatusMail(app, { requireAuth, db, comms = null, ringcentral = null, env = process.env, fetchFn = globalThis.fetch }) {
  const enabled = !!(db && db.enabled);
  const cfgKey = 'taStatusMailCfg';
  const key = (site) => `taStatusMail:${site}`;      // { adopted, trips: { trip: { sent, log } } }
  const bdKey = (site) => `taBreakdown:${site}`;     // trip → { on, at, by, note, log }
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  let lastBoard = null;

  async function settings() { return { ...DEFAULTS, ...(await db.get(cfgKey, {})) }; }

  const editFor = (cfg, trip) => { const e = (cfg.trips || {})[trip]; return Array.isArray(e) ? { emails: e, phones: [] } : (e || null); };
  function contactsOf(item, cfg) { return contactsFor(item, { customers: cfg.customers, prefixes: cfg.prefixes, edit: editFor(cfg, String(tripOf(item).tripNumber)) }); }
  // status emails go to the customer / broker side (not every receiving dock)
  function recipients(item, cfg) {
    const r = contactsOf(item, cfg);
    return emailList(r.contacts.filter((c) => c.email && (r.edited || (['customer', 'broker', 'other'].includes(c.role) && (cfg.useBroker || c.sources.some((x) => x !== 'rate con'))))).map((c) => c.email));
  }

  async function deliver(site, trip, item, ev, ctx, { by = 'AI Dispatcher (automatic)', to = null } = {}) {
    const cfg = await settings();
    const mail = renderEvent(ev, item, ctx);
    if (!mail) return { status: 'skipped' };
    const rcpts = to || recipients(item, cfg);
    let status = 'sent'; let error = null;
    if (!rcpts.length) status = 'not sent — no customer email on file';
    else if (!mailConfig(env).ready) status = 'not sent — Outlook not connected yet';
    else {
      try { await sendMail({ to: rcpts, subject: mail.subject, html: mail.html }, { env, fetchFn }); } catch (e) { status = 'failed'; error = e.message; }
    }
    const at = new Date().toISOString();
    if (status === 'sent' && comms && comms.log) await comms.log(site, trip, { type: 'email', dir: 'out', auto: true, at, to: rcpts.join(', '), subject: mail.subject, text: mail.text.slice(0, 600), by, noThread: true });
    return { status, error, to: rcpts, subject: mail.subject, at };
  }

  // After every Watchtower cycle.
  async function process(site, board, { geo = () => null, now = Date.now() } = {}) {
    if (!enabled) return;
    lastBoard = { site, board, geo };
    const cfg = await settings();
    const items = (board.trips || []).filter((it) => qualifies(it, cfg.prefixes));
    const state = await db.get(key(site), { trips: {} });
    const adopting = !state.adopted;
    const down = await db.get(bdKey(site), {});
    const work = [];
    const next = { ...state, adopted: true, trips: { ...(state.trips || {}) } };
    for (const item of items) {
      const trip = String(tripOf(item).tripNumber || '');
      if (!trip) continue;
      const rec = next.trips[trip] || { sent: { stops: {} }, log: [] };
      const evs = pendingEvents(item, rec.sent, { now, everyHours: cfg.everyHours }).filter((ev) => !(ev.kind === 'location' && down[trip] && down[trip].on));   // no routine location emails during a breakdown
      if (!evs.length) { next.trips[trip] = rec; continue; }
      const nowIso = new Date(now).toISOString();
      const mark = (ev) => {
        if (ev.kind === 'assigned') rec.sent.assigned = nowIso;
        else if (ev.kind === 'picked-up') { rec.sent.pickedUp = nowIso; rec.sent.lastLocationAt = nowIso; } else if (ev.kind === 'arrived') rec.sent.stops = { ...(rec.sent.stops || {}), [ev.stop]: nowIso };
        else if (ev.kind === 'delivered') rec.sent.delivered = nowIso;
        else if (ev.kind === 'location') rec.sent.lastLocationAt = nowIso;
      };
      evs.forEach(mark);
      // only the newest milestone goes out when several piled up (first sight / first run)
      const sendable = adopting || cfg.enabled === false ? [] : [evs[evs.length - 1]];
      const today = rec.log.filter((l) => now - Date.parse(l.at) < 24 * H && l.status === 'sent').length;
      if (today >= MAX_PER_DAY) sendable.length = 0;
      evs.forEach((ev) => { if (!sendable.includes(ev)) rec.log = [{ kind: ev.kind, stop: ev.number || null, at: nowIso, status: adopting ? 'before setup — not sent' : cfg.enabled === false ? 'off — not sent' : 'combined into the next update' }, ...rec.log].slice(0, 80); });
      sendable.forEach((ev) => work.push({ trip, item, ev, rec }));
      next.trips[trip] = rec;
    }
    // forget loads gone from the board for 7 days
    const live = new Set(items.map((it) => String(tripOf(it).tripNumber)));
    for (const [trip, r] of Object.entries(next.trips)) {
      if (!live.has(trip)) { r.goneAt = r.goneAt || new Date(now).toISOString(); if (now - Date.parse(r.goneAt) > 7 * 24 * H) delete next.trips[trip]; } else delete r.goneAt;
    }
    await db.set(key(site), next);
    for (const w of work) {
      const r = await deliver(site, w.trip, w.item, w.ev, { geo, now }); // eslint-disable-line no-await-in-loop
      await db.update(key(site), (cur) => { // eslint-disable-line no-await-in-loop
        const c = { ...(cur || {}), trips: { ...((cur && cur.trips) || {}) } };
        const rec = c.trips[w.trip] || { sent: { stops: {} }, log: [] };
        rec.log = [{ kind: w.ev.kind, stop: w.ev.number || null, at: r.at, status: r.status, error: r.error || null, to: r.to, subject: r.subject }, ...(rec.log || [])].slice(0, 80);
        c.trips[w.trip] = rec;
        return c;
      }, { trips: {} });
    }
  }

  // ---- endpoints ----
  app.get('/truckmate/status-mail/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.json({ ...DEFAULTS, seen: [] });
    try {
      const cfg = await settings();
      const seen = new Set(Object.keys(cfg.customers || {}));
      if (lastBoard) for (const it of lastBoard.board.trips || []) for (const b of billsOf(it)) if (cfg.prefixes.includes(String(b.billNumber || '').charAt(0).toUpperCase()) && b.billToName) seen.add(custKey(b.billToName));
      res.json({ ...cfg, seen: [...seen].sort(), outlook: mailConfig(env).ready });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/truckmate/status-mail/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    try {
      const cur = await settings();
      const customers = b.customers ? Object.fromEntries(Object.entries(b.customers).map(([k, v]) => [custKey(k), emailList(v)]).filter(([k, v]) => k && v.length)) : cur.customers;
      const prefixes = Array.isArray(b.prefixes) ? b.prefixes.map((x) => String(x).trim().charAt(0).toUpperCase()).filter(Boolean) : cur.prefixes;
      const everyHours = b.everyHours != null ? Math.min(12, Math.max(1, Number(b.everyHours) || 3)) : cur.everyHours;
      const { seen, outlook, ...keep } = cur; // eslint-disable-line no-unused-vars
      const next = { ...keep, customers, prefixes: prefixes.length ? prefixes : DEFAULTS.prefixes, everyHours, enabled: b.enabled != null ? !!b.enabled : cur.enabled, useBroker: b.useBroker != null ? !!b.useBroker : cur.useBroker };
      await db.set(cfgKey, next);
      res.json(next);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const itemFor = (site, trip) => (lastBoard && lastBoard.site === site ? (lastBoard.board.trips || []).find((it) => String(tripOf(it).tripNumber) === trip) : null);

  app.get('/truckmate/status-mail/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.json(null);
    const site = siteOf(req); const trip = String(req.params.trip);
    try {
      const cfg = await settings();
      const item = itemFor(site, trip);
      const rec = ((await db.get(key(site), { trips: {} })).trips || {})[trip] || { sent: {}, log: [] };
      const c = item ? contactsOf(item, cfg) : { contacts: [], found: [], edited: false };
      const bd = (await db.get(bdKey(site), {}))[trip] || null;
      res.json({ qualifies: item ? qualifies(item, cfg.prefixes) : null, to: item ? recipients(item, cfg) : [], contacts: c.contacts, found: c.found, edited: c.edited, own: editFor(cfg, trip) || { emails: [], phones: [] }, log: rec.log || [], enabled: cfg.enabled !== false, everyHours: cfg.everyHours, breakdown: bd });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // this load's own recipients (replace the customer list for this load)
  app.put('/truckmate/status-mail/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const trip = String(req.params.trip);
    try {
      const b = req.body || {};
      const emails = emailList(b.emails != null ? b.emails : b.to);
      const phones = [...new Set((Array.isArray(b.phones) ? b.phones : String(b.phones || '').split(/[,;]+/)).map(phone10).filter(Boolean))];
      const cur = await settings();
      const trips = { ...(cur.trips || {}) };
      if (emails.length || phones.length) trips[trip] = { emails, phones, by: who(req), at: new Date().toISOString() }; else delete trips[trip];
      const { seen, outlook, ...keep } = cur; // eslint-disable-line no-unused-vars
      await db.set(cfgKey, { ...keep, trips });
      res.json({ own: trips[trip] || { emails: [], phones: [] } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // dispatcher: send a location update now
  app.post('/truckmate/status-mail/:trip/send', requireAuth, async (req, res) => {
    const site = siteOf(req); const trip = String(req.params.trip);
    const item = itemFor(site, trip);
    if (!item) return res.status(404).json({ error: 'That load is not on the live board.' });
    try {
      const r = await deliver(site, trip, item, { kind: 'location' }, { geo: lastBoard.geo, now: Date.now() }, { by: who(req) });
      await db.update(key(site), (cur) => {
        const c = { ...(cur || {}), trips: { ...((cur && cur.trips) || {}) } };
        const rec = c.trips[trip] || { sent: { stops: {} }, log: [] };
        if (r.status === 'sent') rec.sent = { ...rec.sent, lastLocationAt: r.at };
        rec.log = [{ kind: 'location', at: r.at, status: r.status, error: r.error || null, to: r.to, subject: r.subject, by: who(req) }, ...(rec.log || [])].slice(0, 80);
        c.trips[trip] = rec;
        return c;
      }, { trips: {} });
      if (r.status !== 'sent') return res.status(409).json({ error: r.error || r.status });
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- Breakdown: one switch tells every customer on the load (email + text) ----
  function breakdownMessages(item, kind, note, ctx) {
    const mail = renderEvent({ kind, note }, item, ctx);
    const t = tripOf(item);
    const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
    const ref = `load ${rc.loadNumber || t.tripNumber}`;
    const sms = kind === 'breakdown'
      ? `Florida Beauty Flora dispatch: the truck carrying your ${ref} has had a breakdown. The ETA will be impacted. We will get back to you as soon as we have a better update. Reply STOP to opt out.`
      : `Florida Beauty Flora dispatch: the truck carrying your ${ref} is repaired and back on the road. We will send the updated ETA shortly. Reply STOP to opt out.`;
    return { mail, sms };
  }
  async function everyone(item) {
    const cfg = await settings();
    const c = contactsOf(item, cfg);
    return { emails: emailList(c.contacts.map((x) => x.email).filter(Boolean)), phones: [...new Set(c.contacts.map((x) => x.phone).filter(Boolean))], contacts: c.contacts };
  }

  app.get('/truckmate/breakdown/:trip/preview', requireAuth, async (req, res) => {
    const site = siteOf(req); const trip = String(req.params.trip);
    const item = itemFor(site, trip);
    if (!item) return res.status(404).json({ error: 'That load is not on the live board.' });
    try {
      const on = !((await db.get(bdKey(site), {}))[trip] || {}).on;
      const who2 = await everyone(item);
      const m = breakdownMessages(item, on ? 'breakdown' : 'resumed', null, { geo: lastBoard.geo, now: Date.now() });
      const rcCfg = ringcentral && ringcentral.configFor ? await ringcentral.configFor('__shared') : null;
      res.json({ turningOn: on, ...who2, subject: m.mail.subject, text: m.mail.text, sms: m.sms, texting: !!(rcCfg && rcCfg.fromNumber), outlook: mailConfig(env).ready });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // { on: true|false, notify: true|false, note? }
  app.post('/truckmate/breakdown/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const site = siteOf(req); const trip = String(req.params.trip);
    const b = req.body || {};
    const item = itemFor(site, trip);
    if (!item) return res.status(404).json({ error: 'That load is not on the live board.' });
    const on = !!b.on;
    const at = new Date().toISOString();
    const note = b.note ? String(b.note).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    const result = { emailed: [], texted: [], emailStatus: 'not sent', textStatus: 'not sent', errors: [] };
    try {
      if (b.notify !== false) {
        const all = await everyone(item);
        const m = breakdownMessages(item, on ? 'breakdown' : 'resumed', note, { geo: lastBoard.geo, now: Date.now() });
        if (!all.emails.length) result.emailStatus = 'no customer emails on file';
        else if (!mailConfig(env).ready) result.emailStatus = 'Outlook not connected yet';
        else {
          try { await sendMail({ to: all.emails, subject: m.mail.subject, html: m.mail.html }, { env, fetchFn }); result.emailed = all.emails; result.emailStatus = 'sent'; } catch (e) { result.emailStatus = 'failed'; result.errors.push(e.message); }
        }
        const owner = String((req.user && (req.user.company || req.user.id)) || '__shared');
        const rcCfg = ringcentral && ringcentral.configFor ? await ringcentral.configFor(owner) : null;
        if (!all.phones.length) result.textStatus = 'no customer phones on file';
        else if (!rcCfg || !rcCfg.fromNumber) result.textStatus = 'texting not live yet';
        else {
          for (const ph of all.phones) {
            try { await ringcentral.sendSms(owner, { to: ph, text: m.sms }); result.texted.push(ph); } catch (e) { result.errors.push(`${ph}: ${e.message}`); } // eslint-disable-line no-await-in-loop
          }
          result.textStatus = result.texted.length ? `sent to ${result.texted.length}` : 'failed';
        }
        if (comms && comms.log) {
          if (result.emailed.length) await comms.log(site, trip, { type: 'email', dir: 'out', at, to: result.emailed.join(', '), subject: m.mail.subject, text: m.mail.text.slice(0, 600), by: who(req), noThread: true });
          for (const ph of result.texted) await comms.log(site, trip, { type: 'text', kind: on ? 'breakdown' : 'resumed', to: ph, text: m.sms, by: who(req), at, noThread: true }); // eslint-disable-line no-await-in-loop
        }
      }
      const all = await db.update(bdKey(site), (cur) => {
        const a = { ...(cur || {}) };
        const prev = a[trip] || { log: [] };
        a[trip] = { ...prev, on, at, by: who(req), note, log: [{ on, at, by: who(req), note, emailStatus: result.emailStatus, textStatus: result.textStatus }, ...(prev.log || [])].slice(0, 30) };
        return a;
      }, {});
      res.json({ breakdown: all[trip], ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // board overlay: loads with an active breakdown
  async function overlay(site, trips) {
    if (!enabled) return;
    const all = await db.get(bdKey(site), {});
    for (const item of trips) {
      const bd = all[String(tripOf(item).tripNumber || '')];
      if (bd && bd.on) item._breakdown = { on: true, at: bd.at, by: bd.by, note: bd.note };
    }
  }

  console.log(`[status-mail] customer status emails for ${DEFAULTS.prefixes.join('/')} loads ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { process, overlay };
}

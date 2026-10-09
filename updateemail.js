// ---------------------------------------------------------------
// Delivery update emails — one format for every update Jarvis sends: answers to
// "where are my loads", scheduled ETA updates and the status-email location /
// delay / delivered updates. Mobile-first, single column (max 600px), Outlook-safe
// tables + inline CSS, a plain-text twin, one card per trip (loads needing action
// first), one stated timezone (Eastern), "Being verified" instead of a doubtful ETA,
// and a "Dispatch follow-up" section. Two audiences:
//   customer — their stops only: no driver hours, internal notes or other customers
//   internal — adds driver, hours left, data discrepancies and open to-dos
// Everything comes from live data; nothing missing is invented.
// ---------------------------------------------------------------
import { tzOf } from './localtime.js';

const MIN = 60000;
const TZ = 'America/New_York';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const town = (s) => String(s || '').split(',')[0].trim().toUpperCase();
const cityOf = (s) => String(s || '').replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim();
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// 95 → "1h 35m", 40 → "40m". Pure.
export const hm = (min) => { const m = Math.max(0, Math.round(min)); const h = Math.floor(m / 60); return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`; };
// One clearly stated timezone (Eastern); weekday + date come from the same instant. Pure.
export const etTime = (ms) => (ms == null || Number.isNaN(ms) ? null : `${new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`);
export const etDate = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// TruckMate's delivery time is the stop's wall clock → an instant. Pure.
function stopWall(raw, label) {
  const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const tz = tzOf(label) || TZ;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  return guess + (guess - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute));
}

// One trip, read from live data. focus: { customer, place } picks the stop that matters. Pure.
export function loadSnapshot(item, { eta = null, now = Date.now(), focus = {}, pods = [], alerts = [], notes = [], stage = null, pickup = null } = {}) {
  const t = tripOf(item); const live = (item && item._samsara) || {};
  const bills = billsOf(item);
  const sheet = ((item && item._manifest && item._manifest.stops) || []).filter((s) => /DELIVER/i.test(s.action || ''));
  const want = norm(focus.customer); const wantPlace = town(focus.place);
  const nameAt = (label) => { const h = sheet.find((x) => town(x.tmPlace || x.city) === town(label)); return h ? h.customer : null; };
  const stopsMap = new Map();
  for (const b of bills) {
    const label = b.endZoneDescription || ''; if (!label) continue;
    const s = stopsMap.get(label) || { label, customers: [], bills: [], pieces: 0, delivered: true, deliveredRaw: null };
    if (b.billToName && !s.customers.includes(b.billToName)) s.customers.push(b.billToName);
    if (b.billNumber) s.bills.push(String(b.billNumber));
    if (Number(b.pieces)) s.pieces += Number(b.pieces);
    if (!b.actualDelivery) s.delivered = false; else if (!s.deliveredRaw || String(b.actualDelivery) > s.deliveredRaw) s.deliveredRaw = String(b.actualDelivery);
    stopsMap.set(label, s);
  }
  const stops = [...stopsMap.values()].map((s) => ({ ...s, name: nameAt(s.label) || s.customers[0] || null }));
  const legs = (eta && eta.stops) || [];
  const legOf = (s) => legs.find((l) => town(l.label) === town(s.label)) || null;
  const matches = (s) => (want && (s.customers.some((c) => norm(c).includes(want) || want.includes(norm(c))) || norm(s.name).includes(want))) || (wantPlace && town(s.label) === wantPlace);
  const stop = stops.find(matches) || stops.find((s) => !s.delivered && legOf(s)) || stops.find((s) => !s.delivered) || stops[stops.length - 1] || { label: t.destZoneDesc || '', customers: [], bills: [], pieces: 0, delivered: false };
  const leg = legOf(stop);
  const gpsAt = live.gpsAt ? Date.parse(live.gpsAt) : null;
  const gpsAge = gpsAt ? (now - gpsAt) / MIN : null;
  const code = String(t.status || '').toUpperCase();
  const snap = {
    trip: tripNo(item), truck: String(t.powerUnit || (item._oc && item._oc.truck) || '') || null, trailer: String(t.trailer || '') || null,
    bills: stop.bills.length ? stop.bills : bills.map((b) => String(b.billNumber || '')).filter(Boolean).slice(0, 3),
    customer: stop.name || stop.customers[0] || null, stopCity: cityOf(stop.label) || null,
    location: live.location ? String(live.location).split(',').map((x) => x.trim()).filter((x) => !/^\d{5}/.test(x)).slice(-2).join(', ') : null,
    moving: live.speedMph != null ? live.speedMph > 5 : null, mph: live.speedMph != null ? Math.round(live.speedMph) : null,
    duty: live.hos && live.hos.status ? String(live.hos.status).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null,
    driveLeft: live.hos && live.hos.driveLeftMin != null ? live.hos.driveLeftMin : null,
    drivers: [live.driver1, live.driver2].filter(Boolean).join(' & ') || (item._oc && item._oc.driverName) || null,
    gpsAge, apptMs: leg && leg.apptMs != null ? leg.apptMs : null, apptFrom: leg && leg.apptFrom ? leg.apptFrom : null, etaMs: leg ? leg.etaMs : null,
    discrepancies: alerts.filter((a) => a && a.code === 'sheet-mismatch').map((a) => a.detail || a.title).slice(0, 2),
    podVerified: pods.some((d) => /proof_of_delivery|pod/i.test(`${d.docType || ''}`)),
    miles: leg && leg.miles != null ? Math.round(leg.miles) : null,
    temp: live.tempF != null && !live.tempStale ? { f: Math.round(live.tempF), set: live.setpointF != null ? Math.round(live.setpointF) : null } : null,
    mapUrl: live.lat != null && live.lng != null && gpsAge != null && gpsAge < 120 ? `https://maps.google.com/?q=${live.lat},${live.lng}` : null,
    stageLabel: stage || null,
  };
  // detention record (driver check-ins keep arrive / leave times): 3 h+ at a stop
  const waits = (item && item._waits) || {};
  const det = (w) => (w && w.arrivedAt && (w.minutes || 0) >= 180 ? { in: Date.parse(w.arrivedAt), out: w.leftAt ? Date.parse(w.leftAt) : null, min: w.minutes } : null);
  snap.detentionShipper = det(waits.pickup);
  snap.detentionStop = det(waits[stop.label]);
  // the driver's own words about this load: exceptions and lumper
  const said = notes.map((n) => String(n || '')).join('\n');
  const exc = said.match(/[^\n.]*\b(rejected|refused|not accepted|shortage|short \d|damaged|overage|over,? short)\b[^\n.]*/i);
  const lump = said.match(/lumper[^\n]{0,60}?\$\s?(\d[\d,.]*)/i);
  snap.exception = exc ? exc[0].trim().slice(0, 160) : null;
  snap.lumper = lump ? `$${lump[1]}` : null;
  // before pickup: heading to the shipper (miles / ETA from the pickup, not the receiver)
  if (pickup && !/^(DEPSHIP|ARRCONS|DEPCONS)/i.test(code)) { snap.pickup = pickup; }
  if (stop.delivered) {
    snap.status = 'Delivered';
    snap.deliveredAt = stopWall(stop.deliveredRaw, stop.label);
    snap.quantity = stop.pieces ? `${stop.pieces} piece${stop.pieces === 1 ? '' : 's'}` : null;
    return snap;
  }
  if (/^(DISP|ASSGN)/.test(code)) snap.notDeparted = true;
  // an ETA we can't stand behind → "Being verified", with the reason
  if (!gpsAt) snap.verify = 'no live GPS position yet';
  else if (gpsAge > 90) snap.verify = `last GPS position is ${hm(gpsAge)} old`;
  else if (!leg || snap.etaMs == null) snap.verify = 'no live ETA for this stop yet';
  else if (snap.etaMs < now - 30 * MIN) snap.verify = 'the ETA has passed without a delivery record';
  const late = snap.apptMs != null && snap.etaMs != null && !snap.verify ? (snap.etaMs - snap.apptMs) / MIN : null;
  const apptPassed = snap.apptMs != null && snap.apptMs < now - 15 * MIN;
  if ((late != null && late > 15) || apptPassed) { snap.status = 'Delayed'; snap.lateMin = late != null && late > 15 ? late : (now - snap.apptMs) / MIN; }
  else if (snap.verify) snap.status = 'Being verified';
  else if (snap.notDeparted) snap.status = 'Not departed';
  else snap.status = snap.apptMs != null ? 'On schedule' : 'In transit';
  return snap;
}

const ORDER = { Delayed: 0, 'Being verified': 1, 'Not departed': 2, 'In transit': 3, 'On schedule': 3, Delivered: 4 };
const BAND = { Delayed: ['#FEF3C7', '#78350F'], Delivered: ['#DCFCE7', '#14532D'], 'Being verified': ['#FEF3C7', '#78350F'] };

// Automatic follow-ups from the data (never claims a contact that didn't happen). Pure.
export function autoFollowUps(snaps, { audience = 'customer', tasks = {} } = {}) {
  const out = [];
  for (const s of snaps) {
    if (s.status === 'Delayed') out.push({ issue: `Trip ${s.trip} is running about ${hm(s.lateMin)} behind the appointment`, next: audience === 'internal' ? 'Confirm a new appointment with the receiver and update the customer' : 'Dispatch is reviewing the arrival time; we will update you if it changes', owner: 'Dispatch', status: 'Pending' });
    else if (s.status === 'Being verified') out.push({ issue: `Trip ${s.trip}: ETA being verified (${s.verify})`, next: audience === 'internal' ? 'Get a location from the driver / carrier' : 'Dispatch is confirming the truck\'s position', owner: 'Dispatch', status: 'Pending' });
    if (audience === 'internal') for (const x of (tasks[s.trip] || []).filter((y) => !y.done).slice(0, 2)) out.push({ issue: `Trip ${s.trip}: ${x.title}`, next: x.detail ? String(x.detail).slice(0, 120) : 'Open to-do on the load', owner: x.from && !/jarvis/i.test(x.from) ? x.from : 'Dispatch', status: 'Pending' });
  }
  return out;
}

// The email. Pure. → { subject, html, text }
export function renderUpdateEmail({ audience = 'customer', customer, destination, snaps = [], followUps = [], now = Date.now(), subject = null, extraRef = '', headline = null }) {
  const internal = audience === 'internal';
  const list = [...snaps].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || String(a.trip).localeCompare(String(b.trip)));
  const delivered = list.filter((s) => s.status === 'Delivered').length;
  const delayed = list.filter((s) => s.status === 'Delayed').length;
  const verifying = list.filter((s) => s.status === 'Being verified').length;
  const who = customer || 'Your loads';
  const subj = subject || `${who} | ${delivered} delivered · ${delayed} delayed | ${etDate(now)}${extraRef ? ` | ${extraRef}` : ''}`;
  const onWay = list.length - delivered - delayed - verifying;
  const summary = `${list.length} load${list.length === 1 ? '' : 's'}: ${[delivered && `${delivered} delivered`, delayed && `${delayed} delayed`, verifying && `${verifying} being verified`, onWay && `${onWay} on the way`].filter(Boolean).join(', ') || 'no updates'}.${delayed ? ` Action needed on ${list.filter((s) => s.status === 'Delayed').map((s) => `trip ${s.trip}`).join(', ')}.` : ''}`;
  const rowsFor = (s) => {
    const r = [];
    const add = (k, v) => { if (v != null && v !== '') r.push([k, v]); };
    add('Bill', s.bills && s.bills.length ? s.bills.join(', ') : null);
    if (s.status === 'Delivered') {
      add('Delivered to', [s.customer, s.stopCity].filter(Boolean).join(' — '));
      add('Delivered at', s.deliveredAt ? etTime(s.deliveredAt) : 'Time not recorded yet');
      add('Quantity', s.quantity);
      add('Exceptions', s.exception ? `Reported by the driver: ${s.exception}` : 'None reported (clean bill)');
      add('Lumper', s.lumper || 'None reported');
      if (s.detentionStop) add('Detention', `In ${etTime(s.detentionStop.in)} · Out ${s.detentionStop.out ? etTime(s.detentionStop.out) : '—'} · ${hm(s.detentionStop.min)} — please help us with the detention`);
      if (s.podVerified) add('Proof of delivery', 'POD on file');
      else if (internal) add('Proof of delivery', 'Not received yet');
      return r;
    }
    if (s.pickup) {
      add('Heading to', `Shipper — ${s.pickup.place || 'pickup'}`);
      add('Current location', s.location || 'Not available');
      add('Miles to go', s.pickup.miles != null ? `${s.pickup.miles} mi to the shipper` : null);
      add('Pickup appointment', s.pickup.apptMs ? etTime(s.pickup.apptMs) : null);
      add('ETA to shipper', s.pickup.etaMs ? etTime(s.pickup.etaMs) : 'Being verified');
      add('Then delivering to', [s.customer, s.stopCity].filter(Boolean).join(' — '));
      add('GPS', s.gpsAge == null ? 'No live GPS' : `Updated ${hm(s.gpsAge)} ago`);
      if (internal) { add('Driver', s.drivers); add('Duty status', s.duty); add('Drive time left', s.driveLeft != null ? hm(s.driveLeft) : null); }
      return r;
    }
    add('Delivering to', [s.customer, s.stopCity].filter(Boolean).join(' — '));
    add('Current location', s.location || 'Not available');
    add('Miles to go', s.miles != null && s.miles > 0 ? `${s.miles} mi` : null);
    add('Movement', s.moving == null ? 'Not available' : s.moving ? `Moving${s.mph ? ` · ${s.mph} mph` : ''}` : 'Stopped');
    add('Appointment', s.apptMs != null ? `${etTime(s.apptMs)}${s.apptFrom === 'truckmate-due' ? ' (due time, not a confirmed appointment)' : ''}` : 'No appointment on file');
    add('Estimated arrival', s.verify ? `Being verified — ${s.verify}` : s.etaMs != null ? `${etTime(s.etaMs)}${s.status === 'Delayed' && s.lateMin ? ` · about ${hm(s.lateMin)} after the appointment` : ''}` : 'Being verified');
    add('Trailer temperature', s.temp ? `${s.temp.f}°F${s.temp.set != null ? ` · set ${s.temp.set}°F` : ''}` : null);
    if (s.detentionShipper && s.stageLabel && /loaded/i.test(s.stageLabel)) add('Detention at shipper', `In ${etTime(s.detentionShipper.in)} · Out ${s.detentionShipper.out ? etTime(s.detentionShipper.out) : '—'} · ${hm(s.detentionShipper.min)} — please help us with the detention`);
    add('GPS', s.gpsAge == null ? 'No live GPS' : `Updated ${hm(s.gpsAge)} ago`);
    if (internal) { add('Driver', s.drivers); add('Duty status', s.duty); add('Drive time left', s.driveLeft != null ? hm(s.driveLeft) : null); if (s.discrepancies.length) add('Data check', s.discrepancies.join('; ')); }
    return r;
  };
  const card = (s) => {
    const shown = s.stageLabel && !['Delayed', 'Being verified', 'Delivered'].includes(s.status) ? s.stageLabel : s.status;
    const [bg, fg] = BAND[s.status] || (s.stageLabel ? ['#E0ECFF', '#1E3A8A'] : ['#EEF2F7', '#1F2937']);
    const head = `${shown.toUpperCase()}${s.status === 'Delayed' && s.lateMin ? ` · ${hm(s.lateMin)}` : ''} · Trip ${s.trip}${s.truck ? ` · Truck ${s.truck}` : ''}`;
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #D1D5DB;border-radius:8px;margin:0 0 16px 0;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td bgcolor="${bg}" style="background:${bg};padding:10px 20px;border-radius:8px 8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${fg}">${esc(head)}</td></tr>
<tr><td style="padding:12px 20px 16px 20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
${rowsFor(s).map(([k, v]) => `<tr><td valign="top" style="padding:5px 12px 5px 0;width:38%;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#4B5563">${esc(k)}</td><td valign="top" style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;word-break:break-word">${esc(v)}${k === 'Current location' && s.mapUrl ? ` · <a href="${esc(s.mapUrl)}" style="color:#1D4ED8">see on map</a>` : ''}</td></tr>`).join('\n')}
</table></td></tr></table>`;
  };
  const fu = followUps.length ? `<p style="margin:24px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#1F2937">Dispatch follow-up</p>
${followUps.map((f) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left:3px solid #9CA3AF;margin:0 0 10px 0"><tr><td style="padding:2px 0 2px 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1F2937">${esc(f.issue)}<br><span style="font-size:13px;color:#4B5563">Next: ${esc(f.next || '—')}${f.owner ? ` · Owner: ${esc(f.owner)}` : ''} · <b>${esc(f.status || 'Pending')}</b></span></td></tr></table>`).join('\n')}` : '';
  const html = `<div style="margin:0;padding:0;background:#F3F4F6" bgcolor="#F3F4F6">
<!--[if mso]><table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:600px;margin:0 auto;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td bgcolor="#1E3A5F" style="background:#1E3A5F;padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#FFFFFF">Delivery update${internal ? ' <span style="font-size:13px;font-weight:normal">· internal</span>' : ''}</td></tr>
<tr><td style="padding:14px 20px 4px 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937"><b>${esc(who)}</b>${destination ? `<br><span style="font-size:14px;color:#4B5563">${esc(destination)}</span>` : ''}</td></tr>
<tr><td style="padding:8px 20px 16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937">${headline ? `<b>${esc(headline)}</b><br>` : ''}${esc(summary)}<br><span style="font-size:13px;color:#4B5563">As of ${esc(etTime(now))} · all times Eastern (ET)</span></td></tr>
<tr><td style="padding:0 20px 8px 20px">${list.map(card).join('\n')}${fu}</td></tr>
<tr><td style="padding:12px 20px 20px 20px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#4B5563">Arrival times are estimates and may change with traffic, weather and hours of service. If they change, we will let you know.<br>Florida Beauty Flora Dispatch</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</div>`;
  const text = [`DELIVERY UPDATE${internal ? ' (internal)' : ''}`, who, destination || null, '', ...(headline ? [headline] : []), summary, `As of ${etTime(now)} — all times Eastern (ET)`, '',
    ...list.flatMap((s) => [`${(s.stageLabel && !['Delayed', 'Being verified', 'Delivered'].includes(s.status) ? s.stageLabel : s.status).toUpperCase()}${s.status === 'Delayed' && s.lateMin ? ` · ${hm(s.lateMin)}` : ''} · Trip ${s.trip}${s.truck ? ` · Truck ${s.truck}` : ''}`, ...rowsFor(s).map(([k, v]) => `  ${k}: ${v}${k === 'Current location' && s.mapUrl ? ` (${s.mapUrl})` : ''}`), '']),
    ...(followUps.length ? ['DISPATCH FOLLOW-UP', ...followUps.map((f) => `- ${f.issue} — Next: ${f.next || '—'}${f.owner ? ` (Owner: ${f.owner})` : ''} — ${f.status || 'Pending'}`), ''] : []),
    'Arrival times are estimates and may change. Florida Beauty Flora Dispatch'].filter((x) => x !== null).join('\n');
  return { subject: subj, html, text, counts: { delivered, delayed, verifying, total: list.length } };
}

// Build an update from live data for these trips. followUps are added to the automatic ones.
export async function buildUpdateFor({ db, docs = null, site = 'florida-beauty', items = [], trips = [], customer = null, destination = null, audience = 'customer', followUps = [], now = Date.now(), subject = null, extraRef = '', stage = null, pickup = null, headline = null, attach = null }) {
  const watch = (await db.get(`taWatch:${site}`, {})) || {};
  const alertsAll = Object.values(watch.alerts || {});
  const tasks = audience === 'internal' ? ((await db.get(`taLoadTasks:${site}`, {})) || {}) : {};
  const comms = (await db.get(`taTripComms:${site}`, {})) || {};
  const snaps = []; const attachIds = [];
  for (const trip of trips) {
    const item = items.find((it) => tripNo(it) === String(trip));
    if (!item) continue;
    let pods = [];
    if (docs && docs.listDocs) { try { pods = (await docs.listDocs({ site, trips: [String(trip)] })).filter((d) => !d.restricted); } catch { pods = []; } } // eslint-disable-line no-await-in-loop
    const notes = (comms[String(trip)] || []).filter((c) => c && (c.type === 'reply' || c.kind === 'detention')).map((c) => c.text);
    snaps.push(loadSnapshot(item, { eta: (watch.etas || {})[String(trip)] || null, now, focus: { customer, place: destination }, pods, alerts: alertsAll.filter((a) => String(a.trip) === String(trip)), notes, stage, pickup }));
    // documents to attach: the BOL when loaded, the POD when completed (only what's on file)
    if (attach) attachIds.push(...pods.filter((d) => (attach === 'pod' ? /proof_of_delivery|pod/i : /bill_of_lading|bol/i).test(`${d.docType || ''}`)).slice(0, 3).map((d) => d.id));
  }
  const auto = autoFollowUps(snaps, { audience, tasks });
  const seen = new Set(followUps.map((f) => String(f.issue).slice(0, 40)));
  const all = [...followUps, ...auto.filter((f) => !seen.has(String(f.issue).slice(0, 40)))].slice(0, 8);
  return { ...renderUpdateEmail({ audience, customer: customer || (snaps[0] && snaps[0].customer) || null, destination, snaps, followUps: all, now, subject, extraRef, headline }), attachIds };
}

// Small internal note (e.g. what Jarvis did with an instruction email). Pure.
export function renderFollowUpNote(followUps = [], intro = '') {
  const html = `<div style="margin:0;padding:0;background:#F3F4F6" bgcolor="#F3F4F6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:600px;margin:0 auto;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td style="padding:18px 20px 6px 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937">${esc(intro)}</td></tr>
<tr><td style="padding:4px 20px 18px 20px"><p style="margin:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#1F2937">Dispatch follow-up</p>
${followUps.map((f) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left:3px solid #9CA3AF;margin:0 0 10px 0"><tr><td style="padding:2px 0 2px 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1F2937">${esc(f.issue)}<br><span style="font-size:13px;color:#4B5563">Next: ${esc(f.next || '—')}${f.owner ? ` · Owner: ${esc(f.owner)}` : ''} · <b>${esc(f.status || 'Pending')}</b></span></td></tr></table>`).join('')}
</td></tr></table></div>`;
  const text = `${intro}\n\nDISPATCH FOLLOW-UP\n${followUps.map((f) => `- ${f.issue} — Next: ${f.next || '—'}${f.owner ? ` (Owner: ${f.owner})` : ''} — ${f.status || 'Pending'}`).join('\n')}`;
  return { html, text };
}

// ---------------------------------------------------------------
// The driver's homework (Nov 21, 2026): the "On the Road Trip Log" payroll pays from, in the driver app. Same sheet as the paper:
// one line per ZIP (date, trip #, zip, pick-up / drop-off place, full or empty, boxes, short/over, ref # or lumper, transfer
// truck, trailer, bill #, reimbursement) — plus wait time and bonus on each line.
//   · one sheet per trip, like the paper (Nov 21 — Ferney's sheet: out of Miami on 627549, the load home on 627656, empty back
//     to the yard, "this trip ended the 22 of November"): the open sheet holds every trip with check-ins in the last 30 days that
//     isn't on a sheet already turned in (by the driver, or by their team partner for both); turning it in closes it
//   · a team turns in one sheet: the co-driver from TruckMate is on it, and the partner's open sheet leaves out the trips already
//     turned in for both. When it's turned in, the co-driver gets a push ("your signature is needed"); the app opens on the
//     signature, and once they sign it both signatures are on the homework (sent live even in training mode: a driver asked)
//   · filled in from what we already have: the week's trips (board, or the past-loads record), the driver's check-ins (dates,
//     arrival and departure at each stop), the trip sheet stops (zip, customer, bills, boxes), the load sheet dispatch sent or the rate con
//     (pickups and deliveries with their ZIPs), and a bonus / extra pay dispatch wrote on the load. A pickup counts as arriving
//     empty, so the miles from one load to the next show as empty miles
//   · waiting time = dispatch's own waiting-time clock (waitingtime.js) when it ran for that stop; else the same rule: it starts
//     3 hours after the appointment (or after arriving, if the driver got there later) and runs until delivered / loaded
//   · moves nobody wrote down: the truck's Samsara GPS for the week — a stop of 45+ minutes while the truck is empty (between a
//     delivery and the next pickup, or after the last one) that isn't near any line (the yard, the shop, an empty trailer) is
//     added as a line "detected by GPS" for the driver to confirm or delete. Loaded stretches are left alone (rest stops)
//   · expenses the driver paid with their own money, each with receipt photos; the week's scanned paperwork (PODs, BOLs,
//     receipts) goes to payroll with the sheet
//   · the odometer at the start and end of the week from Samsara; the miles from each ZIP to the next from the mile calculator
//   · payroll (a login with the payroll box, or an admin) reviews each one turned in: a checkbox on every move (the miles from
//     the ZIP above), wait, bonus, reimbursement and expense — only what's checked is paid; what isn't is listed before saving.
//     From the sheet they open each trip's history: TruckMate, check-ins, the rate con, the load sheet, every paper on it
//   · the driver checks it, adds what's missing (loads home, comments, bonuses, lumper), signs, and it goes to payroll by email
// Driver words are data: nothing here changes a load.
// ---------------------------------------------------------------
import { driverStops, stepsWithReports } from './driverstops.js';
import { CHECKINS } from './checkins.js';
import { initMiles } from './miles.js';
import { samsaraTokenFrom, listVehicles, vehicleOdometerRange, vehicleGpsHistory } from './samsara.js';
import { sendMail } from './mailer.js';
import { readableFile } from './heic.js';
import { tripLogPdf, pdfName } from './triplogpdf.js';
import { asLive } from './training.js';
import { localToUtcMs } from './watchtower.js';
import { KNOWN_YARDS, yardLabel } from './loadsheet.js';
import { createHash } from 'node:crypto';

const SITE = 'florida-beauty';
const LOGS = (code) => `taTripLog:${SITE}:${code}`;   // week (YYYY-MM-DD, the Sunday) → log
const INDEX = `taTripLogIndex:${SITE}`;
const COSIGN = `taTripLogCosign:${SITE}`;
const COSIGN_WAIT_MS = 15 * 60000;                     // how long payroll waits for the co-driver's signature           // co-driver signatures asked for: [{ owner, ownerName, id, co, coName, trips, at, signedAt }]               // `${driver}|${week}` → { name, week, submittedAt, reviewedAt } — payroll's list
const KEEP_WEEKS = 150;   // about two years of trip sheets on each driver's profile
const OPEN = 'open';      // the sheet being filled in
const MAX_LINES = 80;
const ACTS = ['PU', 'DEL', 'DROP', 'EMPTY', 'CM'];
export const BONUS_KINDS = ['none', 'dispatch', 'holiday', 'weekend', 'extraPU', 'extraDel', 'fuelTr', 'other'];
export const EXPENSE_KINDS = ['lumper', 'fuel', 'scale', 'tolls', 'parking', 'washout', 'repair', 'other'];
const MAX_EXPENSES = 40;
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;   // what goes in the payroll email; past this the rest is listed
const S = (x, n = 120) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const zipOf = (x) => (String(x || '').match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || null;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DAY = 86400000;

// ---------- the week (Sunday → Saturday, Eastern time) ----------
export const ymdET = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// the UTC moment a day starts in Miami (midnight ET, EST or EDT). Pure.
export function etMidnight(ymd) {
  for (const h of [4, 5]) { const ms = Date.parse(`${ymd}T0${h}:00:00Z`); if (Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })) === 0) return ms; }
  return Date.parse(`${ymd}T05:00:00Z`);
}
// the pay week runs Monday to Sunday (Nov 23, Nadim) → { start: 'YYYY-MM-DD' (Monday), end: 'YYYY-MM-DD' (Sunday), fromMs, toMs }. Pure.
export function weekOf(at = Date.now()) {
  const d = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : ymdET(at);
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  const start = new Date(Date.parse(`${d}T12:00:00Z`) - ((dow + 6) % 7) * DAY).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${start}T12:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
  return { start, end, fromMs: etMidnight(start), toMs: etMidnight(new Date(Date.parse(`${end}T12:00:00Z`) + DAY).toISOString().slice(0, 10)) };
}
const mmdd = (ms) => { if (!Number.isFinite(ms)) return ''; const [, m, d] = ymdET(ms).split('-'); return `${m}/${d}`; };
const atOf = (step) => { const v = step && (step.at || (typeof step === 'string' ? step : null)); const ms = Date.parse(v || ''); return Number.isNaN(ms) ? null : ms; };

// ---------- a bonus dispatch wrote on the load ("$70 extra short run", "BONUS: $100 PU R006231") ----------
// → { amount, text } | null. Pure.
export function bonusFromSheet(sh) {
  if (!sh) return null;
  const notes = [...(sh.notes || []), ...((sh.stops || []).flatMap((s) => s.notesAfter || []))].map((n) => S(n, 200));
  for (const n of notes) {
    if (!/\b(bonus|bono|extra|incentive)\b/i.test(n)) continue;
    const m = n.match(/\$\s*(\d{1,4}(?:\.\d{2})?)/) || n.match(/\b(\d{2,4})\s*(?:dollars|usd)\b/i);
    return { amount: m ? Number(m[1]).toFixed(2) : '', text: n };
  }
  return null;
}

// ---------- waiting time: 3 hours after the appointment ----------
export const FREE_MIN = 180;
// An appointment's moment in Miami time: a date (YYYY-MM-DD, or MM/DD in the text) and a time ("6 AM", "08:00 AM", "14:30").
// A time with no date takes `dayMs`'s day. "ASAP" / FCFS / no time → null. Pure.
export function apptMs({ dateIso = null, text = '', dayMs = null } = {}) {
  const tx = String(text || '');
  const tm = tx.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i) || tx.match(/\b([01]?\d|2[0-3]):(\d{2})\b/);
  if (!tm) return null;
  let h = Number(tm[1]); const m = Number(tm[2] || 0);
  if (tm[3]) { const pm = /p/i.test(tm[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  let ymd = /^\d{4}-\d{2}-\d{2}$/.test(dateIso || '') ? dateIso : null;
  const md = tx.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!ymd && md && dayMs) { const y = md[3] ? (md[3].length === 2 ? `20${md[3]}` : md[3]) : ymdET(dayMs).slice(0, 4); ymd = `${y}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`; }
  if (!ymd && dayMs) ymd = ymdET(dayMs);
  if (!ymd) return null;
  return etMidnight(ymd) + (h * 60 + m) * 60000;
}
// The waiting minutes at a stop: dispatch's clock when it ran (waitedMs), else from the driver's check-ins —
// it starts 3 hours after the appointment (or after arriving, if later) and ends when they left. → { wait, from, appt }. Pure.
export function waitAt({ arrivedMs = null, leftMs = null, appt = null, clock = null } = {}) {
  if (clock && clock.waitedMs != null) return { wait: Math.round(clock.waitedMs / 60000) || null, from: clock.startMs || null, appt: clock.apptMs || appt || null, by: 'clock' };
  if (!arrivedMs || !leftMs || leftMs <= arrivedMs) return { wait: null, from: null, appt };
  const from = Math.max(arrivedMs, appt || 0) + FREE_MIN * 60000;
  return { wait: leftMs > from ? Math.round((leftMs - from) / 60000) : null, from, appt, by: 'checkins' };
}

// The Miami terminal / yard's ZIP on the sheets: the one drivers write and payroll pays from (Nov 21: 33152).
export const HOME_ZIP = process.env.TRIPLOG_HOME_ZIP || '33152';
const isMiami = (x) => /\bMIAMI\b|\bMIA\b|DORAL|HIALEAH|MEDLEY/i.test(String(x || ''));

// ---------- one trip's lines ----------
// The pickups (the load sheet dispatch sent or the rate con, else where the trip starts), then each delivery: the trip sheet /
// TruckMate stops with the driver's check-ins, else the load sheet's deliveries. Dated by the check-ins (else the sheet's date);
// time at a stop = check-in "arrived" → "delivered". A pickup is reached empty, a delivery loaded. Pure.
// TruckMate's bill times ("2026-11-23T01:59:50", Miami time) → ms. Pure.
export const billMs = (v) => { const ms = v ? localToUtcMs(String(v).slice(0, 16), 'America/New_York') : NaN; return Number.isFinite(ms) ? ms : null; };
const cityKey = (z) => String(z || '').split(',')[0].trim().toUpperCase();
// Where the load is really picked up: the bills' start zone (most of them), else the trip sheet's LOAD stop. TruckMate's trip
// origin can be where the truck STARTED instead (Nov 23: trip 627700 "MELBOURNE → WINCHESTER" — the truck came from delivering
// 627656 in Melbourne and loaded at the Miami terminal). Pure. → { place, zip, ms } | null
export function realPickup(item) {
  const bills = (item && (item.freightBills || item.orders)) || [];
  const count = {}; for (const b of bills) { const z = String(b.startZoneDescription || '').trim(); if (z) count[z] = (count[z] || 0) + 1; }
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const load = ((item && item._manifest && item._manifest.stops) || []).find((x) => /^LOAD/i.test(String(x.action || '')));
  const ms = Math.min(...bills.map((b) => billMs(b.actualPickup)).filter(Boolean));
  if (!top && !load) return null;
  const zone = top ? top[0] : '';
  const place = load && load.customer && /TERMINAL|COOLER|YARD/i.test(load.customer) ? `${cityKey(zone) || 'MIAMI'}, ${(zone.match(/,\s*([A-Z]{2})\b/) || [])[1] || 'FL'} · ${load.customer}` : zone.replace(/,?\s*\d{5}(-\d{4})?\s*$/, '');
  return { place, zip: zipOf(zone) || (load && load.zip) || '', city: cityKey(zone) || cityKey(load && (load.city || load.customer)), ms: Number.isFinite(ms) ? ms : null };
}

// A broker load (rate con on file): its pickups and deliveries with zip codes, the broker's load number on every line (Ref) and
// the broker in the comment, the FBF B number as on the paper.
// From dispatch's message (the load sheet): the bonus — or "No bonus" said plainly — and a yard drop: the stops going to the yard
// aren't this driver's, a Drop line at the yard (its zip) says PAID or FREE release. A staff POD email for the whole load
// dates deliveries the driver didn't check in.
export function tripLines(item, steps = {}, { sheet = null, geo = {}, clocks = {}, rc = null, yards = KNOWN_YARDS } = {}) {
  const t = tripOf(item); const trip = tripNo(item);
  const out = [];
  const rcRef = rc && rc.loadNumber ? S(rc.loadNumber, 40) : '';
  const rcStops = (kind) => ((rc && rc[kind]) || []).filter((x) => x && (x.zip || x.city)).map((x) => ({ kind: kind === 'pickups' ? 'pickup' : 'delivery', zip: (String(x.zip || '').match(/\d{5}/) || [''])[0], city: x.city || '', state: x.state || '', name: x.name || '', dateIso: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? x.date : null, time: x.time || x.appointment || '' }));
  const real = realPickup(item);
  const puAt = atOf(steps.loaded) || atOf(steps['at-shipper']) || (real && real.ms) || null;
  const bonus = bonusFromSheet(sheet);
  const dayMs = (iso) => { const ms = Date.parse(`${iso || ''}T16:00:00Z`); return Number.isNaN(ms) ? null : ms; };
  const sheetStops0 = ((sheet && sheet.stops) || []).filter((x) => x && (x.zip || x.city));
  const sheetStops = sheetStops0.length ? sheetStops0 : [...rcStops('pickups'), ...rcStops('deliveries')];
  // the trip's bill numbers go on its pickup line too, like the paper
  const tripBills = [...new Set(((item && (item.freightBills || item.orders)) || t.freightBills || []).map((b) => String(b.billNumber || b.bill || '').trim()).filter(Boolean))];
  const puBill = (tripBills.length ? tripBills.join(' / ') : (sheet && sheet.bill) || (rc && rc.fbfBillNumber) || '').slice(0, 200);
  // the city first, like the drivers write it ("Clifton NJ"), then the customer
  const where = (x) => [[S(x.city, 30), x.state].filter(Boolean).join(', '), S(x.name, 50)].filter(Boolean).join(' · ');
  const pickups = sheetStops.filter((x) => x.kind === 'pickup');
  const shipAt = atOf(steps['at-shipper']); const loadedAt = atOf(steps.loaded);
  const puWait = waitAt({ arrivedMs: shipAt, leftMs: loadedAt, appt: pickups[0] ? apptMs({ dateIso: pickups[0].dateIso, text: pickups[0].time, dayMs: shipAt }) : null, clock: clocks[`${trip}:c:at-shipper`] });
  const puExtra = (i) => (i === 0 && puWait.wait ? { wait: puWait.wait, waitAuto: true, waitFrom: puWait.from, appt: puWait.appt } : {});
  if (pickups.length) {
    pickups.forEach((x, i) => out.push(line({ key: `${trip}|PU|${x.zip || x.city || i}`, ms: (i === 0 ? puAt : null) || dayMs(x.dateIso), trip, zip: x.zip || '', place: where(x), act: 'PU', fe: 'E', trl: S(t.trailer, 20), bill: puBill, auto: true, ...puExtra(i),
      ...(i === 0 && bonus ? { bonus: 'dispatch', bonusAmt: bonus.amount, bonusFrom: 'dispatch', comment: bonus.text } : {}) })));
  } else if (real && real.place && cityKey(t.origZoneDesc || t.origin) && cityKey(t.origZoneDesc || t.origin) !== real.city && !(isMiami(t.origZoneDesc || t.origin) && isMiami(real.place))) {
    // the trip starts where the truck was (empty), then the real pickup
    const origin = S(t.origZoneDesc || t.origin, 60);
    out.push(line({ key: `${trip}|START`, ms: puAt ? puAt - 60000 : null, trip, zip: isMiami(origin) ? HOME_ZIP : (zipOf(origin) || ''), place: origin.replace(/,?\s*\d{5}(-\d{4})?\s*$/, ''), act: 'EMPTY', fe: 'E', trl: S(t.trailer, 20), comment: 'Started here, empty to the pickup', auto: true }));
    out.push(line({ key: `${trip}|PU|origin`, ms: puAt, trip, zip: real.zip || (isMiami(real.place) ? HOME_ZIP : ''), place: real.place, act: 'PU', fe: 'E', trl: S(t.trailer, 20), bill: puBill, auto: true, ...puExtra(0),
      ...(bonus ? { bonus: 'dispatch', bonusAmt: bonus.amount, bonusFrom: 'dispatch', comment: bonus.text } : {}) }));
  } else {
    const origin = S(t.origZoneDesc || t.origin || 'Miami Terminal', 60);
    out.push(line({ key: `${trip}|PU|origin`, ms: puAt, trip, zip: isMiami(origin) ? HOME_ZIP : (zipOf(t.origZoneDesc || t.origin) || ''), place: origin.replace(/,?\s*\d{5}(-\d{4})?\s*$/, ''), act: 'PU', fe: 'E', trl: S(t.trailer, 20), bill: puBill, auto: true, ...puExtra(0),
      ...(bonus ? { bonus: 'dispatch', bonusAmt: bonus.amount, bonusFrom: 'dispatch', comment: bonus.text } : {}) }));
  }
  let stops = [];
  try { stops = driverStops(item, { geo }); } catch { stops = []; }
  const release = sheet && sheet.release ? sheet.release : null;
  const toYard = release ? (release.stops || []).map((i) => (sheet.stops || [])[i]).filter(Boolean) : [];
  const yardStop = (st) => toYard.some((y) => (y.zip && st.zip && y.zip === st.zip) || (y.city && String(st.place || '').toUpperCase().startsWith(String(y.city).toUpperCase())));
  if (toYard.length) stops = stops.filter((st) => !yardStop(st));
  const pod = item && item._staffPod && item._staffPod.whole ? item._staffPod : null;
  const podMs = pod ? Date.parse(pod.at) || null : null;
  if (stops.length) {
    for (const st of stops) {
      const arr = atOf(steps[`arrived:${st.key}`]);
      // delivered: the driver's check-in, else TruckMate's own delivery time on the stop's bills (loads run without check-ins)
      const billsHere = ((item && (item.freightBills || item.orders)) || []).filter((b) => (st.bills || []).some((x) => x.bill === b.billNumber));
      const del = atOf(steps[`delivered:${st.key}`]) || (billsHere.length && billsHere.every((b) => b.actualDelivery) ? Math.max(...billsHere.map((b) => billMs(b.actualDelivery) || 0)) || null : null) || (arr ? null : podMs);
      // the appointment: the trip sheet's, else the load sheet's stop with the same ZIP / city
      const ss = sheetStops.find((x) => x.kind === 'delivery' && ((st.zip && x.zip === st.zip) || (x.city && String(st.place || '').toUpperCase().startsWith(String(x.city).toUpperCase()))));
      const appt = apptMs({ text: st.appt || '', dayMs: arr }) || (ss ? apptMs({ dateIso: ss.dateIso, text: ss.time, dayMs: arr }) : null);
      const w = waitAt({ arrivedMs: arr, leftMs: del, appt, clock: clocks[`${trip}:c:arrived:${st.key}`] });
      const wait = w.wait;
      const bills = (st.bills || []).map((b) => b.bill).filter(Boolean);
      const boxes = st.boxes != null ? `${st.boxes}` : '';
      out.push(line({ key: `${trip}|DEL|${st.key}`, ms: del || arr, trip, zip: st.zip || zipOf(st.key) || '', place: [S(st.place, 40), S(st.name, 50)].filter(Boolean).join(' · '), act: 'DEL', pallets: st.pallets || null, fe: 'F', bill: bills.join(' / '), boxes, wait, waitAuto: wait != null, waitFrom: w.from, appt: w.appt, auto: true }));
    }
  } else {
    for (const x of sheetStops.filter((y) => y.kind === 'delivery')) out.push(line({ key: `${trip}|DEL|${x.zip || x.city}`, ms: dayMs(x.dateIso), trip, zip: x.zip || '', place: where(x), act: 'DEL', fe: 'F', bill: (sheet && sheet.bill) || puBill, auto: true }));
  }
  if (release) {
    const key = String(release.yard || '').replace(/\*+/g, ' ').trim().toUpperCase().replace(/\s+YARD$/, '');
    const y = (yards || {})[key] || KNOWN_YARDS[key] || null;
    const dropped = sheet.dropped || null;
    const paid = release.type === 'paid';
    const yname = (y && y.name) || yardLabel(release.yard);
    out.push(line({ key: `${trip}|DROP`, ms: dropped ? Date.parse(dropped.at) || null : null, trip, zip: (String((y && y.address) || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '', place: yname, act: 'DROP', fe: 'F', trl: S(t.trailer, 20), bill: puBill,
      comment: `${paid ? 'PAID' : 'FREE'} RELEASE — trailer dropped at ${yname}${toYard.length ? ` (${toYard.length} stop${toYard.length === 1 ? '' : 's'} delivered from the yard)` : ''}${dropped && dropped.pickedUp ? ` · picked up trailer ${dropped.pickedUp}` : ''}`, auto: true }));
  }
  const puLine = out.find((l) => l.act === 'PU');
  if (puLine && !bonus && sheet) puLine.comment = puLine.comment ? `${puLine.comment} · No bonus` : 'No bonus';
  if (pod) for (const l of out) if (l.act === 'DEL' && !l.comment) l.comment = `Delivered — POD email${pod.by ? ` from ${S(pod.by, 40)}` : ''}`;
  if (rc) for (const l of out) { if (l.act === 'PU' || l.act === 'DEL') { l.ref = l.ref || rcRef; if (l.act === 'PU' && rc.broker && !/Broker load/.test(l.comment || '')) l.comment = [`Broker load · ${S(rc.broker, 60)}${rcRef ? ` #${rcRef}` : ''}`, l.comment].filter(Boolean).join(' · '); } }
  return out;
}
function line(x) {
  return { key: x.key || null, date: mmdd(x.ms), at: x.ms ? new Date(x.ms).toISOString() : null, _ms: x.ms || null, trip: x.trip || '', zip: x.zip || '', place: x.place || '', act: x.act || '', fe: x.fe || '', boxes: x.boxes || '', so: '', ref: '', trf: '', trl: x.trl || '', bill: x.bill || '',
    pallets: x.pallets || null, reimb: '', wait: x.wait != null ? x.wait : null, waitAuto: !!x.waitAuto, waitFrom: x.waitFrom ? new Date(x.waitFrom).toISOString() : null, appt: x.appt ? new Date(x.appt).toISOString() : null, bonus: x.bonus || 'none', bonusAmt: x.bonusAmt || '', bonusFrom: x.bonusFrom || null, comment: x.comment || '', auto: !!x.auto };
}

// What the driver sends back, kept tidy. Pure.
export function cleanLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES).map((r) => {
    const w = Number(r && r.wait);
    return {
      date: S(r.date, 10), trip: S(r.trip, 12), zip: (String(r.zip || '').match(/\d{5}/) || [''])[0], place: S(r.place, 90), act: ACTS.includes(r.act) ? r.act : '',
      fe: r.fe === 'F' || r.fe === 'E' ? r.fe : '', boxes: S(r.boxes, 40), so: S(r.so, 30), ref: S(r.ref, 40), trf: S(r.trf, 12), trl: S(r.trl, 30), bill: S(r.bill, 200).toUpperCase(),
      reimb: S(r.reimb, 12).replace(/[^\d.]/g, ''), wait: Number.isFinite(w) && w > 0 ? Math.min(Math.round(w), 72 * 60) : null, waitAuto: !!r.waitAuto,
      at: /^\d{4}-\d{2}-\d{2}T/.test(String(r.at || '')) ? S(r.at, 30) : null, pallets: Number(r.pallets) > 0 ? Math.min(Math.round(Number(r.pallets)), 60) : null,
      waitFrom: /^\d{4}-\d{2}-\d{2}T/.test(String(r.waitFrom || '')) ? S(r.waitFrom, 30) : null, appt: /^\d{4}-\d{2}-\d{2}T/.test(String(r.appt || '')) ? S(r.appt, 30) : null,
      bonus: BONUS_KINDS.includes(r.bonus) ? r.bonus : 'none', bonusAmt: S(r.bonusAmt, 12).replace(/[^\d.]/g, ''), bonusFrom: r.bonusFrom === 'dispatch' ? 'dispatch' : null, comment: S(r.comment, 300), auto: !!r.auto, detected: r.detected === 'gps' ? 'gps' : null,
      key: r.key ? S(r.key, 120) : null, edited: !!r.edited,   // the app's line it came from; the driver changed it
      // miles payroll typed in for this line (instead of the mile calculator's)
      miOver: r.miOver != null && r.miOver !== '' && Number.isFinite(Number(r.miOver)) && Number(r.miOver) >= 0 ? Math.min(Math.round(Number(r.miOver)), 5000) : null,
    };
  });
}
export function cleanExpenses(list = []) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_EXPENSES).map((x) => ({
    date: S(x && x.date, 10), kind: EXPENSE_KINDS.includes(x && x.kind) ? x.kind : 'other', amount: S(x && x.amount, 12).replace(/[^\d.]/g, ''), trip: S(x && x.trip, 12), note: S(x && x.note, 200),
    receipts: (Array.isArray(x && x.receipts) ? x.receipts : []).map((r) => String(r).replace(/\D/g, '')).filter(Boolean).slice(0, 10),
  })).filter((x) => x.amount || x.note || x.receipts.length);
}
export function cleanHead(h = {}) {
  const o = {}; for (const k of ['name', 'id', 'co', 'coid', 'truck', 'trailer', 'bod', 'eod']) o[k] = S(h[k], 60);
  o.note = S(h.note, 300);   // a note to payroll ("This trip ended the 22 of November. Thank you!")
  return o;
}

// ---------- the payroll email: the same sheet ----------
const BONUS_LABEL = { dispatch: 'Bonus (dispatch)', holiday: 'Holiday', weekend: 'Weekend', extraPU: 'Extra pickup', extraDel: 'Extra delivery', fuelTr: 'Fueled trailer', other: 'Bonus' };
const ACT_LABEL = { PU: 'P/U', DEL: 'Del', DROP: 'Drop', EMPTY: 'Empty', CM: '' };
const hm = (m) => (m == null ? '' : `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60 ? `${m % 60} min` : ''}`.trim() || '0 min');
const EXP_LABEL = { lumper: 'Lumper', fuel: 'Fuel', scale: 'Scale', tolls: 'Tolls', parking: 'Parking', washout: 'Washout', repair: 'Repair', other: 'Other' };
export function payrollEmail(log, { week, miles = [], odometer = null, docs = [] } = {}) {
  const h = log.head || {}; const rows = log.lines || [];
  const money = (v) => (v ? `$${Number(v).toFixed(2)}` : '');
  let lo = 0; let em = 0; let wait = 0; let reimb = 0; let bonuses = 0;
  const body = rows.map((r, i) => {
    const m = r.miOver != null ? r.miOver : miles[i]; if (m != null && r.act !== 'CM') { if (r.fe === 'F') lo += m; else em += m; }
    wait += r.wait || 0; reimb += Number(r.reimb) || 0; if (r.bonus && r.bonus !== 'none') bonuses += 1;
    const pu = r.act === 'PU' ? r.place : ''; const dr = r.act && r.act !== 'PU' && r.act !== 'CM' ? r.place : '';
    const bonus = r.bonus && r.bonus !== 'none' ? `${BONUS_LABEL[r.bonus] || 'Bonus'}${r.bonusAmt ? ` $${r.bonusAmt}` : ''}` : '';
    const td = (v, extra = '') => `<td style="border:1px solid #cfd7e3;padding:4px 6px;vertical-align:top;${extra}">${v}</td>`;
    if (r.act === 'CM') return `<tr>${td(esc(r.date))}${td(esc(r.trip))}${td(esc(r.zip))}<td colspan="10" style="border:1px solid #cfd7e3;padding:4px 6px;font-style:italic">${esc([r.place, r.comment].filter(Boolean).join(' — '))}</td>${td('')}${td('')}${td(esc(bonus), 'color:#15803d;font-weight:700')}</tr>`;
    return `<tr>${td(esc(r.date))}${td(esc(r.trip))}${td(esc(r.zip))}${td(esc(pu))}${td(`${esc(dr)}${r.comment ? ` <i>(${esc(r.comment)})</i>` : ''}`)}${td(r.fe)}${td(esc([ACT_LABEL[r.act], r.boxes].filter(Boolean).join(' ')))}${td(esc(r.so))}${td(esc(r.ref))}${td(esc(r.trf))}${td(esc(r.trl))}${td(esc(r.bill))}${td(money(r.reimb))}${td(m != null && r.act !== 'CM' ? `${m} ${r.fe || ''}` : '', 'color:#15803d;font-weight:700')}${td(esc(hm(r.wait)), 'color:#15803d;font-weight:700')}${td(esc(bonus), 'color:#15803d;font-weight:700')}</tr>`;
  }).join('');
  const th = ['Date', 'Trip #', 'Zip Code', 'Pick Up - Location', 'Drop Off Place - Location', 'Full or Empty', 'Boxes or Pallets', 'Short or Over', 'Ref # or Lumper Amount', 'Driver/Truck # (If Transfer)', 'Trailer #', 'Bill #', 'Driver Reimbursement', 'Miles', 'Wait', 'Bonus']
    .map((x) => `<th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9;font-size:11px;text-align:left">${x}</th>`).join('');
  const exps = log.expenses || [];
  const expTotal = exps.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const expRows = exps.map((x) => `<tr><td style="border:1px solid #cfd7e3;padding:4px 6px">${esc(x.date)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px">${esc(EXP_LABEL[x.kind] || x.kind)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px">${esc(x.trip)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px">${esc(x.note)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px">${money(x.amount)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px">${x.receipts.length ? `${x.receipts.length} receipt${x.receipts.length === 1 ? '' : 's'} attached` : '<b style="color:#b45309">no receipt</b>'}</td></tr>`).join('');
  const docList = docs.map((d) => `<li>${esc(d.label)} · trip ${esc(d.trip || '—')} · ${esc(d.filename || '')}${d.attached ? '' : ' <i>(too big for the email: open it in the console)</i>'}</li>`).join('');
  const odo = odometer && odometer.begin != null && odometer.end != null ? odometer.end - odometer.begin : null;
  const html = `<div style="font-family:Arial,sans-serif;color:#14213d">
<h2 style="margin:0 0 4px">On the Road Trip Log — ${esc(h.name)} (ID ${esc(h.id)})</h2>
<div style="font-size:14px;margin-bottom:8px">Week ${esc(week.start)} to ${esc(week.end)} · Truck ${esc(h.truck)} · Trailer ${esc(h.trailer)}${h.co ? ` · Co-driver ${esc(h.co)} (${esc(h.coid)})` : ''}</div>
<div style="font-size:14px;margin-bottom:8px">Beginning odometer: <b>${esc(h.bod) || '—'}</b> · Ending odometer: <b>${esc(h.eod) || '—'}</b>${odometer && odometer.source ? ` <span style="color:#15803d">(read from ${esc(odometer.source)})</span>` : ''}</div>
<table style="border-collapse:collapse;font-size:12px">${`<tr>${th}</tr>`}${body}
<tr><td colspan="12" style="border:1px solid #cfd7e3;padding:4px 6px;text-align:right;font-weight:700">TOTAL</td><td style="border:1px solid #cfd7e3;padding:4px 6px;font-weight:700">${money(reimb)}</td><td style="border:1px solid #cfd7e3;padding:4px 6px;color:#15803d;font-weight:700">${lo} F · ${em} E</td><td style="border:1px solid #cfd7e3;padding:4px 6px;color:#15803d;font-weight:700">${esc(hm(wait))}</td><td style="border:1px solid #cfd7e3;padding:4px 6px;color:#15803d;font-weight:700">${bonuses}</td></tr></table>
<p style="font-size:13px">Miles from ZIP to ZIP (mile calculator): <b>${lo + em}</b> (${lo} loaded, ${em} empty)${odo != null ? ` · Odometer: <b>${odo}</b> mi` : ''}. Green columns are added by the app; the driver can change them.</p>
${exps.length ? `<h3 style="margin:14px 0 4px">Expenses paid by the driver (with receipts)</h3><table style="border-collapse:collapse;font-size:12px"><tr><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">Date</th><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">What</th><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">Trip #</th><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">Note</th><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">Amount</th><th style="border:1px solid #cfd7e3;padding:4px 6px;background:#f1f4f9">Receipt</th></tr>${expRows}<tr><td colspan="4" style="border:1px solid #cfd7e3;padding:4px 6px;text-align:right;font-weight:700">Expenses total</td><td style="border:1px solid #cfd7e3;padding:4px 6px;font-weight:700">${money(expTotal)}</td><td style="border:1px solid #cfd7e3"></td></tr></table>` : ''}
<p style="font-size:14px"><b>To reimburse: ${money(reimb + expTotal)}</b> (sheet ${money(reimb)} + expenses ${money(expTotal)})</p>
${docs.length ? `<h3 style="margin:14px 0 4px">Paperwork and photos from this trip (${docs.length})</h3><ul style="font-size:13px;margin:0">${docList}</ul>` : ''}
${log.coSignMissing ? `<p style="font-size:13px;color:#b45309;font-weight:700">Co-driver ${esc(log.coSignMissing.name || '')} did not sign within 15 minutes (the app sent them a push at ${esc(new Date(log.coSignMissing.pushedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}).</p>` : log.coSignedBy ? `<p style="font-size:13px">Co-driver ${esc(log.coSignedBy)} signed it in the app.</p>` : ''}
${log.signature ? '<p style="font-size:13px">Driver\'s signature:<br><img src="cid:signature" alt="signature" style="height:60px;border-bottom:1px solid #14213d"></p>' : ''}
<p style="font-size:12px;color:#6b7a8f">Signed in the driver app ${esc(log.submittedAt || '')}.</p></div>`;
  return { subject: `Trip Log · ${h.name || 'Driver'} (${h.id || ''}) · Week of ${week.start}`, html, totals: { loaded: lo, empty: em, wait, reimb, bonuses, expenses: expTotal } };
}

// ---------- the open sheet keeps filling itself ----------
// What the driver saved + what the app knows now: a new stop, trip or GPS move is added in time order (marked new); a line the
// app made that the driver didn't change is brought up to date (a check-in's date, the wait); what the driver changed stays as
// they left it; what they deleted doesn't come back (dismissed). Pure.
export function mergeSheet(saved = [], fresh = [], dismissed = []) {
  const gone = new Set(dismissed);
  const byKey = new Map(fresh.filter((l) => l.key).map((l) => [l.key, l]));
  const have = new Set(saved.map((l) => l.key).filter(Boolean));
  const out = saved.map((l) => (l.key && !l.edited && byKey.has(l.key) ? { ...byKey.get(l.key), edited: false } : l));
  const t = (l) => { const ms = Date.parse(l.at || ''); return Number.isFinite(ms) ? ms : null; };
  for (const f of fresh) {
    if (!f.key || have.has(f.key) || gone.has(f.key)) continue;
    const ms = t(f); const row = { ...f, added: true };
    let at = out.length;
    if (ms != null) { const k = out.findIndex((l) => t(l) != null && t(l) > ms); if (k >= 0) at = k; }
    out.splice(at, 0, row); have.add(f.key);
  }
  return out;
}

// ---------- moves nobody wrote down (Samsara GPS) ----------
const R = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export const milesApart = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// Where the truck sat still: GPS points that stay within `radius` miles for `minMin`+ minutes → [{ lat, lng, from, to, place, zip }]. Pure.
export function staysOf(pts = [], { minMin = 45, radius = 0.6 } = {}) {
  const out = []; let i = 0;
  const ms = (p) => Date.parse(p.t || '');
  while (i < pts.length) {
    const a = pts[i]; let j = i;
    while (j + 1 < pts.length && milesApart(a, pts[j + 1]) <= radius) j += 1;
    const from = ms(a); const to = ms(pts[j]);
    if (Number.isFinite(from) && Number.isFinite(to) && to - from >= minMin * 60000) {
      const place = (pts.slice(i, j + 1).find((p) => p.place) || {}).place || null;
      out.push({ lat: a.lat, lng: a.lng, from, to, place, zip: zipOf(place) });
    }
    i = j + 1;
  }
  return out;
}
// The stays that aren't on the sheet: while empty (not between a trip's first pickup and its last delivery), and not within
// `near` miles of any line's place. → new lines, marked detected. lines: [{ _ms, _pt, trip, act }]. Pure.
export function missingMoves(lines = [], stays = [], { near = 12, max = 8 } = {}) {
  const loaded = [];
  const byTrip = new Map();
  for (const l of lines) { if (!l.trip || !l._ms) continue; const r = byTrip.get(l.trip) || { pu: null, del: null }; if (l.act === 'PU' && (r.pu == null || l._ms < r.pu)) r.pu = l._ms; if (l.act === 'DEL' && (r.del == null || l._ms > r.del)) r.del = l._ms; byTrip.set(l.trip, r); }
  for (const r of byTrip.values()) if (r.pu != null && r.del != null && r.del > r.pu) loaded.push([r.pu, r.del]);
  // near the line just before or just after it in time (the yard at the start doesn't hide the trip back to the yard at the end)
  const timed = lines.filter((l) => l._ms).sort((a, b) => a._ms - b._ms);
  const neighbors = (s) => { const i = timed.findIndex((l) => l._ms > s.from); const before = i < 0 ? timed[timed.length - 1] : timed[i - 1]; const after = i < 0 ? null : timed[i]; return [before, after].filter((l) => l && l._pt); };
  return stays
    .filter((s) => !loaded.some(([a, b]) => s.from > a && s.to < b))
    .filter((s) => !neighbors(s).some((l) => milesApart(s, l._pt) <= near))
    .slice(0, max)
    .map((s) => {
      const hours = Math.round(((s.to - s.from) / 3600000) * 10) / 10;
      return { ...line({ key: `gps|${s.zip || ''}|${new Date(s.from).toISOString().slice(0, 13)}`, ms: s.from, zip: s.zip || (isMiami(s.place) ? HOME_ZIP : ''), place: S(String(s.place || '').replace(/,?\s*USA$/i, ''), 90), act: 'EMPTY', fe: 'E' }),
        detected: 'gps', comment: `GPS: truck stopped here ${hours} h — confirm what you did or delete this line` };
    });
}

// ---------- payroll's review ----------
// What gets paid from a turned-in sheet: pay = { lines: [{ move, wait, bonus, reimb }], expenses: [bool] } (checked = paid).
// → { paid: { loadedMi, emptyMi, waitMin, bonuses, bonusAmt, reimb, expenses }, unpaid: [text] }. Pure.
export function reviewTotals(log, pay = {}, miles = null) {
  const lines = log.lines || []; const mi = miles || log.miles || []; const pl = pay.lines || []; const pe = pay.expenses || [];
  const paid = { loadedMi: 0, emptyMi: 0, waitMin: 0, bonuses: 0, bonusAmt: 0, reimb: 0, expenses: 0 }; const unpaid = [];
  const where = (r, i) => `Line ${i + 1}${r.date ? ` (${r.date})` : ''}${r.trip ? ` trip ${r.trip}` : ''}${r.zip ? ` ZIP ${r.zip}` : ''}`;
  let prev = null;
  lines.forEach((r, i) => {
    const p = pl[i] || {}; const m = Number(r.miOver != null ? r.miOver : mi[i]);
    if (r.act !== 'CM' && Number.isFinite(m) && m > 0) {
      if (p.move) { if (r.fe === 'F') paid.loadedMi += m; else paid.emptyMi += m; } else unpaid.push(`${where(r, i)}: ${m} mi ${r.fe === 'F' ? 'loaded' : 'empty'}${prev ? ` from ${prev}` : ''}`);
    }
    if (r.wait) { if (p.wait) paid.waitMin += r.wait; else unpaid.push(`${where(r, i)}: wait ${hm(r.wait)}`); }
    if (r.bonus && r.bonus !== 'none') { if (p.bonus) { paid.bonuses += 1; paid.bonusAmt += Number(r.bonusAmt) || 0; } else unpaid.push(`${where(r, i)}: bonus ${BONUS_LABEL[r.bonus] || ''}${r.bonusAmt ? ` $${r.bonusAmt}` : ''}`); }
    if (Number(r.reimb) > 0) { if (p.reimb) paid.reimb += Number(r.reimb); else unpaid.push(`${where(r, i)}: reimbursement $${Number(r.reimb).toFixed(2)}`); }
    if (r.zip) prev = r.zip;
  });
  (log.expenses || []).forEach((x, i) => { if (!(Number(x.amount) > 0)) return; if (pe[i]) paid.expenses += Number(x.amount); else unpaid.push(`Expense ${i + 1}: ${EXP_LABEL[x.kind] || x.kind} $${Number(x.amount).toFixed(2)}${x.trip ? ` (trip ${x.trip})` : ''}`); });
  for (const k of ['bonusAmt', 'reimb', 'expenses']) paid[k] = Math.round(paid[k] * 100) / 100;
  return { paid, unpaid };
}

// ---------- the routes ----------
export function initTripLog(app, { db, requireDriver, requireAuth = null, board, tripsOf, sheets = null, loadsFor, nameOf = null, notify = null, env = process.env, now = () => Date.now(), mail = sendMail, fetchFn = globalThis.fetch }) {
  const miles = initMiles({ db, env, fetchFn });
  const pool = db && db.enabled && db.pool;
  const DOC_LABEL = { pod: 'POD', bol: 'BOL', receipt: 'Receipt', lumper: 'Lumper receipt', scale: 'Scale ticket' };
  const labelOf = (r) => DOC_LABEL[String(r.doc_type || '').toLowerCase()] || (/pod/i.test(r.filename || '') ? 'POD' : /bol/i.test(r.filename || '') ? 'BOL' : /receipt|recibo/i.test(r.filename || '') ? 'Receipt' : 'Paperwork');
  // the paperwork the driver scanned for the week's trips, and the receipts they added to the sheet (metadata; bytes when asked)
  async function weekDocs(trips, week, extraIds = [], { bytes = false } = {}) {
    if (!pool || (!trips.length && !extraIds.length)) return [];
    const { rows } = await pool.query(
      `SELECT id, trips, filename, media_type, size_bytes, doc_type, uploaded_at${bytes ? ', data' : ''} FROM ta_docs
        WHERE site = $1 AND kind = 'driverdoc' AND NOT restricted
          AND ((trips && $2::text[] AND uploaded_at >= $3 AND uploaded_at < $4) OR id = ANY($5::bigint[]))
        ORDER BY uploaded_at LIMIT 120`,
      [SITE, trips.map(String), new Date(week.fromMs).toISOString(), new Date(week.toMs + 2 * DAY).toISOString(), extraIds.map(Number).filter(Boolean)]).catch(() => ({ rows: [] }));
    const papers = rows.map((r) => ({ id: String(r.id), kind: 'doc', trip: (r.trips || [])[0] || null, filename: r.filename || null, mediaType: r.media_type, bytes: Number(r.size_bytes) || 0, label: labelOf(r), at: r.uploaded_at, data: bytes ? r.data : undefined }));
    // the photos the driver took at the stops (with the box count, missing boxes, a problem) — kept apart from the papers
    let photos = [];
    if (trips.length) {
      const q = await pool.query(
        `SELECT id, trip, filename, media_type, size_bytes, created_at${bytes ? ', data' : ''} FROM ta_stop_files
          WHERE site = $1 AND trip = ANY($2::text[]) AND created_at >= $3 AND created_at < $4 ORDER BY created_at LIMIT 120`,
        [SITE, trips.map(String), new Date(week.fromMs - DAY).toISOString(), new Date(week.toMs + 2 * DAY).toISOString()]).catch(() => ({ rows: [] }));
      photos = q.rows.map((r) => ({ id: `p-${r.id}`, kind: 'photo', trip: r.trip || null, filename: r.filename || null, mediaType: r.media_type, bytes: Number(r.size_bytes) || 0, label: 'Photo', at: r.created_at, data: bytes ? r.data : undefined }));
    }
    return [...papers, ...photos];
  }
  const tripsOfLog = (lines) => [...new Set((lines || []).map((l) => l.trip).filter(Boolean))];
  const zipPoint = async (z) => (z ? miles.geocode(`${z}, USA`) : null);
  const miles2 = async (p, q) => (await miles.road(p, q)).miles;

  async function vehicleOf(truck) {
    const token = samsaraTokenFrom(env); if (!token || !truck) return null;
    const vs = await listVehicles(token);
    const list = (vs && vs.data) || vs || [];
    const v = list.find((x) => String(x.name || '').replace(/^0+/, '').toUpperCase() === String(truck).replace(/^0+/, '').toUpperCase());
    return v ? { token, id: v.id } : null;
  }
  async function odometer(truck, week) {
    try {
      const v = await vehicleOf(truck); if (!v) return null;
      return await vehicleOdometerRange(v.token, v.id, new Date(week.fromMs).toISOString(), new Date(Math.min(week.toMs, now())).toISOString());
    } catch (e) { console.warn('[triplog] odometer:', e.message); return null; }
  }
  // the truck's stops over the sheet's dates (kept 30 minutes per truck and start: the sheet opens many times)
  const STAYS = 'taTripLogStays';
  async function periodStays(truck, week) {
    const k = `${truck}|${week.start}`;
    const cache = (await db.get(STAYS, {}).catch(() => ({}))) || {};
    if (cache[k] && now() - cache[k].at < 30 * 60000) return cache[k].stays;
    try {
      const v = await vehicleOf(truck); if (!v) return [];
      const pts = await vehicleGpsHistory(v.token, v.id, new Date(week.fromMs).toISOString(), new Date(Math.min(week.toMs, now())).toISOString());
      const stays = staysOf(pts);
      await db.update(STAYS, (cur) => ({ ...Object.fromEntries(Object.entries(cur || {}).filter(([, x]) => now() - x.at < 6 * 3600000).slice(-200)), [k]: { at: now(), stays } }), {}).catch(() => {});
      return stays;
    } catch (e) { console.warn('[triplog] gps:', e.message); return []; }
  }

  // the trips already on a turned-in sheet: the driver's own, and the ones their team partner turned in for both
  async function turnedIn(code) {
    const mine = Object.entries(await store(code)).filter(([k, l]) => k !== OPEN && l && l.status === 'submitted').flatMap(([, l]) => tripsOfLog(l.lines));
    const idx = (await db.get(INDEX, {})) || {};
    const forMe = Object.values(idx).filter((x) => x && codeOf(x.co) === codeOf(code));
    return { trips: new Set([...mine, ...forMe.flatMap((x) => x.trips || [])]), byPartner: forMe.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))) };
  }

  // ---------- the homework fills itself as the driver works (Nov 23, Nadim) ----------
  // No looking back: every load a driver is on is saved for payroll WHILE it runs (its lines kept up to date from the board,
  // the check-ins and the trip sheet), so nothing depends on finished-load records later. A load goes on the sheet once it's
  // completed (every stop delivered, dropped at a yard, or it left the board finished) and stays until the sheet is turned in.
  const LIVE = `taTripLogLive:${SITE}`;   // { [driverCode]: { [trip]: { lines, truck, trailer, partner, start, doneAt, how, onBoard, seenAt } } }
  const driversOf = (it) => { const t = tripOf(it); return [t.driver, t.driver2].map(codeOf).filter(Boolean); };
  async function ctxOf() {
    const [book, reports, geo, clocks, rcs, yardsSaved] = await Promise.all([db.get(CHECKINS(SITE), {}), db.get(`taStopReports:${SITE}`, {}).catch(() => ({})), db.get('taGeoZip', {}).catch(() => ({})), db.get(`taWaiting:${SITE}`, {}).catch(() => ({})), db.get(`taTruckMateRateCon:${SITE}`, {}).catch(() => ({})), db.get(`taYards:${SITE}`, {}).catch(() => ({}))]);
    return { book: book || {}, reports: reports || {}, geo: geo || {}, clocks: clocks || {}, rcs: rcs || {}, yards: { ...KNOWN_YARDS, ...(yardsSaved || {}) } };
  }
  // one load → its lines now, and whether it's completed. → entry
  async function entryOf(it, ctx) {
    const trip = tripNo(it);
    let stopsHere = []; try { stopsHere = driverStops(it, { geo: ctx.geo }); } catch { stopsHere = []; }
    const steps = stepsWithReports((ctx.book[trip] || {}).steps || {}, stopsHere, ctx.reports[trip] || []);
    const sh = sheets ? await sheets.get(trip).catch(() => null) : null;
    const tl = tripLines(it, steps, { sheet: sh, geo: ctx.geo, clocks: ctx.clocks, rc: ctx.rcs[trip] || null, yards: ctx.yards });
    const times = [...Object.values(steps).map(atOf), ...tl.map((l) => l._ms)].filter(Boolean);
    const bills = (it.freightBills || it.orders || []);
    // delivered: every stop checked in delivered, or TruckMate has a delivery time on every bill
    const allDelivered = (stopsHere.length > 0 && stopsHere.every((st) => atOf(steps[`delivered:${st.key}`]))) || (bills.length > 0 && bills.every((b) => b.actualDelivery)) || !!(it._staffPod && it._staffPod.whole);
    const t = tripOf(it);
    return { lines: tl, truck: t.powerUnit ? String(t.powerUnit) : '', trailer: t.trailer ? String(t.trailer) : '', drivers: driversOf(it),
      start: times.length ? Math.min(...times) : null, how: allDelivered ? 'delivered' : sh && sh.dropped ? 'dropped at a yard' : null };
  }
  // save the board's loads into each driver's homework; a load that left the board is completed. `only` = one driver.
  async function capture({ items = null, only = null } = {}) {
    const list = items || (await board()) || [];
    if (!list.length) return 0;                      // no board (an outage): never mark anything finished on that
    const ctx = await ctxOf();
    const mine = list.filter((it) => tripNo(it) && driversOf(it).length && (!only || driversOf(it).includes(codeOf(only))));
    const fresh = [];
    for (const it of mine) fresh.push(await entryOf(it, ctx).catch(() => null)); // eslint-disable-line no-await-in-loop
    const onBoard = new Set(list.map(tripNo).map(String));
    const at = now();
    await db.update(LIVE, (cur) => {
      const all = { ...(cur || {}) };
      fresh.forEach((e, i) => {
        if (!e) return; const trip = tripNo(mine[i]);
        for (const d of e.drivers) {
          const old = (all[d] || {})[trip] || {};
          const partner = e.drivers.find((x) => x !== d) || '';
          all[d] = { ...(all[d] || {}), [trip]: { lines: e.lines, truck: e.truck, trailer: e.trailer, partner, start: old.start || e.start || at,
            doneAt: old.doneAt || (e.how ? at : null), how: old.how || e.how, onBoard: true, seenAt: at } };
        }
      });
      // left the board → completed (the finish sweep, a delivered status, or TruckMate closing it)
      for (const [d, trips] of Object.entries(all)) {
        if (only && d !== codeOf(only)) continue;
        for (const [trip, x] of Object.entries(trips)) if (x && x.onBoard && !onBoard.has(String(trip))) trips[trip] = { ...x, onBoard: false, doneAt: x.doneAt || at, how: x.how || 'finished' };
        // keep it small: three weeks after a load is completed
        for (const [trip, x] of Object.entries(trips)) if (x && x.doneAt && at - x.doneAt > 21 * DAY) delete trips[trip];
      }
      return all;
    }, {});
    return fresh.filter(Boolean).length;
  }
  // 4 times a day — midnight, 6 AM, noon, 6 PM Miami time — whatever was done since (and whenever a driver opens the sheet)
  const SLOT = 'taTripLogCaptureSlot';
  async function captureIfDue() {
    const h = Number(new Date(now()).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
    const slot = `${ymdET(now())}T${String(h - (h % 6)).padStart(2, '0')}`;
    if ((await db.get(SLOT, null)) === slot) return false;
    await db.set(SLOT, slot);
    await capture();
    return true;
  }
  if (env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) { const t = setInterval(() => { captureIfDue().catch((e) => console.warn('[triplog] capture:', e.message)); }, 5 * 60000); if (t.unref) t.unref(); }

  // the open sheet: the driver's completed loads (Monday–Sunday, as they happen) not turned in yet; trips still running stay off
  async function prefill(driver, { running = false } = {}) {   // running: a TEST copy may show loads still running (a preview)
    const code = driver.code;
    const items = await board();
    await capture({ items, only: code }).catch((e) => console.warn('[triplog] capture:', e.message));
    const saved = ((await db.get(LIVE, {})) || {})[codeOf(code)] || {};
    const done = (await turnedIn(code)).trips;
    const lines = []; const trucks = []; const trailers = []; const partners = [];
    const loads = Object.entries(saved).filter(([trip, x]) => x && (x.doneAt || running) && !done.has(String(trip))).sort((a, b) => (a[1].start || 0) - (b[1].start || 0));
    // the sheet reads like the work went: where he started, the pickup, the deliveries (zip codes), then the next load — whole
    // loads in the order they started. Between two loads, if the truck ran empty from the last delivery to the next pickup,
    // an Empty line: zip to zip, the miles, on the way to pick up that load (its B number).
    for (const [trip, x] of loads) {
      let tl = (x.lines || []).map((l) => ({ ...l }));
      const prev = [...lines].reverse().find((l) => l.zip);
      if (prev) tl = tl.filter((l) => !/\|START$/.test(String(l.key || '')));   // after a load: the empty run comes from its last delivery
      const pu = tl.find((l) => l.act === 'PU');
      // the week's first load starting somewhere else: that empty run gets its miles too
      const start = !prev && tl.find((l) => /\|START$/.test(String(l.key || '')));
      if (start && pu && start.zip && pu.zip && start.zip !== pu.zip) {
        let mi = null;
        try { const [p, q] = await Promise.all([zipPoint(start.zip), zipPoint(pu.zip)]); mi = p && q ? Math.round(await miles2(p, q)) : null; } catch { mi = null; } // eslint-disable-line no-await-in-loop
        start.comment = `Empty ${start.zip} → ${pu.zip}${mi != null ? `, ${mi} mi` : ''}, on the way to pick up load${pu.bill ? ` ${pu.bill}` : ` ${trip}`}`;
      }
      if (prev && pu && pu.zip && prev.zip !== pu.zip) {
        let mi = null;
        try { const [p, q] = await Promise.all([zipPoint(prev.zip), zipPoint(pu.zip)]); mi = p && q ? Math.round(await miles2(p, q)) : null; } catch { mi = null; } // eslint-disable-line no-await-in-loop
        const ms = pu._ms ? pu._ms - 60000 : null;
        tl.unshift(line({ key: `${trip}|EMPTYTO`, ms, trip, zip: pu.zip, place: `${prev.zip} → ${pu.zip}`, act: 'EMPTY', fe: 'E', trl: pu.trl, bill: pu.bill,
          comment: `Empty ${prev.zip} → ${pu.zip}${mi != null ? `, ${mi} mi` : ''}, on the way to pick up load${pu.bill ? ` ${pu.bill}` : ` ${trip}`}`, auto: true }));
      }
      lines.push(...tl);
      if (x.truck) trucks.push(x.truck); if (x.trailer) trailers.push(x.trailer); if (x.partner) partners.push(x.partner);
    }
    const period = periodOf(lines);
    const truck = trucks[0] || '';
    const odo = await odometer(truck, period);
    const co = partners[0] || '';
    const coName = co && nameOf ? await nameOf(co).catch(() => '') : '';
    return {
      head: { name: driver.name || '', id: String(code), co: coName || '', coid: co, truck, trailer: [...new Set(trailers)].join(' - '), bod: odo && odo.begin != null ? String(odo.begin) : '', eod: odo && odo.end != null ? String(odo.end) : '', note: '' },
      lines: lines.map(({ _ms, _pt, _sk, ...x }) => x), odometer: odo, status: 'new', period,
    };
  }
  // a sheet's dates: its first line to its last (or to now while it's open). Pure.
  function periodOf(lines = [], endMs = null) {
    const ts = lines.map((l) => (l._ms != null ? l._ms : Date.parse(l.at || ''))).filter((x) => Number.isFinite(x));
    const fromMs = ts.length ? Math.min(...ts) : now() - 7 * DAY;
    const toMs = endMs || (ts.length ? Math.max(Math.max(...ts), now()) : now());
    return { start: ymdET(fromMs), end: ymdET(endMs || (ts.length ? Math.max(...ts) : now())), fromMs, toMs };
  }

  // a sheet's row in the list: when, status, and the totals (no lines)
  const summary = (id, log) => {
    const lines = log.lines || []; const ex = log.expenses || []; const p = log.period || periodOf(lines);
    return { week: id, id, start: p.start, end: p.end, status: id === OPEN ? (log.status === 'submitted' ? 'submitted' : 'draft') : log.status || 'draft', submittedAt: log.submittedAt || null, savedAt: log.savedAt || null, emailedAt: log.emailedAt || null,
      trips: tripsOfLog(lines), lines: lines.length, waitMin: lines.reduce((a, r) => a + (r.wait || 0), 0), bonuses: lines.filter((r) => r.bonus && r.bonus !== 'none').length, co: (log.head || {}).co || null,
      reimburse: Math.round((lines.reduce((a, r) => a + (Number(r.reimb) || 0), 0) + ex.reduce((a, x) => a + (Number(x.amount) || 0), 0)) * 100) / 100, submissions: (log.submissions || []).length };
  };
  // a signature is kept with the driver's paperwork (ta_docs), the sheet keeps its id
  async function saveSignature(sig, driver, id) {
    if (!pool || !sig) return null;
    const buf = Buffer.from(sig.split(',')[1], 'base64');
    const { rows } = await pool.query(
      `INSERT INTO ta_docs (site, kind, trips, filename, media_type, size_bytes, sha256, uploaded_by, data, doc_type, restricted) VALUES ($1, 'driverdoc', '{}', $2, 'image/png', $3, $4, $5, $6, 'signature', true) RETURNING id`,
      [SITE, `trip-log-signature-${driver.code}-${String(id).replace(/[^\dT-]/g, '')}.png`, buf.length, createHash('sha256').update(buf).digest('hex'), `${driver.name} (driver trip log)`, buf]).catch(() => ({ rows: [] }));
    return rows[0] ? String(rows[0].id) : null;
  }
  async function imageOf(docId) {
    if (!pool || !docId) return null;
    const { rows } = await pool.query('SELECT data FROM ta_docs WHERE id = $1 AND site = $2', [Number(docId), SITE]).catch(() => ({ rows: [] }));
    return rows[0] ? `data:image/png;base64,${Buffer.from(rows[0].data).toString('base64')}` : null;
  }
  const signatureOf = (log) => imageOf(log && log.signatureId);
  const store = async (code) => (await db.get(LOGS(code), {})) || {};
  const keep = (cur, id, log) => { const all = { ...(cur || {}) }; if (log === null) delete all[id]; else all[id] = log; const open = all[OPEN]; delete all[OPEN];
    const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[0].localeCompare(a[0])).slice(0, KEEP_WEEKS)); return open ? { [OPEN]: open, ...kept } : kept; };
  const sigOk = (x) => /^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/.test(String(x || '')) && String(x).length <= 300000;
  const odoOf = (o) => (o && typeof o === 'object' ? { begin: Number(o.begin) || null, end: Number(o.end) || null, source: S(o.source, 40) || null } : null);
  const docsFor = async (log, { bytes = false } = {}) => weekDocs(tripsOfLog(log.lines), log.period || periodOf(log.lines), (log.expenses || []).flatMap((x) => x.receipts || []), { bytes });
  const partnerNote = (byPartner) => (byPartner[0] ? { name: byPartner[0].name, code: byPartner[0].code, trips: byPartner[0].trips || [], submittedAt: byPartner[0].submittedAt } : null);

  // the open sheet (saved changes, else filled in now), or a turned-in one (?id=)
  app.get('/driver/me/log', requireDriver, async (req, res) => {
    try {
      const all = await store(req.driver.code);
      const id = String(req.query.id || req.query.week || OPEN);
      const saved = all[id];
      if (id !== OPEN && !saved) return res.status(404).json({ error: 'That sheet is not here.' });
      let log = saved ? { ...saved, signature: saved.signatureId || saved.signature ? true : undefined, coSignature: saved.coSignatureId ? true : undefined } : await prefill(req.driver);
      // the open sheet keeps filling itself, whatever the driver changed (their changes stay)
      if (saved && id === OPEN) {
        const fresh = await prefill(req.driver);
        const auto = saved.autoHead || {};
        const head = { ...saved.head };
        for (const k of ['co', 'coid', 'truck', 'trailer', 'bod', 'eod']) if (!head[k] || head[k] === auto[k]) head[k] = fresh.head[k] || head[k];
        log = { ...log, head, lines: mergeSheet(saved.lines || [], fresh.lines.map(({ _ms, ...x }) => x), saved.dismissed || []), odometer: fresh.odometer || saved.odometer, autoHead: fresh.head };
      } else if (!saved) log = { ...log, autoHead: log.head };
      const period = log.period || periodOf(log.lines);
      const docs = (await docsFor({ ...log, period })).map(({ data, ...d }) => d);
      const partner = id === OPEN ? partnerNote((await turnedIn(req.driver.code)).byPartner.filter((x) => now() - Date.parse(x.submittedAt) < 14 * DAY)) : null;
      // a turned-in sheet: the signatures as pictures (the app draws the sheet like the paper)
      const sigs = saved && id !== OPEN ? { signature: (await signatureOf(saved)) || (sigOk(saved.signature) ? saved.signature : null), coSignature: (await imageOf(saved.coSignatureId)) || (sigOk(saved.coSignature) ? saved.coSignature : null) } : {};
      return res.json({ id, week: { ...period, id }, expenses: [], ...log, ...sigs, period: log.period && saved && id !== OPEN ? log.period : periodOf(log.lines), docs, partner });
    } catch (e) { console.warn('[triplog]', e.message); return res.status(502).json({ error: 'Could not load your trip log. Try again.' }); }
  });
  // the driver's sheets: the open one, then the ones turned in (newest first)
  app.get('/driver/me/logs', requireDriver, async (req, res) => {
    const all = await store(req.driver.code);
    return res.json({ weeks: Object.entries(all).map(([id, log]) => summary(id, log)) });
  });
  // start the open sheet over from what the app knows (the driver's own changes are dropped)
  app.post('/driver/me/log/refill', requireDriver, async (req, res) => {
    try {
      await db.update(LOGS(req.driver.code), (cur) => keep(cur, OPEN, null), {});
      const log = await prefill(req.driver); const docs = (await docsFor(log)).map(({ data, ...d }) => d);
      return res.json({ id: OPEN, week: { ...log.period, id: OPEN }, expenses: [], ...log, docs });
    } catch (e) { return res.status(502).json({ error: 'Could not load your trip log. Try again.' }); }
  });
  app.put('/driver/me/log', requireDriver, async (req, res) => {
    const b = req.body || {}; const lines = cleanLines(b.lines);
    const log = { head: cleanHead(b.head), lines, expenses: cleanExpenses(b.expenses), odometer: odoOf(b.odometer), status: 'draft', savedAt: new Date(now()).toISOString(), period: periodOf(lines),
      autoHead: b.autoHead && typeof b.autoHead === 'object' ? cleanHead(b.autoHead) : null };
    await db.update(LOGS(req.driver.code), (cur) => {
      const prev = (cur || {})[OPEN] || {};
      // a line the app made that the driver deleted: don't put it back
      const kept = new Set(lines.map((l) => l.key).filter(Boolean));
      const sent = (Array.isArray(b.dismissed) ? b.dismissed : []).map((k) => S(k, 120)).filter((k) => k && !kept.has(k));
      const dismissed = [...new Set([...(prev.dismissed || []), ...sent, ...(prev.lines || []).map((l) => l.key).filter((k) => k && !kept.has(k))])].slice(-300);
      return keep(cur, OPEN, { ...log, autoHead: log.autoHead || prev.autoHead || null, dismissed });
    }, {});
    return res.json({ ok: true, savedAt: log.savedAt });
  });
  // a receipt photo for an expense (kept with the driver's paperwork) → { id }
  app.post('/driver/me/log/receipt', requireDriver, async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Not available right now.' });
    const b = req.body || {};
    try {
      const f = await readableFile({ dataBase64: String(b.dataBase64 || ''), mediaType: String(b.mediaType || ''), filename: 'receipt.jpg' });
      const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
      if (!buf.length || buf.length > 14 * 1024 * 1024) return res.status(400).json({ error: 'That photo is empty or too big.' });
      if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/i.test(f.mediaType || '')) return res.status(400).json({ error: 'Only photos or PDFs.' });
      const trip = S(b.trip, 12).replace(/\D/g, '');
      const name = `receipt-${trip || 'NOTRIP'}-${Date.now()}.${/pdf/i.test(f.mediaType) ? 'pdf' : /png/i.test(f.mediaType) ? 'png' : 'jpg'}`;
      const { rows } = await pool.query(
        `INSERT INTO ta_docs (site, kind, trips, filename, media_type, size_bytes, sha256, uploaded_by, data, doc_type) VALUES ($1, 'driverdoc', $2, $3, $4, $5, $6, $7, $8, 'receipt') RETURNING id`,
        [SITE, trip ? [trip] : [], name, f.mediaType.toLowerCase(), buf.length, createHash('sha256').update(buf).digest('hex'), `${req.driver.name} (driver trip log)`, buf]);
      return res.json({ id: String(rows[0].id) });
    } catch (e) { console.warn('[triplog] receipt:', e.message); return res.status(400).json({ error: 'Could not save the photo. Try again.' }); }
  });
  // the miles from each ZIP to the next (mile calculator, cached) → [miles | null]
  app.post('/driver/me/log/miles', requireDriver, async (req, res) => {
    const legs = (Array.isArray((req.body || {}).legs) ? req.body.legs : []).slice(0, 80);
    const out = [];
    for (const l of legs) {
      const [a, b] = (Array.isArray(l) ? l : []).map((z) => (String(z || '').match(/^\d{5}$/) || [null])[0]);
      if (!a || !b) { out.push(null); continue; }
      if (a === b) { out.push(0); continue; }
      try { const [p, q] = await Promise.all([zipPoint(a), zipPoint(b)]); out.push(p && q ? (await miles.road(p, q)).miles : null); } catch { out.push(null); } // eslint-disable-line no-await-in-loop
    }
    return res.json({ miles: out });
  });
  // turn in the open sheet (or a turned-in one again, ?id): it's closed under its first day, and goes to payroll
  app.post('/driver/me/log/submit', requireDriver, async (req, res) => {
    const b = req.body || {};
    const sig = String(b.signature || ''); const coSig = b.coSignature ? String(b.coSignature) : null;
    if (!sigOk(sig)) return res.status(400).json({ error: 'Sign before sending.' });
    if (coSig && !sigOk(coSig)) return res.status(400).json({ error: 'The co-driver signature did not come through. Sign again.' });
    const lines = cleanLines(b.lines);
    if (!lines.length) return res.status(400).json({ error: 'The sheet has no lines.' });
    const head = cleanHead(b.head);
    const period = periodOf(lines, now());
    const all = await store(req.driver.code);
    const again = b.id && b.id !== OPEN && all[b.id] ? String(b.id) : null;
    const id = again || `${period.start}T${new Date(period.fromMs).toISOString().slice(11, 16)}`;
    const log = { head, lines, expenses: cleanExpenses(b.expenses), odometer: odoOf(b.odometer), status: 'submitted', submittedAt: new Date(now()).toISOString(), signature: sig, period: { ...period, end: ymdET(Math.max(...lines.map((l) => Date.parse(l.at || '')).filter(Number.isFinite), period.fromMs)) } };
    const [sigId, coSigId] = await Promise.all([saveSignature(sig, req.driver, id), coSig ? saveSignature(coSig, { code: head.coid || 'co', name: head.co || 'co-driver' }, id) : null]);
    const legMiles = (Array.isArray(b.miles) ? b.miles : []).slice(0, MAX_LINES).map((m) => (m != null && Number.isFinite(Number(m)) ? Math.round(Number(m)) : null));
    const stored = { ...log, signature: sigId ? undefined : sig, signatureId: sigId, coSignatureId: coSigId, miles: legMiles };
    await db.update(LOGS(req.driver.code), (cur) => { const prev = (cur || {})[id] || {}; const next = keep(cur, id, { ...stored, submissions: [...(prev.submissions || []), stored.submittedAt].slice(-20), reviews: prev.reviews || [] }); return again ? next : keep(next, OPEN, null); }, {});
    // a team sheet: the co-driver signs it on their own phone (a push takes them to the signature). Payroll gets it once they
    // sign, or after 15 minutes either way, marked "the co-driver didn't sign" (Nadim, Nov 21)
    if (head.coid && !coSig && codeOf(head.coid) !== codeOf(req.driver.code)) {
      const ask = { owner: String(req.driver.code), ownerName: req.driver.name || head.name || '', id, co: codeOf(head.coid), coName: head.co || '', trips: tripsOfLog(lines), start: log.period.start, end: log.period.end, at: new Date(now()).toISOString(), signedAt: null, finalizedAt: null };
      await db.update(COSIGN, (cur) => [ask, ...((cur || []).filter((x) => !(x.owner === ask.owner && x.id === id)))].slice(0, 300), []).catch(() => {});
      // on the list now (so the partner's own sheet leaves these trips out), held from payroll until it's ready
      await db.update(INDEX, (cur) => ({ ...(cur || {}), [`${req.driver.code}|${id}`]: { code: String(req.driver.code), name: req.driver.name || head.name || '', week: id, id, start: log.period.start, end: log.period.end, submittedAt: log.submittedAt, truck: head.truck || '', trips: tripsOfLog(lines), co: head.coid || null, coName: head.co || null, held: true, reviewedAt: null, reviewedBy: null } }), {}).catch(() => {});
      if (notify) {
        const first = String(ask.ownerName || 'Your partner').split(' ')[0];
        Promise.resolve(asLive(() => notify(ask.co, { title: 'Homework: your signature', body: `${first} turned in the homework for trip ${ask.trips.join(', ')}. Tap to sign it as co-driver. / ${first} entregó el homework: toque para firmarlo.`, data: { tab: 'log', cosign: `${ask.owner}|${id}` } })))
          .then((r) => db.update(COSIGN, (cur) => (cur || []).map((x) => (x.owner === ask.owner && x.id === id ? { ...x, pushed: r && r.sent ? 'sent' : r && r.held ? 'held' : (r && r.skipped) || 'not sent' } : x)), [])).catch(() => {});
      }
      return res.json({ ok: true, id, submittedAt: log.submittedAt, waitingForCoDriver: ask.coName || ask.co, sendsBy: new Date(now() + COSIGN_WAIT_MS).toISOString() });
    }
    const sent = await toPayroll(req.driver.code, req.driver.name, id);
    return res.json({ ok: true, id, submittedAt: log.submittedAt, emailed: !!sent });
  });
  // the turned-in sheet goes to payroll: on payroll's list (the team partner on it) and the email with the PDF and every paper
  async function toPayroll(ownerCode, ownerName, id) {
    const log = (await store(ownerCode))[id]; if (!log) return false;
    const head = log.head || {};
    await db.update(INDEX, (cur) => ({ ...(cur || {}), [`${ownerCode}|${id}`]: { code: String(ownerCode), name: ownerName || head.name || '', week: id, id, start: log.period.start, end: log.period.end, submittedAt: log.submittedAt, truck: head.truck || '', trips: tripsOfLog(log.lines), co: head.coid || null, coName: head.co || null, coSignedAt: log.coSignedAt || null, coSignMissing: log.coSignMissing || null, held: false, reviewedAt: null, reviewedBy: null } }), {}).catch(() => {});
    const [sig, coSig] = await Promise.all([signatureOf(log).then((x) => x || (sigOk(log.signature) ? log.signature : null)), imageOf(log.coSignatureId).then((x) => x || (sigOk(log.coSignature) ? log.coSignature : null))]);
    const docs = await docsFor(log, { bytes: true });
    let room = MAX_ATTACH_BYTES;
    const files = docs.map((d) => { const fits = d.data && d.bytes <= room; if (fits) room -= d.bytes; return { ...d, attached: !!fits }; });
    const e = payrollEmail({ ...log, signature: sig }, { week: log.period, miles: log.miles || [], odometer: log.odometer, docs: files });
    const to = String(env.PAYROLL_EMAILS || 'ntellez@floridabeauty.us').split(',').map((x) => x.trim()).filter(Boolean);
    let pdf = null; try { pdf = await tripLogPdf(log, { signature: sig, coSignature: coSig }); } catch (err) { console.warn('[triplog] pdf:', err.message); }
    try {
      await mail({ to, subject: e.subject, html: e.html, attachments: [...(sig ? [{ name: 'signature.png', contentType: 'image/png', bytes: Buffer.from(sig.split(',')[1], 'base64'), cid: 'signature' }] : []),
        ...(pdf ? [{ name: pdfName(log), contentType: 'application/pdf', bytes: Buffer.from(pdf) }] : []),
        ...files.filter((d) => d.attached).map((d) => ({ name: `${d.label.replace(/\s+/g, '-')}-${d.trip || 'trip'}-${d.filename || d.id}`.slice(0, 120), contentType: d.mediaType, bytes: Buffer.from(d.data) }))] }, { env });
      await db.update(LOGS(ownerCode), (cur) => keep(cur, id, { ...((cur || {})[id] || log), emailedAt: new Date(now()).toISOString() }), {});
      return true;
    } catch (err) { console.warn('[triplog] email:', err.message); return false; }
  }
  // team sheets still waiting for the co-driver after 15 minutes: to payroll either way, "the co-driver didn't sign"
  async function sweepCosign() {
    const due = ((await db.get(COSIGN, [])) || []).filter((x) => !x.signedAt && !x.finalizedAt && now() - Date.parse(x.at) >= COSIGN_WAIT_MS);
    for (const x of due) {
      const at = new Date(now()).toISOString();
      await db.update(LOGS(x.owner), (cur) => { const c = { ...(cur || {}) }; if (c[x.id]) c[x.id] = { ...c[x.id], coSignMissing: { name: x.coName || x.co, pushedAt: x.at, pushed: x.pushed || null, sentAt: at } }; return c; }, {}); // eslint-disable-line no-await-in-loop
      await db.update(COSIGN, (cur) => (cur || []).map((y) => (y.owner === x.owner && y.id === x.id ? { ...y, finalizedAt: at } : y)), []); // eslint-disable-line no-await-in-loop
      await toPayroll(x.owner, x.ownerName, x.id).catch((e) => console.warn('[triplog] cosign sweep:', e.message)); // eslint-disable-line no-await-in-loop
    }
    return due.length;
  }
  if (env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) { const t = setInterval(() => { sweepCosign().catch(() => {}); }, 60000); if (t.unref) t.unref(); }
  // the co-driver: homework their partner turned in that's waiting for their signature (with the sheet to look at)
  app.get('/driver/me/log/cosign', requireDriver, async (req, res) => {
    const mine = ((await db.get(COSIGN, [])) || []).filter((x) => codeOf(x.co) === codeOf(req.driver.code) && !x.signedAt);
    const out = [];
    for (const x of mine.slice(0, 5)) {
      const l = (await store(x.owner))[x.id]; // eslint-disable-line no-await-in-loop
      if (l && !l.coSignatureId) out.push({ owner: x.owner, ownerName: x.ownerName, id: x.id, trips: x.trips, start: x.start, end: x.end, at: x.at, head: l.head, lines: l.lines, expenses: l.expenses || [], miles: l.miles || [] });
    }
    return res.json({ waiting: out });
  });
  app.post('/driver/me/log/cosign', requireDriver, async (req, res) => {
    const b = req.body || {}; const sig = String(b.signature || '');
    if (!sigOk(sig)) return res.status(400).json({ error: 'Sign before sending.' });
    const asks = (await db.get(COSIGN, [])) || [];
    const ask = asks.find((x) => x.owner === String(b.owner) && x.id === String(b.id) && codeOf(x.co) === codeOf(req.driver.code));
    if (!ask) return res.status(404).json({ error: 'That homework is not waiting for your signature.' });
    const sigId = await saveSignature(sig, req.driver, ask.id);
    const at = new Date(now()).toISOString();
    let done = false;
    await db.update(LOGS(ask.owner), (cur) => { const c = { ...(cur || {}) }; const l = c[ask.id]; if (!l) return c; c[ask.id] = { ...l, coSignatureId: sigId, coSignature: sigId ? undefined : sig, coSignedAt: at, coSignedBy: req.driver.name || '' }; done = true; return c; }, {});
    if (!done) return res.status(404).json({ error: 'That homework is not here any more.' });
    await db.update(COSIGN, (cur) => (cur || []).map((x) => (x === ask || (x.owner === ask.owner && x.id === ask.id) ? { ...x, signedAt: at } : x)), []);
    await db.update(INDEX, (cur) => { const c = { ...(cur || {}) }; const k = `${ask.owner}|${ask.id}`; if (c[k]) c[k] = { ...c[k], coSignedAt: at }; return c; }, {}).catch(() => {});
    // signed within the 15 minutes: now it goes to payroll, with both signatures
    if (!ask.finalizedAt) {
      await db.update(COSIGN, (cur) => (cur || []).map((x) => (x.owner === ask.owner && x.id === ask.id ? { ...x, finalizedAt: at } : x)), []);
      await toPayroll(ask.owner, ask.ownerName, ask.id).catch((e) => console.warn('[triplog] cosign:', e.message));
    }
    return res.json({ ok: true, signedAt: at });
  });
  // the sheet as a PDF that looks like the paper "On the Road Trip Log" (the driver's own)
  app.get('/driver/me/log/pdf', requireDriver, async (req, res) => {
    const all = await store(req.driver.code); const id = String(req.query.id || OPEN); const log = all[id];
    if (!log) return res.status(404).json({ error: 'Save or turn in the sheet first.' });
    return sendPdf(res, log);
  });
  async function sendPdf(res, log) {
    try {
      const [sig, coSig] = await Promise.all([signatureOf(log), imageOf(log.coSignatureId)]);
      const bytes = await tripLogPdf(log, { signature: sig || (sigOk(log.signature) ? log.signature : null), coSignature: coSig || (sigOk(log.coSignature) ? log.coSignature : null) });
      res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', `inline; filename="${pdfName(log)}"`);
      return res.send(Buffer.from(bytes));
    } catch (e) { console.warn('[triplog] pdf:', e.message); return res.status(502).json({ error: 'Could not make the PDF. Try again.' }); }
  }
  // the office: a driver's homework on their profile — the weeks, and one week's sheet as it was turned in (admins: it's pay)
  const mayRead = (u) => !!(u && (u.admin || u.role === 'admin' || u.companyAdmin || u.payroll));
  const codeOf = (x) => String(x || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
  if (requireAuth) {
    app.get('/truckmate/driver-profiles/:code/logs', requireAuth, async (req, res) => {
      if (!mayRead(req.user)) return res.status(403).json({ error: 'Payroll and admins only: the trip logs are pay information.' });
      const all = await store(codeOf(req.params.code));
      return res.json({ weeks: Object.entries(all).sort((a, b) => b[0].localeCompare(a[0])).map(([wk, log]) => summary(wk, log)) });
    });
    app.get('/truckmate/driver-profiles/:code/logs/:week', requireAuth, async (req, res) => {
      if (!mayRead(req.user)) return res.status(403).json({ error: 'Payroll and admins only: the trip logs are pay information.' });
      const wk = String(req.params.week); const log = (await store(codeOf(req.params.code)))[wk];
      if (!log) return res.status(404).json({ error: 'No trip log for that week.' });
      const week = { ...(log.period || periodOf(log.lines)), id: wk };
      const docs = (await docsFor({ ...log, period: week })).map(({ data, ...d }) => d);
      const { signature, ...rest } = log;
      return res.json({ week, id: wk, ...rest, signature: (await signatureOf(log)) || signature || null, coSignature: (await imageOf(log.coSignatureId)) || rest.coSignature || null, docs });
    });
  }
  // ---------- payroll ----------
  if (requireAuth) {
    // the sheet as a PDF like the paper, with payroll's checks when it was reviewed
    app.get('/truckmate/driver-profiles/:code/logs/:week/pdf', requireAuth, async (req, res) => {
      if (!mayRead(req.user)) return res.status(403).json({ error: 'Payroll and admins only.' });
      const log = (await store(codeOf(req.params.code)))[String(req.params.week)];
      if (!log) return res.status(404).json({ error: 'No trip log for that week.' });
      return sendPdf(res, log);
    });
    const gate = (req, res) => { if (mayRead(req.user)) return true; res.status(403).json({ error: 'Payroll and admins only.' }); return false; };
    // a photo the driver took at a stop (on the homework): payroll and admins only
    app.get('/truckmate/payroll/photo/:id', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      if (!pool) return res.status(503).json({ error: 'Not available right now.' });
      const id = String(req.params.id).replace(/^p-/, '');
      const { rows } = await pool.query('SELECT filename, media_type, data FROM ta_stop_files WHERE id = $1 AND site = $2', [id, SITE]).catch(() => ({ rows: [] }));
      if (!rows[0]) return res.status(404).json({ error: 'That photo is not here any more.' });
      res.set('Content-Type', rows[0].media_type); res.set('Cache-Control', 'private, max-age=3600');
      return res.end(rows[0].data);
    });
    // TEST homework (Nov 23, Nadim: "we need to test the steps"): an admin turns in a COPY of a driver's open sheet to payroll —
    // under a TEST code (TEST0986; the co-driver as TEST2473), signed by nobody, no push to anyone, so the drivers' own
    // homework and their partner's sheet don't change. It lands on payroll's list like a real one, and the payroll email (with
    // the PDF) goes out as usual (PAYROLL_EMAILS — Nadim while training). "Delete test copies" takes every TEST one away.
    const isAdmin = (u) => !!(u && (u.admin === true || u.role === 'admin'));
    const testCode = (c) => `TEST${codeOf(c)}`;
    app.post('/truckmate/driver-profiles/:code/logs/test-submit', requireAuth, async (req, res) => {
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
      const code = codeOf(req.params.code);
      try {
        const name = (nameOf ? await nameOf(code).catch(() => '') : '') || `driver ${code}`;
        // { running: true } previews loads still running; { fresh: true } leaves the driver's saved open sheet out (only what
        // the app builds now) — Nov 23: to see the new layout on Ferney's 627700
        const opt = req.body || {};
        const fresh = await prefill({ code, name }, { running: !!opt.running });
        const saved = opt.fresh ? null : (await store(code))[OPEN];
        let lines = cleanLines(saved ? mergeSheet(saved.lines || [], fresh.lines.map(({ _ms, ...x }) => x), saved.dismissed || []) : fresh.lines.map(({ _ms, ...x }) => x));
        // only some trips (Nov 23: test with the finished LTL + the load down to Melbourne, not the trip running now); a line
        // without a trip (a move GPS found) stays when it falls between the kept trips
        const pick = [].concat((req.body && req.body.trips) || []).map(String).filter(Boolean);
        if (pick.length) {
          const kept = lines.filter((l) => pick.includes(String(l.trip || '')));
          const ts = kept.map((l) => Date.parse(l.at)).filter(Number.isFinite);
          const lo = Math.min(...ts); const hi = Math.max(...ts);
          lines = lines.filter((l) => (l.trip ? pick.includes(String(l.trip)) : Date.parse(l.at) >= lo && Date.parse(l.at) <= hi));
        }
        if (!lines.length) return res.status(409).json({ error: pick.length ? `No lines for trip ${pick.join(', ')} on ${name}'s sheet.` : `${name} has no lines on the open sheet to test with.` });
        const real = cleanHead({ ...fresh.head, ...((saved && saved.head) || {}) });
        const head = { ...real, name: `TEST — ${real.name || name}`, id: testCode(code), co: real.co ? `${real.co} (test)` : '', coid: real.coid ? testCode(real.coid) : '' };
        const period = periodOf(lines, now());
        const id = `${period.start}T${new Date(period.fromMs).toISOString().slice(11, 16)}-test`;
        const at = new Date(now()).toISOString();
        const log = { head, lines, expenses: cleanExpenses((saved && saved.expenses) || []), odometer: fresh.odometer || (saved && saved.odometer) || null, status: 'submitted', submittedAt: at, test: true, testBy: (req.user && (req.user.name || req.user.email)) || 'admin', period: { ...period, end: ymdET(Math.max(...lines.map((l) => Date.parse(l.at) || 0).filter(Boolean), period.fromMs)) }, miles: [] };
        await db.update(LOGS(testCode(code)), (cur) => keep(cur, id, { ...log, submissions: [at] }), {});
        const emailed = await toPayroll(testCode(code), head.name, id);
        return res.json({ ok: true, code: testCode(code), id, lines: lines.length, emailed, to: String(env.PAYROLL_EMAILS || 'ntellez@floridabeauty.us').split(',').map((x) => x.trim()).filter(Boolean) });
      } catch (e) { return res.status(502).json({ error: e.message }); }
    });
    app.post('/truckmate/payroll/test-copies/delete', requireAuth, async (req, res) => {
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
      const idx = (await db.get(INDEX, {})) || {};
      const codes = [...new Set(Object.values(idx).map((x) => String(x.code || '')).filter((c) => /^TEST/.test(c)))];
      for (const c of codes) await db.set(LOGS(c), {}); // eslint-disable-line no-await-in-loop
      await db.update(INDEX, (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([, x]) => !/^TEST/.test(String((x && x.code) || '')))), {});
      return res.json({ ok: true, removed: codes });
    });
    app.get('/truckmate/payroll/me', requireAuth, (req, res) => res.json({ canPay: mayRead(req.user) }));
    // every sheet turned in (newest first), to review or reviewed
    app.get('/truckmate/payroll/logs', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const idx = (await db.get(INDEX, {})) || {};
      return res.json({ logs: Object.values(idx).filter((x) => !x.held).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))).slice(0, 500) });
    });
    app.get('/truckmate/payroll/logs/:code/:week', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const code = codeOf(req.params.code); const wk = String(req.params.week);
      const log = (await store(code))[wk];
      if (!log) return res.status(404).json({ error: 'No trip log for that week.' });
      const week = { ...(log.period || periodOf(log.lines)), id: wk };
      const docs = (await docsFor({ ...log, period: week })).map(({ data, ...d }) => d);
      // sheets turned in before the miles were kept: work them out now (mile calculator, cached)
      let miles = log.miles;
      if (!Array.isArray(miles) || miles.length !== (log.lines || []).length) {
        miles = [];
        let prev = null;
        for (const r of log.lines || []) {
          let m = null;
          if (r.act !== 'CM' && prev && r.zip) { if (prev === r.zip) m = 0; else { try { const [p, q] = await Promise.all([zipPoint(prev), zipPoint(r.zip)]); m = p && q ? (await miles2(p, q)) : null; } catch { m = null; } } } // eslint-disable-line no-await-in-loop
          miles.push(m); if (r.zip) prev = r.zip;
        }
      }
      const { signature, ...rest } = log;
      return res.json({ week, id: wk, code, ...rest, miles, signature: (await signatureOf(log)) || signature || null, coSignature: (await imageOf(log.coSignatureId)) || rest.coSignature || null, docs });
    });
    // payroll works on the sheet itself: changes lines, adds or deletes them, adds or takes away a bonus, fixes the header.
    // The driver's own lines are kept (driverLines, the first time), and who changed it and when
    app.put('/truckmate/payroll/logs/:code/:week', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const code = codeOf(req.params.code); const wk = String(req.params.week); const b = req.body || {};
      const by = (req.user && (req.user.name || req.user.email)) || 'payroll';
      const lines = cleanLines(b.lines);
      if (!lines.length) return res.status(400).json({ error: 'The sheet needs at least one line.' });
      const miles = Array.isArray(b.miles) ? b.miles.slice(0, MAX_LINES).map((m) => (m != null && Number.isFinite(Number(m)) ? Math.round(Number(m)) : null)) : null;
      let out = null;
      await db.update(LOGS(code), (cur) => {
        const c = { ...(cur || {}) }; const l = c[wk]; if (!l) return c;
        out = { ...l, lines, ...(b.head ? { head: { ...cleanHead(b.head), note: (l.head || {}).note || '' } } : {}), ...(b.expenses ? { expenses: cleanExpenses(b.expenses) } : {}),
          miles: miles && miles.length === lines.length ? miles : l.miles, driverLines: l.driverLines || l.lines, driverHead: l.driverHead || l.head,
          payrollEdits: [...(l.payrollEdits || []), { by, at: new Date(now()).toISOString() }].slice(-50) };
        c[wk] = out; return c;
      }, {});
      if (!out) return res.status(404).json({ error: 'No trip log for that week.' });
      return res.json({ ok: true, lines: out.lines, miles: out.miles, payrollEdits: out.payrollEdits });
    });
    // the miles from each ZIP to the next, for payroll's changes (mile calculator, cached)
    app.post('/truckmate/payroll/miles', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const legs = (Array.isArray((req.body || {}).legs) ? req.body.legs : []).slice(0, 80);
      const out = [];
      for (const l of legs) {
        const [a, b] = (Array.isArray(l) ? l : []).map((z) => (String(z || '').match(/^\d{5}$/) || [null])[0]);
        if (!a || !b) { out.push(null); continue; }
        if (a === b) { out.push(0); continue; }
        try { const [p, q] = await Promise.all([zipPoint(a), zipPoint(b)]); out.push(p && q ? await miles2(p, q) : null); } catch { out.push(null); } // eslint-disable-line no-await-in-loop
      }
      return res.json({ miles: out });
    });
    // payroll saves what's paid; anything not checked has to be confirmed as not paid
    app.post('/truckmate/payroll/logs/:code/:week/review', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const code = codeOf(req.params.code); const wk = String(req.params.week); const b = req.body || {};
      const log = (await store(code))[wk];
      if (!log || log.status !== 'submitted') return res.status(404).json({ error: 'That sheet was not turned in.' });
      const pay = { lines: (Array.isArray(b.pay && b.pay.lines) ? b.pay.lines : []).slice(0, MAX_LINES).map((x) => ({ move: !!(x && x.move), wait: !!(x && x.wait), bonus: !!(x && x.bonus), reimb: !!(x && x.reimb) })),
        expenses: (Array.isArray(b.pay && b.pay.expenses) ? b.pay.expenses : []).slice(0, MAX_EXPENSES).map(Boolean) };
      const miles = Array.isArray(b.miles) ? b.miles.slice(0, MAX_LINES).map((m) => (m != null && Number.isFinite(Number(m)) ? Math.round(Number(m)) : null)) : null;
      const { paid, unpaid } = reviewTotals(log, pay, log.miles && log.miles.length === (log.lines || []).length ? log.miles : miles);
      if (unpaid.length && !b.confirmUnpaid) return res.status(409).json({ error: 'Some items are not checked for pay.', unpaid });
      const by = (req.user && (req.user.name || req.user.email)) || 'payroll';
      const review = { at: new Date(now()).toISOString(), by, pay, paid, unpaid, note: S(b.note, 500) };
      await db.update(LOGS(code), (cur) => { const c = { ...(cur || {}) }; const l = c[wk]; if (!l) return c; c[wk] = { ...l, review, reviews: [...(l.reviews || []), { at: review.at, by }].slice(-20), miles: l.miles && l.miles.length ? l.miles : miles }; return c; }, {});
      await db.update(INDEX, (cur) => { const c = { ...(cur || {}) }; const k = `${code}|${wk}`; if (c[k]) c[k] = { ...c[k], reviewedAt: review.at, reviewedBy: by, paid }; return c; }, {}).catch(() => {});
      return res.json({ ok: true, review });
    });
    // a trip's history for payroll: what TruckMate has, the driver's check-ins, the rate con, the load sheet, every paper on it
    app.get('/truckmate/payroll/trip/:trip', requireAuth, async (req, res) => {
      if (!gate(req, res)) return undefined;
      const trip = String(req.params.trip).replace(/\D/g, '');
      const items = await board();
      const rundowns = (await db.get(`taRundowns:${SITE}`, {}).catch(() => ({}))) || {};
      const it = items.find((x) => tripNo(x) === trip) || (rundowns[trip] && rundowns[trip].rec && rundowns[trip].rec.item) || null;
      const t = tripOf(it);
      const bills = ((it && (it.freightBills || it.orders)) || t.freightBills || []).map((x) => ({ bill: x.billNumber || x.bill || null, pieces: x.pieces != null ? Number(x.pieces) : null, from: x.startZoneDescription || x.startZone || null, to: x.endZoneDescription || x.endZone || null, customer: x.billToName || null, delivered: x.actualDelivery || null }));
      const history = ((it && it._times && it._times.statusHistory) || []).slice(-40).map((h) => ({ status: h.status || h.code || null, at: h.at || h.time || h.changed || null }));
      const steps = (((await db.get(CHECKINS(SITE), {})) || {})[trip] || {}).steps || {};
      const rc = ((await db.get(`taTruckMateRateCon:${SITE}`, {}).catch(() => ({}))) || {})[trip] || null;
      const sh = sheets ? await sheets.get(trip).catch(() => null) : null;
      let docs = [];
      if (pool) {
        const { rows } = await pool.query(`SELECT id, kind, filename, media_type, doc_type, uploaded_at, uploaded_by FROM ta_docs WHERE site = $1 AND $2 = ANY(trips) AND NOT restricted AND kind <> 'packet' ORDER BY uploaded_at LIMIT 80`, [SITE, trip]).catch(() => ({ rows: [] }));
        const KIND = { ratecon: 'Rate con', tripsheet: 'Trip sheet', manifest: 'Trip sheet', driverdoc: 'Driver paperwork', artisdoc: 'ARTIS paper', email: 'Email attachment', rundown: 'Rundown', message: 'Message picture' };
        docs = rows.map((r) => ({ id: String(r.id), label: r.doc_type === 'rate_confirmation' ? 'Rate con (email)' : labelOf(r) !== 'Paperwork' ? labelOf(r) : (KIND[r.kind] || r.kind), filename: r.filename || null, at: r.uploaded_at, by: r.uploaded_by || null, mediaType: r.media_type }));
      }
      return res.json({ trip, found: !!it, onBoard: items.includes(it),
        load: it ? { status: t.status || null, truck: t.powerUnit || null, trailer: t.trailer || null, driver: t.driver || null, driver2: t.driver2 || null, origin: t.origZoneDesc || t.origin || null, destination: t.destZoneDesc || t.destination || null } : null,
        bills, history, checkins: Object.entries(steps).map(([k, v]) => ({ step: k, at: (v && v.at) || v || null, by: (v && v.by) || null, auto: !!(v && v.auto) })).sort((a, b) => String(a.at).localeCompare(String(b.at))),
        rateCon: rc ? { broker: rc.broker || rc.brokerName || null, rate: rc.rate || rc.totalRate || rc.lineHaul || null, loadNumber: rc.loadNumber || rc.reference || null, stops: (rc.stops || []).slice(0, 12), instructions: (rc.specialInstructions || rc.instructions || []).slice ? (rc.specialInstructions || rc.instructions || []).slice(0, 12) : [], uploadedBy: rc.uploadedBy || null, uploadedAt: rc.uploadedAt || null } : null,
        loadSheet: sh ? { from: sh.from || null, sentAt: sh.sentAt || null, notes: sh.notes || [], stops: (sh.stops || []).map((x) => ({ kind: x.kind, name: x.name, city: x.city, state: x.state, zip: x.zip, date: x.date, time: x.time })) } : null,
        docs });
    });
  }
  return { prefill, sweepCosign, capture, captureIfDue };
}

// ---------------------------------------------------------------
// The run report and the driver's grade (Nov 21, 2026): when an LTL or team run finishes, Nadim gets one email with the whole
// run — every stop with our ETA and ARTIS's against the real arrival, when they arrived and left, boxes delivered vs expected,
// pallets, missing boxes, check-ins, the driver's notes, their photos and the POD / BOL they scanned — and a grade from 1 to 10.
// The grade starts at 10 and loses points by rules that can each be turned off or weighted (taDriverGradeRules):
//   · left late: from loaded to rolling out of the yard
//   · stopped in Florida after leaving Miami (outside our yards), on the way out
//   · stops that weren't customers, yards or the rest the run allows (team runs drive straight through)
//   · didn't check in at the stops in the app, didn't report the boxes, didn't scan the paperwork
//   · reported missing boxes without a photo
// Each point lost says why, so the rules can be tuned. Grades are kept per driver (taDriverGrades). Nothing here contacts ARTIS.
// ---------------------------------------------------------------
import { samsaraTokenFrom, listVehicles, vehicleGpsHistory } from './samsara.js';
import { staysOf, milesApart } from './triplog.js';

const SITE = 'florida-beauty';
const RULES = 'taDriverGradeRules';
const GRADES = `taDriverGrades:${SITE}`;
const SENT = `taRunReportSent:${SITE}`;
const MIN = 60000; const H = 60 * MIN;
const MAX_ATTACH = 18 * 1024 * 1024;
const MIAMI = { lat: 25.8, lng: -80.32 };   // our terminal, lot and cooler are all within a few miles
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hm = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

// the rules and their points; each can be turned off or reweighted (Nadim: "we'll play with the list")
export const DEFAULT_RULES = {
  leftLate: { on: true, label: 'Left the yard late after loading', okMin: 30, points: [[60, 1], [Infinity, 2]] },
  floridaStops: { on: true, label: 'Stopped in Florida after leaving Miami', minMin: 20, each: 1, max: 3 },
  extraStops: { on: true, label: 'Stops that were not customers, yards or allowed rest', minMin: 30, each: 1, max: 3, soloRestEveryH: 14, teamRests: 1 },
  checkins: { on: true, label: 'Did not check in at the stops in the app', under80: 1, under50: 2 },
  boxReports: { on: true, label: 'Did not report the boxes at a stop', some: 1, over30: 2 },
  paperwork: { on: true, label: 'Did not scan the POD / BOL at a stop', some: 1, over30: 2 },
  missingNoPhoto: { on: true, label: 'Reported missing boxes without a photo', each: 0.5, max: 1 },
};
export const mergeRules = (saved = {}) => Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, d]) => [k, { ...d, ...((saved || {})[k] || {}) }]));

// ---------- what happened on the run (pure) ----------
// the stops on the run: the trip sheet's delivery stops, else TruckMate's bills by place; each with its bills and boxes
export function runStops(item) {
  const bills = (item && (item.freightBills || item.orders)) || tripOf(item).freightBills || [];
  const byPlace = new Map();
  for (const b of bills) {
    const label = String(b.endZoneDescription || '').trim(); if (!label) continue;
    const place = label.replace(/,\s*\d{5}(-\d{4})?\s*$/, '');
    const s = byPlace.get(place) || { place, label, customers: new Set(), bills: [], boxes: 0, deliveredAt: null };
    if (b.billToName) s.customers.add(String(b.billToName).replace(/\s*\*$/, '').trim());
    s.bills.push(String(b.billNumber || '')); s.boxes += Number(b.pieces) || 0;
    if (b.actualDelivery) s.deliveredAt = b.actualDelivery;
    byPlace.set(place, s);
  }
  const sheet = ((item && item._manifest && item._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || ''));
  const out = [...byPlace.values()].map((s) => {
    const sh = sheet.find((x) => x.city && s.place.toUpperCase().startsWith(String(x.city).toUpperCase()));
    return { ...s, customers: [...s.customers], customer: (sh && sh.customer) || [...s.customers][0] || null, sheetBoxes: sh ? (sh.sheetPieces != null ? sh.sheetPieces : sh.boxes) : null, n: sh ? sh.n || null : null, stopKey: sh ? sh.key : null };
  });
  return out.sort((a, b) => (a.n || 99) - (b.n || 99));
}
const cityKey = (x) => { const all = String(x || '').toUpperCase().match(/([A-Z][A-Z .'-]*?),\s*([A-Z]{2})\b/g); return all ? all[all.length - 1].replace(/\s+/g, ' ').trim() : ''; };
// the driver's reports at a stop (boxes, missing, photos, scans, problems), by its city. Pure.
export const reportsAt = (reports, stop) => (reports || []).filter((r) => cityKey(r.stop) && cityKey(r.stop) === cityKey(stop.place));

// From loaded to rolling: the first GPS point 2+ miles from where the truck sat when it was loaded. → minutes | null. Pure.
export function leftAfterLoaded(pts = [], loadedMs) {
  if (!loadedMs || !pts.length) return null;
  const after = pts.filter((p) => Date.parse(p.t) >= loadedMs);
  if (!after.length) return null;
  const start = after[0];
  const gone = after.find((p) => milesApart(start, p) >= 2);
  return gone ? Math.round((Date.parse(gone.t) - loadedMs) / MIN) : null;
}
// GPS stays that weren't a customer stop (geofence visit) or our Miami yard; the Florida ones (on the way out) apart. Pure.
export function otherStops(stays = [], visits = [], { departedMs = null, leftFloridaMs = null } = {}) {
  const atCustomer = (s) => visits.some((v) => v.enteredAt && s.to >= v.enteredAt - 15 * MIN && s.from <= (v.exitedAt || v.enteredAt) + 15 * MIN);
  const atYard = (s) => milesApart(s, MIAMI) <= 6;
  const out = { florida: [], other: [] };
  for (const s of stays) {
    if ((departedMs && s.to < departedMs) || atCustomer(s) || atYard(s)) continue;
    const fl = /,\s*FL\b|\bFlorida\b/i.test(s.place || '') || (s.lat < 31 && s.lng > -87.6);
    if (fl && (!leftFloridaMs || s.from < leftFloridaMs)) out.florida.push(s); else out.other.push(s);
  }
  return out;
}

// The grade: 10, minus each rule's points (floored at 1). facts: what happened. → { grade, lost: [{ rule, label, points, why }] }. Pure.
export function gradeRun(facts, rules = DEFAULT_RULES) {
  const lost = []; const take = (rule, points, why) => { if (points > 0) lost.push({ rule, label: rules[rule].label, points, why }); };
  const r = rules;
  if (r.leftLate.on && facts.leftAfterMin != null && facts.leftAfterMin > r.leftLate.okMin) {
    const p = (r.leftLate.points.find(([upTo]) => facts.leftAfterMin <= upTo) || [0, 0])[1];
    take('leftLate', p, `Rolled out ${hm(facts.leftAfterMin)} after loading (${hm(r.leftLate.okMin)} is fine)`);
  }
  if (r.floridaStops.on) { const fl = (facts.floridaStops || []).filter((s) => (s.to - s.from) / MIN >= r.floridaStops.minMin); if (fl.length) take('floridaStops', Math.min(r.floridaStops.max, fl.length * r.floridaStops.each), `${fl.length} stop${fl.length === 1 ? '' : 's'} in Florida: ${fl.map((s) => `${s.place || 'unknown place'} (${hm(Math.round((s.to - s.from) / MIN))})`).join('; ')}`); }
  if (r.extraStops.on) {
    const long = (facts.otherStops || []).filter((s) => (s.to - s.from) / MIN >= r.extraStops.minMin);
    const allowed = facts.team ? r.extraStops.teamRests : Math.max(1, Math.ceil((facts.runHours || 0) / r.extraStops.soloRestEveryH));
    const extra = Math.max(0, long.length - allowed);
    if (extra) take('extraStops', Math.min(r.extraStops.max, extra * r.extraStops.each), `${long.length} stops of ${hm(r.extraStops.minMin)}+ that weren't customers (${allowed} allowed for a ${facts.team ? 'team' : 'solo'} run of ${Math.round(facts.runHours || 0)} h): ${long.map((s) => `${s.place || 'unknown'} ${hm(Math.round((s.to - s.from) / MIN))}`).join('; ')}`);
  }
  const n = facts.stops || 0;
  if (n) {
    if (r.checkins.on) { const pct = (facts.checkedIn / n) * 100; const p = pct < 50 ? r.checkins.under50 : pct < 80 ? r.checkins.under80 : 0; take('checkins', p, `Checked in at ${facts.checkedIn} of ${n} stops`); }
    if (r.boxReports.on && facts.noBoxReport > 0) take('boxReports', facts.noBoxReport / n > 0.3 ? r.boxReports.over30 : r.boxReports.some, `No box count at ${facts.noBoxReport} of ${n} stops`);
    if (r.paperwork.on && facts.noPaperwork > 0) take('paperwork', facts.noPaperwork / n > 0.3 ? r.paperwork.over30 : r.paperwork.some, `No POD / BOL scanned at ${facts.noPaperwork} of ${n} stops`);
  }
  if (r.missingNoPhoto.on && facts.missingNoPhoto > 0) take('missingNoPhoto', Math.min(r.missingNoPhoto.max, facts.missingNoPhoto * r.missingNoPhoto.each), `${facts.missingNoPhoto} missing-box report${facts.missingNoPhoto === 1 ? '' : 's'} without a photo`);
  const total = lost.reduce((a, x) => a + x.points, 0);
  return { grade: Math.max(1, Math.round((10 - total) * 10) / 10), lost };
}

// ---------- the email (pure) ----------
export function renderRunReport(run) {
  const t = run.trip; const g = run.grade;
  const color = g.grade >= 8 ? '#15803d' : g.grade >= 5 ? '#b45309' : '#b91c1c';
  const cell = 'padding:6px 8px;border-top:1px solid #E2E8F0;vertical-align:top;font-size:13px;color:#172538;';
  const off = (etaMs, ms) => { if (!etaMs || !ms) return ''; const d = Math.round((ms - etaMs) / MIN); return d === 0 ? 'on time' : `${hm(Math.abs(d))} ${d > 0 ? 'later' : 'earlier'}`; };
  const stopRows = run.stops.map((s, i) => {
    const boxLines = s.boxReports.map((b) => `${b.boxes != null ? `<b>${b.boxes}</b>` : '?'}${b.expected ? ` of ${b.expected}` : ''}${b.pallets != null ? ` · ${b.pallets} pallet${b.pallets === 1 ? '' : 's'}` : ''}${b.missing ? ` · <b style="color:#b91c1c">${b.missing} MISSING</b>` : ''}${b.noPaperwork ? ' · no paperwork at this stop' : ''} <span style="color:#596A7F">(${esc(b.by || 'driver')})</span>`).join('<br>');
    return `<tr><td style="${cell}"><b>${i + 1}. ${esc(s.customer || s.place)}</b><br><span style="color:#596A7F">${esc(s.place)} · ${s.bills.length} bill${s.bills.length === 1 ? '' : 's'} · expected ${s.sheetBoxes != null ? s.sheetBoxes : s.boxes} boxes</span></td>
<td style="${cell}">${s.firstEta ? `first ${fmt(s.firstEta)}<br>last ${fmt(s.lastEta)}` : '—'}${s.artisEta ? `<br><span style="color:#596A7F">ARTIS ${fmt(s.artisEta)}</span>` : ''}</td>
<td style="${cell}"><b>${fmt(s.arrivedMs)}</b>${s.leftMs ? `<br>left ${fmt(s.leftMs)}` : ''}${s.minutes != null ? `<br><span style="color:#596A7F">${hm(s.minutes)} there</span>` : ''}${s.arrivedMs && s.lastEta ? `<br><span style="color:#596A7F">our ETA ${off(s.lastEta, s.arrivedMs)}${s.artisEta ? ` · ARTIS ${off(s.artisEta, s.arrivedMs)}` : ''}</span>` : ''}</td>
<td style="${cell}">${boxLines || '<span style="color:#b45309">no box count</span>'}</td>
<td style="${cell}">${s.checkedIn ? '✓ checked in' : '<span style="color:#b45309">no check-in</span>'}${s.scans.length ? `<br>${s.scans.map((x) => `📄 ${esc((x.paper || 'paper').toUpperCase())}${x.bill ? ` ${esc(x.bill)}` : ''}`).join('<br>')}` : '<br><span style="color:#b45309">no POD / BOL</span>'}${s.photos ? `<br>📷 ${s.photos} photo${s.photos === 1 ? '' : 's'}` : ''}${s.problems.length ? `<br><b style="color:#b91c1c">⚠️ ${esc(s.problems.join('; '))}</b>` : ''}${s.notes.length ? `<br><i>“${esc(s.notes.join('” “'))}”</i>` : ''}</td></tr>`;
  }).join('');
  const lostRows = g.lost.map((x) => `<li><b>−${x.points}</b> ${esc(x.label)}: ${esc(x.why)}</li>`).join('');
  const stays = (list) => list.map((s) => `<li>${fmt(s.from)} · ${hm(Math.round((s.to - s.from) / MIN))} · ${esc(s.place || `${s.lat.toFixed(3)}, ${s.lng.toFixed(3)}`)}</li>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#172538;max-width:820px">
<h2 style="margin:0 0 4px">Run report — trip ${esc(t.trip)}${t.next ? ` + ${esc(t.next)}` : ''} · truck ${esc(t.truck || '—')}</h2>
<div style="color:#596A7F;font-size:13px">${esc(t.drivers.join(' & ') || 'driver')}${t.team ? ' (team)' : ''} · trailer ${esc(t.trailer || '—')} · ${esc(t.from || '')} → ${esc(t.to || '')} · loaded ${fmt(run.loadedMs)} · rolled ${run.leftAfterMin != null ? `${hm(run.leftAfterMin)} later` : '—'} · finished ${fmt(run.finishedMs)} (${esc(run.reason || 'finished')})</div>
<div style="margin:14px 0;padding:12px 14px;border-radius:12px;border:2px solid ${color}"><span style="font-size:30px;font-weight:800;color:${color}">${g.grade}</span><span style="font-size:15px;color:#596A7F"> / 10 driver grade</span>
${lostRows ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">${lostRows}</ul>` : '<div style="font-size:13px;color:#15803d;margin-top:6px">Nothing lost: left on time, no stops off the route, checked in, counted the boxes and scanned the paperwork everywhere.</div>'}</div>
<div style="font-size:13px;margin-bottom:10px"><b>${run.stops.length}</b> stops · <b>${run.totals.boxes}</b> boxes delivered of ${run.totals.expected} expected${run.totals.missing ? ` · <b style="color:#b91c1c">${run.totals.missing} missing</b>` : ''}${run.totals.pallets ? ` · ${run.totals.pallets} pallets` : ''} · ${run.totals.photos} photos · ${run.totals.scans} POD / BOL scans · average ${hm(run.totals.avgStopMin)} at a stop</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">
<tr style="background:#F4F6F9"><th align="left" style="padding:6px 8px;font-size:12px">Stop</th><th align="left" style="padding:6px 8px;font-size:12px">ETAs</th><th align="left" style="padding:6px 8px;font-size:12px">Arrived · left</th><th align="left" style="padding:6px 8px;font-size:12px">Boxes</th><th align="left" style="padding:6px 8px;font-size:12px">Driver app</th></tr>
${stopRows || `<tr><td colspan="5" style="${cell}">No stops found on this trip.</td></tr>`}</table>
${run.floridaStops.length ? `<h3 style="margin:16px 0 4px;font-size:15px">Stops in Florida after leaving Miami</h3><ul style="font-size:13px;margin:0">${stays(run.floridaStops)}</ul>` : ''}
${run.otherStops.length ? `<h3 style="margin:16px 0 4px;font-size:15px">Other stops (GPS, not customers or our yards)</h3><ul style="font-size:13px;margin:0">${stays(run.otherStops)}</ul>` : ''}
${run.attachedNote ? `<p style="font-size:12px;color:#596A7F">${esc(run.attachedNote)}</p>` : ''}
<p style="font-size:12px;color:#596A7F">Arrivals are the truck entering each customer's geofence (else TruckMate's delivered time). The grade rules can be changed or turned off.</p></div>`;
  return { subject: `Run report · trip ${t.trip} · truck ${t.truck || '—'} · ${t.drivers.join(' & ')} · grade ${g.grade}/10`, html };
}

// ---------- gathering it and sending it ----------
export function initRunReport({ db, sendMail = null, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const pool = enabled && db.pool;
  async function gpsFor(truck, fromMs, toMs) {
    const token = samsaraTokenFrom(env); if (!token || !truck) return [];
    try {
      const vs = await listVehicles(token); const list = (vs && vs.data) || vs || [];
      const v = list.find((x) => String(x.name || '').replace(/^0+/, '').toUpperCase() === String(truck).replace(/^0+/, '').toUpperCase());
      return v ? await vehicleGpsHistory(token, v.id, new Date(fromMs).toISOString(), new Date(toMs).toISOString()) : [];
    } catch (e) { console.warn('[run-report] gps:', e.message); return []; }
  }
  // everything about the run, graded
  async function build(site, item, reason = 'finished') {
    const t = tripOf(item); const n = tripNo(item);
    const stops = runStops(item);
    const reports = (((await db.get(`taStopReports:${site}`, {})) || {})[n]) || [];
    const paperwork = (((await db.get(`taDriverPaperwork:${site}`, [])) || []).filter((p) => String(p.trip) === n));
    const steps = ((((await db.get(`taDriverCheckins:${site}`, {})) || {})[n]) || {}).steps || {};
    const visits = Object.values((((await db.get(`taStopVisits:${site}`, {})) || {})[n]) || {});
    const log = ((await db.get(`taEtaLog:${site}`, {})) || {})[n] || {};
    const hist = (item._times && item._times.statusHistory) || [];
    const atOf = (x) => { const ms = Date.parse((x && (x.at || x)) || ''); return Number.isFinite(ms) ? ms : null; };
    const loadedMs = atOf(steps.loaded) || atOf((hist.find((h) => /LOADEDTOGO/i.test(h.status)) || {}).at) || atOf((hist.find((h) => /DEPSHIP/i.test(h.status)) || {}).at);
    const finishedMs = now();
    const pts = loadedMs ? await gpsFor(t.powerUnit, loadedMs - 30 * MIN, finishedMs) : [];
    const leftAfterMin = leftAfterLoaded(pts, loadedMs);
    const departedMs = leftAfterMin != null ? loadedMs + leftAfterMin * MIN : loadedMs;
    const outOfFl = pts.find((p) => Date.parse(p.t) > (departedMs || 0) && p.lat >= 31);
    const stays = staysOf(pts, { minMin: 15 });
    const os = otherStops(stays, visits, { departedMs, leftFloridaMs: outOfFl ? Date.parse(outOfFl.t) : null });
    const scanRows = [...reports.filter((r) => r.kind === 'scan'), ...paperwork.map((p) => ({ kind: 'scan', paper: p.kind, bill: p.bill, docIds: p.docIds || [], by: p.by, at: p.at, stop: null }))];
    const plKey = (label) => { const p = String(label || '').split(',').map((x) => x.trim().toUpperCase()); return p[0] && p[1] ? `${p[0].replace(/[^A-Z ]/g, '')}|${p[1].slice(0, 2)}` : null; };
    const built = stops.map((s) => {
      const here = reportsAt(reports, s);
      const boxReports = here.filter((r) => r.kind === 'boxes');
      const scans = [...here.filter((r) => r.kind === 'scan'), ...scanRows.filter((r) => !r.stop && r.bill && s.bills.includes(r.bill))];
      const v = visits.find((x) => x.stopKey && s.stopKey && x.stopKey === s.stopKey) || visits.find((x) => x.geofence && x.geofence.name && s.customer && String(x.geofence.name).toUpperCase().includes(String(s.customer).toUpperCase().split(' ')[0]));
      const h = log[plKey(s.label)] || {};
      const ours = h.ours || []; const artis = h.artis || [];
      const ck = Object.keys(steps).some((k) => (/^arrived:|^delivered:/).test(k) && cityKey(k.replace(/^(arrived|delivered):/, '')) === cityKey(s.place));
      return { ...s, boxReports, scans, photos: here.reduce((a, r) => a + ((r.files || []).length), 0), files: here.flatMap((r) => (r.files || []).map((f) => ({ ...f, report: r.kind }))),
        problems: here.filter((r) => r.kind === 'problem').map((r) => r.why || 'problem'), notes: here.map((r) => r.note).filter(Boolean),
        arrivedMs: v ? v.enteredAt : null, leftMs: v ? v.exitedAt : null, minutes: v ? (v.dwellMin != null ? v.dwellMin : v.exitedAt ? Math.round((v.exitedAt - v.enteredAt) / MIN) : null) : null,
        firstEta: ours[0] ? ours[0].etaMs : null, lastEta: ours.length ? (ours.filter((e) => !v || e.at < v.enteredAt).pop() || ours[0]).etaMs : null, artisEta: artis.length ? (artis.filter((e) => !v || e.at < v.enteredAt).pop() || artis[0]).etaMs : null, checkedIn: ck };
    });
    const sum = (f) => built.reduce((a, s) => a + f(s), 0);
    const last = (s) => s.boxReports[s.boxReports.length - 1] || {};
    const dwell = built.map((s) => s.minutes).filter((m) => m != null);
    const facts = {
      team: !!t.driver2, runHours: loadedMs ? (finishedMs - loadedMs) / H : 0, leftAfterMin, floridaStops: os.florida, otherStops: os.other, stops: built.length,
      checkedIn: built.filter((s) => s.checkedIn).length, noBoxReport: built.filter((s) => !s.boxReports.length).length, noPaperwork: built.filter((s) => !s.scans.length && !s.boxReports.some((b) => b.noPaperwork)).length,
      missingNoPhoto: reports.filter((r) => r.kind === 'boxes' && r.missing && !(r.files || []).length).length,
    };
    const rules = mergeRules(await db.get(RULES, {}).catch(() => ({})));
    const grade = gradeRun(facts, rules);
    const drivers = [t.driver, t.driver2].filter(Boolean).map(String);
    return { trip: { trip: n, truck: t.powerUnit || null, trailer: t.trailer || null, from: t.origZoneDesc || null, to: t.destZoneDesc || null, drivers, team: !!t.driver2 }, reason, loadedMs, finishedMs, leftAfterMin,
      stops: built, floridaStops: os.florida, otherStops: os.other, facts, grade,
      totals: { boxes: sum((s) => Number(last(s).boxes) || 0), expected: sum((s) => Number(s.sheetBoxes != null ? s.sheetBoxes : s.boxes) || 0), missing: sum((s) => Number(last(s).missing) || 0), pallets: sum((s) => Number(last(s).pallets) || 0), photos: sum((s) => s.photos), scans: sum((s) => s.scans.length), avgStopMin: dwell.length ? Math.round(dwell.reduce((a, b) => a + b, 0) / dwell.length) : null } };
  }
  // the photos and the scanned paperwork, attached up to the size limit
  async function attachments(run) {
    if (!pool) return { files: [], note: null };
    const out = []; let room = MAX_ATTACH; let left = 0;
    const photoIds = run.stops.flatMap((s, i) => s.files.map((f) => ({ id: f.id, stop: i + 1 })));
    if (photoIds.length) {
      const { rows } = await pool.query('SELECT id, filename, media_type, size_bytes, data FROM ta_stop_files WHERE site = $1 AND id = ANY($2::text[])', [SITE, photoIds.map((p) => p.id)]).catch(() => ({ rows: [] }));
      for (const r of rows) { const st = (photoIds.find((p) => p.id === r.id) || {}).stop; if (r.size_bytes > room) { left += 1; continue; } room -= r.size_bytes; out.push({ name: `stop${st}-photo-${r.filename || r.id}`.slice(0, 100), contentType: r.media_type, bytes: Buffer.from(r.data) }); }
    }
    const docIds = run.stops.flatMap((s, i) => s.scans.flatMap((x) => (x.docIds || []).map((id) => ({ id, stop: i + 1, label: `${(x.paper || 'paper').toUpperCase()}${x.bill ? `-${x.bill}` : ''}` }))));
    if (docIds.length) {
      const { rows } = await pool.query('SELECT id, filename, media_type, size_bytes, data FROM ta_docs WHERE site = $1 AND id = ANY($2::bigint[])', [SITE, docIds.map((d) => Number(d.id)).filter(Boolean)]).catch(() => ({ rows: [] }));
      for (const r of rows) { const d = docIds.find((x) => String(x.id) === String(r.id)) || {}; if (Number(r.size_bytes) > room) { left += 1; continue; } room -= Number(r.size_bytes); out.push({ name: `stop${d.stop}-${d.label}-${r.filename || r.id}`.slice(0, 100), contentType: r.media_type, bytes: Buffer.from(r.data) }); }
    }
    return { files: out, note: left ? `${left} more photo / paper file${left === 1 ? '' : 's'} didn't fit in this email — they're on the trip card.` : null };
  }
  // an LTL run (trip sheet) or a team run finished → the report, once, to Nadim; the grade kept on each driver
  async function onFinished(site, rec, reason) {
    if (!enabled || !rec || !rec.item) return null;
    const item = rec.item; const t = tripOf(item); const n = tripNo(item); if (!n) return null;
    const ltl = !!((item._manifest && (item._manifest.stops || []).length) || /LTL/i.test(String(item._loadLabel || '')));
    if (!ltl && !t.driver2) return null;
    const sent = (await db.get(SENT, {})) || {};
    if (sent[n]) return null;
    const run = await build(site, item, reason);
    await db.update(GRADES, (cur) => [{ trip: n, at: new Date(now()).toISOString(), drivers: run.trip.drivers, truck: run.trip.truck, team: run.trip.team, grade: run.grade.grade, lost: run.grade.lost }, ...((cur || []).filter((g) => g.trip !== n))].slice(0, 1000), []);
    await db.update(SENT, (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [n]: new Date(now()).toISOString() }).slice(-1000)), {});
    if (!sendMail) return run;
    const a = await attachments(run);
    const m = renderRunReport({ ...run, attachedNote: a.note });
    const to = String(env.RUN_REPORT_EMAILS || 'ntellez@floridabeauty.us').split(',').map((x) => x.trim()).filter(Boolean);
    await sendMail({ to, subject: m.subject, html: m.html, attachments: a.files });
    return run;
  }
  return { build, onFinished, rules: async () => mergeRules(await db.get(RULES, {}).catch(() => ({}))), grades: async () => (await db.get(GRADES, [])) || [] };
}

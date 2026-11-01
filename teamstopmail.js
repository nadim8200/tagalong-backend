// The email when a team truck sits too long. Layout + wording only: who gets it and when come from the caller. Pure.
import { TRAINING_SLOT } from './latemail.js';
import { fmtLocalShort } from './localtime.js';

const NAVY = '#13325B'; const TEXT = '#1F2937'; const MUTED = '#5B6778'; const LINE = '#E2E8F0'; const RED = '#C62828'; const FONT = 'Arial,Helvetica,sans-serif';
const LIVE_URL = 'https://mytagalong.app/truckmate?tab=active';
const NA = 'Not available';
const GPS_STALE_MIN = 30;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMin = (m) => { if (m == null || Number.isNaN(Number(m))) return null; const v = Math.max(0, Math.round(m)); return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`; };
const et = (ms) => (ms == null || Number.isNaN(ms) ? null : fmtLocalShort(ms, ''));
const DUTY = { driving: 'Driving', onDuty: 'On duty', offDuty: 'Off duty', sleeperBerth: 'Sleeper berth', sleeperBed: 'Sleeper berth', yardMove: 'Yard move', personalConveyance: 'Personal conveyance' };
const APPT = { committed: 'committed to the customer', handwritten: 'handwritten on the trip sheet', printed: 'trip sheet', sheet: 'trip sheet', ratecon: 'rate con', 'truckmate-appt': 'TruckMate appointment', 'truckmate-due': 'TruckMate due time' };
const digits = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const phoneText = (p) => { const d = digits(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };

const SHEET_MAX_BYTES = 3 * 1024 * 1024;   // same limit as the billing emails — a big scan must never block the alert
// The stored pages of this load's trip sheet (only sheet pages, never the rest of a packet). Newest version wins. Pure.
export function tripSheetIds(item) {
  const sh = (item && item._manifest) || null;
  if (sh && Array.isArray(sh.docIds) && sh.docIds.length) return [...new Set(sh.docIds.map(String))];
  const pk = ((item && item._packet) || []).filter((p) => /^manifest/.test(p.type || '') && p.docId).sort((a, b) => (a.file - b.file) || (a.page - b.page)).map((p) => p.docId);
  if (pk.length) return [...new Set(pk.map(String))];
  const stored = ((item && item._docs) || []).filter((d) => d && d.kind === 'tripsheet' && !d.restricted);
  const newest = stored.reduce((n, d) => Math.max(n, d.version || 1), 1);
  return stored.filter((d) => (d.version || 1) === newest).sort((a, b) => (a.page || 0) - (b.page || 0)).map((d) => String(d.id));
}
// Stored pages → attachments: every page that can be read, in order, up to the size the mail system takes. The note says exactly what is attached. Pure.
export function tripSheetFiles(files, ids, trip) {
  if (!ids.length) return { status: 'none', note: 'No trip sheet on file', attachments: [] };
  const look = 'Open it on the load in the console.';
  if (!files.length) return { status: 'unavailable', note: `Trip sheet could not be attached. ${look}`, attachments: [] };
  const ext = (t) => (/pdf/i.test(t) ? 'pdf' : /png/i.test(t) ? 'png' : 'jpg');
  const fit = []; let room = SHEET_MAX_BYTES;
  for (const f of files) { if (f.data.length <= room) { fit.push(f); room -= f.data.length; } }
  if (!fit.length) return { status: 'too_large', note: `Trip sheet too large to attach. ${look}`, attachments: [] };
  const all = fit.length === ids.length;
  return { status: 'attached', note: all ? 'Trip sheet attached' : `Trip sheet attached: ${fit.length} of ${ids.length} pages. Open the rest on the load in the console.`, attachments: fit.map((f) => ({ name: `Trip sheet ${trip}${ids.length > 1 ? ` page ${ids.indexOf(String(f.id)) + 1 || fit.indexOf(f) + 1}` : ''}.${ext(f.mediaType)}`, contentType: f.mediaType, bytes: f.data })) };
}

// Everything the email shows, from the alert, the load and the ETA board. Nothing is filled in that isn't there. Pure.
export function teamStopFacts(a, item, { etas = null, now = Date.now(), showPhones = true, mapCid = null, sheet = null, reportUrl = null } = {}) {
  const t = (item && item.trip) || {};
  const l = (item && item._samsara) || {};
  const driver = (name, code, h, info) => {
    if (!name && !code) return null;
    const phone = showPhones && info && info.phone ? info.phone : null;
    const hosMs = h && h.at ? Date.parse(h.at) : null;
    return { hosStale: hosMs != null && (now - hosMs) / 60000 > GPS_STALE_MIN, name: name || `Driver ${code}`, duty: h ? DUTY[h.status] || h.status || null : null, atWheel: !!(h && (h.status === 'driving') && Number(l.speedMph) > 3), driveLeft: h ? fmtMin(h.driveLeftMin) : null, shiftLeft: h ? fmtMin(h.shiftLeftMin) : null, cycleLeft: h ? fmtMin(h.cycleLeftMin) : null, phone, hosAt: h && h.at ? et(Date.parse(h.at)) : null };
  };
  const leg = etas && Array.isArray(etas.stops) ? etas.stops[0] : null;
  const gpsMs = l.gpsAt ? Date.parse(l.gpsAt) : null;
  const lateMin = leg && leg.etaMs && leg.apptMs ? Math.round((leg.etaMs - leg.apptMs) / 60000) : null;
  const stopMin = a.stoppedSinceMs ? (now - a.stoppedSinceMs) / 60000 : null;
  return {
    unit: a.unit || t.powerUnit || null, trip: a.trip || t.tripNumber || null, trailer: t.trailer || null, severity: a.severity, title: a.title,
    duration: fmtMin(stopMin), durationFloor: !!a.stopStartUnknown, stoppedSince: a.stopStartUnknown ? null : et(a.stoppedSinceMs), alertAt: et(now),
    location: l.location || null, lat: l.lat ?? null, lng: l.lng ?? null, mapCid: l.lat != null ? mapCid : null,
    gpsSource: l.source === 'driver app' ? 'Driver phone' : String(l.source || '').includes('traccar') ? 'FMC00A' : l.source ? 'Samsara' : null,
    gpsAt: et(gpsMs), gpsStale: gpsMs == null || (now - gpsMs) / 60000 > GPS_STALE_MIN,
    drivers: [driver(l.driver1, t.driver, l.hos, l.driver1Info), driver(l.driver2, t.driver2, l.hos2, l.driver2Info)].filter(Boolean),
    codes: (l.dtcCodes || []).map((c) => [c.code, c.meaning].filter(Boolean).join(' — ')).filter(Boolean),
    next: leg ? [((item && (item.freightBills || item.orders)) || []).filter((b) => b && b.endZoneDescription === leg.label).map((b) => b.billToName).find(Boolean), leg.label].filter(Boolean).join(' — ') : null, appt: leg && leg.apptMs ? fmtLocalShort(leg.apptMs, leg.label) : null, apptFrom: leg ? APPT[leg.apptFrom] || null : null,
    eta: leg && leg.etaMs ? fmtLocalShort(leg.etaMs, leg.label) : null, miles: leg && leg.miles != null ? Math.round(leg.miles) : null,
    risk: lateMin == null ? null : lateMin > 0 ? `About ${fmtMin(lateMin)} past the appointment (estimated)` : 'None projected (estimated)',
    owner: a.ack && a.ack.by ? a.ack.by : 'Unassigned', reportUrl, sheetNote: (sheet && sheet.note) || 'No trip sheet on file', sheetAttached: !!(sheet && sheet.status === 'attached'),
  };
}

const heading = (s) => `<tr><td class="ts-pad" style="padding:22px 24px 8px;font-family:${FONT};font-size:17px;font-weight:bold;color:${NAVY};">${esc(s)}</td></tr>`;
const button = (href, label) => `<a href="${esc(href)}" style="display:inline-block;margin:6px 8px 0 0;padding:11px 16px;border:1px solid #0B5CC8;border-radius:6px;font-family:${FONT};font-size:15px;font-weight:bold;color:#0B5CC8;text-decoration:none;">${esc(label)}</a>`;
const kv = (k, v) => `<tr><td width="42%" style="padding:8px 8px 8px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};vertical-align:top;">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:15px;color:${TEXT};vertical-align:top;word-break:break-word;">${esc(v || NA)}</td></tr>`;

function driverCard(d, i, many) {
  const call = d.phone ? `<a href="tel:+1${digits(d.phone)}" style="color:#0B5CC8;font-weight:bold;">${esc(phoneText(d.phone))}</a>` : 'Phone not available';
  const line = (k, v) => `<div style="padding:2px 0;">${esc(k)}: <b style="color:${TEXT};">${esc(v || 'Not reported')}</b></div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:1px solid ${LINE};border-radius:8px;"><tr><td style="padding:12px 14px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};">
<div style="font-size:12px;">${many ? `Driver ${i + 1}` : 'Driver'}${d.atWheel ? ' · <b style="color:#15803D;">At the wheel</b>' : ''}</div>
<div style="font-size:17px;font-weight:bold;color:${NAVY};word-break:break-word;">${esc(d.name)}</div>
${line('Duty status', d.duty)}${line('Drive left', d.driveLeft)}${line('Shift left', d.shiftLeft)}${line('Cycle left', d.cycleLeft)}
<div style="padding:6px 0 2px;font-size:15px;">${call}</div>
<div style="font-size:12px;">Samsara ELD · ${d.hosAt ? `updated ${esc(d.hosAt)}` : 'update time not reported'}${d.hosStale ? ' · <b style="color:#92400E;">may be out of date</b>' : ''}</div>
</td></tr></table>`;
}

export function renderTeamStopEmail(f) {
  const subject = `Team truck ${f.unit || 'not recorded'} stopped: ${String(f.title || '').replace(/^Team truck stopped\s*/, '')}${f.trip ? ` — trip ${f.trip}` : ''}`;
  const many = f.drivers.length > 1;
  const durationText = f.duration ? `${f.durationFloor ? 'At least ' : ''}${f.duration}` : NA;
  const since = f.stoppedSince || 'Not confirmed — already parked when tracking started';
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const gpsLine = f.gpsSource || f.gpsAt ? `${f.gpsSource || 'GPS'} · ${f.gpsAt ? `updated ${f.gpsAt}` : 'update time not reported'}` : 'GPS not reported';
  const action = 'Contact the drivers to confirm the stop reason and expected departure. Review reported faults and record the outcome.';
  const health = f.codes.length ? `${f.codes.length} reported engine code${f.codes.length === 1 ? '' : 's'}` : 'No engine codes reported';
  const clock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;border:3px solid ${RED};border-radius:24px;font-family:${FONT};font-size:26px;line-height:26px;font-weight:bold;color:${RED};">&#9719;</td></tr></table>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media (max-width:480px){.ts-pad{padding-left:16px!important;padding-right:16px!important}.ts-big{font-size:34px!important}}</style></head>
<body style="margin:0;padding:0;background:#F1F5F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td class="ts-pad" style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">Florida Beauty</td></tr>
<tr><td class="ts-pad" style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td class="ts-pad" style="padding:18px 24px 0;font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:.5px;color:${MUTED};">EXTENDED STOP · TEAM TRUCK</td></tr>
<tr><td class="ts-pad" style="padding:2px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || 'not recorded')}</td></tr>
<tr><td class="ts-pad" style="padding:0 24px;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(f.trip || 'not recorded')}${f.trailer ? ` · Trailer ${esc(f.trailer)}` : ''}</td></tr>
${f.sheetAttached
    ? `<tr><td class="ts-pad" style="padding:12px 24px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NAVY}" style="background:${NAVY};border-radius:8px;"><tr><td style="padding:12px 16px;font-family:${FONT};font-size:17px;font-weight:bold;color:#FFFFFF;">&#128206; ${esc(f.sheetNote)}</td></tr></table></td></tr>`
    : `<tr><td class="ts-pad" style="padding:4px 24px 14px;font-family:${FONT};font-size:14px;color:${MUTED};">${esc(f.sheetNote)}</td></tr>`}
<tr><td class="ts-pad" style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFF1F2" style="background:#FFF1F2;border-radius:8px;"><tr>
<td width="56" valign="top" style="padding:16px 0 16px 16px;">${clock}</td>
<td style="padding:14px 16px;font-family:${FONT};color:${TEXT};"><div class="ts-big" style="font-size:40px;line-height:1.1;font-weight:bold;color:${RED};">${esc(durationText)}</div>
<div style="font-size:13px;font-weight:bold;letter-spacing:.4px;color:${RED};">STOPPED AT ALERT TIME</div>
<div style="padding-top:8px;font-size:14px;line-height:1.5;">Stopped since: <b>${esc(since)}</b><br>Alert generated: <b>${esc(f.alertAt || NA)}</b></div>
<div style="padding-top:4px;font-size:13px;color:${MUTED};">Snapshot at email generation—not a live timer.</div></td></tr></table></td></tr>
${heading('Last reported location')}
${f.mapCid ? `<tr><td class="ts-pad" style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck's last reported location near ${esc(f.location || 'the reported position')}" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td class="ts-pad" style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b><div style="font-size:13px;color:${MUTED};">${esc(gpsLine)}</div>${f.gpsStale ? `<div style="padding-top:4px;font-size:14px;font-weight:bold;color:#92400E;">This GPS location may be out of date.</div>` : ''}<div>${mapUrl ? button(mapUrl, 'Open map') : ''}${button(LIVE_URL, 'View live trip')}</div></td></tr>
${heading(many ? 'Driver team' : 'Driver')}
<tr><td class="ts-pad" style="padding:0 24px;">${f.drivers.length ? f.drivers.map((d, i) => driverCard(d, i, many)).join('') : `<div style="font-family:${FONT};font-size:15px;color:${TEXT};">No driver reported.</div>`}</td></tr>
<tr><td class="ts-pad" style="padding:12px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${NAVY};">Action requested</b><br>${esc(action)}<div style="padding-top:6px;font-size:14px;color:${MUTED};">Owner: ${esc(f.owner)}</div>${f.reportUrl ? `<div style="padding-top:10px;font-size:14px;color:${TEXT};">Is it broken down?</div><a href="${esc(f.reportUrl)}" style="display:block;margin-top:6px;padding:16px 18px;border-radius:6px;background:${RED};font-family:${FONT};font-size:20px;font-weight:bold;text-align:center;color:#FFFFFF;text-decoration:none;">Report breakdown</a>` : ''}</td></tr></table></td></tr>
${heading('Truck health')}
<tr><td class="ts-pad" style="padding:0 24px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${f.codes.length ? '#FFF7E7' : '#F5F7FA'}" style="background:${f.codes.length ? '#FFF7E7' : '#F5F7FA'};border-radius:8px;"><tr><td style="padding:12px 14px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${f.codes.length ? '#92400E' : NAVY};">${esc(health)}</b>${f.codes.slice(0, 4).map((c) => `<div style="font-size:13px;word-break:break-word;">${esc(c)}</div>`).join('')}<div style="padding-top:4px;font-size:14px;">Stop reason has not been confirmed.</div></td></tr></table></td></tr>
${heading('Delivery impact')}
<tr><td class="ts-pad" style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${kv('Next stop', f.next)}${kv('Appointment', f.appt ? `${f.appt}${f.apptFrom ? ` (${f.apptFrom})` : ''}` : null)}${kv('Estimated arrival', f.eta)}${kv('Distance remaining', f.miles != null ? `${f.miles.toLocaleString('en-US')} mi` : null)}${kv('Projected delay', f.risk)}</table></td></tr>
<tr><td class="ts-pad" style="padding:20px 24px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};"><b style="color:${NAVY};">Jarvis · AI Dispatcher</b><br>Florida Beauty<br>Stop time from Jarvis's truck tracking · hours from Samsara ELD · ETA is an estimate.</td></tr>
</table></td></tr></table></body></html>`;
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'EXTENDED STOP · TEAM TRUCK', `Truck ${f.unit || 'not recorded'}`, `Trip ${f.trip || 'not recorded'}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, f.sheetNote, '',
    `${durationText} STOPPED AT ALERT TIME`, `Stopped since: ${since}`, `Alert generated: ${f.alertAt || NA}`, 'Snapshot at email generation—not a live timer.', '',
    'LAST REPORTED LOCATION', f.location || 'Location not reported', gpsLine, ...(f.gpsStale ? ['This GPS location may be out of date.'] : []), ...(mapUrl ? [`Open map: ${mapUrl}`] : []), `View live trip: ${LIVE_URL}`, '',
    many ? 'DRIVER TEAM' : 'DRIVER', ...(f.drivers.length ? f.drivers.flatMap((d, i) => [`${many ? `Driver ${i + 1}: ` : ''}${d.name}${d.atWheel ? ' (at the wheel)' : ''}`, `  Duty status: ${d.duty || 'Not reported'}`, `  Drive left: ${d.driveLeft || 'Not reported'}  Shift left: ${d.shiftLeft || 'Not reported'}  Cycle left: ${d.cycleLeft || 'Not reported'}`, `  ${d.phone ? phoneText(d.phone) : 'Phone not available'}`]) : ['No driver reported.']), '',
    'ACTION REQUESTED', action, `Owner: ${f.owner}`, ...(f.reportUrl ? [`Report breakdown: ${f.reportUrl}`] : []), '', 'TRUCK HEALTH', health, ...f.codes.slice(0, 4), 'Stop reason has not been confirmed.', '',
    'DELIVERY IMPACT', `Next stop: ${f.next || NA}`, `Appointment: ${f.appt ? `${f.appt}${f.apptFrom ? ` (${f.apptFrom})` : ''}` : NA}`, `Estimated arrival: ${f.eta || NA}`, `Distance remaining: ${f.miles != null ? `${f.miles} mi` : NA}`, `Projected delay: ${f.risk || NA}`, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n');
  return { subject, html, text };
}

// The email when that truck is really moving again: same stop, same people. Numbers come from the confirmed movement. Pure.
export function renderRollingEmail(ep, item, { etas = null, now = Date.now(), showPhones = true, mapCid = null } = {}) {
  const f = teamStopFacts({ unit: ep.unit, trip: ep.trip }, item, { etas, now, showPhones, mapCid });
  const GREEN = '#166534';
  const rolling = fmtMin((now - ep.movingSince) / 60000) || NA;
  const stopped = ep.stoppedSinceMs ? fmtMin((ep.movingSince - ep.stoppedSinceMs) / 60000) : null;
  const prev = stopped ? `${ep.stopStartUnknown ? 'at least ' : ''}${stopped}` : NA;
  const movedAt = et(ep.movingSince) || NA;
  const speed = ep.speedMph != null ? `${Math.round(ep.speedMph)} mph` : NA;
  const subject = `Truck ${f.unit || 'not recorded'} rolling again — Trip ${f.trip || 'not recorded'}`;
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const gpsLine = f.gpsSource || f.gpsAt ? `${f.gpsSource || 'GPS'} · ${f.gpsAt ? `updated ${f.gpsAt}` : 'update time not reported'}` : 'GPS not reported';
  const many = f.drivers.length > 1;
  const confirm = `Truck movement was confirmed at ${et(ep.confirmedAt) || movedAt}. Previous stop duration: ${prev}.`;
  const caveat = 'Movement does not confirm that engine faults or delivery delays are resolved.';
  const appt = f.appt ? `${f.appt}${f.apptFrom ? ` (${f.apptFrom})` : ''}` : null;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media (max-width:480px){.ts-pad{padding-left:16px!important;padding-right:16px!important}.ts-big{font-size:34px!important}}</style></head>
<body style="margin:0;padding:0;background:#F1F5F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td class="ts-pad" style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">Florida Beauty</td></tr>
<tr><td class="ts-pad" style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td class="ts-pad" style="padding:18px 24px 0;font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:.5px;color:${MUTED};">MOVEMENT RESUMED</td></tr>
<tr><td class="ts-pad" style="padding:2px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || 'not recorded')}</td></tr>
<tr><td class="ts-pad" style="padding:0 24px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(f.trip || 'not recorded')}${f.trailer ? ` · Trailer ${esc(f.trailer)}` : ''}</td></tr>
<tr><td class="ts-pad" style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F0FDF4" style="background:#F0FDF4;border-radius:8px;"><tr>
<td width="56" valign="top" style="padding:16px 0 16px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;border:3px solid ${GREEN};border-radius:24px;font-family:${FONT};font-size:26px;line-height:26px;font-weight:bold;color:${GREEN};">&#9719;</td></tr></table></td>
<td style="padding:14px 16px;font-family:${FONT};color:${TEXT};"><div class="ts-big" style="font-size:40px;line-height:1.1;font-weight:bold;color:${GREEN};">${esc(rolling)}</div>
<div style="font-size:13px;font-weight:bold;letter-spacing:.4px;color:${GREEN};">ROLLING</div>
<div style="padding-top:8px;font-size:14px;line-height:1.5;">Latest reported speed: <b>${esc(speed)}</b><br>Moving since: <b>${esc(movedAt)}</b><br>Updated: <b>${esc(f.gpsAt || NA)}</b></div>
<div style="padding-top:4px;font-size:13px;color:${MUTED};">Snapshot at email generation—not a live timer.</div></td></tr></table></td></tr>
<tr><td class="ts-pad" style="padding:10px 24px 0;font-family:${FONT};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9" style="background:#F1F5F9;border-radius:6px;"><tr><td style="padding:9px 14px;font-size:15px;color:${TEXT};">Previous stop: <b>${esc(prev)}</b></td></tr></table></td></tr>
${heading('Updated location')}
${f.mapCid ? `<tr><td class="ts-pad" style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck's latest reported location near ${esc(f.location || 'the reported position')}" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td class="ts-pad" style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b><div style="font-size:13px;color:${MUTED};">${esc(gpsLine)}</div><div>${mapUrl ? button(mapUrl, 'Open map') : ''}${button(LIVE_URL, 'View live trip')}</div></td></tr>
${heading('Updated driver status')}
<tr><td class="ts-pad" style="padding:0 24px;">${f.drivers.length ? f.drivers.map((d, i) => driverCard(d, i, many)).join('') : `<div style="font-family:${FONT};font-size:15px;color:${TEXT};">No driver reported.</div>`}</td></tr>
<tr><td class="ts-pad" style="padding:12px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F0FDF4" style="background:#F0FDF4;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${GREEN};">Movement resumed</b><br>${esc(confirm)}</td></tr></table></td></tr>
${heading('Delivery update')}
<tr><td class="ts-pad" style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${kv('Next stop', f.next)}${kv('Appointment', appt)}${kv('Updated ETA (estimated)', f.eta)}${kv('Distance remaining', f.miles != null ? `${f.miles.toLocaleString('en-US')} mi` : null)}${kv('Projected delay', f.risk)}</table></td></tr>
<tr><td class="ts-pad" style="padding:8px 24px 0;font-family:${FONT};font-size:13px;color:${MUTED};">${esc(caveat)}</td></tr>
<tr><td class="ts-pad" style="padding:18px 24px 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};"><b style="color:${NAVY};">Jarvis · AI Dispatcher</b><br>Florida Beauty</td></tr>
</table></td></tr></table></body></html>`;
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'MOVEMENT RESUMED', `Truck ${f.unit || 'not recorded'}`, `Trip ${f.trip || 'not recorded'}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, '',
    `${rolling} ROLLING`, `Latest reported speed: ${speed}`, `Moving since: ${movedAt}`, `Updated: ${f.gpsAt || NA}`, 'Snapshot at email generation—not a live timer.', `Previous stop: ${prev}`, '',
    'UPDATED LOCATION', f.location || 'Location not reported', gpsLine, ...(mapUrl ? [`Open map: ${mapUrl}`] : []), `View live trip: ${LIVE_URL}`, '',
    'UPDATED DRIVER STATUS', ...(f.drivers.length ? f.drivers.flatMap((d, i) => [`${many ? `Driver ${i + 1}: ` : ''}${d.name}${d.atWheel ? ' (at the wheel)' : ''}`, `  Duty status: ${d.duty || 'Not reported'}`, `  Drive left: ${d.driveLeft || 'Not reported'}  Shift left: ${d.shiftLeft || 'Not reported'}  Cycle left: ${d.cycleLeft || 'Not reported'}`, `  ${d.phone ? phoneText(d.phone) : 'Phone not available'}`]) : ['No driver reported.']), '',
    'MOVEMENT RESUMED', confirm, '', 'DELIVERY UPDATE', `Next stop: ${f.next || NA}`, `Appointment: ${appt || NA}`, `Updated ETA (estimated): ${f.eta || NA}`, `Distance remaining: ${f.miles != null ? `${f.miles} mi` : NA}`, `Projected delay: ${f.risk || NA}`, caveat, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n');
  return { subject, html, text };
}

// shared with the breakdown email
export const emailParts = { heading, button, kv, driverCard, FONT, NAVY, TEXT, MUTED, LINE, RED, et, TRAINING_SLOT };

// The two good-news emails: "Transfer completed" (a physical handoff someone confirmed) and "Breakdown fixed & rolling"
// (a reported repair plus confirmed movement). Layout + wording only: nothing is shown that isn't on record. Pure.
import { teamStopFacts, emailParts } from './teamstopmail.js';

const { liveUrl, heading, button, kv, driverCard, FONT, NAVY, TEXT, MUTED, LINE, et, TRAINING_SLOT } = emailParts;
const GREEN = '#166534'; const TONES = { blue: '#1D4ED8', amber: '#B45309', red: '#C62828' }; const NR = 'Not recorded'; const NA = 'Not available'; const NC = 'Not confirmed'; const NP = 'Not provided';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMin = (m) => { if (m == null || Number.isNaN(Number(m))) return null; const v = Math.max(0, Math.round(m)); return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`; };
const uniq = (a) => [...new Set(a.filter(Boolean))];
const billsOf = (item) => (item && (item.freightBills || item.orders)) || (item && item.trip && item.trip.freightBills) || [];
const unitKey = (x) => String(x || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();
const pad = 'class="ts-pad"';
const cap = (s) => (s ? `${String(s).charAt(0).toUpperCase()}${String(s).slice(1)}` : null);

// What the load looks like right now, kept so the handoff can show before → after. Pure.
export function snapshotLoad(item, etas = null, now = Date.now()) {
  const t = (item && item.trip) || {}; const bills = billsOf(item); const leg = etas && Array.isArray(etas.stops) ? etas.stops[0] : null;
  const known = bills.filter((b) => b.pieces != null && b.pieces !== '');
  return { at: now, unit: t.powerUnit || null, trip: t.tripNumber != null ? String(t.tripNumber) : null, trailer: t.trailer || null, bills: uniq(bills.map((b) => b.billNumber)).map(String), customers: uniq(bills.map((b) => b.billToName)).map((c) => String(c).replace(/\s*\*$/, '').trim()), pieces: known.length && known.length === bills.length ? known.reduce((n, b) => n + Number(b.pieces || 0), 0) : null, broker: (item && item._ratecon && item._ratecon.broker) || null, commodity: (item && item._manifest && item._manifest.commodity) || null, etaMs: (leg && leg.etaMs) || null, nextStop: (leg && leg.label) || null, apptMs: (leg && leg.apptMs) || null };
}
// Who is on a truck right now, kept because the board stops showing them once the load moves. Pure.
export function crewOf(item, now = Date.now()) {
  const t = (item && item.trip) || {}; const l = (item && item._samsara) || {};
  return { at: now, trip: { powerUnit: t.powerUnit || null, tripNumber: t.tripNumber || null, driver: t.driver || null, driver2: t.driver2 || null }, live: { driver1: l.driver1 || null, driver2: l.driver2 || null, hos: l.hos || null, hos2: l.hos2 || null, driver1Info: l.driver1Info || null, driver2Info: l.driver2Info || null } };
}
const driversIn = (c, now, showPhones) => (c ? teamStopFacts({ unit: c.trip.powerUnit, trip: c.trip.tripNumber }, { trip: c.trip, _samsara: c.live }, { now, showPhones }).drivers : []);
const crewKind = (n) => (n > 1 ? 'Team' : n === 1 ? 'Solo' : NA);

// The email-safe page around both emails. Dark colors for the mail apps that honor them; the light card stays readable in the rest.
function shell(banner, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media (max-width:480px){.ts-pad{padding-left:16px!important;padding-right:16px!important}.ts-big{font-size:34px!important}.tc-col{max-width:100%!important;display:block!important;width:100%!important}}
@media (prefers-color-scheme:dark){.fb-card .fb-tone,.fb-card .fb-tone td,.fb-card .fb-tone div{color:#FFFFFF!important}.fb-card .fb-tone-blue,.fb-card .fb-tone-blue td,.fb-card .fb-tone-blue div{background:${TONES.blue}!important}.fb-card .fb-tone-amber,.fb-card .fb-tone-amber td,.fb-card .fb-tone-amber div{background:${TONES.amber}!important}.fb-card .fb-tone-red,.fb-card .fb-tone-red td,.fb-card .fb-tone-red div{background:${TONES.red}!important}.fb-page{background:#0B1220!important}.fb-card,.fb-card td,.fb-card table{background:#14202F!important;color:#E5E7EB!important;border-color:#334155!important}.fb-card div,.fb-card b{color:#E5E7EB!important}.fb-card a{color:#8AB8FF!important}.fb-card .fb-green,.fb-card .fb-green td,.fb-card .fb-green div,.fb-card .fb-green b{background:${GREEN}!important;color:#FFFFFF!important}.fb-card .fb-blue2,.fb-card .fb-blue2 td,.fb-card .fb-blue2 div,.fb-card .fb-blue2 b{background:#1E293B!important;color:#E5E7EB!important}.fb-card .fb-soft-amber,.fb-card .fb-soft-amber td,.fb-card .fb-soft-amber div,.fb-card .fb-soft-amber b{background:#3A2A10!important;color:#FDE68A!important}.fb-card .fb-soft,.fb-card .fb-soft td,.fb-card .fb-soft div,.fb-card .fb-soft b{background:#123524!important;color:#D1FAE5!important}}</style></head>
<body class="fb-page" style="margin:0;padding:0;background:#F1F5F9;"><table class="fb-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;">
<table class="fb-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td ${pad} style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">Florida Beauty</td></tr>
<tr><td ${pad} style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td ${pad} style="padding:16px 24px 0;"><table class="${banner.tone ? `fb-tone fb-tone-${banner.tone}` : 'fb-green'}" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${banner.tone ? TONES[banner.tone] : GREEN}" style="background:${banner.tone ? TONES[banner.tone] : GREEN};border-radius:8px;"><tr><td width="52" align="center" valign="middle" style="padding:14px 0 14px 14px;font-family:${FONT};font-size:34px;line-height:34px;font-weight:bold;color:#FFFFFF;">${banner.mark || '&#10003;'}</td><td style="padding:14px 16px;font-family:${FONT};color:#FFFFFF;"><div style="font-size:22px;line-height:1.2;font-weight:bold;color:#FFFFFF;">${esc(banner.title)}</div><div style="padding-top:3px;font-size:15px;color:#FFFFFF;">${esc(banner.sub)}</div></td></tr></table></td></tr>
${body}
<tr><td ${pad} style="padding:20px 24px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};"><b style="color:${NAVY};">Jarvis · AI Dispatcher</b><br>Florida Beauty</td></tr>
</table></td></tr></table></body></html>`;
}
const table = (rows) => `<tr><td ${pad} style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
const drivers = (list, many) => (list.length ? list.map((d, i) => driverCard(d, i, many)).join('') : `<div style="padding:0 0 10px;font-family:${FONT};font-size:15px;color:${TEXT};">Crew ${NA.toLowerCase()}.</div>`);
const driverText = (list, many) => (list.length ? list.flatMap((d, i) => [`${many ? `Driver ${i + 1}: ` : ''}${d.name}`, `  Duty status: ${d.duty || 'Not reported'}`, `  Drive left: ${d.driveLeft || 'Not reported'}  Shift left: ${d.shiftLeft || 'Not reported'}  Cycle left: ${d.cycleLeft || 'Not reported'}`, `  ${d.phone || 'Phone not available'}`, `  Samsara ELD · ${d.hosAt ? `updated ${d.hosAt}` : 'update time not reported'}`]) : [`Crew ${NA.toLowerCase()}.`]);

const trucksLine = (a, b) => `<tr><td ${pad} style="padding:14px 24px 0;font-family:${FONT};font-size:28px;line-height:1.2;font-weight:bold;color:${NAVY};">Truck ${esc(a)}${b ? ` → Truck ${esc(b)}` : ''}</td></tr>`;
const tripLine = (trip, trailer) => `<tr><td ${pad} style="padding:2px 24px 0;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(trip)}${trailer ? ` · Trailer ${esc(trailer)}` : ''}</td></tr>`;
const message = (head, lines) => `<tr><td ${pad} style="padding:14px 24px 0;"><table class="fb-blue2" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F7FA" style="background:#F5F7FA;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};">${head ? `<b style="color:${NAVY};">${esc(head)}</b>` : ''}${lines.filter(Boolean).map((l) => `<div style="word-break:break-word;">${esc(l)}</div>`).join('')}</td></tr></table></td></tr>`;
const viewTrip = (trip) => `<tr><td ${pad} style="padding:12px 24px 0;">${button(liveUrl(trip), 'View trip')}</td></tr>`;
const mailEnd = (trip) => ['', `View trip: ${liveUrl(trip)}`, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'];
const col = (html) => `<div class="tc-col" style="display:inline-block;width:100%;max-width:290px;vertical-align:top;">${html}</div>`;

// One truck in a transfer: where it is, only as far as GPS says. Pure.
function positionFacts(unit, p, rolling, now) {
  const has = p && p.lat != null && p.lng != null;
  const gpsMs = p && p.at ? Date.parse(p.at) : null;
  return { unit, location: (p && p.location) || 'Not reported', status: rolling == null ? 'Not reported' : `${rolling ? 'Rolling' : 'Stopped'}${p && p.speedMph != null ? ` · ${p.speedMph} mph` : ''}`, gps: gpsMs ? et(gpsMs) : 'Not reported', stale: gpsMs == null ? false : (now - gpsMs) / 60000 > 30, map: has ? `https://www.google.com/maps?q=${encodeURIComponent(`${p.lat},${p.lng}`)}` : null };
}
const positionCard = (label, f) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:1px solid ${LINE};border-radius:8px;"><tr><td style="padding:12px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};"><div style="font-size:12px;font-weight:bold;letter-spacing:.4px;">${esc(label)}</div><div style="font-size:24px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit)}</div><div style="font-size:15px;font-weight:bold;color:${TEXT};word-break:break-word;">${esc(f.location)}</div><div>Status: <b style="color:${TEXT};">${esc(f.status)}</b></div><div>GPS: <b style="color:${TEXT};">${esc(f.gps)}</b></div>${f.stale ? '<div style="font-weight:bold;color:#92400E;">This GPS may be out of date.</div>' : ''}${f.map ? `<div style="padding-top:4px;"><a href="${esc(f.map)}" style="font-weight:bold;color:#0B5CC8;">Open map</a></div>` : ''}</td></tr></table>`;

const TRANSFER = {
  start: { tone: 'blue', mark: '&#8644;', title: 'TRANSFER PLANNED', sub: () => 'Nothing has happened yet.', head: 'What happens next', lines: () => ['Jarvis will follow both trucks and report when they are together.'] },
  update: { tone: 'blue', mark: '&#8644;', title: 'TRANSFER UPDATE', sub: (s) => (s.distanceMi != null ? `Trucks ${s.distanceMi} mi apart` : 'Not both trucks on GPS'), head: null, lines: () => ['Jarvis reports every 2 hours while the trucks are apart.'] },
  together: { tone: 'blue', mark: '&#8644;', title: 'TRUCKS TOGETHER', sub: () => 'Transfer not confirmed yet.', head: 'What happens next', lines: (s, x) => [`If they are still together in ${x.askAfter} minutes, Jarvis will text the driver to confirm the transfer, and call if nobody answers.`] },
  no: { tone: 'amber', mark: '&#9888;&#65038;', title: 'TRANSFER NOT DONE YET', sub: () => 'A driver answered no.', head: 'Driver answer', lines: (s, x) => [x.answer, x.source ? `Source: ${x.source}` : null, 'Jarvis keeps following and will ask again.'] },
  unclear: { tone: 'amber', mark: '&#9888;&#65038;', title: 'TRANSFER NOT CONFIRMED', sub: () => 'The answer was not a clear yes.', head: 'Driver answer', lines: (s, x) => [x.answer, x.source ? `Source: ${x.source}` : null, 'This does not count as a confirmation. Jarvis keeps following and will ask again.'] },
  done: { tone: 'blue', mark: '&#10003;', title: 'TRANSFER DONE', sub: () => 'Driver answered.', head: 'Driver answer', lines: (s, x) => [x.answer, x.source ? `Source: ${x.source}` : null] },
};

// The transfer emails before the handoff is confirmed. a / b: truck positions, left out when there are none. Pure.
export function renderTransferStatus(kind, plan, a, b, s = {}, { outcome = null, now = Date.now(), askAfter = 15, subject = '', spot = undefined, mapCid = null } = {}) {
  const k = TRANSFER[kind];
  const x = { askAfter, answer: (outcome && outcome.summary) || null, source: (outcome && outcome.source) || null };
  const fa = positionFacts(plan.from, a, s.aRolling ?? null, now); const fb = positionFacts(plan.to, b, s.bRolling ?? null, now);
  const distance = s.distanceMi != null ? `${s.distanceMi} mi${s.together ? ' · together' : ''}` : 'Unknown. One truck has no GPS.';
  const asOf = et(now);
  const lines = k.lines(s, x).filter(Boolean);
  const away = (mi) => (mi == null ? NA : mi < 0.5 ? 'At the transfer location' : `About ${Math.round(mi)} road mi (estimated)`);
  const spotRows = spot === undefined ? [] : [['Transfer location', spot ? spot.label : 'Not on file'], ...(spot ? [[`Truck ${plan.from} to transfer location`, away(spot.aMi)], [`Truck ${plan.to} to transfer location`, away(spot.bMi)]] : [])];
  const body = `${trucksLine(plan.from, plan.to)}${tripLine(plan.trip, plan.trailer)}
<tr><td ${pad} style="padding:16px 24px 0;font-size:0;" align="center"><!--[if mso]><table role="presentation" width="592" cellpadding="0" cellspacing="0" border="0"><tr><td width="296" valign="top"><![endif]-->${col(positionCard('LEAVING TRUCK', fa))}<!--[if mso]></td><td width="296" valign="top"><![endif]-->${col(positionCard('TRANSFER TRUCK', fb))}<!--[if mso]></td></tr></table><![endif]--></td></tr>
${table(`${kv('Distance between trucks', distance)}${kv('As of', asOf)}`)}
${mapCid ? `<tr><td ${pad} style="padding:12px 24px 0;"><img src="cid:${esc(mapCid)}" width="592" alt="Map of both trucks and the transfer location" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></td></tr>` : ''}
${spotRows.length ? `<tr><td style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>${table(spotRows.map(([key, v]) => kv(key, v)).join(''))}` : ''}
${message(k.head, lines)}
${viewTrip(plan.trip)}`;
  const truckText = (label, f) => [`${label}: Truck ${f.unit}`, `  ${f.location}`, `  Status: ${f.status}`, `  GPS: ${f.gps}${f.stale ? ' (may be out of date)' : ''}`, ...(f.map ? [`  Open map: ${f.map}`] : [])];
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', k.title, k.sub(s), `Truck ${plan.from} → Truck ${plan.to}`, `Trip ${plan.trip}${plan.trailer ? ` · Trailer ${plan.trailer}` : ''}`, '',
    ...truckText('LEAVING TRUCK', fa), ...truckText('TRANSFER TRUCK', fb), `Distance between trucks: ${distance}`, `As of: ${asOf}`, ...spotRows.map(([key, v]) => `${key}: ${v}`), '', ...(k.head ? [k.head.toUpperCase()] : []), ...lines, ...mailEnd(plan.trip)].join('\n');
  return { subject, html: shell({ tone: k.tone, mark: k.mark, title: k.title, sub: k.sub(s) }, body), text };
}

// "Transfer completed" went out, then the handoff was undone. Pure.
export function renderTransferReversedEmail({ trip, from, to, by, subject }) {
  const notice = 'Disregard the earlier "Transfer completed" email.';
  const body = `${trucksLine(from, to)}${tripLine(trip)}
<tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
${table(kv('Reported by', by || 'Dispatch'))}
${message('What changed', ['This transfer was undone. Check TruckMate and the load before acting on the earlier email.'])}
${viewTrip(trip)}`;
  return { subject, html: shell({ tone: 'red', mark: '&#10005;', title: 'TRANSFER REVERSED', sub: notice }, body), text: ['FLORIDA BEAUTY — Dispatch notifications', '', 'TRANSFER REVERSED', notice, `Truck ${from} → Truck ${to}`, `Trip ${trip}`, `Reported by: ${by || 'Dispatch'}`, 'This transfer was undone. Check TruckMate and the load before acting on the earlier email.', ...mailEnd(trip)].join('\n') };
}

// Everything the "Transfer completed" email shows. rec: the handoff record; item: the load as TruckMate has it now. Pure.
export function handoffFacts(rec, item, { etas = null, now = Date.now(), showPhones = true } = {}) {
  const b = rec.before || {}; const c = rec.confirm || {};
  const t = (item && item.trip) || null;
  const onReceiving = !!t && unitKey(t.powerUnit) === unitKey(rec.to);
  const after = onReceiving ? snapshotLoad(item, etas, now) : null;
  const fromCrew = (rec.crew || {})[unitKey(rec.from)] || null;
  const liveTo = onReceiving ? crewOf(item, now) : null;
  const toCrew = liveTo && (liveTo.live.driver1 || liveTo.trip.driver) ? liveTo : (rec.crew || {})[unitKey(rec.to)] || null;
  const asOf = (crew, live) => (!crew ? NA : live ? `Current at ${et(now)}` : `Snapshot from ${et(crew.at)}. Newer data may exist.`);
  const list = (x) => (x && x.length ? x.join(', ') : null);
  const same = (x, y) => (x != null && y != null ? String(x) === String(y) : false);
  const row = (label, before, afterV) => ({ label, before: before ?? NR, after: !after ? NC : afterV == null ? NR : same(before, afterV) ? 'Unchanged' : afterV });
  const change = b.etaMs && after && after.etaMs ? Math.round((after.etaMs - b.etaMs) / 60000) : null;
  const dep = ((item && item._times && item._times.statusHistory) || []).filter((h) => h && h.at && /^(DEPSHIP|DEPCONS)/i.test(String(h.status || '')) && Date.parse(h.at) >= (c.atMs || now)).sort((x, y) => Date.parse(x.at) - Date.parse(y.at))[0];
  const handling = (item && item._ratecon && item._ratecon.specialInstructions) || [];
  const fromDrivers = driversIn(fromCrew, now, showPhones); const toDrivers = driversIn(toCrew, now, showPhones);
  return {
    from: rec.from, to: rec.to, trip: rec.trip, trailer: (after && after.trailer) || b.trailer || null, doneNote: c.source === 'TruckMate' ? 'Done in TruckMate.' : 'Physical handoff confirmed.',
    confirmedAt: c.atMs ? et(c.atMs) : c.atText || (c.reportedAt ? `Time not stated. Reported ${et(c.reportedAt)}` : NR), confirmedBy: c.by || NR, source: c.source || NR, location: c.location || NR, evidence: c.summary || null,
    fromCrew: { drivers: fromDrivers, kind: crewKind(fromDrivers.length), asOf: asOf(fromCrew, false), trailer: b.trailer || NA, trip: b.trip || rec.trip },
    toCrew: { drivers: toDrivers, kind: crewKind(toDrivers.length), asOf: asOf(toCrew, toCrew === liveTo), trailer: (after && after.trailer) || NC, trip: (after && after.trip) || NC },
    rows: [
      { label: 'Truck', before: rec.from, after: rec.to },
      row('Trailer', b.trailer, after && after.trailer),
      row('Trip', b.trip || rec.trip, after && after.trip),
      row('Bills', list(b.bills), after && list(after.bills)),
      row('Customer', list(b.customers), after && list(after.customers)),
      row('Broker', b.broker, after && after.broker),
      row('Cargo', b.commodity, after && after.commodity),
      row('Boxes', b.pieces, after && after.pieces),
    ],
    type: cap(c.type) || NR, scope: cap(c.scope) || NR, truckMate: onReceiving ? `Shows trip ${t.tripNumber} on truck ${rec.to}` : `Not updated yet. ${t ? `Still shows truck ${t.powerUnit}.` : 'Load not on the board.'}`,
    arrivalFrom: c.arrivalFrom || NR, arrivalTo: c.arrivalTo || NR,
    previousEta: b.etaMs ? et(b.etaMs) : NR, revisedEta: after && after.etaMs ? et(after.etaMs) : NA, nextStop: (after && after.nextStop) || b.nextStop || NA, appt: after && after.apptMs ? et(after.apptMs) : b.apptMs ? et(b.apptMs) : NA,
    change: change == null ? NA : change === 0 ? 'No change (estimated)' : `${fmtMin(Math.abs(change))} ${change > 0 ? 'later' : 'earlier'} (estimated)`,
    departure: dep ? `Departed ${et(Date.parse(dep.at))} (TruckMate)` : 'Departure not confirmed', handling: handling.length ? `${handling.length} instruction${handling.length === 1 ? '' : 's'} on the rate con` : NR,
  };
}

function truckCard(title, unit, c) {
  const many = c.drivers.length > 1;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:1px solid ${LINE};border-radius:8px;"><tr><td style="padding:12px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};">
<div style="font-size:12px;font-weight:bold;letter-spacing:.4px;">${esc(title)}</div><div style="font-size:24px;font-weight:bold;color:${NAVY};">Truck ${esc(unit)}</div>
<div>Trailer: <b style="color:${TEXT};">${esc(c.trailer)}</b></div><div>Trip: <b style="color:${TEXT};">${esc(c.trip)}</b></div><div style="padding-bottom:8px;">Crew: <b style="color:${TEXT};">${esc(c.kind)}</b></div>
${drivers(c.drivers, many)}<div style="font-size:12px;">${esc(c.asOf)}</div></td></tr></table>`;
  return body;
}

// Transfer completed. Only ever rendered for a confirmed physical handoff. Pure.
export function renderTransferCompletedEmail(f) {
  const subject = `Transfer completed — Truck ${f.from} → Truck ${f.to} — Trip ${f.trip}`;
  const route = `Truck ${f.from} → Truck ${f.to}`;
  const body = `<tr><td ${pad} style="padding:14px 24px 0;font-family:${FONT};font-size:28px;line-height:1.2;font-weight:bold;color:${NAVY};">${esc(route)}</td></tr>
<tr><td ${pad} style="padding:2px 24px 0;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(f.trip)}${f.trailer ? ` · Trailer ${esc(f.trailer)}` : ''}</td></tr>
${heading('Handoff confirmed')}
${table(`${kv('Confirmed at', f.confirmedAt)}${kv('Confirmed by', f.confirmedBy)}${kv('Source', f.source)}${kv('Location', f.location)}${f.evidence ? kv('Record', f.evidence) : ''}`)}
<tr><td ${pad} style="padding:16px 24px 0;font-size:0;" align="center"><!--[if mso]><table role="presentation" width="592" cellpadding="0" cellspacing="0" border="0"><tr><td width="296" valign="top"><![endif]-->${col(truckCard('FROM · ORIGINAL TRUCK', f.from, f.fromCrew))}<!--[if mso]></td><td width="296" valign="top"><![endif]-->${col(truckCard('TO · RECEIVING TRUCK', f.to, f.toCrew))}<!--[if mso]></td></tr></table><![endif]--></td></tr>
${heading('Handoff')}
<tr><td ${pad} style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="26%" style="padding:6px 8px 6px 0;font-family:${FONT};font-size:12px;color:${MUTED};"></td><td width="37%" style="padding:6px 8px 6px 0;font-family:${FONT};font-size:12px;font-weight:bold;color:${MUTED};">BEFORE</td><td style="padding:6px 0;font-family:${FONT};font-size:12px;font-weight:bold;color:${MUTED};">AFTER</td></tr>${f.rows.map((r) => `<tr><td style="padding:8px 8px 8px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};vertical-align:top;">${esc(r.label)}</td><td style="padding:8px 8px 8px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${TEXT};vertical-align:top;word-break:break-word;">${esc(r.before)}</td><td style="padding:8px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:14px;font-weight:bold;color:${TEXT};vertical-align:top;word-break:break-word;">${esc(r.after)}</td></tr>`).join('')}</table></td></tr>
${table(`${kv('Transfer type', f.type)}${kv('Full or partial', f.scope)}${kv('TruckMate', f.truckMate)}`)}
${heading('Arrival and delivery timing')}
${table(`${kv(`Truck ${f.from} arrival`, f.arrivalFrom)}${kv(`Truck ${f.to} arrival`, f.arrivalTo)}${kv('Previous ETA', f.previousEta)}${kv('Revised ETA (estimated)', f.revisedEta)}${kv('Next stop', f.nextStop)}${kv('Appointment', f.appt)}${kv('Timing change', f.change)}`)}
${heading('Next step')}
${table(`${kv('Departure', f.departure)}${kv('Next stop', f.nextStop)}${kv('Handling', f.handling)}`)}
<tr><td ${pad} style="padding:8px 24px 0;font-family:${FONT};font-size:13px;color:${MUTED};">This confirms the handoff only. It does not resolve truck faults or delivery delays.</td></tr>
<tr><td ${pad} style="padding:10px 24px 0;">${button(liveUrl(f.trip), 'View trip')}</td></tr>`;
  const html = shell({ title: 'TRANSFER COMPLETED', sub: f.doneNote }, body);
  const crew = (label, unit, c) => [`${label}: Truck ${unit}`, `Trailer: ${c.trailer}`, `Trip: ${c.trip}`, `Crew: ${c.kind}`, ...driverText(c.drivers, c.drivers.length > 1), c.asOf, ''];
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'TRANSFER COMPLETED', f.doneNote, route, `Trip ${f.trip}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, '',
    'HANDOFF CONFIRMED', `Confirmed at: ${f.confirmedAt}`, `Confirmed by: ${f.confirmedBy}`, `Source: ${f.source}`, `Location: ${f.location}`, ...(f.evidence ? [`Record: ${f.evidence}`] : []), '',
    ...crew('FROM', f.from, f.fromCrew), ...crew('TO', f.to, f.toCrew),
    'HANDOFF (before → after)', ...f.rows.map((r) => `${r.label}: ${r.before} → ${r.after}`), `Transfer type: ${f.type}`, `Full or partial: ${f.scope}`, `TruckMate: ${f.truckMate}`, '',
    'ARRIVAL AND DELIVERY TIMING', `Truck ${f.from} arrival: ${f.arrivalFrom}`, `Truck ${f.to} arrival: ${f.arrivalTo}`, `Previous ETA: ${f.previousEta}`, `Revised ETA (estimated): ${f.revisedEta}`, `Next stop: ${f.nextStop}`, `Appointment: ${f.appt}`, `Timing change: ${f.change}`, '',
    'NEXT STEP', `Departure: ${f.departure}`, `Next stop: ${f.nextStop}`, `Handling: ${f.handling}`, 'This confirms the handoff only. It does not resolve truck faults or delivery delays.', '', `View trip: ${liveUrl(f.trip)}`, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n');
  return { subject, html, text };
}

// The load this truck carries now against the load it broke down with. Pure.
export function currentAssignment(report, item) {
  const cur = item && item.trip && item.trip.tripNumber != null ? String(item.trip.tripNumber) : null;
  const moved = report.transferredTo ? `Trip ${report.trip} moved to truck ${report.transferredTo}.` : null;
  if (!cur) return { kind: 'none', line: `${moved ? `${moved} ` : ''}No current load on this truck.` };
  if (cur === String(report.trip)) return { kind: 'same', line: `Same load as the breakdown: trip ${cur}.` };
  return { kind: 'new', line: `${moved || `Trip ${report.trip} is no longer on this truck.`} Current load: trip ${cur}.` };
}

// The sections both recovery emails share: repair, location, crew, the load. item: the load this truck carries now. Pure.
function recoveryBlocks({ report, item, live, etas, now, showPhones, mapCid }) {
  const truckItem = { trip: { powerUnit: report.unit }, _samsara: live || {} };
  const f = teamStopFacts({ unit: report.unit, trip: (item && item.trip && item.trip.tripNumber) || null }, item || truckItem, { etas: item ? etas : null, now, showPhones, mapCid });
  const fixedAt = et(report.fixedAt) || NA;
  const lasted = report.fixedAt && report.atMs ? `${fmtMin((report.fixedAt - report.atMs) / 60000)} (reported ${et(report.atMs)} to reported fixed ${fixedAt})` : NA;
  const asg = currentAssignment(report, item);
  const trailer = (report.before && report.before.trailer) || f.trailer;
  const many = f.drivers.length > 1;
  const crew = many ? 'Team' : f.drivers.length ? 'Solo' : NA;
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const gpsLine = f.gpsSource || f.gpsAt ? `${f.gpsSource || 'GPS'} · ${f.gpsAt ? `updated ${f.gpsAt}` : 'update time not reported'}` : 'GPS not reported';
  const appt = f.appt ? `${f.appt}${f.apptFrom ? ` (${f.apptFrom})` : ''}` : null;
  const delivery = asg.kind === 'none' ? '' : `${kv('Next stop', f.next)}${kv('Appointment', appt)}${kv('Updated ETA (estimated)', f.eta)}${kv('Distance remaining', f.miles != null ? `${f.miles.toLocaleString('en-US')} mi` : null)}${kv('Projected delay', f.risk)}`;
  const html = `${heading('Repair summary')}
${table(`${kv('Issue', report.reason)}${kv('Repair performed', report.repair || NP)}${kv('Reported fixed by', report.fixedBy)}${kv('Repair completed', report.repairTime || NP)}${kv('Reported fixed', fixedAt)}${kv('Provider', report.provider || NP)}${kv('Notes', report.repairNotes || NP)}${kv('Breakdown duration', lasted)}`)}
${heading('Updated location')}
${f.mapCid ? `<tr><td ${pad} style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck's latest reported location near ${esc(f.location || 'the reported position')}" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td ${pad} style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b><div style="font-size:13px;color:${MUTED};">${esc(gpsLine)}</div>${f.gpsStale && f.gpsAt ? '<div style="padding-top:4px;font-size:14px;font-weight:bold;color:#92400E;">This GPS location may be out of date.</div>' : ''}<div>${mapUrl ? button(mapUrl, 'Open map') : ''}${button(liveUrl(f.trip || report.trip), 'View truck')}</div></td></tr>
${heading(`Current driver crew · ${crew}`)}
<tr><td ${pad} style="padding:0 24px;">${f.drivers.length ? f.drivers.map((d, i) => driverCard(d, i, many)).join('') : `<div style="font-family:${FONT};font-size:15px;color:${TEXT};">No driver reported.</div>`}</td></tr>
${heading('Current assignment and delivery')}
<tr><td ${pad} style="padding:0 24px 8px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b>${esc(asg.line)}</b></td></tr>
${delivery ? table(delivery) : ''}`;
  const text = ['REPAIR SUMMARY', `Issue: ${report.reason || NA}`, `Repair performed: ${report.repair || NP}`, `Reported fixed by: ${report.fixedBy || NA}`, `Repair completed: ${report.repairTime || NP}`, `Reported fixed: ${fixedAt}`, `Provider: ${report.provider || NP}`, `Notes: ${report.repairNotes || NP}`, `Breakdown duration: ${lasted}`, '',
    'UPDATED LOCATION', f.location || 'Location not reported', gpsLine, ...(mapUrl ? [`Open map: ${mapUrl}`] : []), `View truck: ${liveUrl(f.trip || report.trip)}`, '',
    `CURRENT DRIVER CREW · ${crew}`, ...driverText(f.drivers, many), '',
    'CURRENT ASSIGNMENT AND DELIVERY', asg.line, ...(asg.kind === 'none' ? [] : [`Next stop: ${f.next || NA}`, `Appointment: ${appt || NA}`, `Updated ETA (estimated): ${f.eta || NA}`, `Distance remaining: ${f.miles != null ? `${f.miles} mi` : NA}`, `Projected delay: ${f.risk || NA}`])];
  return { f, many, trailer, fixedAt, html, text };
}
const monitorBlock = (head, lines, caveat) => `${heading('Monitoring status')}
<tr><td ${pad} style="padding:0 24px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b>${esc(head)}</b>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}<div style="padding-top:6px;font-size:13px;color:${MUTED};">${esc(caveat)}</div></td></tr>`;
const openLine = (others) => (others.length ? `${others.length} other open alert${others.length === 1 ? '' : 's'} on this truck: ${others.slice(0, 4).join('; ')}.` : 'No other open alerts on this truck.');
const incidentLine = (report, trailer) => `INCIDENT Trip ${report.trip}${trailer ? ` · Trailer ${trailer}` : ''}`;

// Breakdown fixed & rolling: one per incident, when a reported repair meets confirmed movement. Pure.
export function renderFixedRollingEmail({ ep, report, item, etas = null, now = Date.now(), showPhones = true, mapCid = null }) {
  const b = recoveryBlocks({ report: { ...report, unit: ep.unit }, item, live: ep.live || (item && item._samsara) || {}, etas, now, showPhones, mapCid });
  const { f, many, trailer } = b;
  const elapsed = fmtMin((now - ep.movingSince) / 60000) || NA;
  const speed = ep.speedMph != null ? `${Math.round(ep.speedMph)} mph` : NA;
  const movedAt = et(ep.movingSince) || NA;
  const monitor = ep.alertsOn ? (many ? 'Team-truck alerts resumed.' : 'Breakdown hold cleared for this truck.') : 'Alert status not confirmed.';
  const otherLine = openLine(ep.openAlerts || []);
  const caveat = 'This email does not change monitoring or close any alert. Movement does not confirm that truck faults or delivery delays are resolved.';
  const body = `<tr><td ${pad} style="padding:14px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || NR)}</td></tr>
<tr><td ${pad} style="padding:0 24px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">${esc(incidentLine(report, trailer))}</td></tr>
<tr><td ${pad} style="padding:0 24px;"><table class="fb-soft" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F0FDF4" style="background:#F0FDF4;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};color:${TEXT};"><div class="ts-big" style="font-size:40px;line-height:1.1;font-weight:bold;color:${GREEN};">${esc(elapsed)}</div><div style="font-size:13px;font-weight:bold;letter-spacing:.4px;color:${GREEN};">ROLLING</div><div style="padding-top:8px;font-size:14px;line-height:1.5;">Speed: <b>${esc(speed)}</b><br>Movement started: <b>${esc(movedAt)}</b><br>Telemetry: <b>${esc(f.gpsAt || NA)}</b></div><div style="padding-top:4px;font-size:13px;color:${MUTED};">Snapshot at email generation—not a live timer.</div></td></tr></table></td></tr>
${b.html}
${monitorBlock(monitor, [otherLine], caveat)}`;
  const html = shell({ title: 'BREAKDOWN FIXED & ROLLING', sub: 'Repair reported fixed · Movement confirmed' }, body);
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'BREAKDOWN FIXED & ROLLING', 'Repair reported fixed · Movement confirmed', `Truck ${f.unit || NR}`, incidentLine(report, trailer), '',
    `${elapsed} ROLLING`, `Speed: ${speed}`, `Movement started: ${movedAt}`, `Telemetry: ${f.gpsAt || NA}`, 'Snapshot at email generation—not a live timer.', '',
    ...b.text, '', 'MONITORING STATUS', monitor, otherLine, caveat, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n');
  return { subject: `Breakdown fixed & rolling — Truck ${f.unit || NR}`, html, text };
}

// Staff say it's repaired; the truck hasn't been confirmed moving. held: another record still keeps alerts off. Pure.
export function renderFixedReportedEmail({ report, item = null, live = null, etas = null, now = Date.now(), showPhones = true, mapCid = null, held = false, others = [], subject }) {
  const l = live || (item && item._samsara) || {};
  const b = recoveryBlocks({ report, item, live: l, etas, now, showPhones, mapCid });
  const { f, many, trailer, fixedAt } = b;
  const AMBER = '#92400E';
  const status = l.speedMph == null ? 'Not reported' : Number(l.speedMph) > 3 ? `Moving · ${Math.round(l.speedMph)} mph, not confirmed yet` : 'Stopped · 0 mph';
  const alerts = held ? 'This truck is still on hold from another open record, so alerts for it stay off.' : many ? 'Team truck alerts are back on for this truck.' : 'Breakdown hold cleared for this truck.';
  const otherLine = openLine(others);
  const next = 'A separate email follows once movement is confirmed.';
  const caveat = 'A reported repair does not confirm that truck faults or delivery delays are resolved. This email does not close any alert.';
  const body = `<tr><td ${pad} style="padding:14px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || NR)}</td></tr>
<tr><td ${pad} style="padding:0 24px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">${esc(incidentLine(report, trailer))}</td></tr>
<tr><td ${pad} style="padding:0 24px;"><table class="fb-soft-amber" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFF7E7" style="background:#FFF7E7;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};color:${TEXT};"><div class="ts-big" style="font-size:30px;line-height:1.15;font-weight:bold;color:${AMBER};">Waiting to move</div><div style="font-size:13px;font-weight:bold;letter-spacing:.4px;color:${AMBER};">MOVEMENT NOT CONFIRMED</div><div style="padding-top:8px;font-size:14px;line-height:1.5;">Status: <b>${esc(status)}</b><br>Reported fixed: <b>${esc(fixedAt)}</b><br>Telemetry: <b>${esc(f.gpsAt || NA)}</b></div><div style="padding-top:4px;font-size:13px;color:${MUTED};">Snapshot at email generation—not a live timer.</div></td></tr></table></td></tr>
${b.html}
${monitorBlock(alerts, [otherLine, next], caveat)}`;
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'BREAKDOWN REPORTED FIXED', 'Awaiting confirmed movement', `Truck ${f.unit || NR}`, incidentLine(report, trailer), '',
    'Waiting to move', 'MOVEMENT NOT CONFIRMED', `Status: ${status}`, `Reported fixed: ${fixedAt}`, `Telemetry: ${f.gpsAt || NA}`, 'Snapshot at email generation—not a live timer.', '',
    ...b.text, '', 'MONITORING STATUS', alerts, otherLine, next, caveat, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n');
  return { subject, html: shell({ tone: 'amber', mark: '&#9888;&#65038;', title: 'BREAKDOWN REPORTED FIXED', sub: 'Awaiting confirmed movement' }, body), text };
}

// The answer to a stop email: who said what, and what happens next. Pure.
const STOP_FROM = { 'email button': 'From the stop email', 'email reply': 'Reply to the stop email', console: 'Marked Solved in the console' };
export function renderStopReviewEmail({ a, item, review, subject, etas = null, now = Date.now(), showPhones = true, mapCid = null }) {
  const f = teamStopFacts(a, item, { etas, now, showPhones, mapCid });
  const yes = review.status === 'authorized';
  const title = yes ? 'STOP AUTHORIZED' : 'STOP NOT AUTHORIZED';
  const sub = yes ? 'Alerts for this stop are off' : 'Alerts for this stop continue';
  const next = yes ? 'Jarvis will not send more alerts for this stop. You will get one email when the truck is confirmed rolling again.' : 'Alerts continue until the truck is rolling or someone authorizes the stop.';
  const stopped = f.duration ? `${a.stopStartUnknown ? 'At least ' : ''}${f.duration}` : null;
  const rows = [[yes ? 'Authorized by' : 'Marked by', review.by], ['When', et(review.atMs)], ['How', STOP_FROM[review.source] || review.source], ['Stopped so far', stopped], ['Stopped since', f.stoppedSince]].filter(([, v]) => v);
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const body = `${trucksLine(f.unit)}${tripLine(f.trip, f.trailer)}
${message(yes ? 'Reason' : 'Note', [review.reason ? `"${review.reason}"` : 'No note added.'])}
<tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
${table(rows.map(([k, v]) => kv(k, v)).join(''))}
${heading('Location')}
${f.mapCid ? `<tr><td ${pad} style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck near ${esc(f.location || 'its reported position')}" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td ${pad} style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b></td></tr>
${message('What happens next', [next])}
${viewTrip(f.trip)}`;
  return { subject, html: shell({ ...(yes ? {} : { tone: 'red' }), mark: yes ? '&#10003;' : '&#10005;', title, sub }, body), text: ['FLORIDA BEAUTY — Dispatch notifications', '', title, sub, `Truck ${f.unit}`, `Trip ${f.trip}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, '', `${yes ? 'Reason' : 'Note'}: ${review.reason || 'No note added.'}`, ...rows.map(([k, v]) => `${k}: ${v}`), `Location: ${f.location || 'Location not reported'}`, '', next, ...mailEnd(f.trip)].join('\n') };
}

// The email to someone who just got a console login. It holds a temporary password, so it goes only to that person. Pure.
export function renderLoginEmail({ name, email, tempPassword, url, by = null }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const box = (k, v) => `<tr><td style="padding:6px 16px;font-family:${FONT};font-size:13px;color:${MUTED};">${esc(k)}<div style="font-size:18px;font-weight:bold;color:${NAVY};word-break:break-all;">${esc(v)}</div></td></tr>`;
  const para = (t) => `<tr><td ${pad} style="padding:12px 24px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};">${t}</td></tr>`;
  const steps = (list) => `<tr><td ${pad} style="padding:8px 24px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${TEXT};">${list.map((x, i) => `<div><b>${i + 1}.</b> ${esc(x)}</div>`).join('')}</td></tr>`;
  const signIn = `<tr><td ${pad} style="padding:16px 24px 0;"><a href="${esc(url)}" style="display:block;padding:15px 18px;border-radius:6px;background:#1D4ED8;font-family:${FONT};font-size:18px;font-weight:bold;text-align:center;color:#FFFFFF;text-decoration:none;">Sign in / Ingresar</a></td></tr>`;
  const EN = ['Tap Sign in below and enter the username and temporary password above.', 'Choose your own password when it asks you to.', 'You are in. Use your new password from now on.'];
  const ES = ['Toca Ingresar y escribe el usuario y la contraseña temporal de arriba.', 'Elige tu propia contraseña cuando te lo pida.', 'Listo. Desde ahora usa tu nueva contraseña.'];
  const keep = 'This password is temporary. It expires in 3 days and stops working once you choose your own. Keep this email private.';
  const keepEs = 'Esta contraseña es temporal. Vence en 3 días y deja de funcionar cuando elijas la tuya. Mantén este correo en privado.';
  const notYou = 'Not expecting this? Tell Florida Beauty dispatch and do not sign in.';
  const notYouEs = '¿No esperabas este correo? Avísale a despacho de Florida Beauty y no ingreses.';
  const body = `${para(`<b>Hi${first ? ` ${esc(first)}` : ''},</b><br>Your Dynamic Dispatch account has been created${by ? ` by ${esc(by)}` : ''}. This is the email with your temporary password.`)}
<tr><td ${pad} style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F7FA" style="background:#F5F7FA;border-radius:8px;"><tr><td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>${box('Username / Usuario', email)}${box('Temporary password / Contraseña temporal', tempPassword)}<tr><td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr></table></td></tr>
${heading('Follow these steps')}${steps(EN)}${signIn}
${para(`<span style="font-size:13px;color:${MUTED};">${esc(keep)} ${esc(notYou)}</span>`)}
${heading('En español')}
${para(`Hola${first ? ` ${esc(first)}` : ''}, tu cuenta de Dynamic Dispatch fue creada${by ? ` por ${esc(by)}` : ''}. Este correo trae tu contraseña temporal.`)}
${steps(ES)}
${para(`<span style="font-size:13px;color:${MUTED};">${esc(keepEs)} ${esc(notYouEs)}</span>`)}`;
  return {
    subject: 'Your Dynamic Dispatch account / Tu cuenta de Dynamic Dispatch',
    html: shell({ tone: 'blue', mark: '&#10003;', title: 'YOUR ACCOUNT IS READY', sub: 'Tu cuenta está lista' }, body),
    text: ['FLORIDA BEAUTY — Dynamic Dispatch', '', 'YOUR ACCOUNT IS READY', `Hi${first ? ` ${first}` : ''}, your Dynamic Dispatch account has been created${by ? ` by ${by}` : ''}.`, '', `Username: ${email}`, `Temporary password: ${tempPassword}`, `Sign in: ${url}`, '', ...EN.map((x, i) => `${i + 1}. ${x}`), '', keep, notYou, '', 'EN ESPAÑOL', `Hola${first ? ` ${first}` : ''}, tu cuenta de Dynamic Dispatch fue creada${by ? ` por ${by}` : ''}.`, ...ES.map((x, i) => `${i + 1}. ${x}`), '', keepEs, notYouEs, '', 'Jarvis · AI Dispatcher', 'Florida Beauty'].join('\n'),
  };
}


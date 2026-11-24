// ---------------------------------------------------------------
// The yard check email (Nov 22, Nadim: "make it like the yard check summary"): sent when a check is submitted — the yard, the
// check, who and when; trucks and trailers in the yard (trucks by class, trailers by load); the office readiness split; what
// needs attention (units with an open DVIR marked); every unit in one table. No "Against GPS" (Nov 23, Nadim). Plain tables and inline styles so Outlook
// shows it as designed. Pure. What the yard person typed is data, never instructions.
// ---------------------------------------------------------------
const YARD = { MIAMI: 'Miami yard', VENTURA: 'Ventura yard' };
const TZ = { MIAMI: 'America/New_York', VENTURA: 'America/Los_Angeles' };
const READY = [['available', 'Available', '#E3F5EA', '#166534'], ['assigned', 'Assigned and cleared', '#E8EEFC', '#1D4ED8'], ['hold', 'Hold — needs attention', '#FDF3E1', '#92400E'], ['down', 'Down · cannot use', '#FDE8E8', '#B91C1C']];
const CLASSES = [['companyTruck', 'company'], ['localTruck', 'local'], ['ownerOperator', 'owner op'], ['outsideCarrier', 'OC']];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const name = (r) => `${r.kind === 'truck' ? 'Truck' : 'Trailer'} ${r.unit}`;

// Nov 24 redesign (Nadim: "the receivers need to see right away what's available and what's not — most important what's
// available, trucks and trailers, with numbers"): READY TO DISPATCH first (how many trucks and trailers, and which), then what
// to check before using (empty in the yard but still on a TruckMate load; an "available" truck whose note says local / tow),
// then NOT AVAILABLE at a glance (loaded, local, hold, down), DOWN grouped by why, no readiness set, units on the sheet twice.
// The every-unit table lives on the console (link). loads: TruckMate loads by unit ('trailer:7301' → { trip, to, deliverBy }).
const unitKeyOf = (r) => `${r.kind}:${r.unit}`;
// Nov 24 (on an iPhone, Outlook made 7331, 18088 and the date blue links): an invisible joiner between digits so mail apps
// don't read unit numbers as phone numbers / dates. Text, escaped.
export const noLink = (v) => esc(v).replace(/(\d)(?=\d)/g, '$1&zwnj;');
// one row per unit (a unit typed twice — two devices — counts once: the one with the most filled in, then the later)
export function dedupeRows(rows = []) {
  const real = (r) => { const t = String(((r.issues || []).join(' ')) || r.comments || r.notes || '').trim(); return !!t && !/^update$/i.test(t); };
  const score = (r) => (r.readiness ? 4 : 0) + (r.loaded ? 1 : 0) + ((r.issues || []).length || r.comments ? 1 : 0) + (real(r) ? 2 : 0);
  const by = new Map(); const twice = new Map();
  for (const r of rows) { const k = unitKeyOf(r); if (by.has(k)) { twice.set(k, (twice.get(k) || 1) + 1); if (score(r) >= score(by.get(k))) by.set(k, r); } else by.set(k, r); }
  return { rows: [...by.values()], twice: [...twice.entries()].map(([k, n]) => ({ key: k, n })) };
}
const noteOf = (r) => String(((r.issues || []).length ? r.issues.join(' · ') : r.comments) || r.notes || '').replace(/\s*·\s*\d+ photos?/g, '').trim();
// why a unit is down, from what the yard wrote (and the shop / dealer flags)
export function downReason(r) {
  const t = `${noteOf(r)} ${r.notes || ''}`.toLowerCase();
  if (r.atDealer || r.condition === 'dealer' || /dealer/.test(t)) return 'At / needs the dealer';
  if (r.condition === 'shop' || /\bshop\b/.test(t)) return 'In shop';
  if (/sold|for sale/.test(t)) return 'Sold / for sale';
  if (/\btow/.test(t)) return 'Towed in';
  if (/part/.test(t)) return 'Waiting on parts';
  if (!t.trim() || /^(update|\?|-)$/.test(t.trim()) || /^update\b/.test(t.trim())) return 'No reason given';
  return 'Other';
}
const REASONS = ['Waiting on parts', 'Towed in', 'In shop', 'At / needs the dealer', 'Other', 'Sold / for sale', 'No reason given'];
const short = (s, n = 26) => { const x = String(s || '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const fmtWhen = (v) => { const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/); if (!m) return ''; const d = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${Number(m[3])}`; if (!m[4] || (m[4] === '00' && m[5] === '00')) return d; const h = Number(m[4]); return `${d} ${h % 12 || 12}${m[5] !== '00' ? `:${m[5]}` : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const town = (to) => String(to || '').split(',')[0].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function yardCheckEmail(c, { dvrUnits = new Set(), consoleUrl = 'https://mytagalong.app/truckmate', shop = {}, test = false, loads = {}, downSince = {} } = {}) {
  const { rows, twice } = dedupeRows((c.rows || []).filter((r) => r.here));
  const trucks = rows.filter((r) => r.kind === 'truck'); const trailers = rows.filter((r) => r.kind === 'trailer');
  const when = new Date(c.checkedAt || c.at).toLocaleString('en-US', { timeZone: TZ[c.yard] || TZ.MIAMI, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const shift = c.shift === 'morning' ? 'Morning' : 'Night';
  const yard = YARD[c.yard] || c.yard;
  const etaOf = (r) => ((shop[unitKeyOf(r)] || []).find((u) => u.eta) || {}).eta || null;
  const loadOf = (r) => loads[unitKeyOf(r)] || null;
  // the yard's mark wins (Nov 24): marked empty = empty, whatever TruckMate says; not marked → TruckMate's load decides
  const yardLoaded = (r) => r.loaded === 'loaded' || r.loaded === 'partial' || (!r.loaded && !!loadOf(r));
  // READY: available trucks (not local); available trailers empty in the yard and on no TruckMate load
  const readyTrucks = trucks.filter((r) => r.readiness === 'available' && !r.localTruck);
  const availTl = trailers.filter((r) => r.readiness === 'available' && !yardLoaded(r));
  const readyTrailers = availTl;
  const onLoadEmpty = [];
  const sus = (r) => (/\blocal\b/i.test(noteOf(r)) ? 'says "Local"?' : /\btow/i.test(noteOf(r)) ? 'says "Tow"?' : null);
  const loadedTl = trailers.filter(yardLoaded);
  const local = trucks.filter((r) => r.localTruck);
  const hold = rows.filter((r) => r.readiness === 'hold');
  const down = rows.filter((r) => r.readiness === 'down');
  const unset = trucks.filter((r) => !r.readiness && !r.localTruck);
  const subject = `${test ? 'TEST — ' : ''}${yard} · ${shift.toLowerCase()} · READY: ${readyTrucks.length} truck${readyTrucks.length === 1 ? '' : 's'} · ${readyTrailers.length} trailer${readyTrailers.length === 1 ? '' : 's'} · ${down.length} down · ${hold.length} hold`;

  // ── the look (Nov 24, Nadim: "more modern, and all the info shows: ready trucks and trailers, loaded trailers and delivery
  // time, down trucks / trailers with the reason and how long they've been down") — cards, big numbers, clean tables.
  const F = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const nm = (r) => `${r.kind === 'truck' ? 'TK' : 'TL'} ${r.unit}`;
  const nowMs = Date.parse(c.checkedAt || c.at) || Date.now();
  const downFor = (r) => { const t = Date.parse(downSince[unitKeyOf(r)] || ''); if (!Number.isFinite(t)) return { text: 'New today', days: 0 }; const d = Math.floor((nowMs - t) / 86400000); return d < 1 ? { text: 'New today', days: 0 } : { text: `${d} day${d === 1 ? '' : 's'}`, days: d, since: fmtWhen(new Date(t).toISOString().slice(0, 10)) }; };
  const pill = (r, note, warn) => `<span style="display:inline-block;margin:0 6px 8px 0;padding:6px 10px;border-radius:10px;background:${warn ? '#FFF4E5' : '#FFFFFF'};border:1px solid ${warn ? '#F5B35C' : '#BBE5C8'};font-size:15px;font-weight:700;color:#0F2A1D;white-space:nowrap">${noLink(r.unit)}${note ? `<span style="font-size:12px;font-weight:600;color:${warn ? '#B45309' : '#4B6B57'}"> · ${esc(note)}</span>` : ''}</span>`;
  const hero = (n, label, sub, list) => `<td width="50%" class="stack" style="padding:6px;vertical-align:top"><div style="background:linear-gradient(160deg,#E9FBEF,#D4F5DF);background-color:#E3F8EA;border-radius:18px;padding:18px 18px 10px">
<div style="font-size:11px;letter-spacing:1.6px;font-weight:800;color:#15803D">READY ${esc(label.toUpperCase())}</div>
<div style="font-size:56px;line-height:1;font-weight:800;color:#0F5132;margin-top:6px">${n}</div><div style="font-size:12px;color:#3F6B50;margin:4px 0 12px">${sub}</div>
<div>${list || '<span style="font-size:13px;color:#4B6B57">None right now</span>'}</div></div></td>`;
  const stat = (n, label, color) => `<td width="25%" style="padding:4px;vertical-align:top"><div style="background:#FFFFFF;border:1px solid #E6EAF1;border-radius:14px;padding:12px 12px 10px;text-align:center"><div style="font-size:26px;font-weight:800;color:${color};line-height:1">${n}</div><div style="font-size:11px;font-weight:700;color:#5B6676;margin-top:6px;letter-spacing:.3px">${label}</div></div></td>`;
  const card = (title, count, color, inner, note = '') => `<div style="background:#FFFFFF;border:1px solid #E6EAF1;border-radius:18px;margin-top:14px;overflow:hidden">
<div style="padding:14px 18px;border-bottom:1px solid #EEF1F6"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px"></span><b style="font-size:16px;color:#14213D">${title}</b> <span style="font-size:14px;color:#8A94A6;font-weight:700">${count}</span>${note ? `<div style="font-size:12px;color:#8A94A6;margin-top:3px">${note}</div>` : ''}</div>${inner}</div>`;
  const th = (t, w = '') => `<th align="left" style="padding:9px 18px;font-size:10.5px;letter-spacing:1.2px;color:#8A94A6;font-weight:800;background:#F8FAFC${w ? `;width:${w}` : ''}">${t}</th>`;
  const td = (v, x = '') => `<td style="padding:11px 18px;border-top:1px solid #F0F2F6;font-size:14px;color:#14213D;vertical-align:top${x}">${v}</td>`;
  const table = (head, body) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${head}${body}</table>`;
  const unitCell = (r) => `<b style="font-size:15px">${noLink(nm(r))}</b>${r.ownerOperator ? '<div style="font-size:11px;color:#8A94A6">owner op</div>' : r.localTruck ? '<div style="font-size:11px;color:#7E22CE">local</div>' : ''}`;
  const badge = (t, bg, fg) => `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:800;white-space:nowrap">${esc(t)}</span>`;

  const truckPills = readyTrucks.map((r) => pill(r, sus(r) || short(noteOf(r).replace(/^update$/i, ''), 16) || (r.ownerOperator ? 'owner op' : ''), !!sus(r))).join('');
  const tlPills = readyTrailers.map((r) => pill(r, short(noteOf(r), 16))).join('');
  // loaded trailers: where they go and when they're due (TruckMate), soonest first
  const loadedRows = loadedTl.map((r) => ({ r, l: loadOf(r) })).sort((a, b) => String((a.l && a.l.deliverBy) || '9').localeCompare(String((b.l && b.l.deliverBy) || '9')));
  // down: every truck and trailer with the reason and how long, longest first
  const downRows = down.map((r) => ({ r, why: downReason(r), note: noteOf(r), d: downFor(r), eta: etaOf(r) })).sort((a, b) => b.d.days - a.d.days || REASONS.indexOf(a.why) - REASONS.indexOf(b.why) || (a.r.kind === b.r.kind ? 0 : a.r.kind === 'truck' ? -1 : 1));
  const whyColor = { 'Waiting on parts': ['#FEF3C7', '#92400E'], 'Towed in': ['#FEE2E2', '#991B1B'], 'In shop': ['#DBEAFE', '#1E40AF'], 'At / needs the dealer': ['#EDE9FE', '#5B21B6'], 'Sold / for sale': ['#F1F5F9', '#475569'], Other: ['#F1F5F9', '#334155'], 'No reason given': ['#F1F5F9', '#94A3B8'] };

  const html = `<div style="${F};background:#EEF1F6;padding:20px 10px;color:#14213D">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><meta name="format-detection" content="telephone=no,date=no,address=no">
<style>:root{color-scheme:light only;supported-color-schemes:light only}a[x-apple-data-detectors],u + #body a{color:inherit!important;text-decoration:none!important;font:inherit!important}@media (max-width:600px){.stack{display:block!important;width:100%!important;box-sizing:border-box}}</style>
<div style="max-width:720px;margin:0 auto">
<div style="background:#0F1B33;border-radius:20px;padding:20px 22px;color:#FFFFFF">
<div style="font-size:11px;letter-spacing:2px;font-weight:800;color:#8FB0FF">${test ? 'TEST · NOT SAVED · ' : ''}YARD CHECK</div>
<div style="font-size:24px;font-weight:800;margin-top:4px">${esc(yard)} · ${shift.toLowerCase()}</div>
<div style="font-size:13px;color:#AFC0DB;margin-top:4px">${noLink(when)} · checked by ${esc(c.by)} · ${trucks.length} trucks · ${trailers.length} trailers on the ground</div></div>

<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:10px"><tr>
${hero(readyTrucks.length, 'trucks', 'Available to dispatch now', truckPills)}
${hero(readyTrailers.length, 'trailers', 'Empty · ready to go', tlPills)}
</tr></table>

<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:4px"><tr>
${stat(loadedTl.length, 'LOADED TRAILERS', '#1D4ED8')}${stat(local.length, 'LOCAL TRUCKS', '#7E22CE')}${stat(hold.length, 'ON HOLD', '#D97706')}${stat(down.length, 'DOWN', '#DC2626')}
</tr></table>

${onLoadEmpty.length ? `<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:16px;padding:12px 16px;margin-top:14px;font-size:13.5px;line-height:1.55;color:#7C2D12"><b>Check before using:</b> ${onLoadEmpty.map((r) => `${noLink(nm(r))} (trip ${noLink(loadOf(r).trip)})`).join(' · ')} — empty in the yard but still on a load in TruckMate. Close the load and ${onLoadEmpty.length === 1 ? 'it is' : 'they are'} ready.</div>` : ''}

${loadedRows.length ? card('Loaded trailers', loadedRows.length, '#1D4ED8', table(`<tr>${th('TRAILER', '22%')}${th('LOAD')}${th('GOING TO')}${th('DELIVER BY')}</tr>`, loadedRows.map(({ r, l }) => `<tr>${td(`<b style="font-size:15px">${noLink(r.unit)}</b>${r.readiness === 'down' ? `<div>${badge('down', '#FEE2E2', '#991B1B')}</div>` : ''}`)}${td(l ? `Trip ${noLink(l.trip)}` : '<span style="color:#8A94A6">—</span>')}${td(l && l.to ? esc(town(l.to)) : '<span style="color:#8A94A6">—</span>')}${td(l && l.deliverBy ? `<b>${noLink(fmtWhen(l.deliverBy))}</b>` : '<span style="color:#8A94A6">not given</span>', ';white-space:nowrap')}</tr>`).join(''))) : ''}

${downRows.length ? card('Down', downRows.length, '#DC2626', table(`<tr>${th('UNIT', '22%')}${th('REASON')}${th('DOWN FOR')}</tr>`, downRows.map(({ r, why, note, d, eta }) => { const [bg, fg] = whyColor[why] || whyColor.Other; return `<tr>${td(unitCell(r))}${td(`${badge(why, bg, fg)}${note && !/^update$/i.test(note) ? `<div style="font-size:13px;color:#5B6676;margin-top:5px">${esc(short(note, 60))}</div>` : ''}${eta ? `<div style="font-size:12.5px;color:#1D4ED8;font-weight:700;margin-top:4px">Ready ETA ${esc(fmtWhen(eta))}</div>` : ''}${dvrUnits.has(unitKeyOf(r)) ? `<div style="margin-top:4px">${badge('DVIR open', '#FEE2E2', '#991B1B')}</div>` : ''}`)}${td(`<b style="color:${d.days >= 7 ? '#B91C1C' : d.days >= 3 ? '#B45309' : '#14213D'}">${esc(d.text)}</b>${d.since ? `<div style="font-size:11.5px;color:#8A94A6">since ${esc(d.since)}</div>` : ''}`, ';white-space:nowrap')}</tr>`; }).join('')), 'Longest first · "New today" = first check it showed up down') : ''}

${hold.length ? card('On hold', hold.length, '#D97706', table('', hold.map((r) => `<tr>${td(unitCell(r), ';width:22%')}${td(esc(noteOf(r) && !/^update$/i.test(noteOf(r)) ? noteOf(r) : 'No note'))}</tr>`).join(''))) : ''}

${local.length ? card('Local trucks', local.length, '#7E22CE', `<div style="padding:12px 18px 4px">${local.map((r) => pill(r, r.readiness === 'down' ? 'down' : '', false)).join('')}</div>`) : ''}

${unset.length || twice.length ? card('Needs a decision', unset.length, '#64748B', `<div style="padding:12px 18px;font-size:13.5px;line-height:1.6">${unset.length ? `No readiness set: ${unset.map((r) => `<b>${esc(r.unit)}</b>${noteOf(r) && !/^update$/i.test(noteOf(r)) ? ` (${esc(short(noteOf(r), 30))})` : ''}`).join(' · ')}` : ''}${twice.length ? `<div style="color:#B45309;margin-top:6px">On the sheet twice (counted once): ${twice.map((x) => esc(x.key.replace('truck:', 'TK ').replace('trailer:', 'TL '))).join(', ')}</div>` : ''}</div>`) : ''}

<div style="text-align:center;margin:18px 0 6px"><a href="${esc(consoleUrl)}" style="display:inline-block;background:#1D4ED8;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:14px;padding:12px 22px;border-radius:12px">Open the full yard check</a></div>
<div style="text-align:center;font-size:12px;color:#8A94A6">Jarvis · AI Dispatcher · Florida Beauty Flora</div>
</div></div>`;
  const text = [`${test ? 'TEST — ' : ''}YARD CHECK — ${yard}, ${shift.toLowerCase()} check`, `${when} · checked by ${c.by}`, '',
    `READY TRUCKS (${readyTrucks.length}): ${readyTrucks.map((r) => `${r.unit}${sus(r) ? ` (${sus(r)})` : ''}`).join(', ') || 'none'}`,
    `READY TRAILERS (${readyTrailers.length}): ${readyTrailers.map((r) => r.unit).join(', ') || 'none'}`,
    ...(onLoadEmpty.length ? [`Check before using (empty, still on a TruckMate load): ${onLoadEmpty.map((r) => `${r.unit} (trip ${loadOf(r).trip})`).join(', ')}`] : []), '',
    `LOADED TRAILERS (${loadedRows.length}):`, ...loadedRows.map(({ r, l }) => `- ${r.unit}${l ? ` · trip ${l.trip} · ${town(l.to)}${l.deliverBy ? ` · deliver ${fmtWhen(l.deliverBy)}` : ''}` : ''}`), '',
    `DOWN (${downRows.length}):`, ...downRows.map(({ r, why, note, d, eta }) => `- ${nm(r)} · ${why}${note && !/^update$/i.test(note) ? ` (${note})` : ''} · down ${d.text}${eta ? ` · ready ETA ${fmtWhen(eta)}` : ''}`), '',
    `On hold: ${hold.map((r) => r.unit).join(', ') || 'none'} · Local trucks: ${local.map((r) => r.unit).join(', ') || 'none'}`,
    ...(unset.length ? [`No readiness set: ${unset.map((r) => r.unit).join(', ')}`] : []), '', `Full check: ${consoleUrl}`, 'Jarvis · AI Dispatcher'].join('\n');
  return { subject, html, text };
}

export function mockYardCheck(now = Date.now()) {
  const t = (unit, x) => ({ kind: 'truck', unit, here: true, ...x });
  const l = (unit, x) => ({ kind: 'trailer', unit, here: true, ...x });
  return {
    yard: 'MIAMI', shift: 'night', day: new Date(now).toISOString().slice(0, 10), by: 'Luis (sample)', checkedAt: new Date(now).toISOString(),
    rows: [
      t('2405', { readiness: 'hold', condition: 'issue', access: 'blocked', companyTruck: true, comments: 'Missing front bumper', notes: 'Blocked in by trailer 7304 — move before 6 AM' }),
      t('2094', { readiness: 'down', condition: 'issue', localTruck: true, comments: 'Headlights out', photos: ['a', 'b'] }),
      t('4504', { readiness: 'assigned', condition: 'clear', access: 'clear', companyTruck: true, comments: 'Trip 627700 tomorrow' }),
      t('2216', { readiness: 'available', condition: 'clear', companyTruck: true }),
      t('39', { readiness: 'available', condition: 'clear', ownerOperator: true }),
      l('18094', { readiness: 'assigned', loaded: 'loaded', inside: 'clean', tempF: '41', setF: '34', comments: 'Sealed · assigned' }),
      l('7304', { readiness: 'available', loaded: 'empty', inside: 'cleaning', comments: 'Clean and empty' }),
      l('2077', { readiness: 'assigned', loaded: 'loaded', inside: 'clean', tempF: '32', setF: '28', comments: 'Trip 627542 · ready' }),
      l('7366', { readiness: 'available', loaded: 'empty', inside: 'clean' }),
      l('2052', { readiness: 'hold', loaded: 'partial', inside: 'damaged', comments: 'Rear door seal torn' }),
    ],
    result: { missing: [{ kind: 'trailer', unit: '2021' }, { kind: 'trailer', unit: '2048' }, { kind: 'truck', unit: '2620' }], extra: [{ kind: 'trailer', unit: '7366' }] },
  };
}

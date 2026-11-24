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
// one row per unit (a unit typed twice — two devices — counts once: the one with the most filled in, then the later)
export function dedupeRows(rows = []) {
  const score = (r) => (r.readiness ? 4 : 0) + (r.loaded ? 1 : 0) + ((r.issues || []).length || r.comments ? 1 : 0);
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
const REASONS = ['Waiting on parts', 'Towed in', 'In shop', 'At / needs the dealer', 'Sold / for sale', 'Other', 'No reason given'];
const short = (s, n = 26) => { const x = String(s || '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const fmtWhen = (v) => { const m = String(v || '').match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/); if (!m) return ''; const d = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${Number(m[3])}`; if (!m[4] || (m[4] === '00' && m[5] === '00')) return d; const h = Number(m[4]); return `${d} ${h % 12 || 12}${m[5] !== '00' ? `:${m[5]}` : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const town = (to) => String(to || '').split(',')[0].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function yardCheckEmail(c, { dvrUnits = new Set(), consoleUrl = 'https://mytagalong.app/truckmate', shop = {}, test = false, loads = {} } = {}) {
  const { rows, twice } = dedupeRows((c.rows || []).filter((r) => r.here));
  const trucks = rows.filter((r) => r.kind === 'truck'); const trailers = rows.filter((r) => r.kind === 'trailer');
  const when = new Date(c.checkedAt || c.at).toLocaleString('en-US', { timeZone: TZ[c.yard] || TZ.MIAMI, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const shift = c.shift === 'morning' ? 'Morning' : 'Night';
  const yard = YARD[c.yard] || c.yard;
  const etaOf = (r) => ((shop[unitKeyOf(r)] || []).find((u) => u.eta) || {}).eta || null;
  const loadOf = (r) => loads[unitKeyOf(r)] || null;
  const yardLoaded = (r) => r.loaded === 'loaded' || r.loaded === 'partial';
  // READY: available trucks (not local); available trailers empty in the yard and on no TruckMate load
  const readyTrucks = trucks.filter((r) => r.readiness === 'available' && !r.localTruck);
  const availTl = trailers.filter((r) => r.readiness === 'available' && !yardLoaded(r));
  const readyTrailers = availTl.filter((r) => !loadOf(r));
  const onLoadEmpty = availTl.filter((r) => loadOf(r));
  const sus = (r) => (/\blocal\b/i.test(noteOf(r)) ? 'says "Local"?' : /\btow/i.test(noteOf(r)) ? 'says "Tow"?' : null);
  const loadedTl = trailers.filter(yardLoaded);
  const local = trucks.filter((r) => r.localTruck);
  const hold = rows.filter((r) => r.readiness === 'hold');
  const down = rows.filter((r) => r.readiness === 'down');
  const unset = trucks.filter((r) => !r.readiness && !r.localTruck);
  const subject = `${test ? 'TEST — ' : ''}${yard} · ${shift.toLowerCase()} · READY: ${readyTrucks.length} truck${readyTrucks.length === 1 ? '' : 's'} · ${readyTrailers.length} trailer${readyTrailers.length === 1 ? '' : 's'} · ${down.length} down · ${hold.length} hold`;

  const chip = (r, warn = null, note = null) => `<span style="display:inline-block;margin:0 4px 6px 0;background:${warn ? '#FFF7ED' : '#FFFFFF'};border:1px solid ${warn ? '#F59E0B' : '#86EFAC'};border-radius:6px;padding:3px 8px;font-weight:bold;white-space:nowrap">${r.kind === 'truck' ? 'TK' : 'TL'} ${esc(r.unit)}${warn || note ? ` <span style="color:#B45309;font-weight:normal">· ${esc(warn || note)}</span>` : ''}</span>`;
  const readyBox = (n, label, list, foot) => `<div style="background:#ECFDF3;border:2px solid #16A34A;border-radius:12px;padding:12px 14px"><div><span style="font-size:44px;font-weight:bold;color:#15803D;line-height:1">${n}</span> <span style="font-size:17px;font-weight:bold;color:#14532D">${label}</span></div><div style="margin-top:10px;line-height:1.9">${list || '<span style="color:#64748B">None</span>'}</div>${foot ? `<div style="font-size:12px;color:#166534;margin-top:4px">${foot}</div>` : ''}</div>`;
  const truckList = readyTrucks.map((r) => chip(r, sus(r), sus(r) ? null : short(noteOf(r).replace(/^update$/i, ''), 18) || null)).join('');
  const tlList = readyTrailers.map((r) => chip(r, null, short(noteOf(r), 18) || null)).join('');
  const ownerOps = readyTrucks.filter((r) => r.ownerOperator).map((r) => r.unit);
  const tile = (n, label, sub, color) => `<td width="25%" style="padding:0 3px;vertical-align:top"><div style="background:#FFFFFF;border:1px solid #DDE3EC;border-left:4px solid ${color};border-radius:8px;padding:8px 10px"><div style="font-size:24px;font-weight:bold;color:${color}">${n}</div><div style="font-size:12px;font-weight:bold">${label}</div><div style="font-size:11px;color:#64748B">${sub}</div></div></td>`;
  const split = (list) => `${list.filter((r) => r.kind === 'truck').length} trucks · ${list.filter((r) => r.kind === 'trailer').length} trailers`;
  const nm = (r) => `${r.kind === 'truck' ? 'TK' : 'TL'} ${r.unit}`;
  const withNote = (r) => { const n = noteOf(r); return `${esc(nm(r))}${n && !/^update$/i.test(n) ? ` ${esc(short(n, 40))}` : ''}${dvrUnits.has(unitKeyOf(r)) ? ' <b style="color:#B91C1C">(DVIR open)</b>' : ''}`; };
  const groups = REASONS.map((g) => [g, down.filter((r) => r.kind === 'truck' && downReason(r) === g)]).filter(([, l]) => l.length);
  const tlDown = down.filter((r) => r.kind === 'trailer');
  const row = (k, v) => `<tr><td style="padding:6px 8px;border-top:1px solid #EEF2F7;white-space:nowrap;vertical-align:top"><b>${esc(k)}</b></td><td style="padding:6px 8px;border-top:1px solid #EEF2F7">${v}</td></tr>`;
  const sec = (label, color, inner, bg = '#FFFFFF') => `<div style="background:${bg};border:1px solid #DDE3EC;border-top:0;padding:14px 18px"><div style="font-size:12px;letter-spacing:1.5px;font-weight:bold;color:${color}">${label}</div>${inner}</div>`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14213D;background:#EEF1F6;padding:18px 10px">
<div style="max-width:720px;margin:0 auto">
<div style="background:#1B2742;color:#FFFFFF;border-radius:12px 12px 0 0;padding:14px 18px">
<div style="font-size:11px;letter-spacing:2px;color:#9DB8FF;font-weight:bold">${test ? 'TEST · NOT SAVED · ' : ''}YARD CHECK · ${esc(yard.toUpperCase())}</div>
<div style="font-size:20px;font-weight:bold;margin-top:3px">${shift} check · ${esc(when.split(',').slice(0, 2).join(','))}</div>
<div style="font-size:13px;color:#C9D6EA;margin-top:2px">Checked by ${esc(c.by)} at ${esc(when.split(', ').pop())} · ${trucks.length} trucks and ${trailers.length} trailers on the ground</div></div>
${sec('READY TO DISPATCH NOW', '#15803D', `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:8px"><tr>
<td width="50%" style="padding-right:6px;vertical-align:top">${readyBox(readyTrucks.length, readyTrucks.length === 1 ? 'truck' : 'trucks', truckList, ownerOps.length ? `${ownerOps.join(', ')} ${ownerOps.length === 1 ? 'is an owner operator' : 'are owner operators'}` : '')}</td>
<td width="50%" style="padding-left:6px;vertical-align:top">${readyBox(readyTrailers.length, readyTrailers.length === 1 ? 'trailer' : 'trailers', tlList, readyTrailers.length ? 'Empty, not on any load in TruckMate' : '')}</td></tr></table>
${onLoadEmpty.length ? `<div style="margin-top:12px;background:#FFF7ED;border:1px solid #FDBA74;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6"><b style="color:#9A3412">Check before using — ${onLoadEmpty.length} trailer${onLoadEmpty.length === 1 ? ' is' : 's are'} empty in the yard but TruckMate still has ${onLoadEmpty.length === 1 ? 'it' : 'them'} on a load:</b><br>${onLoadEmpty.map((r) => `${esc(nm(r))} (trip ${esc(loadOf(r).trip)})`).join(' · ')}<br><span style="color:#7C2D12">If those loads are done, close them in TruckMate and ${onLoadEmpty.length === 1 ? 'it becomes' : 'these become'} available.</span></div>` : ''}`)}
${sec('NOT AVAILABLE', '#475569', `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:8px"><tr>${tile(loadedTl.length, 'Loaded trailers', 'on loads, waiting', '#1D4ED8')}${tile(local.length, 'Local trucks', 'yard / local use', '#7E22CE')}${tile(hold.length, 'On hold', split(hold), '#D97706')}${tile(down.length, 'Down', split(down), '#DC2626')}</tr></table>
<div style="margin-top:12px;font-size:13px;line-height:1.7">
${loadedTl.length ? `<div><b style="color:#1D4ED8">Loaded trailers (${loadedTl.length}):</b> ${loadedTl.map((r) => { const l = loadOf(r); return `${esc(nm(r))}${l ? ` → ${esc(town(l.to))}${l.deliverBy ? `, ${esc(fmtWhen(l.deliverBy))}` : ''}` : ''}${r.readiness === 'down' ? ' <span style="color:#DC2626">(down)</span>' : ''}`; }).join(' · ')}</div>` : ''}
${local.length ? `<div><b style="color:#7E22CE">Local (${local.length}):</b> ${local.map((r) => `${esc(r.unit)}${r.readiness === 'down' ? ' (down)' : ''}`).join(' · ')}</div>` : ''}
${hold.length ? `<div><b style="color:#D97706">On hold (${hold.length}):</b> ${hold.map(withNote).join(' · ')}</div>` : ''}
</div>`, '#F8FAFC')}
${down.length ? sec(`DOWN (${down.length}) — BY REASON`, '#DC2626', `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;font-size:13px">${groups.map(([g, l]) => row(`${g} ${l.length}`, l.map((r) => { const e = etaOf(r); return `${withNote(r).replace(/^TK /, '')}${e ? ` <b style="color:#1D4ED8">· ready ${esc(fmtWhen(e))}</b>` : ''}`; }).join(' · '))).join('')}${tlDown.length ? row(`Trailers ${tlDown.length}`, tlDown.map(withNote).join(' · ')) : ''}</table>`) : ''}
${unset.length || twice.length ? sec(`NO READINESS SET (${unset.length}) — ASK THE YARD`, '#475569', `${unset.length ? `<div style="font-size:13px;line-height:1.7;margin-top:6px">${unset.map(withNote).join(' · ')}</div>` : ''}${twice.length ? `<div style="font-size:12px;color:#B45309;margin-top:8px">⚠ On the sheet twice: ${twice.map((x) => `${esc(x.key.replace('truck:', 'TK ').replace('trailer:', 'TL '))} (${x.n}×)`).join(', ')} — counted once above.</div>` : ''}`) : ''}
<div style="background:#FFFFFF;border:1px solid #DDE3EC;border-top:0;border-radius:0 0 12px 12px;padding:12px 18px;font-size:13px"><a href="${esc(consoleUrl)}" style="color:#1D4ED8;font-weight:bold">Open the full yard check</a> — every unit's card, photos and shop updates.<div style="color:#64748B;margin-top:8px">Jarvis · AI Dispatcher · Florida Beauty Flora</div></div>
</div></div>`;
  const text = [`${test ? 'TEST — ' : ''}YARD CHECK — ${yard}, ${shift.toLowerCase()} check`, `${when} · checked by ${c.by}`, '',
    `READY TO DISPATCH: ${readyTrucks.length} trucks · ${readyTrailers.length} trailers`,
    `Trucks: ${readyTrucks.map((r) => `${r.unit}${sus(r) ? ` (${sus(r)})` : ''}`).join(', ') || 'none'}`, `Trailers: ${readyTrailers.map((r) => r.unit).join(', ') || 'none'}`,
    ...(onLoadEmpty.length ? [`Check before using (empty, still on a TruckMate load): ${onLoadEmpty.map((r) => `${r.unit} (trip ${loadOf(r).trip})`).join(', ')}`] : []), '',
    `NOT AVAILABLE: ${loadedTl.length} loaded trailers · ${local.length} local trucks · ${hold.length} on hold · ${down.length} down`,
    ...groups.map(([g, l]) => `- ${g}: ${l.map((r) => r.unit).join(', ')}`), ...(tlDown.length ? [`- Trailers down: ${tlDown.map((r) => r.unit).join(', ')}`] : []),
    ...(unset.length ? ['', `No readiness set: ${unset.map((r) => r.unit).join(', ')}`] : []), '', `Full check: ${consoleUrl}`, 'Jarvis · AI Dispatcher'].join('\n');
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

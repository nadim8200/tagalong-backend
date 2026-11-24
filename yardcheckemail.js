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

export function yardCheckEmail(c, { dvrUnits = new Set(), consoleUrl = 'https://mytagalong.app/truckmate', shop = {}, test = false } = {}) {
  const rows = (c.rows || []).filter((r) => r.here);
  const trucks = rows.filter((r) => r.kind === 'truck'); const trailers = rows.filter((r) => r.kind === 'trailer');
  const when = new Date(c.checkedAt || c.at).toLocaleString('en-US', { timeZone: TZ[c.yard] || TZ.MIAMI, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const shift = c.shift === 'morning' ? 'Morning' : 'Night';
  const yard = YARD[c.yard] || c.yard;
  const att = rows.map((r) => {
    const set = r.setF != null && r.setF !== '' ? Number(r.setF) : null; const now = r.tempF != null && r.tempF !== '' ? Number(r.tempF) : null;
    const why = [r.readiness === 'hold' ? 'hold' : null, r.readiness === 'down' ? 'down' : null, r.condition === 'issue' ? 'issue found' : null, r.condition === 'shop' ? 'in the shop' : null, r.condition === 'dealer' && !r.atDealer ? 'needs the dealer' : null, r.atDealer ? `at the dealer${r.dealerSince ? ` since ${r.dealerSince.slice(5).replace('-', '/')}` : ''}` : null, r.access === 'blocked' ? 'blocked in' : null,
      r.inside === 'cleaning' ? 'needs cleaning' : null, r.inside === 'damaged' ? 'damaged inside' : null, r.kind === 'trailer' && r.loaded === 'loaded' && r.reeferOn === false ? 'reefer off' : null,
      set != null && now != null && Math.abs(now - set) >= 5 ? `reefer ${now}°F / set ${set}°F` : null, dvrUnits.has(`${r.kind}:${r.unit}`) ? 'DVIR open' : null].filter(Boolean);
    return why.length ? { r, why, note: [r.comments, r.notes].filter(Boolean).join(' · ') } : null;
  }).filter(Boolean);
  // Nov 24: a local truck and a loaded trailer are never available — the server's counts when it has them (TruckMate loads too)
  const loadedTl = (r) => r.loaded === 'loaded' || r.loaded === 'partial';
  const rd = (c.result && c.result.readiness) || null;
  const tally = (k) => (rd && rd[k] ? { t: rd[k].trucks, l: rd[k].trailers } : { t: trucks.filter((r) => r.readiness === k && !(k === 'available' && r.localTruck)).length, l: trailers.filter((r) => r.readiness === k && !(k === 'available' && loadedTl(r))).length });
  const loadedN = c.result && c.result.counts && c.result.counts.loadedTrailers != null ? c.result.counts.loadedTrailers : trailers.filter(loadedTl).length;
  const localN = trucks.filter((r) => r.localTruck).length;
  const etaOf = (r) => ((shop[`${r.kind}:${r.unit}`] || []).find((u) => u.eta) || {}).eta || null;
  const subject = `${test ? 'TEST — ' : ''}Yard check // ${yard} // ${shift.toLowerCase()} // ${trucks.length} trucks · ${trailers.length} trailers${att.length ? ` · ${att.length} need attention` : ''}`;

  const card = 'background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px';
  const totals = (label, n, sub) => `<td width="50%" style="padding:0 6px 0 0;vertical-align:top"><div style="${card}"><div style="font-size:13px;color:#475569">${label}</div><div style="font-size:30px;font-weight:bold;color:#14213D;line-height:1.15">${n}</div><div style="font-size:12px;color:#64748B">${sub}</div></div></td>`;
  const ready = READY.map(([k, l, bg, fg]) => { const t = tally(k); return `<td width="25%" style="padding:0 3px;vertical-align:top"><div style="background:${bg};color:${fg};border-radius:8px;padding:9px 10px"><div style="font-size:21px;font-weight:bold">${t.t + t.l}</div><div style="font-size:12px;font-weight:bold">${l}</div><div style="font-size:11px">${t.t} trucks · ${t.l} trailers</div></div></td>`; }).join('');
  const chip = (k) => { const r = READY.find(([v]) => v === k); return r ? `<span style="background:${r[2]};color:${r[3]};padding:2px 7px;border-radius:5px;font-size:11px;font-weight:bold;white-space:nowrap">${esc(r[1].split(' ')[0])}</span>` : '—'; };
  const th = (t) => `<th align="left" style="padding:8px 10px;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:#64748B;border-bottom:1px solid #E2E8F0">${t}</th>`;
  const table = rows.map((r) => {
    const cond = [r.inside ? (r.inside === 'cleaning' ? 'needs cleaning' : r.inside) : null, r.condition === 'issue' ? 'issue found' : r.condition === 'clear' ? 'no visible issue' : r.condition === 'shop' ? 'in the shop' : r.condition === 'dealer' && !r.atDealer ? 'needs the dealer' : null, r.atDealer ? `at the dealer${r.dealerSince ? ` since ${r.dealerSince.slice(5).replace('-', '/')}` : ''}` : null, r.access === 'blocked' ? 'blocked in' : null, etaOf(r) ? `ready ETA ${String(etaOf(r)).replace('T', ' ')}` : null, r.localTruck ? 'local' : null].filter(Boolean).join(' · ');
    const cls = CLASSES.filter(([k]) => r[k]).map(([, l]) => l).join(', ');
    const note = [cls, r.comments, r.notes].filter(Boolean).join(' · ');
    return `<tr><td style="padding:8px 10px;border-top:1px solid #EEF2F7;white-space:nowrap"><b>${r.kind === 'truck' ? 'TK' : 'TL'} ${esc(r.unit)}</b></td><td style="padding:8px 10px;border-top:1px solid #EEF2F7">${chip(r.readiness)}</td><td style="padding:8px 10px;border-top:1px solid #EEF2F7">${esc(r.loaded || '—')}</td><td style="padding:8px 10px;border-top:1px solid #EEF2F7">${esc(cond || '—')}</td><td style="padding:8px 10px;border-top:1px solid #EEF2F7;white-space:nowrap">${r.tempF || r.setF ? `${esc(r.tempF || '—')} / ${esc(r.setF || '—')}°F` : '—'}</td><td style="padding:8px 10px;border-top:1px solid #EEF2F7;color:#475569">${esc(note || '—')}${dvrUnits.has(`${r.kind}:${r.unit}`) ? ' <b style="color:#B91C1C">· DVIR</b>' : ''}${(r.photos || []).length ? ` · ${r.photos.length} photo${r.photos.length === 1 ? '' : 's'}` : ''}</td></tr>`;
  }).join('');

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14213D;background:#F3F5F9;padding:18px">
<div style="max-width:720px;margin:0 auto">
<div style="background:#1B2742;color:#FFFFFF;border-radius:12px 12px 0 0;padding:16px 20px">
<div style="font-size:11px;letter-spacing:2px;color:#9DB8FF;font-weight:bold">DYNAMIC DISPATCH / OPERATIONS · YARD CHECK SUMMARY</div>
<div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(yard)} · ${shift.toLowerCase()} check</div>
<div style="font-size:13px;color:#C9D6EA;margin-top:2px">${esc(when)} · checked by ${esc(c.by)} · ${rows.length} units</div></div>
<div style="background:#F3F5F9;padding:14px 0 0">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse"><tr>
${totals('Trucks in the yard', trucks.length, CLASSES.map(([k, l]) => `${trucks.filter((r) => r[k]).length} ${l}`).join(' · '))}
${totals('Trailers in the yard', trailers.length, `${trailers.filter((r) => r.loaded === 'loaded').length} loaded · ${trailers.filter((r) => r.loaded === 'empty').length} empty · ${trailers.filter((r) => r.loaded === 'partial').length} partial`)}
</tr></table>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:10px"><tr>${[['Available trucks', tally('available').t, '#ECFDF3', '#15803D'], ['Available trailers', tally('available').l, '#ECFDF3', '#15803D'], ['Loaded trailers', loadedN, '#EFF6FF', '#1D4ED8'], ['Local trucks', localN, '#F3E8FF', '#7E22CE']].map(([l, n, bg, fg]) => `<td width="25%" style="padding:0 3px;vertical-align:top"><div style="background:${bg};border:2px solid ${fg};border-radius:8px;padding:9px 10px"><div style="font-size:26px;font-weight:bold;color:${fg}">${n}</div><div style="font-size:12px;font-weight:bold;color:${fg}">${l}</div></div></td>`).join('')}</tr></table>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:10px"><tr>${ready}</tr></table>
<div style="${card};margin-top:10px"><div style="font-size:15px;font-weight:bold;margin-bottom:6px">Needs attention (${att.length})</div>${att.length ? att.map(({ r, why, note }) => `<div style="font-size:13px;line-height:1.6"><b>${esc(name(r))}</b> · ${esc(why.join(', '))}${note ? ` <span style="color:#64748B">— ${esc(note)}</span>` : ''}</div>`).join('') : '<div style="font-size:13px;color:#64748B">Nothing — every unit is clear.</div>'}</div>
<div style="font-size:15px;font-weight:bold;margin:14px 0 6px">Every unit (${rows.length})</div>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;font-size:13px">
<tr>${th('Unit')}${th('Readiness')}${th('Load')}${th('Condition')}${th('Reefer')}${th('Comment')}</tr>${table || '<tr><td colspan="6" style="padding:10px;color:#64748B">No units on this check.</td></tr>'}</table>
<p style="font-size:13px;margin:14px 0 0"><a href="${esc(consoleUrl)}" style="color:#1D4ED8">Open it on the Yard tab</a> for photos and the full cards.</p>
<p style="font-size:13px;color:#475569;margin:10px 0 0">Jarvis · AI Dispatcher<br>Florida Beauty Flora</p>
</div></div></div>`;
  const text = [`YARD CHECK SUMMARY — ${yard}, ${shift.toLowerCase()} check`, `${when} · checked by ${c.by} · ${rows.length} units`, '',
    `Trucks in the yard: ${trucks.length} · Trailers in the yard: ${trailers.length}`,
    READY.map(([k, l]) => { const t = tally(k); return `${l}: ${t.t + t.l} (${t.t} trucks · ${t.l} trailers)`; }).join('\n'), '',
    `Needs attention (${att.length}):`, ...att.map(({ r, why, note }) => `- ${name(r)} · ${why.join(', ')}${note ? ` — ${note}` : ''}`), '',
    'Every unit:', ...rows.map((r) => `- ${name(r)} · ${r.readiness || '—'} · ${r.loaded || '—'}${r.comments ? ` · ${r.comments}` : ''}`), '', 'Jarvis · AI Dispatcher'].join('\n');
  return { subject, html, text };
}

// A made-up check, to see the email (POST /truckmate/yard-checks/email-preview). Pure.
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

// ---------------------------------------------------------------
// Broker load follow-up. On a broker load, "will miss the appointment" only counts once staff asked Jarvis to
// follow up AND the delivery date + time is confirmed by a person. Jarvis asks whoever requested it, by email,
// keeps asking once, then watches the ETA against that time and emails if the truck is over an hour late.
// Internal only: nothing here reaches a broker, customer or driver. Hub outbound loads never come through here.
// ---------------------------------------------------------------
import { brokerLoad } from './watchtower.js';
import { stopKey, commitMs, lateStops, lateMessage } from './commitments.js';
import { makeToken, readToken } from './breakdownreport.js';
import { emailParts } from './teamstopmail.js';
import { tzOf, zoneName } from './localtime.js';

const KEY = (site) => `taBrokerFollow:${site}`;     // trip → { since, by, byEmail, source, askedAt, asks, sent }
const REASK_MS = 2 * 3600000;
const MAX_ASKS = 2;
const STAFF_DOMAIN = /@floridabeauty\.us$/i;
const LINK_PURPOSE = 'delivery-confirm';
const DAY = 86400000;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders || tripOf(it).freightBills)) || [];

// The commitments a person set on this load (never one filled in from the rate con, TruckMate or an old load). Pure.
export function confirmedCommits(commits = {}) {
  return Object.fromEntries(Object.entries(commits || {}).filter(([, c]) => c && c.atMs && c.by && !c.auto && !c.fromRC && !c.fromTM && !c.fromSheet && !c.fcfs && !c.cleared));
}

// The delivery stops still open on a load, in bill order. Pure.
export function openStops(item) {
  const out = new Map();
  for (const b of billsOf(item)) {
    if (b.actualDelivery) continue;
    const p = String(b.endZoneDescription || '').split(',').map((x) => x.trim());
    const city = p[0]; const state = (p[1] || '').slice(0, 2).toUpperCase();
    const k = stopKey(city, state);
    if (k && !out.has(k)) out.set(k, { key: k, city, state, customer: b.billToName || null });
  }
  return [...out.values()];
}

const cleanName = (x) => String(x || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
const SOURCE = (c) => (c.fromRC ? 'rate con' : c.fromTM ? 'TruckMate' : c.fromSheet ? 'trip sheet' : c.auto ? 'saved from a previous load' : 'on file');
const friendlyDate = (local) => new Date(`${String(local).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const friendlyTime = (local) => { const [h, m] = String(local).slice(11, 16).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// One entry per open stop still needing a person's confirmation: same stops and keys as openStops, never split or joined from display text.
// Names come from the rate con when it matches the stop (a bill-to can be the broker). A time on file stays visible, marked as unconfirmed. Pure.
export function requestStops(item, commits = {}) {
  const mine = confirmedCommits(commits);
  const rc = ((item && item._ratecon && item._ratecon.deliveries) || []);
  return openStops(item).filter((s) => !mine[s.key]).map((s) => {
    const billed = [...new Set(billsOf(item).filter((b) => !b.actualDelivery && stopKey(...String(b.endZoneDescription || '').split(',').map((x) => x.trim())) === s.key).map((b) => cleanName(b.billToName)).filter(Boolean))];
    const del = rc.find((d) => stopKey(d.city, d.state) === s.key);
    const c = (commits || {})[s.key] || null;
    const tentative = c && !c.cleared ? c : null;
    return { ...s, name: cleanName(del && del.name) || billed.join(' · ') || null, reference: (del && del.refs) || null,
      date: tentative ? (tentative.local ? friendlyDate(tentative.local) : tentative.day || null) : null,
      time: tentative ? (tentative.fcfs ? `First come, first served${tentative.hours ? ` ${tentative.hours}` : ''}` : tentative.local ? friendlyTime(tentative.local) : null) : null,
      zone: tentative && tentative.local ? `${zoneName(tzOf(`${s.city}, ${s.state}`))} (local at the stop)` : null, source: tentative ? SOURCE(tentative) : null };
  });
}

// The email asking for the time. Layout + wording only: who gets it and when come from the caller. Pure.
export function askEmail(trip, item, { again = false, commits = {}, internal = true, confirmUrl = null } = {}) {
  const { FONT, NAVY, TEXT, MUTED, LINE, TRAINING_SLOT } = emailParts;
  const t = tripOf(item);
  const subject = `Trip ${trip}: what time does truck ${t.powerUnit || ''} need to be at delivery?`.replace('truck  need', 'the truck need');
  const stops = requestStops(item, commits);
  const one = stops.length <= 1;
  const title = one ? 'Please confirm delivery appointment' : 'Please confirm delivery appointments';
  const intro = `Please confirm the delivery date and appointment time or receiving window ${one ? 'for the location below' : 'for each location below'}.`;
  const lead = again ? 'Reminder: this is still needed to follow up on this load.' : null;
  const rc = (item && item._ratecon) || {};
  const ref = [rc.broker ? `Broker ${rc.broker}` : null, rc.loadNumber ? `Load ${rc.loadNumber}` : null].filter(Boolean).join(' · ');
  const label = (s) => [s.name, s.city, s.state].filter(Boolean).join(', ');
  const replyLine = (s) => `${label(s) || 'Delivery'}: [Date] · [Time or window] · [Timezone]`;
  const mark = (v, s) => (v ? `${v} · Please confirm (${s.source})` : null);
  const rows = (s) => [['Delivery date', mark(s.date, s) || 'Awaiting confirmation'], ['Time or window', mark(s.time, s) || 'Awaiting confirmation'], ['Timezone', mark(s.zone, s) || 'Please specify'], ...(s.reference ? [['Reference', s.reference]] : [])];
  const noAppt = 'No appointment required? Please provide receiving hours and any check-in requirements.';
  const assumed = 'If a reply gives no timezone, Jarvis reads the time as local at the stop.';
  const how = internal ? 'Reply to this email, or update the corresponding stop in the dispatch console.' : 'Reply to this email.';
  const timing = 'Delivery timing remains unconfirmed. Jarvis will not classify a delivery as late against an unconfirmed appointment.';
  const card = (s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border:1px solid ${LINE};border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};">
<div style="font-size:16px;font-weight:bold;color:${NAVY};word-break:break-word;">&#128205; ${esc(s.name || `${s.city}, ${s.state}`)}</div><div style="padding-bottom:8px;font-size:15px;color:${MUTED};">${esc(`${s.city}, ${s.state}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows(s).map(([k, v]) => `<tr><td width="38%" style="padding:6px 8px 6px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:15px;color:${MUTED};vertical-align:top;">${esc(k)}</td><td style="padding:6px 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:15px;color:${TEXT};vertical-align:top;word-break:break-word;">${esc(v)}</td></tr>`).join('')}</table></td></tr></table>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media (max-width:480px){.ts-pad{padding-left:16px!important;padding-right:16px!important}}
@media (prefers-color-scheme:dark){.fb-page{background:#0B1220!important}.fb-card,.fb-card td,.fb-card table{background:#14202F!important;color:#E5E7EB!important;border-color:#334155!important}.fb-card div,.fb-card b{color:#E5E7EB!important}.fb-card .fb-blue,.fb-card .fb-blue td,.fb-card .fb-blue div,.fb-card .fb-blue b{background:#17324F!important;color:#DBEAFE!important}.fb-card .fb-gray,.fb-card .fb-gray td,.fb-card .fb-gray div,.fb-card .fb-gray b{background:#1E293B!important;color:#CBD5E1!important}}</style></head>
<body class="fb-page" style="margin:0;padding:0;background:#F1F5F9;"><table class="fb-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;">
<table class="fb-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td class="ts-pad" align="center" style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;letter-spacing:2px;color:${NAVY};">FLORIDA BEAUTY</td></tr>
<tr><td class="ts-pad" align="center" style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td class="ts-pad" style="padding:16px 24px 0;"><table class="fb-blue" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:8px;"><tr><td align="center" style="padding:12px 16px;font-family:${FONT};font-size:14px;font-weight:bold;letter-spacing:1px;color:${NAVY};">&#128197; CONFIRMATION REQUESTED</td></tr></table></td></tr>
<tr><td class="ts-pad" align="center" style="padding:16px 24px 0;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:bold;color:${NAVY};">${esc(title)}</td></tr>
<tr><td class="ts-pad" align="center" style="padding:4px 24px 0;font-family:${FONT};font-size:16px;color:${MUTED};">Trip ${esc(trip)}${t.powerUnit ? ` · Truck ${esc(t.powerUnit)}` : ''}${ref ? `<div style="font-size:14px;word-break:break-word;">${esc(ref)}</div>` : ''}</td></tr>
<tr><td class="ts-pad" style="padding:14px 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};">${lead ? `<b>${esc(lead)}</b><br>` : ''}${esc(intro)}</td></tr>
<tr><td class="ts-pad" style="padding:0 24px;">${stops.map(card).join('')}</td></tr>
${confirmUrl ? `<tr><td class="ts-pad" style="padding:2px 24px 16px;"><a href="${esc(confirmUrl)}" style="display:block;padding:16px 18px;border-radius:6px;background:${NAVY};font-family:${FONT};font-size:20px;font-weight:bold;text-align:center;color:#FFFFFF;text-decoration:none;">&#128197; Set date and time</a><div style="padding-top:6px;font-family:${FONT};font-size:13px;text-align:center;color:${MUTED};">Opens a page with a calendar and clock. Submit it there.</div></td></tr>` : ''}
<tr><td class="ts-pad" style="padding:0 24px;"><table class="fb-blue" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><div style="padding-bottom:6px;font-size:17px;font-weight:bold;color:${NAVY};">${confirmUrl ? 'Or reply with these details' : 'Reply with these details'}</div>${(stops.length ? stops : [{}]).map((s) => `<div style="padding:3px 0;word-break:break-word;"><b>${esc(label(s) || 'Delivery')}:</b> [Date] · [Time or window] · [Timezone]</div>`).join('')}<div style="padding-top:8px;font-size:14px;color:${MUTED};">${esc(noAppt)}</div><div style="padding-top:4px;font-size:14px;color:${MUTED};">${esc(assumed)}</div></td></tr></table></td></tr>
<tr><td class="ts-pad" style="padding:14px 24px;font-family:${FONT};font-size:15px;color:${TEXT};">${esc(how)}</td></tr>
<tr><td class="ts-pad" style="padding:0 24px;"><table class="fb-gray" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F7FA" style="background:#F5F7FA;border-radius:8px;"><tr><td style="padding:12px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};"><b style="color:${NAVY};">Timing status</b><br>${esc(timing)}</td></tr></table></td></tr>
<tr><td class="ts-pad" style="padding:18px 24px 20px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};">Thank you,<br><b style="color:${NAVY};">Jarvis</b><br>AI Dispatcher · Florida Beauty</td></tr>
</table></td></tr></table></body></html>`;
  const text = ['FLORIDA BEAUTY — Dispatch notifications', '', 'CONFIRMATION REQUESTED', title, `Trip ${trip}${t.powerUnit ? ` · Truck ${t.powerUnit}` : ''}`, ...(ref ? [ref] : []), '', ...(lead ? [lead] : []), intro, '',
    ...stops.flatMap((s) => [s.name || `${s.city}, ${s.state}`, `${s.city}, ${s.state}`, ...rows(s).map(([k, v]) => `  ${k}: ${v}`), '']),
    ...(confirmUrl ? [`Set date and time: ${confirmUrl}`, ''] : []), confirmUrl ? 'OR REPLY WITH THESE DETAILS' : 'REPLY WITH THESE DETAILS', ...(stops.length ? stops : [{}]).map(replyLine), noAppt, assumed, '', how, '', 'TIMING STATUS', timing, '', 'Thank you,', 'Jarvis', 'AI Dispatcher · Florida Beauty'].join('\n');
  return { subject, text, html };
}

// The page behind the button: the phone's own calendar and clock for each stop. Pure.
export function confirmPage(p, stops, by, note = null) {
  const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;color:#1F2937}main{max-width:520px;margin:0 auto;padding:16px}.c{background:#fff;border-radius:10px;padding:20px}h1{margin:0 0 2px;font-size:24px;color:#13325B}.s{margin:0 0 16px;color:#5B6778}.t{border:1px solid #E2E8F0;border-radius:8px;padding:14px;margin-bottom:12px}.n{font-weight:bold;color:#13325B;word-break:break-word}.w{color:#5B6778;margin-bottom:8px}label{display:block;font-weight:bold;margin:12px 0 6px;color:#13325B}input{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:18px;min-height:48px;padding:10px 12px;border:1px solid #B8C3D3;border-radius:8px;background:#fff;color:#1F2937}.z,.f{font-size:14px;color:#5B6778;margin-top:6px}button{width:100%;margin-top:14px;min-height:52px;font:inherit;font-weight:bold;font-size:18px;color:#fff;background:#13325B;border:0;border-radius:8px}button:disabled{opacity:.6}.e{color:#C62828;margin-top:10px}</style></head><body><main><div class="c">${body}</div></main></body></html>`;
  if (!p) return shell('Link not valid', '<h1>This link has expired</h1><p class="s">Set the time on the stop in the console, or reply to the email.</p>');
  if (note) return shell('Delivery times', `<h1>Delivery times</h1><p class="s">Trip ${esc(p.t)}</p><p>${esc(note)}</p>`);
  const card = (s, i) => `<div class="t" data-key="${esc(s.key)}"><div class="n">${esc(s.name || `${s.city}, ${s.state}`)}</div><div class="w">${esc(`${s.city}, ${s.state}`)}</div><label for="d${i}">Delivery date</label><input id="d${i}" type="date" value="${esc(s.dateValue || '')}"><label for="h${i}">Appointment time</label><input id="h${i}" type="time" value="${esc(s.timeValue || '')}"><div class="z">${esc(zoneName(tzOf(`${s.city}, ${s.state}`)))} time, local at the stop${s.source ? `. Filled in from the ${esc(s.source)}: please confirm.` : ''}</div></div>`;
  return shell(`Confirm delivery, trip ${p.t}`, `<h1>Set date and time</h1><p class="s">Trip ${esc(p.t)}</p><form id="f">${stops.map(card).join('')}<label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name" value="${esc(by || '')}"><button id="b" type="submit">Submit</button><div class="e" id="e" role="alert"></div></form><p class="f">Jarvis answers on the email thread. No appointment? Reply to the email with the receiving hours.</p><script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');var stops=[].map.call(document.querySelectorAll('.t'),function(t){var i=t.querySelectorAll('input');return{key:t.getAttribute('data-key'),date:i[0].value,time:i[1].value};});if(stops.some(function(x){return(!x.date)!==(!x.time);})){e.textContent='Each stop needs both a date and a time.';return;}b.disabled=true;e.textContent='';try{var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('n').value,stops:stops})});var j=await r.json();if(!r.ok)throw new Error(j.error||'Could not save.');document.querySelector('.c').innerHTML=j.example?'<h1>Example only</h1><p class="s">Nothing was saved and no email went out. On a real load this is where it says Confirmed.</p>':'<h1>Confirmed</h1><p class="s">Saved. Jarvis will watch the ETA against this time. You can close this page.</p>';}catch(x){e.textContent=x.message;b.disabled=false;}});</script>`);
}

// What goes back on the thread once times are set. Pure.
export function confirmedReply(trip, item, saved, by, left = []) {
  const t = tripOf(item);
  const line = (s) => `${[s.name, `${s.city}, ${s.state}`].filter(Boolean).join(', ')}: ${friendlyDate(s.local)}, ${friendlyTime(s.local)} ${zoneName(tzOf(`${s.city}, ${s.state}`))} time`;
  const follow = 'I will follow this load through and watch the ETA against this time to make sure the truck arrives on time. If it looks more than an hour late, the team gets an email.';
  const still = left.length ? `Still needed: ${left.map((s) => `${s.city}, ${s.state}`).join('; ')}.` : null;
  const head = `Confirmed for trip ${trip}${t.powerUnit ? `, truck ${t.powerUnit}` : ''}.`;
  return { text: [head, ...saved.map(line), `Confirmed by ${by}.`, follow, still, 'Jarvis · AI Dispatcher · Florida Beauty'].filter(Boolean).join('\n'),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937"><p><b>${esc(head)}</b></p>${saved.map((s) => `<p style="margin:0 0 6px">${esc(line(s))}</p>`).join('')}<p>Confirmed by ${esc(by)}.</p><p>${esc(follow)}</p>${still ? `<p><b>${esc(still)}</b></p>` : ''}<p style="font-size:14px;color:#5B6778">Jarvis · AI Dispatcher · Florida Beauty</p></div>` };
}

export function initBrokerFollow(app, { requireAuth, db, getBoard, commitments, sendMail, listEmails = async () => [], secret = null, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', replyInThread = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const site0 = 'florida-beauty';
  const all = async (site = site0) => (enabled ? (await db.get(KEY(site), {})) || {} : {});
  const save = (site, fn) => db.update(KEY(site), (cur) => fn({ ...(cur || {}) }), {});
  const itemFor = async (site, trip) => ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => tripNo(it) === String(trip)) || null;
  // the question goes only to one of our own people, for real even while training mode is on
  const ask = async (f, trip, item, again) => {
    if (!f.byEmail || !STAFF_DOMAIN.test(f.byEmail)) return false;
    const confirmUrl = secret ? `${baseUrl}/dc/${makeToken({ t: trip, by: f.by || null }, secret, now(), LINK_PURPOSE)}` : null;
    await sendMail({ to: [f.byEmail], ...askEmail(trip, item, { again, commits: (await commitments.all())[trip], confirmUrl }) }, { direct: true });
    return true;
  };

  // deliverAt: 'YYYY-MM-DDTHH:MM' at the stop, when they already said it. city: which stop on a multi-stop load.
  async function start(site, trip, { by = null, byEmail = null, source = 'email', deliverAt = null, city = null, emailId = null } = {}) {
    const t = String(trip || '').replace(/\D/g, '');
    const item = await itemFor(site, t);
    if (!item) return { ok: false, error: `Trip ${t} is not on the board.` };
    if (!brokerLoad(item)) return { ok: false, notBroker: true, error: `Trip ${t} is an outbound load from our hub, not a broker load.` };
    await save(site, (c) => { c[t] = { sent: {}, asks: 0, ...(c[t] || {}), since: (c[t] && c[t].since) || new Date(now()).toISOString(), by, byEmail: byEmail ? String(byEmail).toLowerCase() : (c[t] && c[t].byEmail) || null, emailId: emailId || (c[t] && c[t].emailId) || null, source }; return c; });
    if (deliverAt) { const r = await confirm(site, t, { deliverAt, city, by }); if (r.ok) return { ok: true, confirmed: true, ...r }; }
    const commits = confirmedCommits((await commitments.all())[t]);
    if (Object.keys(commits).length) return { ok: true, confirmed: true };
    const cur = (await all(site))[t];
    const asked = await ask(cur, t, item, false).catch((e) => { console.warn('[broker-follow]', e.message); return false; });
    if (asked) await save(site, (c) => { c[t] = { ...c[t], askedAt: new Date(now()).toISOString(), asks: (c[t].asks || 0) + 1 }; return c; });
    return { ok: true, confirmed: false, asked, needTime: true };
  }

  async function confirm(site, trip, { deliverAt, city = null, by = null } = {}) {
    const t = String(trip || '').replace(/\D/g, '');
    if (!(await all(site))[t]) return { ok: false, error: `Jarvis is not following up on trip ${t}.` };
    const local = String(deliverAt || '').slice(0, 16);
    const item = await itemFor(site, t);
    const stops = item ? openStops(item) : [];
    // "West Sacramento" or "West Sacramento, CA". Two stops with the same city name and no state: ask, never pick one
    const [wantCity, wantState] = String(city || '').split(',').map((x) => x.trim().toUpperCase());
    const hits = wantCity ? stops.filter((s) => s.city.toUpperCase() === wantCity && (!wantState || s.state === wantState.slice(0, 2))) : stops.length === 1 ? stops : [];
    const st = hits.length === 1 ? hits[0] : null;
    if (!st) return { ok: false, error: stops.length > 1 ? `Which stop? ${stops.map((s) => `${s.city}, ${s.state}`).join(' or ')}` : 'No open delivery stop on this load.' };
    const r = await commitments.commit(t, { ...st, local, by: by || 'staff' });
    return r ? { ok: true, stop: `${st.city}, ${st.state}`, local } : { ok: false, error: 'That date and time could not be read.' };
  }

  // The page's Submit. Every time is checked before any is saved; a stop already confirmed is left alone. Then the thread hears it, once.
  async function submitTimes(site, p, { name, stops: picks } = {}) {
    const t = String(p.t);
    const f = (await all(site))[t];
    const item = await itemFor(site, t);
    if (!f || !item) return { code: 410, error: 'Jarvis is no longer following up on this load.' };
    const by = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!by) return { code: 400, error: 'Add your name.' };
    const open = requestStops(item, (await commitments.all())[t] || {});
    if (!open.length) return { code: 409, error: 'These stops are already confirmed.' };
    const filled = (Array.isArray(picks) ? picks : []).slice(0, 30).filter((x) => x && x.date && x.time);
    if (!filled.length) return { code: 400, error: 'Pick a date and time.' };
    const valid = [];
    for (const x of filled) {
      const st = open.find((s) => s.key === x.key);
      if (!st) continue;
      const local = `${x.date}T${x.time}`.slice(0, 16);
      const ms = commitMs(local, st.state);
      if (!ms) return { code: 400, error: `That date or time could not be read for ${st.city}, ${st.state}.` };
      if (ms < now() - DAY) return { code: 400, error: `That date for ${st.city}, ${st.state} has already passed.` };
      valid.push({ ...st, local });
    }
    if (!valid.length) return { code: 409, error: 'These stops are already confirmed.' };
    // two people submitting at once: the first one counts
    let won = [];
    await save(site, (c) => { const set = { ...((c[t] && c[t].linkSet) || {}) }; won = valid.filter((v) => !set[v.key]); for (const v of won) set[v.key] = { local: v.local, by, at: new Date(now()).toISOString() }; c[t] = { ...c[t], linkSet: set }; return c; });
    if (!won.length) return { code: 409, error: 'These stops are already confirmed.' };
    for (const v of won) await commitments.commit(t, { key: v.key, city: v.city, state: v.state, customer: v.customer, local: v.local, by }); // eslint-disable-line no-await-in-loop
    const left = open.filter((s) => !won.some((v) => v.key === s.key));
    const m = confirmedReply(t, item, won, by, left);
    let told = false;
    try {
      if (replyInThread && f.emailId) told = !!(await replyInThread(site, f.emailId, { ...m, by: 'Jarvis (delivery confirmation)' })).sent;
      if (!told && f.byEmail && STAFF_DOMAIN.test(f.byEmail)) { await sendMail({ to: [f.byEmail], subject: `Re: ${askEmail(t, item).subject}`, ...m }, { direct: true }); told = true; }
    } catch (e) { console.warn('[broker-follow] confirmed reply:', e.message); }
    return { code: 200, ok: true, told, stops: won.map((v) => v.key) };
  }

  // after each board refresh: ask again once, and over an hour late against a confirmed time → one email per stop + time
  async function process(site, board) {
    if (!enabled) return { sent: 0 };
    const follows = await all(site);
    const ids = Object.keys(follows);
    if (!ids.length) return { sent: 0 };
    const items = (board && board.trips) || [];
    const commits = await commitments.all();
    const etas = ((await db.get(`taWatch:${site}`, {})) || {}).etas || {};
    let n = 0;
    for (const trip of ids) {
      const f = follows[trip];
      const it = items.find((x) => tripNo(x) === trip);
      if (!it) { await save(site, (c) => { delete c[trip]; return c; }); continue; }   // delivered / off the board
      const mine = confirmedCommits(commits[trip]);
      if (!Object.keys(mine).length) {
        if ((f.asks || 0) > 0 && (f.asks || 0) < MAX_ASKS && now() - Date.parse(f.askedAt) >= REASK_MS) {
          const sentOk = await ask(f, trip, it, true).catch(() => false);
          if (sentOk) await save(site, (c) => { c[trip] = { ...c[trip], askedAt: new Date(now()).toISOString(), asks: (c[trip].asks || 0) + 1 }; return c; });
        }
        continue;
      }
      for (const st of lateStops({ commits: mine, etas: etas[trip], leftAt: Date.parse(f.since), now: now() })) {
        const id = `${st.key}|${st.local}`;
        if ((f.sent || {})[id]) continue;
        const m = lateMessage(it, st);
        const mail = { subject: m.subject.replace(/^Late for a committed time/, 'Will miss the delivery time'), html: m.html, text: m.text };
        try {
          const list = await listEmails();
          if (list.length) await sendMail({ to: list, ...mail });
          if (f.byEmail && STAFF_DOMAIN.test(f.byEmail) && !list.includes(f.byEmail)) await sendMail({ to: [f.byEmail], ...mail }, { direct: true });
          await save(site, (c) => { c[trip] = { ...c[trip], sent: { ...(c[trip].sent || {}), [id]: new Date(now()).toISOString() } }; return c; });
          n += 1;
        } catch (e) { console.warn('[broker-follow] alert:', e.message); }
      }
    }
    return { sent: n };
  }

  // on the board: a followed load with a confirmed time → watchtower may call it late
  async function overlay(site, trips) {
    const follows = await all(site);
    if (!Object.keys(follows).length) return;
    const commits = await commitments.all();
    for (const it of trips) {
      const f = follows[tripNo(it)];
      if (f) it._brokerFollow = { by: f.by, since: f.since, confirmed: Object.keys(confirmedCommits(commits[tripNo(it)])).length > 0 };
    }
  }

  if (app) {
    // the link in the email: opening it changes nothing (mail scanners open links), only Submit does
    app.get('/dc/:token', async (req, res) => {
      const p = secret ? readToken(req.params.token, secret, now(), LINK_PURPOSE) : null;
      res.set('Cache-Control', 'no-store').type('html');
      if (!p) return res.send(confirmPage(null));
      const f = (await all())[String(p.t)]; const item = await itemFor(site0, p.t);
      if (p.x && item) return res.send(confirmPage(p, requestStops(item, {}), p.by));   // an example: the real page, and Submit saves nothing
      if (!f || !item) return res.send(confirmPage(p, [], null, 'Jarvis is no longer following up on this load.'));
      const commits = (await commitments.all())[String(p.t)] || {};
      const stops = requestStops(item, commits).map((s) => { const local = (commits[s.key] || {}).local || ''; return { ...s, dateValue: local.slice(0, 10), timeValue: local.slice(11, 16) }; });
      return res.send(stops.length ? confirmPage(p, stops, f.by || p.by) : confirmPage(p, [], null, 'These stops are already confirmed.'));
    });
    app.post('/dc/:token', async (req, res) => {
      const p = secret ? readToken(req.params.token, secret, now(), LINK_PURPOSE) : null;
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      if (p.x) return res.json({ ok: true, example: true });
      try { const r = await submitTimes(site0, p, req.body || {}); return res.status(r.code).json(r); } catch (e) { console.warn('[broker-follow]', e.message); return res.status(500).json({ error: 'Could not save. Set it in the console.' }); }
    });
    app.get('/truckmate/broker-follow', requireAuth, async (req, res) => res.json(await all(String(req.query.site || site0))));
    app.delete('/truckmate/broker-follow/:trip', requireAuth, async (req, res) => { await save(String(req.query.site || site0), (c) => { delete c[String(req.params.trip)]; return c; }); res.json({ ok: true }); });
  }
  const exampleLink = (trip, by) => (secret ? `${baseUrl}/dc/${makeToken({ t: String(trip), by, x: true }, secret, now(), LINK_PURPOSE)}` : null);
  return { start, confirm, submitTimes, exampleLink, process, overlay, all };
}

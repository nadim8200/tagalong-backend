// ---------------------------------------------------------------
// Outbound follow-up emails to our staff ("Flower outbound follow-up"): one block per
// trip, grouped by region + scheduled date — trip, scheduled pickup / departure / meetup,
// current VERIFIED status, next action — and only the specific details still missing.
// Statuses come from system records only (TruckMate / GPS / recorded sends); anything
// else is "Awaiting confirmation" / "Not verified". All pure.
// ---------------------------------------------------------------
import { TZ_BY_STATE, wallMs } from './pickupfollow.js';

const MIN = 60000;
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tripOf = (it) => (it && it.trip) || it || {};
const STARTED = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE)/i;

// time zone named in the email → IANA (never guessed from a region)
const ZONES = { ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', EASTERN: 'America/New_York', MIAMI: 'America/New_York', CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago', CENTRAL: 'America/Chicago', MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver', MOUNTAIN: 'America/Denver', PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PACIFIC: 'America/Los_Angeles' };
const ABBR = { 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Phoenix': 'MST (AZ)', 'America/Los_Angeles': 'PT' };
const STATES = { FLORIDA: 'FL', CALIFORNIA: 'CA', GEORGIA: 'GA', TEXAS: 'TX', 'NEW JERSEY': 'NJ', 'NEW YORK': 'NY', ILLINOIS: 'IL', PENNSYLVANIA: 'PA', 'NORTH CAROLINA': 'NC', ARIZONA: 'AZ', WASHINGTON: 'WA', OREGON: 'OR' };
const EASTERN = new Set(['FL', 'GA', 'SC', 'NC', 'VA', 'WV', 'MD', 'DE', 'DC', 'NJ', 'NY', 'PA', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME', 'OH', 'MI', 'IN', 'KY']);
export const zoneNamed = (raw) => ZONES[String(raw || '').toUpperCase().replace(/[^A-Z]/g, '')] || null;
const originState = (item) => { const m = String(tripOf(item).origZoneDesc || '').match(/,\s*([A-Z]{2})\b/); return m ? m[1] : null; };
const regionState = (region) => { const r = String(region || '').toUpperCase().trim(); return STATES[r] || (/^[A-Z]{2}$/.test(r) ? r : null); };

// The time zone for a scheduled time: stated in the email, else the load's own origin on the
// board — and only when that doesn't contradict the region the email gives. Pure.
export function validateZone(ins, item) {
  const said = zoneNamed(ins && ins.tz);
  if (said) return { tz: said, how: 'stated in the email' };
  const st = originState(item);
  const reg = regionState(ins && ins.region);
  if (!st) return { tz: null, issue: 'time zone not stated and the load has no origin on the board' };
  if (reg && reg !== st) return { tz: null, issue: `the email says ${ins.region} but the load starts in ${st}` };
  const tz = TZ_BY_STATE[st] || (EASTERN.has(st) ? 'America/New_York' : null);
  return tz ? { tz, how: `load origin ${st}` } : { tz: null, issue: `time zone for ${st} not known` };
}

const EVENT = { pickup: 'Pickup', departure: 'Departure', meetup: 'Meetup' };
const fmtDate = (ymd) => { const d = new Date(`${ymd}T12:00:00Z`); return isNaN(d) ? ymd : d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
const fmtClock = (hm) => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const fmtAt = (ms, tz) => new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
// "35 degrees" → shown with its unit only when the email gives one
export const tempNote = (raw) => { const s = String(raw || '').trim(); if (!s) return null; return /°\s*[FC]\b|\b(fahrenheit|celsius)\b|\d\s*[FC]\b/i.test(s) ? `Temperature: ${s}` : `Temperature: ${s} — unit not stated, verify (°F?)`; };

// One staff follow-up item → the trip block. ins: parsed pickup_followup (or note/task) with
// its result; item: the board load (or null); ctx: { now, reachable(item) }. Pure.
export function tripBlock(ins, item, { now = Date.now(), reachable = () => false } = {}) {
  const ev = EVENT[ins.event] || (ins.kind === 'pickup_followup' ? 'Pickup' : null);
  const zone = ins.date && ins.time ? validateZone(ins, item) : null;
  const ms = zone && zone.tz ? wallMs(ins.date, +ins.time.slice(0, 2), +ins.time.slice(3, 5), zone.tz) : null;
  const when = ins.date ? `${fmtDate(ins.date)}, ${ins.time ? `${fmtClock(ins.time)}${zone && zone.tz ? ` ${ABBR[zone.tz] || ''}` : ' (time zone not confirmed)'}` : ins.timeText ? `${ins.timeText} (exact time not given)` : 'time not given'}` : ins.timeText || null;
  const scheduled = ev ? `${ev}${ins.place ? ` · ${ins.place}` : ''}${when ? ` · ${when}` : ''}` : 'No time given';
  const details = [];
  if (ins.message) details.push(`Requested: ${ins.message}`);
  const t = tempNote(ins.temp); if (t) details.push(t);
  // current status — only from system records
  const st = String(tripOf(item).status || '');
  let status;
  if (!item) status = { label: 'Not verified', tone: 'amber', text: `Trip ${ins.trip} is not on the active board` };
  else if (STARTED.test(st)) status = { label: 'Departed', tone: 'green', text: `TruckMate: ${st}` };
  else if (ms && now > ms + 30 * MIN) status = { label: 'Not departed', tone: 'red', text: `${Math.round((now - ms) / MIN)} min past the scheduled time — TruckMate shows ${st || 'no status'}` };
  else status = { label: 'Awaiting confirmation', tone: 'amber', text: `Confirmation pending — TruckMate shows ${st || 'no status'}` };
  // next action — what is actually set up, or the one detail missing
  let next; let need = null;
  if (ins.result && ins.result.error) next = `Could not set up: ${ins.result.error}`;
  else if (ev && !ins.date) { need = `the ${ev.toLowerCase()} date for ${ins.trip}`; next = `Need the ${ev.toLowerCase()} date — reply with it`; }
  else if (ev && !ins.time) { need = `the exact ${ev.toLowerCase()} time for ${ins.trip}${ins.place ? ` (${ins.place})` : ''}`; next = `Need the exact ${ev.toLowerCase()} time — reply with it and Jarvis follows up`; }
  else if (ev && zone && !zone.tz) { need = `the time zone for ${ins.trip}'s ${fmtClock(ins.time)} ${ev.toLowerCase()} (${zone.issue})`; next = `Need the time zone — ${zone.issue}`; }
  else if (ev && status.tone === 'green') next = 'Nothing — already departed';
  else if (ev && ms) {
    const checks = [ms - 60 * MIN, ms - 30 * MIN].filter((x) => x > now).map((x) => fmtAt(x, zone.tz));
    next = reachable(item)
      ? `Jarvis checks in with the driver${checks.length ? ` at ${checks.join(' and ')} ${ABBR[zone.tz] || ''}` : ' now'}, then replies here when it departs`
      : 'Dispatch: confirm with the driver — Jarvis can\'t reach them (no texting consent or app on file). Jarvis watches TruckMate / GPS and replies here when it departs';
  } else next = ins.result && typeof ins.result.sent === 'string' ? ins.result.sent : ins.result && ins.result.skipped ? ins.result.skipped : 'Confirmation pending';
  const region = ins.region || (originState(item) ? Object.keys(STATES).find((k) => STATES[k] === originState(item)) || originState(item) : null);
  return { trip: ins.trip, group: [region ? region.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) : null, ins.date ? fmtDate(ins.date) : null].filter(Boolean).join(' · ') || 'Other', sortKey: `${ins.date || '9999'} ${ins.time || '99'}`, scheduled, status, next, need, details };
}

const TONE = { amber: { bg: '#FEF3C7', fg: '#78350F', bd: '#F59E0B' }, green: { bg: '#DCFCE7', fg: '#14532D', bd: '#22C55E' }, red: { bg: '#FEE2E2', fg: '#7F1D1D', bd: '#EF4444' } };
const NAVY = '#1E3A5F';
const F = 'font-family:Arial,Helvetica,sans-serif';

// The whole email. blocks: tripBlock() results (+ optional extra rows {title, text}). Pure.
export function renderOutboundFollowUp({ heading = 'Flower outbound follow-up', blocks = [], extras = [], closing = null }) {
  const groups = [];
  for (const b of [...blocks].sort((a, c) => a.sortKey.localeCompare(c.sortKey))) { let g = groups.find((x) => x.title === b.group); if (!g) groups.push(g = { title: b.group, list: [] }); g.list.push(b); }
  const regions = [...new Set(groups.map((g) => g.title))];
  const summary = `${blocks.length} trip${blocks.length === 1 ? '' : 's'}${regions.length && regions[0] !== 'Other' ? ` · ${regions.join(' and ')}` : ''}`;
  const needs = blocks.filter((b) => b.need).map((b) => b.need);
  const row = (k, v) => `<tr><td style="${F};font-size:13px;color:#4B5563;padding:4px 0 0 0">${esc(k)}</td></tr><tr><td style="${F};font-size:16px;line-height:1.5;color:#111827;padding:0 0 2px 0;word-break:break-word">${v}</td></tr>`;
  const card = (b) => { const t = TONE[b.status.tone]; return `<tr><td style="padding:0 0 16px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #D1D5DB;border-radius:6px" bgcolor="#FFFFFF"><tr><td style="padding:18px 20px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="${F};font-size:18px;font-weight:bold;color:${NAVY}">Trip ${esc(b.trip)}</td></tr>
<tr><td style="padding:6px 0 4px 0"><span style="${F};display:inline-block;font-size:13px;font-weight:bold;color:${t.fg};background:${t.bg};border:1px solid ${t.bd};border-radius:4px;padding:2px 8px">${esc(b.status.label)}</span></td></tr>
${row('Scheduled', esc(b.scheduled))}${row('Current status', esc(b.status.text))}${row('Next action', esc(b.next))}${b.details.map((d) => `<tr><td style="${F};font-size:13px;line-height:1.4;color:#4B5563;padding:6px 0 0 0">${esc(d)}</td></tr>`).join('')}</table></td></tr></table></td></tr>`; };
  const html = `<div style="margin:0;padding:0;background:#F3F4F6" bgcolor="#F3F4F6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:600px;margin:0 auto;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td style="padding:20px 20px 4px 20px;${F};font-size:20px;font-weight:bold;color:${NAVY}">${esc(heading)}</td></tr>
<tr><td style="padding:0 20px 12px 20px;${F};font-size:16px;line-height:1.5;color:#1F2937;border-bottom:1px solid #E5E7EB">${esc(summary)}</td></tr>
${groups.map((g) => `<tr><td style="padding:16px 20px 8px 20px;${F};font-size:16px;font-weight:bold;color:${NAVY}">${esc(g.title)}</td></tr><tr><td style="padding:0 20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${g.list.map(card).join('')}</table></td></tr>`).join('')}
${extras.length ? `<tr><td style="padding:4px 20px 8px 20px;border-top:1px solid #E5E7EB">${extras.map((x) => `<p style="margin:10px 0 0 0;${F};font-size:16px;line-height:1.5;color:#1F2937"><b>${esc(x.title)}</b><br>${esc(x.text)}</p>`).join('')}</td></tr>` : ''}
${needs.length ? `<tr><td style="padding:12px 20px 4px 20px;border-top:1px solid #E5E7EB;${F};font-size:16px;font-weight:bold;color:${NAVY}">Still needed from dispatch</td></tr><tr><td style="padding:0 20px 8px 20px">${needs.map((n) => `<p style="margin:6px 0;${F};font-size:16px;line-height:1.5;color:#1F2937">• ${esc(n[0].toUpperCase() + n.slice(1))}</p>`).join('')}<p style="margin:6px 0;${F};font-size:13px;color:#4B5563">Reply on this email and Jarvis completes them.</p></td></tr>` : ''}
${closing ? `<tr><td style="padding:8px 20px;${F};font-size:16px;line-height:1.5;color:#1F2937">${esc(closing)}</td></tr>` : ''}
<tr><td style="padding:12px 20px 20px 20px;${F};font-size:13px;color:#4B5563;border-top:1px solid #E5E7EB">Jarvis — AI Dispatcher · Florida Beauty Flora</td></tr></table></div>`;
  const text = [heading.toUpperCase(), summary, '',
    ...groups.flatMap((g) => [`== ${g.title} ==`, ...g.list.flatMap((b) => [`Trip ${b.trip} — ${b.status.label.toUpperCase()}`, `  Scheduled: ${b.scheduled}`, `  Current status: ${b.status.text}`, `  Next action: ${b.next}`, ...b.details.map((d) => `  ${d}`), ''])]),
    ...extras.map((x) => `${x.title}: ${x.text}`),
    ...(needs.length ? ['STILL NEEDED FROM DISPATCH', ...needs.map((n) => `- ${n}`), 'Reply on this email and Jarvis completes them.', ''] : []),
    ...(closing ? [closing, ''] : []), 'Jarvis — AI Dispatcher · Florida Beauty Flora'].join('\n');
  return { html, text, summary, needs };
}

// Identity of what an acknowledgment says (source message + each trip's action / status /
// next step) — the same content is never sent twice. Pure.
export const ackKey = (sourceId, blocks = [], extras = []) => `${sourceId}|${blocks.map((b) => `${b.trip}:${b.scheduled}:${b.status.label}:${b.next}`).sort().join('|')}|${extras.map((x) => `${x.title}:${x.text}`).join('|')}`;

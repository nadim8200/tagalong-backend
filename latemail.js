// ---------------------------------------------------------------
// The body of the "late for a committed time" email (commitments.js → lateMessage). Formatting only:
// the subject, recipients, training routing, triggers and every number come from the caller unchanged.
// Email-safe HTML (tables, inline styles, explicit colours) + a plain-text twin in the same order. Pure.
// ---------------------------------------------------------------
import { tzOf, zoneName } from './localtime.js';

// The training banner goes here (training.js) instead of on top of the email — a compact one inside the card.
export const TRAINING_SLOT = '<!--jarvis:training-slot-->';

const C = { text: '#172538', muted: '#596A7F', line: '#E2E8F0', actionBg: '#FFF7E7', actionText: '#754C12', amber: '#C18B27', white: '#FFFFFF', page: '#F4F6F9' };
const FONT = 'Arial, Helvetica, sans-serif';
const SHORT_ZONE = { Eastern: 'ET', Central: 'CT', Mountain: 'MT', Pacific: 'PT', Alaska: 'AKT', Hawaii: 'HT' };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok = (ms) => ms != null && !Number.isNaN(ms);

// "about 20 h 1 min" — the same minutes the alert computed, just spelled out. Pure.
export function delayText(min) {
  if (min == null || Number.isNaN(min)) return null;
  const h = Math.floor(min / 60); const m = min % 60;
  return [h ? `${h} h` : null, m || !h ? `${m} min` : null].filter(Boolean).join(' ');
}
// "MIAMI, FL, 33172" → "Miami, FL 33172" (city words capitalised; state / ZIP kept). Pure.
export function placeText(place) {
  const p = String(place || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!p.length) return '';
  const city = p[0].toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return [city, [p[1], p[2]].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
// One time as { date: 'Fri, Oct 23', time: '3:00 PM ET', local: '12:00 PM PT local' | null } — Eastern like the old
// email, with the stop's own clock beside it when it isn't Eastern. Pure.
export function whenParts(ms, place) {
  if (!ok(ms)) return null;
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = `${d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET`;
  const tz = place ? tzOf(place) : 'America/New_York'; const z = zoneName(tz);
  const local = z === 'Eastern' ? null : `${d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${SHORT_ZONE[z] || z} local`;
  return { date, time, local };
}
// "3315 Northwest 70th Avenue, Miami, FL, 33122" → ["3315 Northwest 70th Avenue", "Miami, FL 33122"]. Pure.
export function addressLines(loc) {
  const p = String(loc || '').split(',').map((x) => x.trim()).filter(Boolean);
  const zip = p.length >= 4 && /^\d{5}(-\d{4})?$/.test(p[p.length - 1]);
  const tail = zip ? 3 : 2;
  if (p.length <= tail) return [p.join(', ')].filter(Boolean);
  const [city, st, z] = p.slice(-tail);
  return [p.slice(0, -tail).join(', '), `${city}, ${st}${zip ? ` ${z}` : ''}`];
}

// d = { trip, truck, trailer, receiver, place, atMs, etaMs, lateMin, miles, by, rule, fcfs, hours, gpsLocation, gpsAt }
export function renderLateEmail(d) {
  const late = delayText(d.lateMin);
  const appt = whenParts(d.atMs, d.place);
  const eta = whenParts(d.etaMs, d.place);
  const where = placeText(d.place);
  const gps = ok(d.gpsAt) ? whenParts(d.gpsAt, null) : null;
  const addr = addressLines(d.gpsLocation);
  const apptLabel = d.fcfs ? 'Receiving closes' : 'Appointment';
  const apptNote = d.fcfs ? `First come, first served${d.hours ? ` · receiving ${d.hours}` : ''}` : null;
  const source = d.by || 'Dispatch';   // who / what set the committed time (as the old email said it)
  const assumptions = 'The estimated arrival assumes an average travel speed of 60 mph (an assumption — not the truck\'s measured speed), the drivers\' remaining driving hours, and about 1 hour at each stop. Traffic, weather and dock time can change it.';
  const action = 'Assign someone to notify the customer and confirm whether the revised arrival time is acceptable.';
  const notified = 'Customer notification: Not sent by Jarvis';

  // ---- plain text (same order) ----
  const tl = (w) => (w ? `${w.date}\n${w.time}${w.local ? ` (${w.local})` : ''}` : 'Not available');
  const text = [
    'DELIVERY DELAY',
    late ? `Estimated ${late} late` : 'Running late',
    [d.receiver, where].filter(Boolean).join('\n'),
    '',
    `${apptLabel.toUpperCase()}${apptNote ? ` (${apptNote})` : ''}`, tl(appt), '',
    'ESTIMATED ARRIVAL', tl(eta), '',
    'ACTION REQUIRED', action, notified, '',
    'SHIPMENT', `Trip: ${d.trip || 'Not available'}`, `Truck: ${d.truck || 'Not available'} · Trailer: ${d.trailer || 'Not available'}`,
    d.miles != null ? `Distance remaining: Approximately ${d.miles} miles` : null, '',
    'LAST REPORTED LOCATION', ...(addr.length ? addr : ['No location reported']),
    gps ? `GPS updated ${gps.date} at ${gps.time}.` : (addr.length ? 'GPS time not reported.' : null), '',
    'ESTIMATE DETAILS', `Appointment source: ${source}.`, assumptions, '',
    'Jarvis · AI Dispatcher',
  ].filter((x) => x != null).join('\n');

  // ---- HTML ----
  const label = (s, color = C.muted) => `<div style="font-family:${FONT};font-size:11px;line-height:1.5;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${esc(s)}</div>`;
  const p = (s, extra = '') => `<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.text};${extra}">${s}</div>`;
  const small = (s) => `<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">${s}</div>`;
  const divider = `<tr><td style="padding:0 24px;"><div style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;
  const section = (inner, pad = '20px 24px') => `<tr><td style="padding:${pad};background:${C.white};">${inner}</td></tr>`;
  const timeBlock = (title, w, note) => `<div style="padding:12px 14px;border:1px solid ${C.line};border-radius:6px;background:${C.white};">${label(title)}${w
    ? `${p(esc(w.date), 'font-weight:bold;')}${p(esc(w.time))}${w.local ? small(esc(w.local)) : ''}`
    : p('Not available', `color:${C.muted};`)}${note ? small(esc(note)) : ''}</div>`;
  // two blocks side by side; they stack on a narrow screen (inline-block wraps even without media queries)
  const col = (inner) => `<!--[if mso]><td valign="top" width="262" style="padding:0 6px;"><![endif]--><div class="lm-col" style="display:inline-block;vertical-align:top;width:100%;max-width:256px;padding:0 0 12px 0;margin-right:10px;">${inner}</div><!--[if mso]></td><![endif]-->`;

  const html = `<!--[if mso]><style>.lm-col{width:256px !important;}</style><![endif]-->
<style>@media only screen and (max-width:620px){.lm-col{max-width:100% !important;margin-right:0 !important;display:block !important;}.lm-wrap{padding:12px !important;}}</style>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td class="lm-wrap" align="center" style="padding:20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.white}" style="max-width:600px;width:100%;background:${C.white};border:1px solid ${C.line};border-radius:8px;">
${TRAINING_SLOT}
${section(`${label('Delivery delay', C.amber)}
<div style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:bold;color:${C.text};margin:4px 0 8px;">${esc(late ? `Estimated ${late} late` : 'Running late')}</div>
${d.receiver ? p(`<b>${esc(d.receiver)}</b>`) : ''}${where ? p(esc(where), `color:${C.muted};`) : ''}`, '24px 24px 18px')}
${section(`<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->${col(timeBlock(apptLabel, appt, apptNote))}${col(timeBlock('Estimated arrival', eta, null))}<!--[if mso]></tr></table><![endif]-->`, '4px 24px 8px')}
${section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.actionBg}" style="background:${C.actionBg};border-left:4px solid ${C.amber};border-radius:6px;padding:14px 16px;">
${label('Action required', C.actionText)}
<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.actionText};font-weight:bold;">${esc(action)}</div>
<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.actionText};margin-top:6px;">${esc(notified)}</div>
</td></tr></table>`, '8px 24px 20px')}
${divider}
${section(`${label('Shipment')}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.muted};padding-right:14px;">Trip</td><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};font-weight:bold;">${esc(d.trip || 'Not available')}</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.muted};padding-right:14px;">Truck</td><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};">${esc(d.truck || 'Not available')} · Trailer ${esc(d.trailer || 'Not available')}</td></tr>
${d.miles != null ? `<tr><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.muted};padding-right:14px;">Distance remaining</td><td style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};">Approximately ${esc(d.miles)} miles</td></tr>` : ''}
</table>`)}
${divider}
${section(`${label('Last reported location')}
${addr.length ? addr.map((l, i) => p(esc(l), i === 0 ? 'font-weight:bold;' : '')).join('') : p('No location reported', `color:${C.muted};`)}
${gps ? small(`GPS updated ${esc(gps.date)} at ${esc(gps.time)}.`) : (addr.length ? small('GPS time not reported.') : '')}`)}
${divider}
${section(`${label('Estimate details')}
${small(`Appointment source: ${esc(source)}.`)}
${small(esc(assumptions))}`, '18px 24px 18px')}
${section(`<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">Jarvis · AI Dispatcher</div>`, '4px 24px 22px')}
</table>
</td></tr></table>`;
  return { html, text };
}

// The compact training notice for this email (training.js puts it in TRAINING_SLOT). Pure.
export function trainingRow(recipients) {
  return `<tr><td style="padding:14px 24px 0;background:${C.white};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#FFF9D6" style="background:#FFF9D6;border:1px solid #E9D98A;border-radius:6px;padding:8px 12px;font-family:${FONT};font-size:12px;line-height:1.5;color:#3B3000;"><b style="font-size:11px;letter-spacing:0.06em;">TRAINING PREVIEW</b> — Not sent to customer. It would have gone to: <b>${esc(recipients || '(nobody)')}</b></td></tr></table></td></tr>`;
}

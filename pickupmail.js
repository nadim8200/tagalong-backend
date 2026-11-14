// ---------------------------------------------------------------
// The pickup-status email to dispatch (approved design, Nov 14): "JARVIS · PICKUP UPDATE". Green "Heading to pickup" when the
// driver said yes (or TruckMate / GPS shows it left), amber "Not yet heading to pickup" (and late / problem) with the driver's
// own words in "Driver's explanation". What the driver said and what the GPS shows stay in separate sections; nothing here says
// the load is on time. Missing values say "Not available". Pictures: cid attachments (a new email) or hosted HTTPS links
// (a reply inside an email chain, which can't carry them).
// ---------------------------------------------------------------
import { readFileSync } from 'node:fs';

const ASSET = (f) => { try { return readFileSync(new URL(`./assets/email/${f}`, import.meta.url)); } catch { return null; } };
export const PICKUP_IMAGES = ['flower-mark.png', 'jarvis-avatar.png', 'icon-clipboard.png', 'icon-truck2.png', 'icon-trailer.png', 'icon-calendar.png', 'icon-signal.png', 'icon-okcircle.png'];
const BYTES = Object.fromEntries(PICKUP_IMAGES.map((f) => [f, ASSET(f)]));
export const imageBytes = (f) => (PICKUP_IMAGES.includes(f) ? BYTES[f] : null);

const NAVY = '#13325B'; const TEXT = '#14213D'; const MUTED = '#5B6778'; const LINE = '#E2E8F0';
const SERIF = "Georgia,'Times New Roman',serif"; const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ABBR = { 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT' };
const day = (ms, tz) => new Date(ms).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
const clock = (ms, tz) => new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const SOURCES = { 'rate con': 'From rate confirmation', 'trip sheet': 'From trip sheet', 'dispatch email': 'From dispatch email', email: 'From dispatch update', 'TruckMate appointment': 'From TruckMate appointment', 'TruckMate pick up by': 'From TruckMate pick-up-by date' };
// times in what the driver wrote ("rolling at 6 PM", "by 8:30") — shown as the driver's plan, never a verified ETA. Pure.
export const hasPlan = (s) => /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b|\b(eta|rolling at|leave at|leaving at|be there|by \d{1,2}|in \d+\s*(min|hour|hr))/i.test(String(s || ''));

// Which version, and its words. outcome: { status, source, driverSaid }. Pure.
export function variant(outcome = {}, driver = 'The driver') {
  const src = String(outcome.source || '');
  const fromDriver = /driver app|driver text|call/i.test(src);
  const how = /driver app/i.test(src) ? 'in the driver app' : /call/i.test(src) ? 'on a Jarvis call' : 'by text';
  if (outcome.status === 'rolling') {
    if (fromDriver) return { tone: 'green', badge: 'DRIVER RESPONSE · YES', heading: 'Heading to pickup', boxTitle: `Confirmed ${how}`, boxText: `${driver} confirmed they are heading to pickup.`, reply: true, how };
    const tm = /TruckMate/i.test(src);
    return { tone: 'green', badge: 'PICKUP STATUS', heading: tm ? 'Departed the shipper' : 'Truck is moving', boxTitle: tm ? 'From TruckMate' : 'From GPS', boxText: tm ? 'TruckMate shows the truck departed the shipper.' : `${src.replace(/^GPS:\s*/i, 'GPS: ')}. The driver has not answered yet.` };
  }
  const words = { delayed: ['DRIVER RESPONSE · RUNNING LATE', 'Pickup will be late'], issue: ['DRIVER RESPONSE · PROBLEM', 'Driver reports a problem'] }[outcome.status] || ['DRIVER RESPONSE · NOT YET', 'Not yet heading to pickup'];
  return { tone: 'amber', badge: words[0], heading: words[1], boxTitle: 'Driver’s explanation', explain: true, how };
}

// → { subject, html, text, attachments }. images: 'cid' or the https base the pictures are served from. Pure.
export function pickupEmail({ trip, truck, trailer, driver, plan, outcome, live = {}, convo = [], subject, images = 'cid' }) {
  const v = variant(outcome, driver || 'The driver');
  const cid = images === 'cid';
  const used = new Set();
  const src = (f) => { used.add(f); return cid ? `cid:pk-${f.replace(/\.png$/, '')}` : `${images}/email/img/${f}`; };
  const img = (f, w, alt = '', extra = '') => (BYTES[f] ? `<img src="${src(f)}" width="${w}" height="${w}" alt="${esc(alt)}" style="display:block;border:0;width:${w}px;height:${w}px;${extra}">` : '');
  const NA = 'Not available';
  const tone = v.tone === 'green' ? { badgeBg: '#DCFCE7', badgeInk: '#166534', boxBg: '#F0FDF4', boxLine: '#86EFAC' } : { badgeBg: '#FDE7B0', badgeInk: '#7A4A00', boxBg: '#FFF8EB', boxLine: '#F6C567' };
  const label = (t) => `<div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1.5px;color:${NAVY};">${esc(t)}</div>`;
  const val = (t, size = 17) => `<div style="font-family:${SERIF};font-size:${size}px;line-height:${size + 5}px;color:${TEXT};">${t}</div>`;
  const note = (t) => `<div style="font-family:${SERIF};font-size:13px;line-height:18px;font-style:italic;color:${MUTED};">${esc(t)}</div>`;
  // pickup: "Name, City, ST" or "City, ST"
  const parts = String((plan && plan.place) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const shipper = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(', ') : null;
  const where = parts.length >= 2 ? parts.slice(-2).join(', ') : (parts[0] || null);
  const tz = plan && plan.tz;
  const pickWhen = plan && plan.ms ? `${day(plan.ms, tz || 'America/New_York')} · ${clock(plan.ms, tz || 'America/New_York')}${tz && ABBR[tz] ? ` ${ABBR[tz]}` : ''}` : null;
  const srcText = [plan && SOURCES[plan.source] ? SOURCES[plan.source] : (plan && plan.source ? `From ${plan.source}` : null), tz && ABBR[tz] ? null : (pickWhen ? 'Time zone not provided' : null)].filter(Boolean).join(' · ');
  // tracking: the GPS on its own
  const gpsMs = Date.parse(live.gpsAt || '');
  const speed = live.speedMph != null && Number.isFinite(Number(live.speedMph)) ? Number(live.speedMph) : null;
  const motion = speed == null ? null : speed > 5 ? { dot: '#16A34A', text: `Moving · ${Math.round(speed)} mph` } : { dot: '#D97706', text: 'Stopped' };
  const map = live.lat != null && live.lng != null ? `https://maps.google.com/?q=${live.lat},${live.lng}` : null;
  const said = String(outcome.driverSaid || '').trim();
  const row = (icon, inner, top = true) => `<tr><td style="padding:16px 0;${top ? `border-top:1px solid ${LINE};` : ''}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="40" valign="top" style="padding-top:2px;">${img(icon, 24)}</td><td valign="top">${inner}</td></tr></table></td></tr>`;
  const idCell = (icon, l, value, first) => `<td valign="middle" width="33%" style="padding:6px 8px;${first ? '' : `border-left:1px solid ${LINE};`}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="pk-ic" valign="middle" style="padding-right:10px;">${img(icon, 26)}</td><td valign="middle">${label(l)}<div style="font-family:${SERIF};font-size:17px;color:${TEXT};white-space:nowrap;">${esc(value || NA)}</div></td></tr></table></td>`;
  const box = v.explain
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tone.boxBg};border:1px solid ${tone.boxLine};border-radius:8px;"><tr>
<td width="44" valign="top" style="padding:14px 0 14px 16px;font-family:${SERIF};font-size:34px;line-height:30px;font-weight:bold;color:#B45309;">&ldquo;</td>
<td valign="top" style="padding:14px 18px 14px 6px;border-left:1px solid ${tone.boxLine};"><div style="font-family:${SERIF};font-size:17px;font-weight:bold;color:${TEXT};">${esc(v.boxTitle)}</div>
<div style="font-family:${SERIF};font-size:16px;line-height:23px;color:${TEXT};margin-top:4px;">${said ? `&ldquo;${esc(said).replace(/\n/g, '<br>')}&rdquo;` : 'No explanation provided.'}</div></td></tr></table>
${said && hasPlan(said) ? `<div style="margin-top:6px;">${note('Driver-reported plan · Not a verified ETA')}</div>` : ''}`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tone.boxBg};border:1px solid ${tone.boxLine};border-radius:8px;"><tr>
<td width="56" valign="middle" align="center" style="padding:14px 0 14px 12px;">${img('icon-okcircle.png', 30)}</td>
<td valign="middle" style="padding:14px 18px;border-left:1px solid ${tone.boxLine};"><div style="font-family:${SERIF};font-size:17px;font-weight:bold;color:${TEXT};">${esc(v.boxTitle)}</div>
<div style="font-family:${SERIF};font-size:16px;line-height:23px;color:${TEXT};margin-top:2px;">${esc(v.boxText)}</div></td></tr></table>`;
  // the driver's own reply, word for word, under the green confirmation (the app's Yes has no words: say what they tapped)
  const answeredAt = Date.parse(outcome.at || '');
  const atText = Number.isFinite(answeredAt) ? `Answered ${day(answeredAt, 'America/New_York')} · ${clock(answeredAt, 'America/New_York')} ET` : null;
  const replyBlock = v.reply ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;background:#FFFFFF;border:1px solid ${LINE};border-radius:8px;"><tr>
<td width="44" valign="top" style="padding:12px 0 12px 16px;font-family:${SERIF};font-size:34px;line-height:30px;font-weight:bold;color:#15803D;">&ldquo;</td>
<td valign="top" style="padding:12px 18px 12px 6px;border-left:1px solid ${LINE};"><div style="font-family:${SERIF};font-size:17px;font-weight:bold;color:${TEXT};">Driver’s reply</div>
<div style="font-family:${SERIF};font-size:16px;line-height:23px;color:${TEXT};margin-top:4px;">${said ? `&ldquo;${esc(said).replace(/\n/g, '<br>')}&rdquo;` : (/driver app/i.test(String(outcome.source || '')) ? 'Tapped &ldquo;Yes, I’m rolling&rdquo; in the driver app (no comment).' : 'No reply text on file.')}</div></td></tr></table>
${said && hasPlan(said) ? `<div style="margin-top:6px;">${note('Driver-reported plan · Not a verified ETA')}</div>` : ''}` : '';
  const talk = convo.length ? row('icon-clipboard.png', `${label('MESSAGES WITH THE DRIVER')}${convo.map((c) => `<div style="font-family:${SERIF};font-size:14px;line-height:20px;color:${TEXT};margin-top:6px;"><span style="color:${MUTED};">${esc(c.when || '')}</span> · <b>${esc(c.who)}</b> (${esc(c.how)}): ${esc(c.text)}</div>`).join('')}`) : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<style>@media only screen and (max-width:480px){.pk-wrap{width:100%!important}.pk-pad{padding-left:16px!important;padding-right:16px!important}.pk-h1{font-size:25px!important;line-height:30px!important}.pk-brand{font-size:16px!important;letter-spacing:2px!important}.pk-id td{padding-left:4px!important;padding-right:4px!important}.pk-id .pk-ic{display:none!important}}</style></head>
<body style="margin:0;padding:0;background:#EEF1F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F5;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" class="pk-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:6px;overflow:hidden;border:1px solid #D9DFE8;">
<tr><td align="center" style="background:${NAVY};padding:20px 20px 16px;">
${BYTES['flower-mark.png'] ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td>${img('flower-mark.png', 38, 'Florida Beauty Flora')}</td></tr></table>` : ''}
<div class="pk-brand" style="font-family:${SERIF};font-size:21px;letter-spacing:4px;color:#FFFFFF;margin-top:8px;">FLORIDA BEAUTY FLORA</div>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin-top:8px;"><tr><td width="34" style="border-top:1px solid #8FA3C0;font-size:0;line-height:0;">&nbsp;</td><td style="padding:0 10px;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:2.5px;color:#DCE5F2;white-space:nowrap;">JARVIS · PICKUP UPDATE</td><td width="34" style="border-top:1px solid #8FA3C0;font-size:0;line-height:0;">&nbsp;</td></tr></table>
</td></tr>
<tr><td class="pk-pad" style="padding:22px 24px 4px;">
<span style="display:inline-block;background:${tone.badgeBg};color:${tone.badgeInk};font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:1.5px;padding:6px 12px;border-radius:6px;">${esc(v.badge)}</span>
<h1 class="pk-h1" style="margin:12px 0 0;font-family:${SERIF};font-size:30px;line-height:36px;font-weight:bold;color:${NAVY};">${esc(v.heading)}</h1>
<div style="font-family:${SERIF};font-size:18px;line-height:24px;color:${TEXT};margin:4px 0 16px;">${esc(driver || 'Driver not on file')} · Trip ${esc(trip)}</div>
${box}
${replyBlock}
${atText ? `<div style="margin-top:6px;">${note(atText)}</div>` : ''}
</td></tr>
<tr><td class="pk-pad" style="padding:16px 24px 0;"><table role="presentation" class="pk-id" width="100%" cellpadding="0" cellspacing="0"><tr>${idCell('icon-clipboard.png', 'TRIP', trip, true)}${idCell('icon-truck2.png', 'TRUCK', truck)}${idCell('icon-trailer.png', 'TRAILER', trailer)}</tr></table></td></tr>
<tr><td class="pk-pad" style="padding:8px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${row('icon-calendar.png', `${label('SCHEDULED PICKUP')}${shipper ? val(`<b>${esc(shipper)}</b>`) : ''}${val(where ? (shipper ? esc(where) : `<b>${esc(where)}</b>`) : NA)}${val(pickWhen ? esc(pickWhen) : 'Pickup time: Not available', 16)}${srcText ? note(srcText) : ''}`)}
${row('icon-signal.png', `${label('LATEST TRACKING')}${val(live.location ? `<b>${esc(live.location)}</b>` : NA)}${motion ? `<div style="font-family:${SERIF};font-size:16px;line-height:22px;color:${TEXT};"><span style="color:${motion.dot};font-size:18px;">&#9679;</span> ${esc(motion.text)}</div>` : ''}${Number.isFinite(gpsMs) ? note(`As of ${day(gpsMs, 'America/New_York')} · ${clock(gpsMs, 'America/New_York')} ET`) : note('No GPS time available')}${map ? `<div style="margin-top:6px;"><a href="${esc(map)}" style="font-family:${SERIF};font-size:16px;color:${NAVY};text-decoration:underline;">View truck on map</a></div>` : ''}`)}
${talk}
</table></td></tr>
<tr><td class="pk-pad" style="padding:6px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};"><tr><td style="padding:16px 0;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="padding-right:16px;">${BYTES['jarvis-avatar.png'] ? img('jarvis-avatar.png', 76, 'Jarvis, AI Dispatcher', 'border-radius:38px;') : ''}</td>
<td valign="middle" style="border-left:1px solid #D5DEEA;padding-left:16px;"><div style="font-family:${SERIF};font-size:24px;font-weight:bold;color:${NAVY};">Jarvis</div><div style="font-family:${SERIF};font-size:16px;line-height:22px;color:${TEXT};">AI Dispatcher</div><div style="font-family:${SERIF};font-size:16px;line-height:22px;color:${TEXT};">Florida Beauty Flora</div></td></tr></table>
</td></tr></table></td></tr>
<tr><td align="center" style="background:#F6F8FB;padding:10px 24px;font-family:${SERIF};font-size:13px;font-style:italic;color:${MUTED};">Internal dispatch update</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    v.badge, v.heading, `${driver || 'Driver not on file'} · Trip ${trip}`, '',
    v.explain ? `${v.boxTitle}: ${said ? `"${said}"` : 'No explanation provided.'}${said && hasPlan(said) ? '\n(Driver-reported plan · Not a verified ETA)' : ''}` : `${v.boxTitle}: ${v.boxText}`,
    ...(v.reply ? [`Driver's reply: ${said ? `"${said}"` : (/driver app/i.test(String(outcome.source || '')) ? 'tapped "Yes, I\'m rolling" in the driver app (no comment)' : 'no reply text on file')}`] : []),
    ...(atText ? [atText] : []), '',
    `Trip ${trip || NA} | Truck ${truck || NA} | Trailer ${trailer || NA}`, '',
    'SCHEDULED PICKUP', ...(shipper ? [shipper] : []), where || NA, pickWhen || 'Pickup time: Not available', ...(srcText ? [srcText] : []), '',
    'LATEST TRACKING', live.location || NA, ...(motion ? [motion.text] : []), Number.isFinite(gpsMs) ? `As of ${day(gpsMs, 'America/New_York')} · ${clock(gpsMs, 'America/New_York')} ET` : 'No GPS time available', ...(map ? [`Map: ${map}`] : []),
    ...(convo.length ? ['', 'MESSAGES WITH THE DRIVER', ...convo.map((c) => `${c.when || ''} · ${c.who} (${c.how}): ${c.text}`)] : []),
    '', 'Jarvis', 'AI Dispatcher', 'Florida Beauty Flora', '—', 'Internal dispatch update',
  ].join('\n');
  const attachments = cid ? [...used].filter((f) => BYTES[f]).map((f) => ({ name: f, contentType: 'image/png', bytes: BYTES[f], cid: `pk-${f.replace(/\.png$/, '')}` })) : [];
  return { subject, html, text, attachments };
}

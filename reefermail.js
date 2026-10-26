// ---------------------------------------------------------------
// The reefer temperature-alert email (ARTIS Trailer Temp Verifications at the loading door): body only.
// Same facts as before — trailer, recorded / set temperature and the difference, where and when it was checked,
// by whom, the trip / truck / destination on that trailer, the dock's photos — laid out like our other alerts.
// Subject, recipients, attachments and when it is sent stay in artisreports.js. Pure.
// ---------------------------------------------------------------
import { TRAINING_SLOT } from './latemail.js';

const C = { text: '#172538', muted: '#596A7F', line: '#E2E8F0', amber: '#B7791F', amberText: '#754C12', amberBg: '#FFF7E7', amberLine: '#F3D9A4', white: '#FFFFFF', page: '#F4F6F9' };
const FONT = 'Arial, Helvetica, sans-serif';
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const PHOTO_W = 264;

// width × height of a JPEG / PNG (to give each photo explicit dimensions). Pure; null when unknown.
export function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unknown */ }
  return null;
}

// x = one door-temp issue (doorTempIssues); trip = { number, truck, destination } or null;
// photos = [{ cid, bytes }] as attached (inline). Returns { html, text }.
export function renderDoorTempEmail(x, { trip = null, photos = [] } = {}) {
  const actual = num(x.actual); const set = num(x.set);
  const diff = actual != null && set != null ? actual - set : null;
  const signed = diff == null ? null : `${diff > 0 ? '+' : ''}${diff}°F`;
  const condition = diff == null ? 'Recorded temperature compared with the reefer setpoint'
    : diff > 0 ? 'Recorded temperature above reefer setpoint' : diff < 0 ? 'Recorded temperature below reefer setpoint' : 'Recorded temperature at the reefer setpoint';
  const deg = (v) => (v == null ? 'Not recorded' : `${v}°F`);
  const location = [x.warehouse || null, x.door ? `Door ${x.door}` : null].filter(Boolean).join(' · ') || 'Not recorded';
  const action = 'Verify reefer operation and the current temperature before departure. If the trailer has already departed, contact the driver to verify.';
  const source = 'ARTIS Trailer Temp Verifications';
  const inArtis = Number(x.photos) || 0;
  const shown = photos.length;

  // ---- plain text (same order) ----
  const text = [
    'FLORIDA BEAUTY — Dispatch notifications', '',
    'TEMPERATURE ALERT',
    `Trailer ${x.trailer || 'Not recorded'}`,
    condition, '',
    `RECORDED: ${deg(actual)}   SETPOINT: ${deg(set)}   DIFFERENCE: ${signed || 'Not available'}`, '',
    'ACTION REQUESTED', action, '',
    'LOAD DETAILS',
    `Trip: ${trip ? trip.number : 'No active trip linked'}`,
    trip ? `Truck: ${trip.truck || 'Not recorded'}` : null,
    `Location: ${location}`,
    trip && trip.destination ? `Destination: ${trip.destination}` : null, '',
    'VERIFICATION RECORD (inspection time — not when this email was sent)',
    `Checked: ${x.atText || 'Not recorded'}`,
    `Checked by: ${x.by || 'Not recorded'}`,
    `Source: ${source}`, '',
    `INSPECTION PHOTOS · ${inArtis || shown}${shown < inArtis ? ` (${shown} included in this email — the rest are in ARTIS)` : shown ? ' (in this email)' : ''}`, '',
    'Recorded inspection reading — not a live temperature update.', '',
    'Jarvis', 'AI Dispatcher · Florida Beauty',
  ].filter((l) => l != null).join('\n');

  // ---- HTML (tables + inline styles; stacks on a phone) ----
  const label = (s, color = C.muted) => `<div style="font-family:${FONT};font-size:11px;line-height:1.5;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${s}</div>`;
  const section = (inner, pad = '18px 24px') => `<tr><td style="padding:${pad};background:${C.white};">${inner}</td></tr>`;
  const divider = `<tr><td style="padding:0 24px;background:${C.white};"><div style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;
  const rows = (list) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">${list.filter(Boolean).map(([k, v, muted]) => `<tr><td valign="top" width="130" style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.muted};padding:3px 12px 3px 0;border-bottom:1px solid ${C.line};">${esc(k)}</td><td valign="top" style="font-family:${FONT};font-size:15px;line-height:1.6;color:${muted ? C.muted : C.text};padding:3px 0;border-bottom:1px solid ${C.line};word-break:break-word;">${esc(v)}</td></tr>`).join('')}</table>`;
  const metric = (k, v, color, missing = 'Not recorded') => `<!--[if mso]><td valign="top" width="176" style="padding:0 4px;"><![endif]--><div class="rm-col" style="display:inline-block;vertical-align:top;width:100%;max-width:172px;margin:0 6px 10px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border:1px solid ${C.line};border-radius:6px;padding:12px 8px;background:${C.white};">${label(esc(k))}${v == null ? `<div style="font-family:${FONT};font-size:16px;line-height:1.5;color:${C.muted};padding:6px 0 4px;">${esc(missing)}</div>` : `<div style="font-family:${FONT};font-size:28px;line-height:1.25;font-weight:bold;color:${color};">${esc(v)}</div>`}</td></tr></table></div><!--[if mso]></td><![endif]-->`;
  const photo = (p, i) => {
    const sz = imageSize(p.bytes);
    const h = sz && sz.w ? Math.round(PHOTO_W * sz.h / sz.w) : null;
    const alt = `Inspection photo ${i + 1} of ${shown} — trailer ${x.trailer || ''}, ${x.atText || 'inspection'}`;
    return `<!--[if mso]><td valign="top" width="${PHOTO_W + 8}" style="padding:0 4px;"><![endif]--><div class="rm-photo" style="display:inline-block;vertical-align:top;width:100%;max-width:${PHOTO_W}px;margin:0 8px 12px 0;"><img src="cid:${esc(p.cid)}" width="${PHOTO_W}"${h ? ` height="${h}"` : ''} alt="${esc(alt)}" style="display:block;width:100%;max-width:${PHOTO_W}px;height:auto;border:1px solid ${C.line};border-radius:6px;font-family:${FONT};font-size:12px;color:${C.muted};"><div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};margin-top:4px;">Inspection photo ${i + 1}</div></div><!--[if mso]></td><![endif]-->`;
  };

  const html = `<!--[if mso]><style>.rm-col{width:172px !important;}.rm-photo{width:${PHOTO_W}px !important;}</style><![endif]-->
<style>@media only screen and (max-width:620px){.rm-col{max-width:100% !important;margin-right:0 !important;display:block !important;}.rm-photo{max-width:100% !important;margin-right:0 !important;display:block !important;}.rm-wrap{padding:10px !important;}}</style>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td class="rm-wrap" align="center" style="padding:20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.white}" style="max-width:600px;width:100%;background:${C.white};border:1px solid ${C.line};border-radius:8px;">
${section(`<div style="font-family:${FONT};font-size:15px;line-height:1.3;font-weight:bold;letter-spacing:0.12em;color:${C.text};">FLORIDA BEAUTY</div><div style="font-family:${FONT};font-size:12px;line-height:1.4;color:${C.muted};">Dispatch notifications</div>`, '18px 24px 6px')}
${TRAINING_SLOT}
${section(`${label(`&#9888;&nbsp;Temperature alert`, C.amber)}
<div style="font-family:${FONT};font-size:30px;line-height:1.2;font-weight:bold;color:${C.text};margin:4px 0 6px;">Trailer ${esc(x.trailer || 'Not recorded')}</div>
<div style="font-family:${FONT};font-size:16px;line-height:1.5;color:${C.text};">${esc(condition)}</div>`, '18px 24px 10px')}
${section(`<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->${metric('Recorded', actual == null ? null : `${actual}°F`, C.text)}${metric('Setpoint', set == null ? null : `${set}°F`, C.text)}${metric('Difference', signed, C.amber, 'Not available')}<!--[if mso]></tr></table><![endif]-->`, '6px 24px 4px')}
${section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.amberBg}" style="background:${C.amberBg};border:1px solid ${C.amberLine};border-left:4px solid ${C.amber};border-radius:6px;padding:14px 16px;">
${label('&#9888;&nbsp;Action requested', C.amberText)}
<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.amberText};">${esc(action)}</div></td></tr></table>`, '6px 24px 18px')}
${divider}
${section(`<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};">Load details</div>
${rows([
    ['Trip', trip ? trip.number : 'No active trip linked', !trip],
    trip ? ['Truck', trip.truck || 'Not recorded', !trip.truck] : null,
    ['Location', location, location === 'Not recorded'],
    trip && trip.destination ? ['Destination', trip.destination] : null,
  ])}`)}
${divider}
${section(`<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};">Verification record</div>
${rows([
    ['Checked', x.atText || 'Not recorded', !x.atText],
    ['Checked by', x.by || 'Not recorded', !x.by],
    ['Source', source],
  ])}
<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};margin-top:6px;">Checked = when the dock recorded the reading, not when this email was sent.</div>`)}
${divider}
${section(`<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};margin-bottom:8px;">Inspection photos · ${inArtis || shown}</div>
${shown ? `<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->${photos.map(photo).join('')}<!--[if mso]></tr></table><![endif]-->` : ''}
${shown < inArtis ? `<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${shown ? `${inArtis - shown} more` : `${inArtis}`} photo${inArtis - shown === 1 ? '' : 's'} could not be loaded into this email — open the check in ARTIS Trailer Temp Verifications.</div>` : ''}
${!inArtis && !shown ? `<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:${C.muted};">No photos were recorded with this check.</div>` : ''}
${shown ? `<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">Shown smaller here — the photos in this email are the full-size originals from ARTIS.</div>` : ''}`)}
${divider}
${section(`<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">Recorded inspection reading — not a live temperature update.</div>
<div style="font-family:${FONT};font-size:17px;line-height:1.4;font-weight:bold;color:${C.text};margin-top:12px;">Jarvis</div>
<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">AI Dispatcher · Florida Beauty</div>`, '16px 24px 22px')}
</table>
</td></tr></table>`;
  return { html, text };
}

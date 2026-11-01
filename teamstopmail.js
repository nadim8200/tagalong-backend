// The email when a team truck sits too long. Layout only: who gets it and when come from the caller. Pure.
import { TRAINING_SLOT } from './latemail.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderTeamStopEmail(a) {
  const red = a.severity === 'critical';
  const unit = a.unit || 'not recorded';
  const subject = `Team truck ${unit} stopped: ${String(a.title || '').replace(/^Team truck stopped\s*/, '')}${a.trip ? ` — trip ${a.trip}` : ''}`;
  const rows = [['Truck', unit], ['Trip', a.trip || 'Not recorded']];
  const html = `<div style="background:#F1F5F9;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#172538"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px"><tr><td style="padding:20px 24px 4px;font-size:13px;letter-spacing:1px;font-weight:bold;color:#13325B">FLORIDA BEAUTY</td></tr><tr><td style="padding:0 24px;font-size:13px;color:#596A7F">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td style="padding:18px 24px 0;font-size:13px;font-weight:bold;color:${red ? '#B42318' : '#92400E'}">${red ? 'TEAM TRUCK STOPPED TOO LONG' : 'TEAM TRUCK STOPPED'}</td></tr>
<tr><td style="padding:4px 24px 0;font-size:24px;font-weight:bold">Truck ${esc(unit)}</td></tr>
<tr><td style="padding:4px 24px 0;font-size:16px">${esc(a.title)}</td></tr>
<tr><td style="padding:14px 24px 0;font-size:15px;line-height:1.5">${esc(a.detail)}</td></tr>
<tr><td style="padding:14px 24px 20px;font-size:14px;line-height:1.6">${rows.map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>')}</td></tr>
</table></div>`;
  return { subject, html, text: `TEAM TRUCK STOPPED\nTruck ${unit}\n${a.title}\n\n${a.detail}\n\nTrip: ${a.trip || 'Not recorded'}` };
}

// Presentation only: all identifiers and site directions come from the detected load.
import { esc, facts } from './jarvismail.js';
export function siteAlertHtml(w, { test, now, fix }) {
  const bills = w.bills.join(', ');
  const noun = w.bills.length === 1 ? 'Bill' : 'Bills';
  const site = (s) => esc(s.site.replace('SITE', ''));
  const label = (t) => `<div style="font-size:11px;letter-spacing:1.2px;font-weight:bold;margin-bottom:10px">${t}</div>`;
  const box = (s, title, bg, ink) => `<td width="45%" bgcolor="${bg}" style="padding:16px 13px;border-radius:12px;color:${ink}">${label(title)}<strong style="font-size:25px">Site ${site(s)}</strong><br><span style="font-size:13px">Letter ${esc(s.letter)}</span></td>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media(max-width:480px){.sa-pad{padding:22px 18px!important}.sa-title{font-size:27px!important}.sa-outer{padding:12px 6px!important}}</style></head><body style="margin:0;background:#e9eef5">
<div style="display:none;max-height:0;overflow:hidden">${esc(fix)} Trip ${esc(w.trip)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#e9eef5"><tr><td class="sa-outer" align="center" style="padding:24px 12px">
${test ? '<p style="font: bold 11px Arial;color:#65748a;letter-spacing:1px">TEST · SAMPLE DATA · NOT A REAL REPORT</p>' : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:570px;background:#fffdf9;border:1px solid #dfe4ec;border-radius:20px;font-family:Arial,sans-serif;color:#172e48">
<tr><td class="sa-pad" style="padding:20px 26px;font-size:12px;font-weight:bold;letter-spacing:1.5px">J &nbsp; FLORIDA BEAUTY FLORA</td></tr>
<tr><td bgcolor="#be342b" style="padding:13px 26px;color:white;font-size:12px;font-weight:bold;letter-spacing:1.3px">&#9888; NEEDS ATTENTION NOW</td></tr>
<tr><td class="sa-pad" bgcolor="#142f49" style="padding:26px;color:#ffffff">
<div style="font-size:25px;color:#ffc2a9;margin-bottom:18px" aria-hidden="true">&#9636; &nbsp; &#8594; &nbsp; &#10003;</div>
<h1 class="sa-title" style="font-size:30px;line-height:1.16;margin:0 0 12px;word-break:break-word">${noun} <span style="color:#ffc2a9">${esc(bills)}</span> ${w.bills.length === 1 ? 'is' : 'are'} in the wrong TruckMate site.</h1>
<p style="font-size:14px;line-height:1.6;color:#c4d3e1;margin:0">The rate confirmation names <strong style="color:#ffffff">${esc(w.carrierName)}.</strong> ${noun} ${esc(bills)} ${w.bills.length === 1 ? 'is' : 'are'} currently in Site ${site(w.have)} (${esc(w.have.letter)}).</p>
<p style="font-size:12px;color:#adc3d8;margin:16px 0 0">${noun} ${esc(bills)} · Trip ${esc(w.trip)} · ${esc(new Date(now).toLocaleString('en-US', {timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))} ET</p></td></tr>
<tr><td class="sa-pad" style="padding:25px 26px;word-break:break-word">
${label(`CORRECTION REQUIRED · ${noun.toUpperCase()} ${esc(bills)}`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px"> <tr>${box(w.have,'CURRENT · INCORRECT','#fcece9','#a5322a')}<td align="center" width="10%" style="font-size:23px">&#8594;</td>${box(w.want,'MOVE TO · CORRECT','#e7effb','#19519a')}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="12"></td><td bgcolor="#007aff" style="padding:19px 21px;border-radius:21px 21px 4px 21px;color:#ffffff;font-size:17px;line-height:1.5">${label('JARVIS · REQUIRED ACTION')}${esc(fix)}</td></tr><tr><td></td><td align="right" style="font-size:0;height:10px"><span style="display:inline-block;border-top:10px solid #007aff;border-left:13px solid transparent"></span></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:13px"><tr><td align="center" bgcolor="#be342b" style="border-radius:9px"><a href="https://mytagalong.app/truckmate?trip=${encodeURIComponent(w.trip)}" style="display:block;padding:15px 12px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none">Open trip ${esc(w.trip)} &#8599;</a></td></tr></table>
<p style="font-size:11px;text-align:center;color:#65748a;margin:9px 0 24px">Review and correct the site in TruckMate.</p>
${label('LOAD DETAILS')}${facts([['Trip',w.trip],[noun,bills],['Rate con names',w.carrierName],w.broker ? ['Broker',w.broker] : null,w.loadNumber ? ['Broker load #',w.loadNumber] : null,w.truck ? ['Truck',w.truck] : null])}
<div style="background:#edf1f6;padding:17px 18px;border-radius:10px;font-size:13px;line-height:1.65;margin-top:22px"><strong>Site rule · Dispatch &amp; Billing</strong><p style="margin:7px 0">All <b>Tempest</b> loads belong in <b>Site 9 (F)</b>, including every OTR freight bill.<br><b>Site 2 (B)</b> is only for FBE and FBF loads.</p><span style="font-size:11px;color:#65748a">From Ronen · Nov 20</span></div>
</td></tr><tr><td class="sa-pad" bgcolor="#edf1f6" style="padding:20px 26px;border-radius:0 0 20px 20px;border-top:1px solid #dfe4ec;font-size:14px"><strong>J &nbsp; Flagged by Jarvis</strong><p style="font-size:12px;color:#65748a;margin:6px 0 0">AI Dispatcher · Florida Beauty Flora</p></td></tr>
</table></td></tr></table></body></html>`;
}

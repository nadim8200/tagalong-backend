// Presentation only: all identifiers and site directions come from the detected load.
// The dark "needs attention" layout (navy card, red banner, dark red / dark blue site boxes, blue Jarvis bubble).
import { esc } from './jarvismail.js';

const K = { page: '#0d1b2e', card: '#13263f', head: '#142c49', body: '#152a44', line: '#2a3f5d', ink: '#ffffff', soft: '#c4d3e1', muted: '#8ea3bd',
  red: '#c23b2f', accent: '#ff9f85', badRed: '#4b2531', badInk: '#f2a596', goodBlue: '#1f3f6b', goodInk: '#a9c9f2', blue: '#0a84ff', rule: '#1c3352' };
const FONT = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif';

export function siteAlertHtml(w, { test, now, fix }) {
  const bills = w.bills.join(', ');
  const noun = w.bills.length === 1 ? 'Bill' : 'Bills';
  const site = (s) => esc(s.site.replace('SITE', ''));
  const label = (t, color = K.muted) => `<div style="font-size:11px;letter-spacing:1.4px;font-weight:bold;color:${color};margin-bottom:10px">${t}</div>`;
  const box = (s, title, bg, ink) => `<td width="45%" bgcolor="${bg}" style="background:${bg};padding:18px 16px;border-radius:12px;color:${ink}">${label(title, ink)}<div class="sa-site" style="font-size:28px;font-weight:bold;line-height:1.1;color:${ink === K.badInk ? '#ff8f7a' : '#ffffff'}">Site ${site(s)}</div><div style="font-size:13px;margin-top:4px;color:${ink}">Letter ${esc(s.letter)}</div></td>`;
  const tile = (glyph, on) => `<td width="50" height="58" align="center" valign="middle" bgcolor="${on ? '#3a5a85' : '#1d3756'}" style="background:${on ? '#3a5a85' : '#1d3756'};border:1px solid ${on ? '#6f93c2' : '#3b5576'};border-radius:8px;font-size:20px;color:#ffffff">${glyph}</td>`;
  const rows = [[`Trip / ${noun}`, `${w.trip} / ${bills}`], ['Rate con names', w.carrierName], w.broker ? ['Broker', w.broker] : null, w.loadNumber ? ['Broker load #', w.loadNumber] : null, w.truck ? ['Truck', w.truck] : null]
    .filter(Boolean).map(([k, v]) => `<tr><td width="44%" style="padding:13px 0;border-bottom:1px solid ${K.line};font-size:14px;color:${K.soft}">${esc(k)}</td><td style="padding:13px 0;border-bottom:1px solid ${K.line};font-size:14px;font-weight:bold;color:${K.ink}">${esc(v)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"><style>@media(max-width:480px){.sa-pad{padding:22px 18px!important}.sa-title{font-size:28px!important}.sa-outer{padding:12px 6px!important}.sa-site{font-size:24px!important}}</style></head><body style="margin:0;background:${K.page}">
<div style="display:none;max-height:0;overflow:hidden">${esc(fix)} Trip ${esc(w.trip)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${K.page}" style="background:${K.page}"><tr><td class="sa-outer" align="center" style="padding:24px 12px;font-family:${FONT}">
${test ? `<p style="font:bold 11px ${FONT};color:${K.muted};letter-spacing:1.4px;margin:0 0 12px">TEST · SAMPLE DATA · NOT A REAL REPORT</p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${K.card}" style="max-width:600px;background:${K.card};border:1px solid #2a4061;border-radius:20px;font-family:${FONT};color:${K.ink};border-collapse:separate;overflow:hidden">
<tr><td class="sa-pad" bgcolor="${K.card}" style="padding:20px 28px;border-radius:20px 20px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="34" height="34" align="center" bgcolor="#0b1626" style="background:#0b1626;border-radius:8px;font-size:17px;font-weight:bold;color:#ffffff">J</td><td style="padding-left:14px;font-size:13px;font-weight:bold;letter-spacing:2px;color:#ffffff">FLORIDA BEAUTY FLORA</td></tr></table></td></tr>
<tr><td bgcolor="${K.red}" style="background:${K.red};padding:14px 28px;color:#ffffff;font-size:13px;font-weight:bold;letter-spacing:1.6px">&#9888;&nbsp; NEEDS ATTENTION NOW</td></tr>
<tr><td class="sa-pad" bgcolor="${K.head}" style="background:${K.head};padding:30px 28px 34px">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:26px" aria-hidden="true"><tr>${tile('!', false)}<td width="44" align="center" style="font-size:20px;color:#c4d3e1">&#8594;</td>${tile('&#10003;', true)}</tr></table>
<h1 class="sa-title" style="font-size:34px;line-height:1.18;margin:0 0 14px;font-weight:bold;color:#ffffff;word-break:break-word">${noun} <span style="color:${K.accent}">${esc(bills)}</span> ${w.bills.length === 1 ? 'is' : 'are'} in the wrong TruckMate site.</h1>
<p style="font-size:15px;line-height:1.6;color:${K.soft};margin:0">The rate confirmation names <strong style="color:#ffffff">${esc(w.carrierName)}.</strong> ${noun} ${esc(bills)} ${w.bills.length === 1 ? 'is' : 'are'} currently in Site ${site(w.have)} (${esc(w.have.letter)}).</p>
<p style="font-size:12px;color:${K.muted};margin:18px 0 0">${noun} ${esc(bills)} · Trip ${esc(w.trip)} · ${esc(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} ET</p></td></tr>
<tr><td class="sa-pad" bgcolor="${K.body}" style="background:${K.body};padding:30px 28px;word-break:break-word">
${label(`CORRECTION REQUIRED · ${noun.toUpperCase()} ${esc(bills)}`, '#ffffff')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tr>${box(w.have, 'CURRENT · INCORRECT', K.badRed, K.badInk)}<td align="center" width="10%" style="font-size:22px;color:#ffffff">&#8594;</td>${box(w.want, 'MOVE TO · CORRECT', K.goodBlue, K.goodInk)}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="14"></td><td bgcolor="${K.blue}" style="background:${K.blue};padding:20px 24px;border-radius:22px 22px 4px 22px;color:#ffffff;font-size:18px;line-height:1.5">${label('JARVIS · REQUIRED ACTION', '#ffffff')}${esc(fix)}</td></tr><tr><td></td><td align="right" style="font-size:0;height:10px"><span style="display:inline-block;border-top:10px solid ${K.blue};border-left:13px solid transparent"></span></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr><td align="center" bgcolor="${K.red}" style="background:${K.red};border-radius:10px"><a href="https://mytagalong.app/truckmate?trip=${encodeURIComponent(w.trip)}" style="display:block;padding:16px 12px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none">Open trip ${esc(w.trip)} &nbsp;&#8599;</a></td></tr></table>
<p style="font-size:12px;text-align:center;color:${K.soft};margin:10px 0 30px">Review and correct the site in TruckMate.</p>
${label('LOAD DETAILS', '#ffffff')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr><td bgcolor="${K.rule}" style="background:${K.rule};padding:20px 22px;border-radius:12px;font-size:14px;line-height:1.7;color:${K.soft}"><strong style="color:#ffffff">Site rule · Dispatch &amp; Billing</strong><div style="margin:8px 0">All <b style="color:#ffffff">Tempest</b> loads belong in <b style="color:#ffffff">Site 9 (F)</b>, including every OTR freight bill.<br><b style="color:#ffffff">Site 2 (B)</b> is only for FBE and FBF loads.</div><span style="font-size:12px;color:${K.muted}">From Ronen · Nov 20</span></td></tr></table>
</td></tr>
<tr><td class="sa-pad" bgcolor="#11233a" style="background:#11233a;padding:22px 28px;border-radius:0 0 20px 20px;border-top:1px solid ${K.line}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="44" height="44" align="center" bgcolor="#0b1626" style="background:#0b1626;border-radius:22px;font-size:18px;font-weight:bold;color:#ffffff">J</td><td style="padding-left:14px"><div style="font-size:15px;font-weight:bold;color:#ffffff">Flagged by Jarvis</div><div style="font-size:13px;color:${K.soft};margin-top:3px">AI Dispatcher · Florida Beauty Flora</div></td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
}

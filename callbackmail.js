// Callback email presentation only. Routing, subject and SMS remain in helpdesk.js.
import { readFileSync } from 'node:fs';
import { esc, telHref } from './jarvismail.js';
const art = readFileSync(new URL('./assets/email/callback-message.png', import.meta.url));
const avatar = readFileSync(new URL('./assets/email/jarvis-avatar.png', import.meta.url));
const lines = (s) => esc(s).replace(/\r?\n/g, '<br>');
export function callbackMail({ req, load, who, reach, forWho, via }) {
  const phone = telHref(req.from.phone);
  const label = (s) => `<div style="font-size:11px;letter-spacing:1.2px;font-weight:bold;margin-bottom:8px">${s}</div>`;
  const bubble = (title, value) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="16"></td><td bgcolor="#007aff" style="background:#007aff;color:#ffffff;border-radius:23px 23px 4px 23px;padding:20px 23px;word-break:break-word">${label(title)}<div style="font-family:Arial,sans-serif;font-size:21px;line-height:1.5;color:#ffffff">${lines(value)}</div></td></tr><tr><td></td><td align="right" style="height:10px;font-size:0"><span style="display:inline-block;width:0;height:0;border-top:10px solid #007aff;border-left:13px solid transparent"></span></td></tr></table>`;
  const details = load ? `<div style="margin:22px 0;padding:18px;background:#edf1f6;border-radius:10px;font-size:14px;line-height:1.7">${label(`LOAD ${esc(load.trip)}`)}Truck ${esc(load.truck || '—')} · Trailer ${esc(load.trailer || '—')}<br><b>Now:</b> ${esc(load.location || 'no GPS')}${load.motion ? ` · ${esc(load.motion)}` : ''}${load.next ? `<br><b>Next stop:</b> ${esc(load.next)}` : ''}</div>` : (req.trip ? `<p>Load ${esc(req.trip)}</p>` : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media(max-width:480px){.cb-pad{padding:22px 18px!important}.cb-title{font-size:27px!important}.cb-outer{padding:12px 6px!important}}</style></head><body style="margin:0;background:#e9eef5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#e9eef5"><tr><td class="cb-outer" align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf9;border:1px solid #e1ded8;border-radius:20px;font-family:Arial,sans-serif;color:#152d47">
<tr><td class="cb-pad" style="padding:20px 28px;font-size:12px;letter-spacing:1.5px;font-weight:bold">J &nbsp; FLORIDA BEAUTY FLORA</td></tr>
<tr><td align="center" bgcolor="#142f49" class="cb-pad" style="padding:24px 28px 30px;color:#ffffff;background:#142f49">
<img src="cid:callback-art" width="230" height="145" alt="Phone with a message bubble — message taken by Jarvis" style="display:block;margin:0 auto 16px;border:0;max-width:100%">
${label(req.urgent ? '<span style="color:#ffbe89">URGENT CALLBACK REQUEST</span>' : '<span style="color:#ffbe89">SOMEONE LEFT A MESSAGE</span>')}
<h1 class="cb-title" style="font-size:29px;line-height:1.2;margin:10px 0;color:#ffffff">${forWho ? `A message for ${esc(forWho)}.` : 'A message for your team.'}</h1>
<p style="font-size:14px;line-height:1.5;color:#c8d5e1;margin:0">${esc(who)} needs someone to reach out — from ${esc(via)}.</p></td></tr>
<tr><td class="cb-pad" style="padding:27px 28px;word-break:break-word">
<div style="color:#64748b">${label('MESSAGE FROM')}</div><div style="font-size:23px;font-weight:bold;margin:4px 0 8px">${esc(who)}</div>
${req.from.company && req.from.company !== who ? `<p style="font-size:14px;margin:0 0 8px">${esc(req.from.company)}</p>` : ''}
${req.role && req.role !== 'unknown' ? `<div style="font-size:13px;color:#64748b;margin-bottom:8px">${esc(req.role)}</div>` : ''}
<p style="font-size:15px;color:#64748b;margin:0 0 22px">${esc(reach)}</p>
${bubble(req.said ? 'WHAT THEY NEED' : 'MESSAGE', req.need)}
${req.said ? `<div style="height:12px"></div>${bubble('WHAT THEY SAID', String(req.said).slice(0, 2500))}` : ''}
<p style="font-size:12px;color:#64748b;margin:5px 0 22px">Captured by Jarvis · ${esc(via)}</p>
${forWho ? `<p style="font-size:13px;margin:0 0 20px;color:#64748b">Message for &nbsp; <strong style="color:#152d47">${esc(forWho)}</strong></p>` : ''}
${details}
${phone ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#ee8d4c" style="border-radius:9px;background:#ee8d4c"><a href="${phone}" style="display:block;padding:15px 12px;color:#182d42;font-weight:bold;font-size:15px;text-decoration:none">Call ${esc(who)}</a></td></tr></table>` : ''}
<p style="text-align:center;margin:18px 0"><a href="https://mytagalong.app/truckmate?tab=inbox" style="color:#174a7a;font-size:14px;font-weight:bold;text-decoration:underline">Open Jarvis inbox →</a></p>
<p style="font-size:12px;line-height:1.7;color:#64748b;text-align:center;margin:0">After reaching out, mark it handled in<br><b>Jarvis inbox → Callback requests.</b></p>
</td></tr><tr><td class="cb-pad" bgcolor="#f2eee7" style="padding:20px 28px;background:#f2eee7;border-radius:0 0 20px 20px;border-top:1px solid #e1ded8">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px"><img src="cid:callback-avatar" width="42" height="42" alt="Jarvis" style="display:block;border-radius:21px"></td><td style="font-size:14px;line-height:1.6;color:#152d47"><b>Message delivered by Jarvis</b><br><span style="font-size:12px;color:#64748b">AI Dispatcher · Florida Beauty Flora</span></td></tr></table>
</td></tr></table></td></tr></table></body></html>`;
  return { html, attachments: [
    { name: 'callback-message.png', contentType: 'image/png', bytes: art, cid: 'callback-art' },
    { name: 'jarvis.png', contentType: 'image/png', bytes: avatar, cid: 'callback-avatar' },
  ] };
}

// ---------------------------------------------------------------
// Every time Jarvis reaches out to a driver (text, TagAlong app message or call), dispatch
// gets a short email: which load / driver, how, and what was asked. Our staff only.
// ---------------------------------------------------------------
import { sendMail, mailConfig } from './mailer.js';

const tripOf = (it) => (it && it.trip) || it || {};
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtPhone = (p) => { const d = String(p || '').replace(/\D+/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ''); };
const HOW = { text: 'Text', app: 'TagAlong app message', call: 'Phone call' };

// What the email says. ev: { trip, channel, to, text, by, kind }; item: the board load. Pure.
export function outreachEmail(ev, item, now = Date.now()) {
  const t = tripOf(item); const s = (item && item._samsara) || {};
  const driver = (item && item._oc && item._oc.driverName) || (s.driver1Info && s.driver1Info.name) || s.driver1 || 'the driver';
  const asked = String(ev.text || '').replace(/^Florida Beauty Flora dispatch: Hi[^,.]*, this is Jarvis \(automated\)\.\s*/i, '').replace(/\s*Reply STOP to opt out\.\s*$/i, '').trim();
  const when = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const subject = `Jarvis → ${driver} · Trip ${ev.trip} · ${HOW[ev.channel] || 'Contact'}`;
  const rows = [['Trip', `${ev.trip}${t.powerUnit ? ` · truck ${t.powerUnit}` : ''}${t.trailer ? ` · trailer ${t.trailer}` : ''}`], ['Driver', `${driver}${ev.to && ev.channel !== 'app' ? ` · ${fmtPhone(ev.to)}` : ''}`], ['How', HOW[ev.channel] || ev.channel], ['When', `${when} ET`], [ev.channel === 'call' ? 'What the call asks' : 'What was asked', asked || '—'], ['Why', ev.by || 'Jarvis']];
  const F = 'font-family:Arial,Helvetica,sans-serif';
  const html = `<div style="margin:0;padding:0;background:#F3F4F6" bgcolor="#F3F4F6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:600px;margin:0 auto;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td style="padding:20px 20px 8px 20px;${F};font-size:20px;font-weight:bold;color:#1E3A5F">Jarvis contacted a driver</td></tr>
${rows.map(([k, v]) => `<tr><td style="padding:4px 20px 0 20px;${F};font-size:13px;color:#4B5563">${esc(k)}</td></tr><tr><td style="padding:0 20px 2px 20px;${F};font-size:16px;line-height:1.5;color:#111827;word-break:break-word">${esc(v)}</td></tr>`).join('')}
<tr><td style="padding:12px 20px 20px 20px;${F};font-size:13px;color:#4B5563;border-top:1px solid #E5E7EB">The driver's answer shows on the load (Calls &amp; texts). Jarvis — AI Dispatcher · Florida Beauty Flora</td></tr></table></div>`;
  const text = `JARVIS CONTACTED A DRIVER\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nJarvis — AI Dispatcher · Florida Beauty Flora`;
  return { subject, html, text };
}

export function initOutreach({ db, getBoard, groupEmail = null, isInternal = () => true, env = process.env, fetchFn = globalThis.fetch }) {
  const enabled = !!(db && db.enabled);
  // the dispatch email: the temp-photo list if set, else the follow-through dispatch group
  const dispatchTo = async () => {
    const own = ((await db.get('taTempPhotosCfg', {})) || {}).to || [];
    let list = own.length ? own : (((await db.get('taFollowCfg', {})) || {}).to || []);
    if (!list.length && groupEmail) list = [await groupEmail('dispatch').catch(() => null)].filter(Boolean);   // the Dispatch email group
    return list.filter((a) => isInternal(a, env));
  };
  async function notify(ev) {
    if (!enabled || !ev || !ev.trip || !mailConfig(env).ready) return { emailed: false };
    const to = await dispatchTo();
    if (!to.length) return { emailed: false };
    const item = ((((await getBoard(ev.site || 'florida-beauty')) || {}).trips) || []).find((x) => String(tripOf(x).tripNumber) === String(ev.trip)) || null;
    const m = outreachEmail(ev, item);
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text }, { env, fetchFn });
    return { emailed: true };
  }
  return { notify };
}

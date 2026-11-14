// ---------------------------------------------------------------
// Emails from Jarvis to our own people (an apology, a heads-up, a how-to). A company admin writes it, Jarvis sends a copy to the
// admin first (marked "copy for review"), and only a second call sends it to the employee. Staff addresses only
// (@floridabeauty.us). Layout: "A note from Jarvis" (staffEmail below); operational alerts keep their own templates.
// ---------------------------------------------------------------
import { readFileSync } from 'node:fs';

export const DRAFTS = 'taStaffMailDrafts';
export const COPY_TO = 'ntellez@floridabeauty.us';
const STAFF = /^[^@\s]+@floridabeauty\.us$/i;
const NAVY = '#13325B';
const BLUE = '#1D63C8';
const TEXT = '#1F2937';
const MUTED = '#4B5563';
const F = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ASSET = (f) => { try { return readFileSync(new URL(`./assets/email/${f}`, import.meta.url)); } catch { return null; } };
const MARK = ASSET('flower-mark.png');
// Jarvis's round avatar for the signature; until assets/email/jarvis-avatar.png exists the signature shows a navy "J" circle
const AVATAR = ASSET('jarvis-avatar.png');
export const ICONS = { mail: ASSET('icon-mail.png'), clock: ASSET('icon-clock.png'), calendar: ASSET('icon-calendar.png') };

// a list of staff addresses, or null when any of them isn't one of ours. Pure.
export function staffList(x) {
  const list = (Array.isArray(x) ? x : String(x || '').split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return list.length && list.every((s) => STAFF.test(s)) ? [...new Set(list)] : null;
}

// "A note from Jarvis": a personal note, explanation or team update to our own people (alerts keep their own layouts).
// Everything given is plain text and escaped. category ("TEAM UPDATE"), headline, greeting ("Hi Saray,"), body (blank
// lines = paragraphs, "- " lines = a list, a line "{{updates}}" = where the key-update box goes, else after the body),
// updates [{ icon: mail|clock|calendar, title, text }], closing ("Thank you,"). Unused parts are left out. copyFor: the
// people it will go to (shown on the review copy). → { subject, html, text, attachments }. Pure.
export function staffEmail({ subject, category = null, headline = null, greeting = null, body = '', updates = [], closing = 'Thank you,', copyFor = null }) {
  const p = (t, extra = '') => `<p style="margin:0 0 16px;font-family:${F};font-size:16px;line-height:24px;color:${TEXT};${extra}">${t}</p>`;
  const ups = (Array.isArray(updates) ? updates : []).filter((u) => u && (u.title || u.text)).slice(0, 6);
  const used = new Set();
  const box = ups.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAF2FC;border-radius:10px;margin:2px 0 20px;"><tr><td style="padding:6px 18px;">${ups.map((u, i) => {
    const ic = ICONS[u.icon] ? u.icon : null; if (ic) used.add(ic);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"${i ? ' style="border-top:1px solid #C9DAF0;"' : ''}><tr>
${ic ? `<td width="44" valign="middle" style="padding:14px 14px 14px 0;"><img src="cid:sm-${ic}" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;"></td>` : ''}
<td valign="middle" style="padding:14px 0;">${u.title ? `<div style="font-family:${F};font-size:17px;line-height:22px;font-weight:bold;color:${NAVY};">${esc(u.title)}</div>` : ''}${u.text ? `<div style="font-family:${F};font-size:14px;line-height:20px;color:${TEXT};margin-top:2px;">${esc(u.text)}</div>` : ''}</td></tr></table>`;
  }).join('')}</td></tr></table>` : '';
  let placed = false;
  const blocks = String(body || '').replace(/\r/g, '').trim().split(/\n\s*\n/).filter((b) => b.trim());
  const parts = blocks.map((b) => {
    if (b.trim() === '{{updates}}') { placed = true; return box; }
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l))) return `<ul style="margin:0 0 16px;padding-left:22px;">${lines.map((l) => `<li style="font-family:${F};font-size:16px;line-height:24px;color:${TEXT};margin:0 0 4px;">${esc(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`;
    return p(lines.map(esc).join('<br>'));
  });
  if (!placed && box) parts.push(box);
  const avatar = AVATAR
    ? '<img src="cid:sm-avatar" width="80" height="80" alt="Jarvis, AI Dispatcher" style="display:block;border:0;width:80px;height:80px;border-radius:40px;">'
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="72" height="72" align="center" valign="middle" style="width:72px;height:72px;border-radius:36px;background:${NAVY};font-family:${F};font-size:30px;font-weight:bold;color:#FFFFFF;">J</td></tr></table>`;
  const banner = copyFor ? `<tr><td style="background:#FEF3C7;padding:10px 24px;font-family:${F};font-size:13px;line-height:18px;color:#78350F;"><b>Copy for review.</b> Not sent yet. It will go to: ${esc(copyFor.join(', '))}</td></tr>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<style>@media only screen and (max-width:480px){.sm-wrap{width:100%!important}.sm-pad{padding-left:18px!important;padding-right:18px!important}.sm-h1{font-size:26px!important;line-height:31px!important}.sm-brand{font-size:15px!important;letter-spacing:1.5px!important}.sm-av img{width:64px!important;height:64px!important;border-radius:32px!important}.sm-name{font-size:22px!important}}</style></head>
<body style="margin:0;padding:0;background:#EEF1F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F5;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" class="sm-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;">
<tr><td align="center" style="background:${NAVY};padding:18px 20px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>${MARK ? '<td valign="middle" style="padding-right:12px;"><img src="cid:sm-mark" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;"></td>' : ''}<td valign="middle" class="sm-brand" style="font-family:${F};font-size:18px;font-weight:bold;letter-spacing:2.5px;color:#FFFFFF;">FLORIDA BEAUTY FLORA</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin-top:8px;"><tr><td width="36" style="border-top:1px solid #8FA3C0;font-size:0;line-height:0;">&nbsp;</td><td style="padding:0 10px;font-family:${F};font-size:11px;font-weight:bold;letter-spacing:2.5px;color:#DCE5F2;white-space:nowrap;">A NOTE FROM JARVIS</td><td width="36" style="border-top:1px solid #8FA3C0;font-size:0;line-height:0;">&nbsp;</td></tr></table>
</td></tr>
${banner}
<tr><td class="sm-pad" style="padding:28px 28px 8px;">
${category ? `<div style="font-family:${F};font-size:13px;font-weight:bold;letter-spacing:2px;color:${BLUE};margin:0 0 8px;">${esc(String(category).toUpperCase())}</div>` : ''}
${headline ? `<h1 class="sm-h1" style="margin:0;font-family:${F};font-size:32px;line-height:38px;font-weight:bold;color:${NAVY};word-wrap:break-word;">${esc(headline)}</h1><table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0 22px;"><tr><td width="56" height="3" style="background:${BLUE};font-size:0;line-height:0;">&nbsp;</td></tr></table>` : ''}
${greeting ? p(esc(greeting), 'font-size:18px;') : ''}
${parts.join('\n')}
${closing ? p(esc(closing), 'margin-bottom:0;') : ''}
</td></tr>
<tr><td class="sm-pad" style="padding:18px 28px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E2E8F0;"><tr><td style="padding-top:18px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td class="sm-av" valign="middle" style="padding-right:16px;">${avatar}</td>
<td valign="middle" style="border-left:1px solid #D5DEEA;padding-left:16px;">
<div class="sm-name" style="font-family:${F};font-size:24px;line-height:30px;font-weight:bold;color:${NAVY};">Jarvis</div>
<div style="font-family:${F};font-size:15px;line-height:21px;color:${MUTED};">Your AI Dispatcher</div>
<div style="font-family:${F};font-size:15px;line-height:21px;color:${MUTED};">Florida Beauty Flora</div>
</td></tr></table></td></tr></table></td></tr>
<tr><td align="center" style="padding:14px 28px 18px;font-family:${F};font-size:12px;font-style:italic;color:#6B7280;">Internal team communication</td></tr>
</table></td></tr></table></body></html>`;
  const plainBody = blocks.map((b) => (b.trim() === '{{updates}}' ? null : b.trim())).filter(Boolean);
  const plainUps = ups.map((u) => `- ${[u.title, u.text].filter(Boolean).join(': ')}`).join('\n');
  const text = [
    copyFor ? `COPY FOR REVIEW — not sent yet. It will go to: ${copyFor.join(', ')}` : null,
    category ? String(category).toUpperCase() : null, headline || null, greeting || null,
    ...(placed ? blocks.map((b) => (b.trim() === '{{updates}}' ? plainUps || null : b.trim())).filter(Boolean) : [...plainBody, plainUps || null].filter(Boolean)),
    closing || null, 'Jarvis\nYour AI Dispatcher\nFlorida Beauty Flora', '—\nInternal team communication',
  ].filter(Boolean).join('\n\n');
  const attachments = [
    ...(MARK ? [{ name: 'flower-mark.png', contentType: 'image/png', bytes: MARK, cid: 'sm-mark' }] : []),
    ...(AVATAR ? [{ name: 'jarvis.png', contentType: 'image/png', bytes: AVATAR, cid: 'sm-avatar' }] : []),
    ...[...used].map((k) => ({ name: `${k}.png`, contentType: 'image/png', bytes: ICONS[k], cid: `sm-${k}` })),
  ];
  return { subject: copyFor ? `[Copy for review] ${subject}` : subject, html, text, attachments };
}

// the optional parts of a note, as plain text (trimmed, capped). Pure.
const t = (x, n) => (x == null || String(x).trim() === '' ? null : String(x).trim().slice(0, n));
export const fields = (b = {}) => ({
  category: t(b.category, 40), headline: t(b.headline, 140), greeting: t(b.greeting, 120),
  updates: (Array.isArray(b.updates) ? b.updates : []).slice(0, 6).map((u) => ({ icon: ['mail', 'clock', 'calendar'].includes(u && u.icon) ? u.icon : null, title: t(u && u.title, 80), text: t(u && u.text, 200) })).filter((u) => u.title || u.text),
  closing: b.closing === undefined ? 'Thank you,' : t(b.closing, 80),
});

export function initStaffMail(app, { requireAdmin, db, sendMail, now = () => Date.now() } = {}) {
  if (!app || !requireAdmin || !db) return {};
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'admin';
  // draft → copy to the admin (ntellez@ unless copyTo says another staff address)
  app.post('/truckmate/staff-email/draft', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const to = staffList(b.to); const cc = b.cc ? staffList(b.cc) : [];
    const copyTo = staffList(b.copyTo || COPY_TO);
    const subject = String(b.subject || '').trim().slice(0, 200); const body = String(b.body || '').trim().slice(0, 8000);
    if (!to || cc === null || !copyTo) return res.status(400).json({ error: 'Staff addresses only (@floridabeauty.us).' });
    if (!subject || !body) return res.status(400).json({ error: 'Write a subject and a message.' });
    const id = `sm${now().toString(36)}`;
    const extra = fields(b);
    const m = staffEmail({ subject, body, ...extra, copyFor: [...to, ...cc] });
    try { await sendMail({ to: copyTo, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments }, { copy: false }); } catch (e) { return res.status(502).json({ error: e.message }); }
    await db.update(DRAFTS, (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [id]: { id, to, cc, subject, body, ...extra, by: who(req), at: new Date(now()).toISOString(), copyTo, sentAt: null } }).slice(-100)), {});
    res.json({ ok: true, id, copyTo, to, cc });
  });
  // the real send, after the admin read the copy
  app.post('/truckmate/staff-email/:id/send', requireAdmin, async (req, res) => {
    const all = (await db.get(DRAFTS, {})) || {}; const d = all[String(req.params.id)];
    if (!d) return res.status(404).json({ error: 'No such draft.' });
    if (d.sentAt) return res.json({ ok: true, already: true, sentAt: d.sentAt });
    const m = staffEmail({ subject: d.subject, body: d.body, ...fields(d) });
    try { await sendMail({ to: d.to, cc: d.cc, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments }); } catch (e) { return res.status(502).json({ error: e.message }); }
    const sentAt = new Date(now()).toISOString();
    await db.update(DRAFTS, (cur) => ({ ...(cur || {}), [d.id]: { ...d, sentAt, sentBy: who(req) } }), {});
    res.json({ ok: true, sentAt, to: d.to });
  });
  app.get('/truckmate/staff-email', requireAdmin, async (req, res) => {
    res.json({ drafts: Object.values((await db.get(DRAFTS, {})) || {}).reverse() });
  });
  return {};
}

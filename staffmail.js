// ---------------------------------------------------------------
// Emails from Jarvis to our own people (an apology, a heads-up, a how-to). A company admin writes it, Jarvis sends a copy to the
// admin first (marked "copy for review"), and only a second call sends it to the employee. Staff addresses only
// (@floridabeauty.us). The body is plain text: blank lines start paragraphs, lines starting "- " become a list.
// ---------------------------------------------------------------
import { readFileSync } from 'node:fs';

export const DRAFTS = 'taStaffMailDrafts';
export const COPY_TO = 'ntellez@floridabeauty.us';
const STAFF = /^[^@\s]+@floridabeauty\.us$/i;
const NAVY = '#13325B';
const F = 'Arial,Helvetica,sans-serif';
const TEXT = '#14213D';
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MARK = (() => { try { return readFileSync(new URL('./assets/email/flower-mark.png', import.meta.url)); } catch { return null; } })();

// a list of staff addresses, or null when any of them isn't one of ours. Pure.
export function staffList(x) {
  const list = (Array.isArray(x) ? x : String(x || '').split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return list.length && list.every((s) => STAFF.test(s)) ? [...new Set(list)] : null;
}

// plain text → paragraphs and lists, in the Jarvis header layout. copyFor: the people it will go to (shown on the review copy). Pure.
export function staffEmail({ subject, body, copyFor = null }) {
  const blocks = String(body || '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  const part = (b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return `<ul style="margin:0 0 14px;padding-left:22px;">${lines.map((l) => `<li style="font-family:${F};font-size:15px;line-height:22px;color:${TEXT};margin:0 0 4px;">${esc(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 14px;font-family:${F};font-size:15px;line-height:22px;color:${TEXT};">${lines.map(esc).join('<br>')}</p>`;
  };
  const banner = copyFor ? `<tr><td style="background:#FEF3C7;padding:10px 20px;font-family:${F};font-size:13px;color:#78350F;"><b>Copy for review.</b> Not sent yet. It will go to: ${esc(copyFor.join(', '))}</td></tr>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#E8EEF6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EEF6;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:14px 20px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
${MARK ? '<td valign="middle" style="padding-right:14px;border-right:1px solid #5F7799;"><img src="cid:sm-mark" width="40" height="40" alt="Florida Beauty Flora" style="display:block;border:0;width:40px;height:40px;"></td>' : ''}
<td valign="middle" style="padding-left:${MARK ? 14 : 0}px;"><div style="font-family:${F};font-size:19px;font-weight:bold;letter-spacing:1px;color:#FFFFFF;">FLORIDA BEAUTY FLORA</div><div style="font-family:${F};font-size:12px;letter-spacing:2px;color:#C9D6EA;">JARVIS · DISPATCH</div></td></tr></table></td></tr>
${banner}
<tr><td style="padding:22px 24px 10px;">${blocks.map(part).join('\n')}</td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject: copyFor ? `[Copy for review] ${subject}` : subject,
    html,
    text: `${copyFor ? `COPY FOR REVIEW — not sent yet. It will go to: ${copyFor.join(', ')}\n\n` : ''}${String(body || '').trim()}`,
    attachments: MARK ? [{ name: 'flower-mark.png', contentType: 'image/png', bytes: MARK, cid: 'sm-mark' }] : [],
  };
}

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
    const m = staffEmail({ subject, body, copyFor: [...to, ...cc] });
    try { await sendMail({ to: copyTo, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments }, { copy: false }); } catch (e) { return res.status(502).json({ error: e.message }); }
    await db.update(DRAFTS, (cur) => Object.fromEntries(Object.entries({ ...(cur || {}), [id]: { id, to, cc, subject, body, by: who(req), at: new Date(now()).toISOString(), copyTo, sentAt: null } }).slice(-100)), {});
    res.json({ ok: true, id, copyTo, to, cc });
  });
  // the real send, after the admin read the copy
  app.post('/truckmate/staff-email/:id/send', requireAdmin, async (req, res) => {
    const all = (await db.get(DRAFTS, {})) || {}; const d = all[String(req.params.id)];
    if (!d) return res.status(404).json({ error: 'No such draft.' });
    if (d.sentAt) return res.json({ ok: true, already: true, sentAt: d.sentAt });
    const m = staffEmail({ subject: d.subject, body: d.body });
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

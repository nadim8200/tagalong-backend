// ---------------------------------------------------------------
// Training mode — while we watch how Jarvis behaves, nothing it sends reaches
// people outside: every email goes to the test addresses instead (the subject
// and a banner say who it was really for), and texts, Jarvis calls and driver-app
// messages are NOT sent — a copy of what would have gone out is emailed to the
// test addresses. Password-reset emails still go to the person (they're private).
// Inbound calls / emails work as usual. Admins turn it on and off.
// ---------------------------------------------------------------
import { TRAINING_SLOT, trainingRow } from './latemail.js';

const KEY = 'taTrainingMode';
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// An email rewritten for training. Pure.
export function redirectEmail(m, to) {
  const split = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).filter(Boolean);
  const orig = [...split(m.to), ...split(m.cc).map((x) => `${x} (cc)`)];
  const banner = `<div style="font-family:Arial,sans-serif;font-size:13px;background:#fff7cc;border:1px solid #e6c200;padding:8px 10px;margin-bottom:12px"><b>TRAINING PREVIEW — Not sent to customer.</b> It would have gone to: <b>${esc(orig.join(', ') || '(nobody)')}</b></div>`;
  // an email with its own spot for the notice (the late-for-committed-time email) gets the compact one there
  const html = String(m.html || '').includes(TRAINING_SLOT) ? String(m.html).replace(TRAINING_SLOT, trainingRow(orig.join(', '))) : banner + (m.html || '');
  return { ...m, to, cc: [], subject: `[TRAINING → ${orig.slice(0, 3).join(', ')}${orig.length > 3 ? '…' : ''}] ${m.subject || ''}`.slice(0, 250), html, ...(m.text ? { text: `TRAINING PREVIEW — Not sent to customer. It would have gone to: ${orig.join(', ') || '(nobody)'}\n\n${m.text}` } : {}) };
}
// The copy for a text / call / app message that was held. Pure.
export function heldCopy(kind, { to, text, trip, purpose }) {
  const what = { text: 'texted', call: 'called', app: 'sent a driver-app message to' }[kind] || 'contacted';
  return {
    subject: `[TRAINING] Jarvis would have ${what} ${to || 'someone'}${trip ? ` · load ${trip}` : ''}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p><b>🧪 TRAINING MODE</b> — nothing was sent.</p><p>Jarvis would have <b>${esc(what)} ${esc(to || '')}</b>${trip ? ` about load <b>${esc(trip)}</b>` : ''}${purpose ? ` (${esc(purpose)})` : ''}:</p>${text ? `<blockquote style="border-left:3px solid #94a3b8;margin:0;padding:4px 10px;color:#334155">${esc(text)}</blockquote>` : ''}<p style="color:#64748b">Turn training mode off in Calls, texts &amp; email to let Jarvis contact people for real.</p></div>`,
  };
}

// People Jarvis may reach FOR REAL while training mode is on (our own staff who asked Jarvis for something —
// e.g. Ronen). Emails and phone numbers; everyone else stays redirected / held.
export const DEFAULT_ALLOW = ['ronen@floridabeauty.us'];
const digits = (x) => String(x || '').replace(/\D/g, '').slice(-10);
export function allowedMatch(allow = [], who = '') {
  const w = String(who || '').trim().toLowerCase();
  return (allow || []).some((a) => { const x = String(a).trim().toLowerCase(); return x.includes('@') ? x === w : (digits(x).length === 10 && digits(x) === digits(w)); });
}
// training mail with approved people: they get the real email; the rest is redirected as before. Pure.
export function guardWithAllow(m, to, allow) {
  const split = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).filter(Boolean);
  const rec = split(m.to); const cc = split(m.cc);
  const ok = rec.filter((x) => allowedMatch(allow, x)); const okCc = cc.filter((x) => allowedMatch(allow, x));
  const rest = rec.filter((x) => !allowedMatch(allow, x)); const restCc = cc.filter((x) => !allowedMatch(allow, x));
  if (!rest.length && !restCc.length) return m;                       // only approved people → as is
  const r = redirectEmail({ ...m, to: rest, cc: restCc }, to);
  return ok.length || okCc.length ? { ...r, to: [...new Set([...r.to, ...ok, ...okCc])] } : r;
}

export function initTraining(app, { requireAuth, requireAdmin, db, sendDirect }) {
  const enabled = !!(db && db.enabled);
  let cache = { at: 0, cfg: { on: false, to: [] } };
  async function cfg() {
    if (!enabled) return { on: false, to: [] };
    if (Date.now() - cache.at < 10000) return cache.cfg;
    const c = { on: false, to: [], ...((await db.get(KEY, {})) || {}) };
    if (!Array.isArray(c.allow)) c.allow = DEFAULT_ALLOW;
    cache = { at: Date.now(), cfg: c };
    return c;
  }
  const active = async () => { const c = await cfg(); return c.on && (c.to || []).length ? c : null; };

  // email: redirect (null = not training)
  async function mailGuard(m) { const c = await active(); return c ? guardWithAllow(m, c.to, c.allow) : m; }
  // text / call / app message: hold it and email a copy → returns a stand-in result, or null when live
  async function hold(kind, info) {
    const c = await active();
    if (!c) return null;
    if (info && allowedMatch(c.allow, info.to)) return null;          // an approved person → goes out for real
    const copy = heldCopy(kind, info);
    try { await sendDirect({ to: c.to, subject: copy.subject, html: copy.html }); } catch (e) { console.warn('[training] copy:', e.message); }
    return { training: true, held: kind, to: info.to || null };
  }

  app.get('/truckmate/training', requireAuth, async (req, res) => { const c = await cfg(); res.json({ on: !!c.on, to: c.to || [], allow: c.allow || [], since: c.since || null, by: c.by || null }); });
  app.put('/admin/training', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(okEmail))].slice(0, 5);
    if (b.on && !to.length) return res.status(400).json({ error: 'Add at least one test email first.' });
    const cur = (await db.get(KEY, {})) || {};
    const allow = Array.isArray(b.allow) ? [...new Set(b.allow.map((x) => String(x).trim().toLowerCase()).filter((x) => okEmail(x) || digits(x).length === 10))].slice(0, 20) : (Array.isArray(cur.allow) ? cur.allow : DEFAULT_ALLOW);
    const next = { on: b.on != null ? !!b.on : !!cur.on, to: to.length || b.to != null ? to : (cur.to || []), allow, since: b.on ? (cur.on ? cur.since : new Date().toISOString()) : (b.on == null ? cur.since || null : null), by: (req.user && (req.user.name || req.user.email)) || 'admin' };
    await db.set(KEY, next);
    cache = { at: 0, cfg: next };
    res.json(next);
  });
  return { cfg, mailGuard, hold, active };
}

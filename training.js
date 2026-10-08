// ---------------------------------------------------------------
// Training mode — while we watch how Jarvis behaves, nothing it sends reaches
// people outside: every email goes to the test addresses instead (the subject
// and a banner say who it was really for), and texts, Jarvis calls and driver-app
// messages are NOT sent — a copy of what would have gone out is emailed to the
// test addresses. Password-reset emails still go to the person (they're private).
// Inbound calls / emails work as usual. Admins turn it on and off.
// ---------------------------------------------------------------
const KEY = 'taTrainingMode';
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// An email rewritten for training. Pure.
export function redirectEmail(m, to) {
  const orig = (Array.isArray(m.to) ? m.to : String(m.to || '').split(/[,;\s]+/)).filter(Boolean);
  const banner = `<div style="font-family:Arial,sans-serif;font-size:13px;background:#fff7cc;border:1px solid #e6c200;padding:8px 10px;margin-bottom:12px"><b>🧪 TRAINING MODE</b> — this email was NOT sent to its real recipients. It would have gone to: <b>${esc(orig.join(', ') || '(nobody)')}</b></div>`;
  return { ...m, to, subject: `[TRAINING → ${orig.slice(0, 3).join(', ')}${orig.length > 3 ? '…' : ''}] ${m.subject || ''}`.slice(0, 250), html: banner + (m.html || '') };
}
// The copy for a text / call / app message that was held. Pure.
export function heldCopy(kind, { to, text, trip, purpose }) {
  const what = { text: 'texted', call: 'called', app: 'sent a driver-app message to' }[kind] || 'contacted';
  return {
    subject: `[TRAINING] Jarvis would have ${what} ${to || 'someone'}${trip ? ` · load ${trip}` : ''}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p><b>🧪 TRAINING MODE</b> — nothing was sent.</p><p>Jarvis would have <b>${esc(what)} ${esc(to || '')}</b>${trip ? ` about load <b>${esc(trip)}</b>` : ''}${purpose ? ` (${esc(purpose)})` : ''}:</p>${text ? `<blockquote style="border-left:3px solid #94a3b8;margin:0;padding:4px 10px;color:#334155">${esc(text)}</blockquote>` : ''}<p style="color:#64748b">Turn training mode off in Calls, texts &amp; email to let Jarvis contact people for real.</p></div>`,
  };
}

export function initTraining(app, { requireAuth, requireAdmin, db, sendDirect }) {
  const enabled = !!(db && db.enabled);
  let cache = { at: 0, cfg: { on: false, to: [] } };
  async function cfg() {
    if (!enabled) return { on: false, to: [] };
    if (Date.now() - cache.at < 10000) return cache.cfg;
    const c = { on: false, to: [], ...((await db.get(KEY, {})) || {}) };
    cache = { at: Date.now(), cfg: c };
    return c;
  }
  const active = async () => { const c = await cfg(); return c.on && (c.to || []).length ? c : null; };

  // email: redirect (null = not training)
  async function mailGuard(m) { const c = await active(); return c ? redirectEmail(m, c.to) : m; }
  // text / call / app message: hold it and email a copy → returns a stand-in result, or null when live
  async function hold(kind, info) {
    const c = await active();
    if (!c) return null;
    const copy = heldCopy(kind, info);
    try { await sendDirect({ to: c.to, subject: copy.subject, html: copy.html }); } catch (e) { console.warn('[training] copy:', e.message); }
    return { training: true, held: kind, to: info.to || null };
  }

  app.get('/truckmate/training', requireAuth, async (req, res) => { const c = await cfg(); res.json({ on: !!c.on, to: c.to || [], since: c.since || null, by: c.by || null }); });
  app.put('/admin/training', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(okEmail))].slice(0, 5);
    if (b.on && !to.length) return res.status(400).json({ error: 'Add at least one test email first.' });
    const next = { on: !!b.on, to, since: b.on ? new Date().toISOString() : null, by: (req.user && (req.user.name || req.user.email)) || 'admin' };
    await db.set(KEY, next);
    cache = { at: 0, cfg: next };
    res.json(next);
  });
  return { cfg, mailGuard, hold };
}

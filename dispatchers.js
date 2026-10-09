// ---------------------------------------------------------------
// Dispatcher accounts — the people who work the AI dispatcher console.
// Admins create / disable / remove them (no public sign-up). A dispatcher signs
// in with email + password and only gets the dispatch side (the console, Jarvis,
// loads, emails, calls) — not the rest of the admin system.
//
// requireDispatch guards every dispatch API: an admin, or an ACTIVE dispatcher.
// A dispatcher who was disabled or removed is locked out on the next request
// (the account is checked, not just the token). Dispatcher logins last 30 days.
// ---------------------------------------------------------------
import { randomBytes, createHash } from 'crypto';

const KEY = 'taDispatchers';
const norm = (e) => String(e || '').toLowerCase().trim();
const view = ({ pass, reset, ...d }) => d;   // never the password (it's only stored scrambled) or a reset token
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
// A temporary password an admin can read out: Truck-Miami-4821 style. Pure-ish.
const WORDS = ['Truck', 'Trailer', 'Miami', 'Reefer', 'Rose', 'Orchid', 'Dock', 'Route', 'Cargo', 'Flora', 'Lane', 'Mile', 'Haul', 'Bloom', 'Tulip', 'Fleet'];
export const tempPassword = () => { const b = randomBytes(4); return `${WORDS[b[0] % 16]}-${WORDS[b[1] % 16]}-${1000 + (b.readUInt16BE(2) % 9000)}`; };
// Is this new password OK? → error text or null. Pure.
export function passwordProblem(next, { current = null, email = '' } = {}) {
  const p = String(next || '');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use letters and at least one number.';
  if (current && p === current) return 'Pick a new password, not the one you were given.';
  if (email && p.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) return "Don't use your email in the password.";
  return null;
}

// What a dispatcher login may do. Dispatchers work loads: the AI dispatcher console
// (loads, alerts, Jarvis chat, calls / texts to drivers, emails on a load). They can
// read settings but never change them, and can't reach anything outside the console
// (TagAlong accounts, the loads page, devices…). Pure.
//   → null (allowed) | 'outside' | 'settings'
const CONSOLE = /^\/(truckmate|watchtower|voice|jarvis)(\/|$)|^\/ringcentral\/(call|calls|sms|my-phone|numbers)(\/|$)|^\/auth\/(me|logout|dispatcher)(\/|$)|^\/push\/(register|unregister)$/;
const ADMIN_ONLY = [
  /\/settings\/?$/, /\/config\/?$/,                    // every settings / config screen
  /^\/voice\/setup/,                                      // Jarvis voice agent in Retell
  /^\/truckmate\/activity\/push/,                         // who gets call / text pushes
  /^\/truckmate\/profiles(\/|$)/,                         // customer & broker profiles, authorized numbers
  /^\/truckmate\/caller-numbers(\/|$)/,                   // which customer a caller's phone number is saved for
  /^\/truckmate\/consent\/settings/,
];
export function dispatcherMayUse(method, path) {
  const p = String(path || '').split('?')[0];
  if (!CONSOLE.test(p)) return 'outside';
  if (String(method).toUpperCase() !== 'GET' && String(method).toUpperCase() !== 'HEAD' && ADMIN_ONLY.some((re) => re.test(p))) return 'settings';
  return null;
}

export function initDispatchers(app, { requireAuth, db, hashPassword, verifyPassword, sign, setCookie, mail = null, appUrl = 'https://mytagalong.app' }) {
  const enabled = !!(db && db.enabled);
  let cache = { at: 0, list: [] };
  const list = async (fresh = false) => {
    if (!fresh && Date.now() - cache.at < 30000) return cache.list;
    const v = await db.get(KEY, { list: [] });
    cache = { at: Date.now(), list: (v && v.list) || [] };
    return cache.list;
  };
  const save = async (fn) => { const v = await db.update(KEY, (cur) => ({ list: fn([...((cur && cur.list) || [])]) }), { list: [] }); cache = { at: Date.now(), list: v.list }; return v.list; };
  const isAdmin = (u) => !!(u && (u.admin || u.role === 'admin'));
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'admin';

  // admin, or an active dispatcher account
  function requireDispatch(req, res, next) {
    return requireAuth(req, res, async () => {
      if (isAdmin(req.user)) return next();
      if (req.user && req.user.role === 'dispatcher') {
        try {
          const d = (await list()).find((x) => x.id === req.user.id);
          if (d && d.active !== false && d.mustChange) return res.status(403).json({ error: 'Set your own password first.', mustChange: true });
          if (d && d.active !== false) return next();
          return res.status(401).json({ error: 'This dispatcher account was turned off. Ask an admin.' });
        } catch { return res.status(503).json({ error: 'Could not check your account.' }); }
      }
      return res.status(403).json({ error: 'Dispatch access only.' });
    });
  }
  const requireAdmin = (req, res, next) => requireAuth(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only.' })));

  app.post('/auth/dispatcher/login', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const e = norm(req.body && req.body.email); const pw = String((req.body && req.body.password) || '');
    if (!e || !pw) return res.status(400).json({ error: 'Email and password required.' });
    try {
      const d = (await list(true)).find((x) => x.email === e);
      if (!d || !verifyPassword(pw, d.pass)) return res.status(401).json({ error: 'Wrong email or password.' });
      if (d.active === false) return res.status(401).json({ error: 'This dispatcher account is turned off. Ask an admin.' });
      const user = { id: d.id, email: d.email, name: d.name, role: 'dispatcher' };
      const token = sign(user, '30d');
      setCookie(res, token);
      const at = new Date().toISOString();
      const seen = { at, ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null, device: String(req.headers['user-agent'] || '').slice(0, 160) || null };
      await save((l) => l.map((x) => (x.id === d.id ? { ...x, lastLoginAt: at, logins: [seen, ...(x.logins || [])].slice(0, 20) } : x)));
      res.json({ ...user, token, mustChange: !!d.mustChange });
    } catch { res.status(502).json({ error: 'Login failed, try again.' }); }
  });

  // the dispatcher sets their own password (required after the first sign-in / an admin reset)
  const logPw = (x, entry) => ({ ...x, passwordChangedAt: entry.at, passwordLog: [entry, ...(x.passwordLog || [])].slice(0, 30) });
  app.post('/auth/dispatcher/password', requireAuth, async (req, res) => {
    if (!req.user || req.user.role !== 'dispatcher') return res.status(403).json({ error: 'Dispatcher accounts only.' });
    const b = req.body || {};
    try {
      const d = (await list(true)).find((x) => x.id === req.user.id);
      if (!d || d.active === false) return res.status(401).json({ error: 'This dispatcher account is turned off. Ask an admin.' });
      if (!verifyPassword(String(b.current || ''), d.pass)) return res.status(401).json({ error: 'Your current password is wrong.' });
      const bad = passwordProblem(b.next, { current: String(b.current || ''), email: d.email });
      if (bad) return res.status(400).json({ error: bad });
      const at = new Date().toISOString();
      await save((l) => l.map((x) => (x.id === d.id ? logPw({ ...x, pass: hashPassword(String(b.next)), mustChange: false, reset: null }, { at, by: d.name, how: 'changed by the dispatcher' }) : x)));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // forgot password → an email with a reset link (only once the Jarvis mailbox is connected)
  const mailReady = () => !!(mail && mail.ready && mail.ready());
  async function sendResetLink(d, by) {
    const token = randomBytes(24).toString('hex');
    const at = new Date().toISOString();
    await save((l) => l.map((x) => (x.id === d.id ? { ...x, reset: { hash: sha(token), until: Date.now() + 60 * 60000, at, by } } : x)));
    const link = `${appUrl}/truckmate?admin&reset=${token}`;
    await mail.send({ to: [d.email], subject: 'Reset your Dynamic Dispatch password', html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Hi ${String(d.name).replace(/[<>&]/g, '')},</p><p>Use this link to set a new password for the AI dispatcher console. It works once, for 1 hour.</p><p><a href="${link}">Set a new password</a></p><p>If you didn't ask for this, ignore this email — your password stays the same.</p><p>Jarvis — Dynamic Dispatch</p></div>` });
  }
  app.get('/auth/dispatcher/forgot', (req, res) => res.json({ available: mailReady() }));
  app.post('/auth/dispatcher/forgot', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    if (!mailReady()) return res.status(503).json({ error: "Password reset by email isn't on yet — ask your admin to reset it." });
    const e = norm(req.body && req.body.email);
    try {
      const d = (await list(true)).find((x) => x.email === e && x.active !== false);
      if (d && !(d.reset && d.reset.until > Date.now() && Date.now() - Date.parse(d.reset.at) < 2 * 60000)) await sendResetLink(d, 'forgot password');
    } catch { /* same answer either way */ }
    res.json({ ok: true, message: 'If that email has a dispatcher account, a reset link is on its way.' });   // never says whether the email exists
  });
  app.post('/auth/dispatcher/reset', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const h = sha(String(b.token || ''));
    try {
      const d = (await list(true)).find((x) => x.reset && x.reset.hash === h);
      if (!d || d.reset.until < Date.now()) return res.status(400).json({ error: 'This reset link expired or was already used. Ask for a new one.' });
      const bad = passwordProblem(b.password, { email: d.email });
      if (bad) return res.status(400).json({ error: bad });
      await save((l) => l.map((x) => (x.id === d.id ? logPw({ ...x, pass: hashPassword(String(b.password)), mustChange: false, reset: null }, { at: new Date().toISOString(), by: d.name, how: 'reset by email link' }) : x)));
      res.json({ ok: true, email: d.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // admin: reset a dispatcher's password — a temporary one to give them (they must change it), or an email link
  app.post('/admin/dispatchers/:id/reset', requireAdmin, async (req, res) => {
    try {
      const d = (await list(true)).find((x) => x.id === req.params.id);
      if (!d) return res.status(404).json({ error: 'Not found.' });
      if ((req.body || {}).how === 'email') {
        if (!mailReady()) return res.status(503).json({ error: 'Email reset links work once the Jarvis mailbox (Outlook) is connected.' });
        await sendResetLink(d, who(req));
        await save((l) => l.map((x) => (x.id === d.id ? { ...x, passwordLog: [{ at: new Date().toISOString(), by: who(req), how: 'reset link emailed by admin' }, ...(x.passwordLog || [])].slice(0, 30) } : x)));
        return res.json({ ok: true, emailed: d.email });
      }
      const temp = tempPassword();
      await save((l) => l.map((x) => (x.id === d.id ? logPw({ ...x, pass: hashPassword(temp), mustChange: true, reset: null }, { at: new Date().toISOString(), by: who(req), how: 'temporary password set by admin' }) : x)));
      res.json({ ok: true, tempPassword: temp });   // shown to the admin once; never stored readable
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/dispatchers', requireAdmin, async (req, res) => {
    try { res.json((await list(true)).map(view)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/admin/dispatchers', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const e = norm(b.email); const name = String(b.name || '').trim().slice(0, 80);
    const pw = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || !name) return res.status(400).json({ error: 'Name and a valid email are required.' });
    if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      if ((await list(true)).some((x) => x.email === e)) return res.status(409).json({ error: 'A dispatcher with that email already exists.' });
      const at = new Date().toISOString();
      const d = { id: `D${Date.now()}${randomBytes(2).toString('hex')}`, email: e, name, pass: hashPassword(pw), active: true, mustChange: true, createdAt: at, createdBy: who(req), passwordLog: [{ at, by: who(req), how: 'first password set by admin' }] };
      await save((l) => [...l, d]);
      res.json(view(d));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.put('/admin/dispatchers/:id', requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (b.password != null && String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      let out = null;
      await save((l) => l.map((x) => {
        if (x.id !== req.params.id) return x;
        out = { ...x, ...(b.name ? { name: String(b.name).slice(0, 80) } : {}), ...(b.active != null ? { active: !!b.active } : {}), ...(b.password ? { pass: hashPassword(String(b.password)), mustChange: true, reset: null, passwordChangedAt: new Date().toISOString(), passwordLog: [{ at: new Date().toISOString(), by: who(req), how: 'password set by admin' }, ...(x.passwordLog || [])].slice(0, 30) } : {}), updatedAt: new Date().toISOString(), updatedBy: who(req) };
        return out;
      }));
      if (!out) return res.status(404).json({ error: 'Not found.' });
      res.json(view(out));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/admin/dispatchers/:id', requireAdmin, async (req, res) => {
    try { await save((l) => l.filter((x) => x.id !== req.params.id)); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return { requireDispatch, requireAdmin };
}

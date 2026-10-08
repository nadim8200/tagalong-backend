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
import { randomBytes } from 'crypto';

const KEY = 'taDispatchers';
const norm = (e) => String(e || '').toLowerCase().trim();
const view = ({ pass, ...d }) => d;

export function initDispatchers(app, { requireAuth, db, hashPassword, verifyPassword, sign, setCookie }) {
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
      await save((l) => l.map((x) => (x.id === d.id ? { ...x, lastLoginAt: new Date().toISOString() } : x)));
      res.json({ ...user, token });
    } catch { res.status(502).json({ error: 'Login failed, try again.' }); }
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
      const d = { id: `D${Date.now()}${randomBytes(2).toString('hex')}`, email: e, name, pass: hashPassword(pw), active: true, createdAt: new Date().toISOString(), createdBy: who(req) };
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
        out = { ...x, ...(b.name ? { name: String(b.name).slice(0, 80) } : {}), ...(b.active != null ? { active: !!b.active } : {}), ...(b.password ? { pass: hashPassword(String(b.password)) } : {}), updatedAt: new Date().toISOString(), updatedBy: who(req) };
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

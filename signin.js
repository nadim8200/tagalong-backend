// ---------------------------------------------------------------
// One sign-in for everything. The same email + password is checked against every kind of account
// (TagAlong owner / admin in Traccar, AI-dispatcher staff, fleet, broker, family), and the person lands
// on the service their account is for. An admin can pin where someone lands (taSignInHome) when one
// email has more than one kind of account; otherwise the order below decides.
// ---------------------------------------------------------------
export const KINDS = ['admin', 'dispatcher', 'fleet', 'owner', 'broker', 'member'];
export const HOME = { admin: '/?admin', dispatcher: '/truckmate?admin', fleet: '/fleet', owner: '/', broker: '/broker', member: '/family' };
export const LABEL = { admin: 'Dynamic Dispatch (admin)', dispatcher: 'AI Dispatcher console', fleet: 'TagAlong Fleet', owner: 'TagAlong app', broker: 'Broker portal', member: 'Family / shared cars' };
const norm = (e) => String(e || '').toLowerCase().trim();

// matches: [{ kind, user, token, ... }] → the one to sign into + the others they also have. Pure.
export function pickAccount(matches = [], pinned = null) {
  const ok = matches.filter((m) => m && m.kind && m.token);
  if (!ok.length) return null;
  const rank = (k) => { const i = KINDS.indexOf(k); return i < 0 ? 99 : i; };
  const sorted = [...ok].sort((a, b) => rank(a.kind) - rank(b.kind));
  const chosen = (pinned && sorted.find((m) => m.kind === pinned)) || sorted[0];
  return { chosen, others: sorted.filter((m) => m !== chosen).map((m) => m.kind) };
}

// checks: { kind: async (email, password, req) → { user, token, ...extra } | { error, status } | null }
export function initSignin(app, { checks, db = null, setCookie, requireAdmin = null }) {
  const pinsKey = 'taSignInHome';
  const pins = async () => (db && db.enabled ? (await db.get(pinsKey, {})) || {} : {});
  app.post('/auth/signin', async (req, res) => {
    const email = norm(req.body && req.body.email); const password = String((req.body && req.body.password) || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const results = await Promise.all(Object.entries(checks).map(async ([kind, fn]) => {
      try { const r = await fn(email, password, req); return r ? { kind: r.kind || kind, ...r } : null; } catch { return null; }
    }));
    const picked = pickAccount(results.filter((r) => r && r.token), (await pins().catch(() => ({})))[email] || null);
    if (!picked) {
      const told = results.find((r) => r && r.error && r.status !== 401);    // e.g. "this dispatcher account is turned off"
      return res.status(told ? (told.status || 403) : 401).json({ error: told ? told.error : 'Wrong email or password.' });
    }
    const { chosen, others } = picked;
    setCookie(res, chosen.token, chosen.kind);
    const view = (m) => { const { token, kind, user, error, status, ...extra } = m; return { ...user, ...extra, token, kind, home: HOME[kind], label: LABEL[kind] }; };
    // more than one account on this email → every one of them (each already checked with this password), so the
    // sign-in can show a tab per service and open the one they tap
    const all = [chosen, ...others.map((k) => results.find((r) => r && r.token && r.kind === k))].filter(Boolean);
    res.json({ ...view(chosen), others: others.map((k) => ({ kind: k, label: LABEL[k] })), accounts: all.length > 1 ? all.map(view) : undefined });
  });
  // admin: where one person lands when they have more than one kind of account
  if (requireAdmin && db) {
    app.get('/admin/signin-home', requireAdmin, async (req, res) => res.json(await pins()));
    app.put('/admin/signin-home', requireAdmin, async (req, res) => {
      const email = norm(req.body && req.body.email); const kind = req.body && req.body.kind;
      if (!email) return res.status(400).json({ error: 'Email required.' });
      if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
      const next = await db.update(pinsKey, (cur) => { const n = { ...(cur || {}) }; if (kind) n[email] = kind; else delete n[email]; return n; }, {});
      res.json(next);
    });
  }
}

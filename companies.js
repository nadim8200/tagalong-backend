// ---------------------------------------------------------------
// Companies for the AI dispatcher. Every dispatch login belongs to ONE company and the server answers it
// only from that company's data — the company comes from the login, never from the page or the link.
//   - platform admin (Dynamics BPO, a Traccar administrator): every company; picks one with ?site=
//   - company admin: their company's console + settings + their company's logins (dispatcher record with
//     companyAdmin: true) — Florida Beauty: Nadim and Ronen
//   - dispatcher / customer service / viewer: their company's console
// Florida Beauty is company #1 and the default for every login that existed before companies.
// A NEW company only reaches the parts of the console that already keep companies apart (COMPANY_READY);
// everything else answers "not set up for your company yet" until it is — never another company's data.
// ---------------------------------------------------------------
export const DEFAULT_COMPANY = 'florida-beauty';
const KEY = 'taCompanies';
export const isPlatformAdmin = (u) => !!(u && (u.admin || u.role === 'admin'));
// the company a login works for (null = the platform admin, who can pick). Pure.
export const companyOf = (u) => (!u ? null : isPlatformAdmin(u) ? null : u.role === 'dispatcher' ? String(u.company || DEFAULT_COMPANY) : null);
export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// paths a company other than Florida Beauty may already use (they keep companies apart). Pure.
const COMPANY_READY = [/^\/auth\/(me|logout|dispatcher)(\/|$)/, /^\/admin\/dispatchers(\/|$)/, /^\/company(\/|$)/, /^\/push\/(register|unregister)$/];
export function companyMayUse(company, path) {
  if (!company || company === DEFAULT_COMPANY) return true;
  const p = String(path || '').split('?')[0].toLowerCase();
  return COMPANY_READY.some((re) => re.test(p));
}

// Express middleware (after the token is read): stamp the company on the request, and make every
// ?site= / body.site the login's own company so no module can be asked for another company's data.
export function companyGate(readUser) {
  return (req, res, next) => {
    const u = readUser(req);
    if (!u) return next();
    if (isPlatformAdmin(u)) { req.company = String((req.query && req.query.site) || DEFAULT_COMPANY); return next(); }
    const c = companyOf(u);
    if (!c) return next();                                   // TagAlong customers: not part of a dispatch company
    req.company = c;
    if (req.query && typeof req.query === 'object') req.query.site = c;
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && 'site' in req.body) req.body.site = c;
    if (!companyMayUse(c, req.path)) return res.status(403).json({ error: 'This part of the AI dispatcher is not set up for your company yet.' });
    return next();
  };
}

// the next customer ID: DD-1001 (Florida Beauty), DD-1002, … Pure.
export function nextCustomerId(list = []) {
  const nums = list.map((c) => Number(String(c.customerId || '').replace(/^DD-/, ''))).filter((n) => n > 0);
  return `DD-${Math.max(1000, ...nums) + 1}`;
}

export function initCompanies(app, { db, requireAdmin, createLogin = null, now = () => new Date().toISOString() }) {
  const enabled = !!(db && db.enabled);
  const list = async () => {
    const v = (enabled ? await db.get(KEY, null) : null) || { list: [] };
    if (!v.list.some((c) => c.id === DEFAULT_COMPANY)) v.list.unshift({ id: DEFAULT_COMPANY, customerId: 'DD-1001', name: 'Florida Beauty Flora', createdAt: null });
    return v.list.map((c) => (c.id === DEFAULT_COMPANY && !c.customerId ? { ...c, customerId: 'DD-1001' } : c));
  };
  // platform admin: the AI-dispatcher customers (companies), and adding one with its first admin login
  app.get('/platform/companies', requireAdmin, async (req, res) => res.json(await list()));
  app.post('/platform/companies', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    const id = slug(b.id || name);
    if (!name || !id) return res.status(400).json({ error: 'Company name required.' });
    const adminEmail = String(b.adminEmail || '').trim().toLowerCase(); const adminName = String(b.adminName || '').trim().slice(0, 80);
    if (adminEmail && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail) || !adminName)) return res.status(400).json({ error: 'The first admin needs a name and a valid email.' });
    const cur = await list();
    if (cur.some((c) => c.id === id)) return res.status(409).json({ error: 'A company with that name already exists.' });
    const by = (req.user && (req.user.name || req.user.email)) || 'admin';
    const rec = { id, customerId: nextCustomerId(cur), name, createdAt: now(), createdBy: by };
    // the first admin login first (an email already in use stops it before the company is made)
    let login = null;
    if (adminEmail && createLogin) {
      try { login = await createLogin({ email: adminEmail, name: adminName, company: id, companyAdmin: true, by }); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    }
    await db.set(KEY, { list: [...cur, rec] });
    res.json({ ...rec, admin: login ? { name: adminName, email: adminEmail, tempPassword: login.tempPassword } : null });
  });
  return { list };
}

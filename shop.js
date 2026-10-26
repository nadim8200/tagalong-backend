// ---------------------------------------------------------------
// TagAlong Shop: the catalog the admin sells and the orders customers place in the app — kept HERE (db
// taShop), not on a car's record. Everyone reads the catalog; an admin edits it and sees every order; a
// customer places orders and sees only their own; "paid" is set only after Stripe confirms the payment.
// The first read copies over what was stored on the old host car (attributes.taShop) once.
// ---------------------------------------------------------------
const KEY = 'taShop';
const MAX_ORDERS = 2000;
const isAdmin = (u) => !!(u && (u.admin || u.role === 'admin'));
const mineOf = (u) => (o) => (o.userId && String(o.userId) === String(u.id)) || (!o.userId && o.email && u.email && String(o.email).toLowerCase() === String(u.email).toLowerCase());

export function initShop(app, { requireAuth, db, legacy = async () => null, verifyPaid = null }) {
  const enabled = !!(db && db.enabled);
  async function load() {
    let s = await db.get(KEY, null);
    if (!s) { const old = await legacy().catch(() => null); s = { products: (old && old.products) || null, orders: (old && old.orders) || [] }; await db.set(KEY, s); }
    return { products: s.products || null, orders: s.orders || [] };
  }
  const save = (fn) => db.update(KEY, (cur) => { const s = fn({ products: (cur && cur.products) || null, orders: (cur && cur.orders) || [] }); s.orders = s.orders.slice(0, MAX_ORDERS); return s; }, null);
  const off = (res) => res.status(503).json({ error: 'Needs the database.' });

  app.get('/shop', requireAuth, async (req, res) => {
    if (!enabled) return off(res);
    const s = await load();
    res.json({ products: s.products, orders: isAdmin(req.user) ? s.orders : s.orders.filter(mineOf(req.user)) });
  });
  app.put('/shop/products', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    if (!enabled) return off(res);
    const products = Array.isArray(req.body && req.body.products) ? req.body.products : null;
    if (!products) return res.status(400).json({ error: 'products required' });
    res.json(await save((s) => ({ ...s, products })));
  });
  app.post('/shop/orders', requireAuth, async (req, res) => {
    if (!enabled) return off(res);
    const b = req.body || {};
    const rec = {
      items: [], customerName: '', email: '', phone: '', address: '', city: '', state: '', zip: '', notes: '', source: 'app',
      ...b,
      id: `O${Date.now()}${Math.floor(Math.random() * 1000)}`, createdAt: new Date().toISOString(), status: 'new', paid: false,
      userId: isAdmin(req.user) && b.userId ? b.userId : req.user.id, email: b.email || req.user.email || '',
    };
    delete rec.amountPaid;
    await save((s) => ({ ...s, orders: [rec, ...s.orders] }));
    res.json(rec);
  });
  // a customer back from Stripe: paid only when Stripe says so
  app.post('/shop/orders/:id/paid', requireAuth, async (req, res) => {
    if (!enabled) return off(res);
    if (!verifyPaid) return res.status(400).json({ error: 'not-configured' });
    try {
      const v = await verifyPaid(String((req.body || {}).sessionId || ''));
      if (!v || !v.paid || String(v.orderId || '') !== String(req.params.id)) return res.status(400).json({ error: 'Payment not confirmed.' });
      const next = await save((s) => ({ ...s, orders: s.orders.map((o) => (o.id === req.params.id && (isAdmin(req.user) || mineOf(req.user)(o)) ? { ...o, paid: true, amountPaid: v.amount } : o)) }));
      res.json(next.orders.find((o) => o.id === req.params.id) || null);
    } catch (e) { res.status(400).json({ error: e.message || 'Could not verify payment.' }); }
  });
  app.patch('/shop/orders/:id', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    if (!enabled) return off(res);
    const next = await save((s) => ({ ...s, orders: s.orders.map((o) => (o.id === req.params.id ? { ...o, ...(req.body || {}), id: o.id } : o)) }));
    res.json(next.orders.find((o) => o.id === req.params.id) || null);
  });
  app.delete('/shop/orders/:id', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    if (!enabled) return off(res);
    await save((s) => ({ ...s, orders: s.orders.filter((o) => o.id !== req.params.id) }));
    res.json({ ok: true });
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initShop } from '../shop.js';

test('shop: catalog for all, edits for admins, customers see only their own orders, paid only when Stripe says', async () => {
  const mm = new Map(); const db = { enabled: true, get: async (k, fb) => (mm.has(k) ? mm.get(k) : fb), set: async (k, v) => mm.set(k, v), update: async (k, fn, fb) => { const v = fn(mm.has(k) ? mm.get(k) : fb); mm.set(k, v); return v; } };
  const app = express(); app.use(express.json());
  let who = null;
  initShop(app, { requireAuth: (req, res, next) => { req.user = who; next(); }, db, legacy: async () => ({ products: [{ id: 'p1', price: 149 }], orders: [] }), verifyPaid: async (sid) => ({ paid: sid === 'good', amount: 149, orderId: sid === 'good' ? mm.get('taShop').orders.find((o) => o.email === 'a@x.com').id : '' }) });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const url = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, body) => { const r = await fetch(url + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    who = { id: 1, role: 'owner', email: 'a@x.com' };
    assert.equal((await call('GET', '/shop')).body.products[0].id, 'p1', 'old catalog copied over');
    const o = (await call('POST', '/shop/orders', { items: [{ productId: 'p1', qty: 1 }], paid: true, status: 'active' })).body;
    assert.equal(o.paid, false); assert.equal(o.status, 'new');
    assert.equal((await call('PUT', '/shop/products', { products: [] })).status, 403);
    assert.equal((await call('POST', `/shop/orders/${o.id}/paid`, { sessionId: 'bad' })).status, 400);
    assert.equal((await call('POST', `/shop/orders/${o.id}/paid`, { sessionId: 'good' })).body.paid, true);
    who = { id: 2, role: 'owner', email: 'b@x.com' };
    assert.deepEqual((await call('GET', '/shop')).body.orders, [], 'not other customers’ orders');
    who = { id: 9, role: 'admin', admin: true };
    assert.equal((await call('GET', '/shop')).body.orders.length, 1);
    assert.equal((await call('PATCH', `/shop/orders/${o.id}`, { status: 'shipped' })).body.status, 'shipped');
  } finally { srv.close(); }
});

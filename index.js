// ---------------------------------------------------------------
// TagAlong backend.
// Holds the Traccar admin token, verifies logins, and proxies tracking requests.
// The browser NEVER holds the token. Every account type gets a real server-side
// session (JWT cookie) and only then can use the proxy.
//
//   Owners / Admin : POST /auth/login          (verified against Traccar)
//   Brokers        : POST /auth/broker/signup | /auth/broker/login
//   Family         : POST /auth/member/signup | /auth/member/login
//   Fleet (B2B)    : POST /auth/fleet/signup  | /auth/fleet/login
//                    GET/PUT /fleet/data      (drivers, assignments, staff)
//   Everyone       : GET  /auth/me   POST /auth/logout
//   Proxy          : ALL  /api/traccar/*        (authenticated; token added here)
//
// Broker/family accounts are stored server-side inside Traccar (a host device's
// attributes) — no separate database needed. Passwords are salted+hashed.
// ---------------------------------------------------------------
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import 'dotenv/config';
import { initPush } from './push.js';
import { initDb } from './db.js';
import { initLoads } from './loads.js';
import { initPod } from './pod.js';
import { initDispatcher } from './dispatcher.js';

const {
  TRACCAR_URL = 'https://gps.dynamicsbpo.com',
  TRACCAR_TOKEN,
  JWT_SECRET,
  ALLOWED_ORIGINS = 'https://tagalong.app,https://www.tagalong.app,http://localhost:3000',
  PORT = 8080,
  COOKIE_SECURE = 'true',
  STRIPE_SECRET_KEY = '',
  PUBLIC_URL = 'https://mytagalong.app', // where customers return after paying
} = process.env;

// Payments are optional — the app falls back to "place an order" if this is unset.
// Trim the key (stray spaces/newlines from copy-paste break the request), and give
// the SDK extra network retries + a longer timeout to survive free-tier cold starts.
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(String(STRIPE_SECRET_KEY).trim(), { maxNetworkRetries: 3, timeout: 30000 })
  : null;

if (!TRACCAR_TOKEN) { console.error('FATAL: set TRACCAR_TOKEN'); process.exit(1); }
if (!JWT_SECRET) { console.error('FATAL: set JWT_SECRET'); process.exit(1); }

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(cors({ origin: origins, credentials: true }));

const COOKIE = 'ta_session';
const cookieOpts = {
  httpOnly: true,
  secure: COOKIE_SECURE === 'true',
  sameSite: COOKIE_SECURE === 'true' ? 'none' : 'lax',
  maxAge: 180 * 24 * 60 * 60 * 1000, // stay signed in ~6 months
};
const traccarHeaders = { Authorization: `Bearer ${TRACCAR_TOKEN}`, Accept: 'application/json' };
const issue = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '180d' }); // long-lived so users aren't re-entering creds
// set the cookie AND return the token so the client can also send it as a
// header (needed when frontend + backend are on different domains).
const setSession = (res, user) => { const t = issue(user); res.cookie(COOKIE, t, cookieOpts); return t; };

// ---- password hashing ----
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const a = Buffer.from(hash, 'hex');
    const b = scryptSync(pw, salt, 64);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

// ---- account store: kept inside a Traccar host device's attributes ----
async function hostDevice() {
  const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
  if (!r.ok) throw new Error('devices fetch failed');
  const all = await r.json();
  if (!all.length) throw new Error('no devices');
  return all.reduce((min, d) => (!min || d.id < min.id ? d : min), null);
}
// Accounts now live in Postgres (see db.js). They previously shared a single
// 4000-character Traccar attribute with push state, the shop and orders — which
// meant that once that blob filled, every new broker/family signup would fail
// with "account save failed". Same JSON shape, no size ceiling, and the
// read-modify-write is now inside a transaction so two simultaneous signups
// can't overwrite one another.
const db = initDb({ TRACCAR_URL, traccarHeaders, DATABASE_URL: process.env.DATABASE_URL });

// Every account list the app knows about. Adding a product means adding its key
// HERE as well as calling makeAccountRoutes — otherwise the route reads an
// undefined list and every signup fails with a generic 502.
const ACCOUNT_LISTS = ['brokers', 'members', 'fleets'];
const blankAccounts = () => Object.fromEntries(ACCOUNT_LISTS.map((k) => [k, []]));

async function readAccounts() {
  const a = await db.get('taAccounts', {});
  const out = {};
  for (const k of ACCOUNT_LISTS) out[k] = a[k] || [];
  return out;
}
async function writeAccounts(mutator) {
  return db.update('taAccounts', (cur) => {
    const copy = {};
    for (const k of ACCOUNT_LISTS) copy[k] = [...(cur[k] || [])];
    return { ...cur, ...mutator(copy) };
  }, blankAccounts());
}
const uid = (p) => `${p}${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const norm = (e) => String(e || '').toLowerCase().trim();

// ---- owner / admin login (verified by Traccar) ----
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const body = new URLSearchParams({ email, password });
    const r = await fetch(`${TRACCAR_URL}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!r.ok) return res.status(401).json({ error: 'Wrong email or password.' });
    const u = await r.json();
    const sess = { id: u.id, email: u.email, name: u.name, role: u.administrator ? 'admin' : 'owner', admin: !!u.administrator };
    const token = setSession(res, sess);
    res.json({ ...u, ...sess, token }); // full Traccar user + a token the client stores
  } catch { res.status(502).json({ error: 'Could not reach the tracking server.' }); }
});

// ---- broker / family signup + login (server-side accounts) ----
function makeAccountRoutes(kind, listKey) {
  app.post(`/auth/${kind}/signup`, async (req, res) => {
    const { email, password, name, company } = req.body || {};
    const e = norm(email);
    if (!e || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
      let created;
      await writeAccounts((acc) => {
        if (acc[listKey].some((x) => x.email === e)) throw Object.assign(new Error('exists'), { code: 'exists' });
        created = { id: uid(kind[0].toUpperCase()), email: e, name: name || '', company: company || '', pass: hashPassword(password), createdAt: new Date().toISOString() };
        acc[listKey].push(created);
        return acc;
      });
      const user = { id: created.id, email: created.email, name: created.name, company: created.company, role: kind };
      const token = setSession(res, user);
      res.json({ ...user, token });
    } catch (err) {
      if (err.code === 'exists') return res.status(409).json({ error: 'An account with that email already exists.' });
      // Log the real cause — a bare "Could not create the account" gives the
      // user nothing and gives us nothing either.
      console.error(`[auth] ${kind} signup failed:`, err.message);
      res.status(502).json({ error: 'Could not create the account.' });
    }
  });
  app.post(`/auth/${kind}/login`, async (req, res) => {
    const e = norm((req.body || {}).email);
    const { password } = req.body || {};
    if (!e || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
      const acc = await readAccounts();
      const rec = acc[listKey].find((x) => x.email === e);
      if (!rec || !verifyPassword(password, rec.pass)) return res.status(401).json({ error: 'Wrong email or password.' });
      const user = { id: rec.id, email: rec.email, name: rec.name, company: rec.company, role: kind };
      const token = setSession(res, user);
      res.json({ ...user, token });
    } catch { res.status(502).json({ error: 'Login failed, try again.' }); }
  });
}
makeAccountRoutes('broker', 'brokers');
makeAccountRoutes('member', 'members');
// TagAlong Fleet — the commercial product. A company account owns drivers,
// vehicle assignments and staff logins. Same signup/login shape as the others.
makeAccountRoutes('fleet', 'fleets');

// ---- fleet data (drivers, vehicle assignments, staff) ----
// One document per company, keyed by the fleet account id. Kept as a document
// because it's read whole on every dashboard load and is small per company;
// drivers become their own table if/when a company has hundreds of them.
const FLEET_BLANK = { drivers: [], assignments: {}, staff: [], updatedAt: null };

function requireFleet(req, res, next) {
  if (!req.user || req.user.role !== 'fleet') return res.status(403).json({ error: 'Fleet account required.' });
  next();
}

app.get('/fleet/data', requireAuth, requireFleet, async (req, res) => {
  try {
    const all = await db.get('taFleet', {});
    res.json(all[String(req.user.id)] || FLEET_BLANK);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.put('/fleet/data', requireAuth, requireFleet, async (req, res) => {
  const body = req.body || {};
  try {
    const next = await db.update('taFleet', (cur) => ({
      ...cur,
      [String(req.user.id)]: {
        drivers: Array.isArray(body.drivers) ? body.drivers : [],
        assignments: body.assignments && typeof body.assignments === 'object' ? body.assignments : {},
        staff: Array.isArray(body.staff) ? body.staff : [],
        updatedAt: new Date().toISOString(),
      },
    }), {});
    res.json(next[String(req.user.id)]);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE, cookieOpts); res.json({ ok: true }); });

function requireAuth(req, res, next) {
  let token = req.cookies[COOKIE];
  if (!token) { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) token = h.slice(7); }
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Session expired.' }); }
}
app.get('/auth/me', requireAuth, (req, res) => res.json(req.user));

// ---- Stripe Checkout (payments) ----
// Prices come from the server-side catalog (host device's taShop.products), never
// from the client, so a customer can't set their own price.
async function shopProducts() {
  const shop = await db.get('taShop', {});
  return shop.products || [];
}
app.get('/stripe/config', (req, res) => res.json({ enabled: !!stripe }));

app.post('/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'not-configured' });
  const { items, orderId } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items to pay for.' });
  try {
    const products = await shopProducts();
    const line_items = items.map((it) => {
      const p = products.find((x) => x.id === it.productId);
      if (!p) throw new Error('Unknown product in cart.');
      return {
        quantity: Math.max(1, Number(it.qty) || 1),
        price_data: { currency: 'usd', unit_amount: Math.round(Number(p.price) * 100), product_data: { name: p.name } },
      };
    });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${PUBLIC_URL}/shop?paid=1&session_id={CHECKOUT_SESSION_ID}&order=${encodeURIComponent(orderId || '')}`,
      cancel_url: `${PUBLIC_URL}/shop?canceled=1`,
      metadata: { orderId: orderId || '', userId: String(req.user.id || '') },
    });
    res.json({ url: session.url });
  } catch (e) { res.status(502).json({ error: e.message || 'Could not start checkout.' }); }
});

// Confirm a completed checkout when the customer returns from Stripe.
app.get('/stripe/verify', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'not-configured' });
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    res.json({ paid: session.payment_status === 'paid', amount: (session.amount_total || 0) / 100, orderId: (session.metadata || {}).orderId || '' });
  } catch (e) { res.status(400).json({ error: e.message || 'Could not verify payment.' }); }
});

// ---- customer self sign-up (token stays on the server) ----
app.post('/auth/register', async (req, res) => {
  const { name, email, password, phone } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const r = await fetch(`${TRACCAR_URL}/api/users`, {
      method: 'POST', headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone, attributes: phone ? { phone } : {} }),
    });
    if (!r.ok) {
      const d = (await r.text().catch(() => '')).replace(/<[^>]+>/g, '').trim().slice(0, 160);
      if (/duplicate|unique|already/i.test(d)) return res.status(409).json({ error: 'That email is already registered — try signing in, or use a different email.' });
      return res.status(r.status).json({ error: `Sign-up failed${d ? ': ' + d : ''}` });
    }
    res.json(await r.json());
  } catch { res.status(502).json({ error: 'Could not reach the server.' }); }
});

// ---- admin creates a login FOR a customer (admin session required) ----
app.post('/auth/admin/create-user', requireAuth, async (req, res) => {
  if (!(req.user && (req.user.admin || req.user.role === 'admin'))) return res.status(403).json({ error: 'Admins only.' });
  const { name, email, phone } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const tempPassword = 'TA' + Math.random().toString(36).slice(2, 8) + Math.floor(10 + Math.random() * 89);
  try {
    const r = await fetch(`${TRACCAR_URL}/api/users`, {
      method: 'POST', headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: tempPassword, phone, attributes: { phone, mustSetPassword: true } }),
    });
    if (!r.ok) {
      const d = (await r.text().catch(() => '')).replace(/<[^>]+>/g, '').trim().slice(0, 160);
      if (/duplicate|unique|already/i.test(d)) return res.status(409).json({ error: 'That email already has a login.' });
      return res.status(r.status).json({ error: `Couldn't create the login${d ? ': ' + d : ''}` });
    }
    res.json({ user: await r.json(), tempPassword });
  } catch { res.status(502).json({ error: 'Could not reach the server.' }); }
});

// ---- password-reset email (no token needed, kept server-side for CORS) ----
app.post('/auth/password-reset', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    const r = await fetch(`${TRACCAR_URL}/api/password/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Couldn’t send the reset email. Email may not be set up on the server yet.' });
    res.json({ ok: true });
  } catch { res.status(502).json({ error: 'Could not reach the server.' }); }
});

// ---- authenticated transparent proxy to Traccar (token added here) ----
app.all('/api/traccar/*', requireAuth, async (req, res) => {
  const path = req.params[0] || '';
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const init = {
    method: req.method,
    headers: {
      ...traccarHeaders,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { 'Content-Type': req.get('content-type') || 'application/json' } : {}),
    },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  try {
    const r = await fetch(`${TRACCAR_URL}/api/${path}${qs}`, init);
    res.status(r.status);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let payload = await r.json().catch(() => ({}));
      payload = await scopeForFleet(req.user, path, payload);
      return res.json(payload);
    }
    res.send(await r.text());
  } catch { res.status(502).json({ error: 'Upstream tracking server error.' }); }
});

// ---- fleet vehicle scoping (ENFORCED HERE, not in the browser) ----
// A vehicle belongs to a fleet company when its Traccar device carries
// attributes.taFleetId === that company's account id. Filtering in the client
// would be decoration — anyone can call the API directly — so every response
// that could carry vehicle data is filtered on the way out.
async function fleetDeviceIds(fleetId) {
  const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
  if (!r.ok) throw new Error('devices fetch failed');
  const all = await r.json();
  return new Set(all
    .filter((d) => String(((d.attributes || {}).taFleetId) || '') === String(fleetId))
    .map((d) => d.id));
}

async function scopeForFleet(user, path, payload) {
  if (!user || user.role !== 'fleet') return payload;
  const ids = await fleetDeviceIds(user.id);

  if (/^devices\b/.test(path) && Array.isArray(payload)) {
    return payload.filter((d) => ids.has(d.id));
  }
  if (/^positions\b/.test(path) && Array.isArray(payload)) {
    return payload.filter((p) => ids.has(p.deviceId));
  }
  if (/^reports\//.test(path) && Array.isArray(payload)) {
    return payload.filter((row) => row.deviceId == null || ids.has(row.deviceId));
  }
  // Anything not explicitly understood returns EMPTY rather than everything —
  // a new Traccar endpoint should fail closed, not leak another company's data.
  if (Array.isArray(payload)) return [];
  return payload;
}

// ---- claiming a vehicle into a fleet ----
// The owner (or admin) gives the company a per-vehicle claim code; the company
// enters it once and the vehicle joins their fleet. Same shape as the broker
// share-code flow already in the app.
// Share codes are DERIVED from the device (id + hardware id) and only written
// onto it the first time the owner views them. So we must compute the code the
// same way the app does — matching only on the stored attribute would reject
// perfectly valid codes for any vehicle whose code was never displayed.
// Mirrors genCode() in src/carCode.js — keep the two in step.
function deviceShareCode(d) {
  const stored = ((d.attributes || {}).shareCode) || '';
  if (stored) return String(stored).toUpperCase();
  const base = `${d.id}-${d.uniqueId || ''}`;
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) { h ^= base.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'TA-' + h.toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
}
const normCode = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

app.post('/fleet/claim', requireAuth, requireFleet, async (req, res) => {
  const code = normCode((req.body || {}).code);
  if (!code) return res.status(400).json({ error: 'Enter the vehicle code.' });
  try {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    if (!r.ok) throw new Error('devices fetch failed');
    const all = await r.json();
    const dev = all.find((d) => normCode(deviceShareCode(d)) === code);
    if (!dev) return res.status(404).json({ error: 'No vehicle found with that code.' });

    const owner = String(((dev.attributes || {}).taFleetId) || '');
    if (owner && owner !== String(req.user.id)) {
      return res.status(409).json({ error: 'That vehicle already belongs to another fleet.' });
    }

    const attributes = { ...(dev.attributes || {}), taFleetId: String(req.user.id) };
    const put = await fetch(`${TRACCAR_URL}/api/devices/${dev.id}`, {
      method: 'PUT',
      headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dev.id, name: dev.name, uniqueId: dev.uniqueId, groupId: dev.groupId || 0,
        phone: dev.phone || '', model: dev.model || '', contact: dev.contact || '',
        category: dev.category || null, disabled: !!dev.disabled, attributes,
      }),
    });
    if (!put.ok) {
      let detail = ''; try { detail = (await put.text()).slice(0, 200); } catch { /* ignore */ }
      console.error('[fleet] claim write failed:', put.status, detail);
      return res.status(502).json({ error: 'Could not add the vehicle.' });
    }
    res.json({ ok: true, id: dev.id, name: (dev.attributes || {}).displayName || dev.name });
  } catch (e) {
    console.error('[fleet] claim failed:', e.message);
    res.status(502).json({ error: 'Could not add the vehicle.' });
  }
});

// Release a vehicle back out of the fleet.
app.post('/fleet/release', requireAuth, requireFleet, async (req, res) => {
  const id = Number((req.body || {}).deviceId);
  if (!id) return res.status(400).json({ error: 'deviceId required.' });
  try {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    const all = await r.json();
    const dev = all.find((d) => d.id === id);
    if (!dev) return res.status(404).json({ error: 'Vehicle not found.' });
    if (String(((dev.attributes || {}).taFleetId) || '') !== String(req.user.id)) {
      return res.status(403).json({ error: 'That vehicle is not on your fleet.' });
    }
    const attributes = { ...(dev.attributes || {}) };
    delete attributes.taFleetId;
    const put = await fetch(`${TRACCAR_URL}/api/devices/${dev.id}`, {
      method: 'PUT',
      headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dev.id, name: dev.name, uniqueId: dev.uniqueId, groupId: dev.groupId || 0,
        phone: dev.phone || '', model: dev.model || '', contact: dev.contact || '',
        category: dev.category || null, disabled: !!dev.disabled, attributes,
      }),
    });
    if (!put.ok) return res.status(502).json({ error: 'Could not remove the vehicle.' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Locked-phone push notifications (APNs). Registers /push/register + /push/unregister
// and starts the server-side alert poller. No-ops safely until the APNS_* env vars are set.
initPush(app, { TRACCAR_URL, traccarHeaders, requireAuth, env: process.env, db });

// Dispatch loads + the API a partner TMS integrates against. Safely no-ops
// (503 with a clear message) until DATABASE_URL is configured.
initLoads(app, { requireAuth, db, pool: db.pool });

// Driver proof-of-delivery capture (counts as DATA, plus the photo evidence).
initPod(app, { requireAuth, db, pool: db.pool });

// The AI dispatcher's continuous review — what needs a human right now.
initDispatcher(app, { requireAuth, db, pool: db.pool });

app.get('/', (_req, res) => res.send('TagAlong backend is running.'));
app.listen(PORT, () => console.log(`TagAlong backend on :${PORT} — origins: ${origins.join(', ')}`));

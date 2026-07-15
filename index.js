// ---------------------------------------------------------------
// TagAlong backend.
// Holds the Traccar admin token, verifies logins, and proxies tracking requests.
// The browser NEVER holds the token. Every account type gets a real server-side
// session (JWT cookie) and only then can use the proxy.
//
//   Owners / Admin : POST /auth/login          (verified against Traccar)
//   Brokers        : POST /auth/broker/signup | /auth/broker/login
//   Family         : POST /auth/member/signup | /auth/member/login
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
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import 'dotenv/config';

const {
  TRACCAR_URL = 'https://gps.dynamicsbpo.com',
  TRACCAR_TOKEN,
  JWT_SECRET,
  ALLOWED_ORIGINS = 'https://tagalong.app,https://www.tagalong.app,http://localhost:3000',
  PORT = 8080,
  COOKIE_SECURE = 'true',
} = process.env;

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
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const traccarHeaders = { Authorization: `Bearer ${TRACCAR_TOKEN}`, Accept: 'application/json' };
const issue = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
const setSession = (res, user) => res.cookie(COOKIE, issue(user), cookieOpts);

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
async function readAccounts() {
  const host = await hostDevice();
  const a = (host.attributes || {}).taAccounts || {};
  return { host, brokers: a.brokers || [], members: a.members || [] };
}
async function writeAccounts(mutator) {
  const { host, brokers, members } = await readAccounts();
  const next = mutator({ brokers: [...brokers], members: [...members] });
  const attributes = { ...(host.attributes || {}), taAccounts: next };
  const r = await fetch(`${TRACCAR_URL}/api/devices/${host.id}`, {
    method: 'PUT',
    headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...host, attributes }),
  });
  if (!r.ok) throw new Error('account save failed');
  return next;
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
    const user = { id: u.id, email: u.email, name: u.name, role: u.administrator ? 'admin' : 'owner', admin: !!u.administrator };
    setSession(res, user);
    res.json(user);
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
      setSession(res, user);
      res.json(user);
    } catch (err) {
      if (err.code === 'exists') return res.status(409).json({ error: 'An account with that email already exists.' });
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
      setSession(res, user);
      res.json(user);
    } catch { res.status(502).json({ error: 'Login failed, try again.' }); }
  });
}
makeAccountRoutes('broker', 'brokers');
makeAccountRoutes('member', 'members');

app.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE, cookieOpts); res.json({ ok: true }); });

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Session expired.' }); }
}
app.get('/auth/me', requireAuth, (req, res) => res.json(req.user));

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
    if (ct.includes('application/json')) res.json(await r.json().catch(() => ({})));
    else res.send(await r.text());
  } catch { res.status(502).json({ error: 'Upstream tracking server error.' }); }
});

app.get('/', (_req, res) => res.send('TagAlong backend is running.'));
app.listen(PORT, () => console.log(`TagAlong backend on :${PORT} — origins: ${origins.join(', ')}`));

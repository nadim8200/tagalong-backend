// ---------------------------------------------------------------
// TagAlong backend.
// Purpose: the browser must NEVER hold the Traccar admin token. This small server
// holds it, requires a real login, and proxies tracking requests. The frontend
// talks to THIS server; only this server talks to Traccar with the token.
//
//   POST /auth/login   { email, password }  -> verifies against Traccar, sets an
//                                              HttpOnly session cookie (JWT)
//   POST /auth/logout                        -> clears the cookie
//   GET  /auth/me                            -> current user (from cookie)
//   ALL  /api/traccar/*                      -> authenticated proxy to Traccar
//                                              (token injected here, server-side)
// ---------------------------------------------------------------
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const {
  TRACCAR_URL = 'https://gps.dynamicsbpo.com',
  TRACCAR_TOKEN,
  JWT_SECRET,
  ALLOWED_ORIGINS = 'https://tagalong.app,https://www.tagalong.app,http://localhost:3000',
  PORT = 8080,
  COOKIE_SECURE = 'true',
} = process.env;

if (!TRACCAR_TOKEN) { console.error('FATAL: set TRACCAR_TOKEN in the environment'); process.exit(1); }
if (!JWT_SECRET) { console.error('FATAL: set JWT_SECRET in the environment'); process.exit(1); }

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

// ---- auth: verify credentials against Traccar, then issue our own session ----
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    // Traccar validates the user; we never store their password.
    const body = new URLSearchParams({ email, password });
    const r = await fetch(`${TRACCAR_URL}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return res.status(401).json({ error: 'Wrong email or password.' });
    const user = await r.json();
    const token = jwt.sign({ id: user.id, email: user.email, admin: !!user.administrator }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie(COOKIE, token, cookieOpts);
    res.json({ id: user.id, email: user.email, name: user.name, administrator: !!user.administrator });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the tracking server.' });
  }
});

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
  const url = `${TRACCAR_URL}/api/${path}${qs}`;
  const init = {
    method: req.method,
    headers: {
      Authorization: `Bearer ${TRACCAR_TOKEN}`,
      Accept: 'application/json',
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { 'Content-Type': req.get('content-type') || 'application/json' } : {}),
    },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  try {
    const r = await fetch(url, init);
    res.status(r.status);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) res.json(await r.json().catch(() => ({})));
    else res.send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'Upstream tracking server error.' });
  }
});

app.get('/', (_req, res) => res.send('TagAlong backend is running.'));
app.listen(PORT, () => console.log(`TagAlong backend on :${PORT} — allowed origins: ${origins.join(', ')}`));

// ---------------------------------------------------------------
// Sign-in protection: stop password guessing. Every login / reset endpoint counts failed tries per
// email and per network address; too many in 15 minutes → locked out for 15 minutes (429), and a
// success clears the email's count. In memory (a restart forgets — fine for slowing attackers).
// ---------------------------------------------------------------
const WINDOW_MS = 15 * 60000;
export const LIMITS = { perEmail: 6, perIp: 30 };

// Pure tracker. now() is injectable for tests.
export function loginGuard({ now = () => Date.now(), limits = LIMITS } = {}) {
  const fails = new Map();   // key → [timestamps]
  const recent = (k) => { const t = now(); const l = (fails.get(k) || []).filter((x) => t - x < WINDOW_MS); if (l.length) fails.set(k, l); else fails.delete(k); return l; };
  const keys = (ip, email) => [`ip:${ip || '?'}`, ...(email ? [`em:${email}`] : [])];
  return {
    // → seconds to wait, or 0 when allowed
    blocked(ip, email) {
      const t = now();
      for (const k of keys(ip, email)) {
        const l = recent(k); const max = k.startsWith('ip:') ? limits.perIp : limits.perEmail;
        if (l.length >= max) return Math.max(1, Math.ceil((l[l.length - max] + WINDOW_MS - t) / 1000));
      }
      return 0;
    },
    failed(ip, email) {
      for (const k of keys(ip, email)) { const l = recent(k); l.push(now()); fails.set(k, l); }
      if (fails.size > 20000) fails.clear();   // never grow without bound
    },
    succeeded(ip, email) { if (email) fails.delete(`em:${email}`); },
  };
}

// Express middleware for the sign-in routes.
export function loginGuardMiddleware(guard = loginGuard()) {
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || '';
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const wait = guard.blocked(ip, email);
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` }); }
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 403) guard.failed(ip, email);
      else if (res.statusCode < 300) guard.succeeded(ip, email);
    });
    return next();
  };
}

// Admin and dispatcher sessions are short; customers' app sessions stay long. Pure.
export const STAFF_SESSION_DAYS = 7;
export function sessionTooOld(user, nowSec = Math.floor(Date.now() / 1000)) {
  if (!user || !user.iat) return false;
  const staff = user.admin || user.role === 'admin' || user.role === 'dispatcher';
  return staff && nowSec - user.iat > STAFF_SESSION_DAYS * 86400;
}

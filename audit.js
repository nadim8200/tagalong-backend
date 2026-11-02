// ---------------------------------------------------------------
// The signature on everything: every change a staff login makes, every sign-in (good or bad) and every answer through a signed email
// link is written here with who, when and what. It sits in front of all the routes, so a new feature is covered without anyone
// remembering to log it. Rows are only ever added: no route edits or deletes them. Passwords, tokens and files are never stored.
// ---------------------------------------------------------------
const SECRET = /pass|pwd|token|secret|api.?key|authorization|credential|ssn|card|cvv|bytes|base64|signature|^next$|^current$/i;
const MAX_TEXT = 200;
const SKIP = /^\/(jarvis\/transcribe|push\/|retell\/)/;
const LINK = /^\/(br|dc|sr)\/[^/]+/;
const MUTATES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The body without anything secret, cut short, files reduced to a count. Pure.
export function cleanBody(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.length > 10 || v.some((x) => x && typeof x === 'object' && x.dataBase64) ? `${v.length} items` : v.map((x) => cleanBody(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).slice(0, 30).map(([k, x]) => [k, cleanBody(x, depth + 1)]));
  return null;
}

const LABELS = [
  [/^POST \/auth\/(\w+\/)?(login|signin)/, (ok) => (ok ? 'Signed in' : 'Failed sign-in')],
  [/^POST \/auth\/logout/, 'Signed out'],
  [/^POST \/auth\/dispatcher\/password/, 'Changed their password'],
  [/^POST \/auth\/dispatcher\/(forgot|reset)/, 'Used forgot password'],
  [/^POST \/admin\/dispatchers\/[^/]+\/reset/, 'Reset a password'],
  [/^POST \/admin\/dispatchers/, 'Created a login'],
  [/^PUT \/admin\/dispatchers/, 'Changed a login'],
  [/^DELETE \/admin\/dispatchers/, 'Removed a login'],
  [/^PUT \/admin\/training/, 'Changed training mode'],
  [/^PUT \/admin\/directory/, 'Changed the employee list'],
  [/^PUT \/truckmate\/alert-recipients/, 'Changed who gets alert emails'],
  [/^POST \/watchtower\/resolve/, 'Resolved an alert'],
  [/^POST \/watchtower\/ack/, 'Took ownership of an alert'],
  [/^POST \/truckmate\/breakdown\/report/, 'Reported a breakdown'],
  [/^POST \/truckmate\/breakdown\/update/, 'Sent a breakdown update'],
  [/^POST \/truckmate\/breakdown\//, 'Used Notify customers'],
  [/^POST \/jarvis\/chat/, 'Asked Jarvis'],
  [/^POST \/jarvis\/actions/, 'Decided on a Jarvis action'],
  [/^POST \/truckmate\/emails\/[^/]+\/reply/, 'Replied to an email'],
  [/^POST \/truckmate\/docs/, 'Uploaded a document'],
  [/^POST \/br\//, 'Reported a breakdown from an email link'],
  [/^POST \/sr\//, 'Answered a stop from an email link'],
  [/^POST \/dc\//, 'Confirmed delivery times from an email link'],
];
const VERB = { POST: 'Did', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Deleted' };
// What happened, in plain words. Pure.
export function auditLabel(method, path, ok = true) {
  const k = `${method} ${path}`;
  for (const [re, l] of LABELS) if (re.test(k)) return typeof l === 'function' ? l(ok) : l;
  return `${VERB[method] || method} ${path}`;
}

// Everything we record for one request, or null when it isn't ours to record. Pure.
export function auditEntry({ method, path, body = {}, status, user = null, ip = null, agent = null, at = new Date() }) {
  if (!MUTATES.has(method)) return null;
  const link = LINK.test(path);
  const auth = /^\/auth\//.test(path);
  const staff = !!(user && (user.admin || user.role === 'admin' || user.role === 'dispatcher'));
  if ((!staff && !link && !auth) || SKIP.test(path)) return null;
  const safePath = path.replace(LINK, '/$1/link');    // the link itself is a key
  const b = body && typeof body === 'object' ? body : {};
  const ok = status < 400;
  const actor = (user && (user.name || user.email)) || (typeof b.name === 'string' && b.name.trim()) || (auth && typeof b.email === 'string' && b.email.trim().toLowerCase()) || 'Unknown';
  const trip = String(b.trip || b.tripNumber || '').match(/^\d{4,8}$/) ? String(b.trip || b.tripNumber) : ((safePath.match(/\b\d{6}\b/) || [])[0] || null);
  return { at, actor: String(actor).slice(0, 120), actorId: user && user.id != null ? String(user.id) : null, role: (user && (user.admin ? 'admin' : user.role)) || (link ? 'email link' : 'not signed in'), company: (user && user.company) || null, action: auditLabel(method, safePath, ok), method, path: safePath.slice(0, 200), trip, status, ip: ip ? String(ip).slice(0, 60) : null, device: agent ? String(agent).slice(0, 120) : null, detail: /password|reset|forgot/i.test(safePath) ? {} : cleanBody(b) };
}

// Sits in front of the routes. It waits for the answer, so a refused request is recorded as refused. It never slows or stops the request.
export function auditTrail({ userOf, write }) {
  return (req, res, next) => {
    if (!MUTATES.has(req.method)) return next();
    const user = (() => { try { return userOf(req); } catch { return null; } })();
    const path = String(req.originalUrl || req.path || '').split('?')[0];
    res.on('finish', () => {
      try {
        const e = auditEntry({ method: req.method, path, body: req.body, status: res.statusCode, user: req.user || user, ip: req.ip, agent: req.headers && req.headers['user-agent'] });
        if (e) Promise.resolve(write(e)).catch((x) => console.warn('[audit] not saved:', x.message, JSON.stringify({ at: e.at, actor: e.actor, action: e.action, trip: e.trip })));
      } catch (x) { console.warn('[audit]', x.message); }
    });
    return next();
  };
}

export function initAudit(app, { db, requireAdmin }) {
  // read-only on purpose: there is no route that changes or removes a row
  app.get('/admin/audit', requireAdmin, async (req, res) => {
    try {
      const u = req.user || {}; const q = req.query || {};
      const rows = await db.readAudit({ actor: q.actor ? String(q.actor).slice(0, 80) : null, trip: q.trip ? String(q.trip).slice(0, 12) : null, before: q.before ? Number(q.before) : null, company: u.admin || u.role === 'admin' ? null : (u.company || null), limit: 200 });
      res.json({ rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

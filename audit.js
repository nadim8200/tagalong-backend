// ---------------------------------------------------------------
// The signature on everything: every change a staff login makes, every sign-in (good or bad) and every answer through a signed email
// link is written here with who, when and what. It sits in front of all the routes, so a new feature is covered without anyone
// remembering to log it. Rows are only ever added: no route edits or deletes them. Passwords, tokens and files are never stored.
// ---------------------------------------------------------------
const SECRET = /pass|pwd|token|secret|api.?key|authorization|credential|ssn|card|cvv|bytes|base64|signature|^next$|^current$|^pin$|^newpin$/i;
const MAX_TEXT = 200;
const SKIP = /^\/(jarvis\/transcribe|push\/|retell\/)/;
const LINK = /^\/(br|dc|sr|lesson|wt)\/[^/]+/;
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
  [/^POST \/admin\/directory\/people\/[^/]+\/erase/, 'Erased an employee'],
  [/^POST \/admin\/directory\/people/, 'Added an employee'],
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
  [/^POST \/lesson\//, 'Erased a Jarvis lesson'],
  [/^POST \/wt\//, 'Answered a waiting time email'],
  [/^POST \/truckmate\/asks\//, 'Answered a Jarvis question'],
  [/^POST \/truckmate\/requests\/[^/]+\/done/, 'Sent a Teach Jarvis request'],
  [/^POST \/truckmate\/requests/, 'Wrote in Teach Jarvis'],
  // what dispatchers do on a load, in plain words: Jarvis learns the team's work from these (team_actions)
  [/^PUT \/truckmate\/driver-profiles\//, 'Changed a driver profile'],
  [/^DELETE \/truckmate\/driver-profiles\//, 'Removed a driver profile'],
  [/^POST \/truckmate\/loadsheet\/preview/, 'Checked load info before sending'],
  [/^POST \/truckmate\/loadsheet\/[^/]+\/ratecon-send/, 'Sent the load to the driver (from the rate con)'],
  [/^POST \/truckmate\/loadsheet$/, 'Sent load info to the driver'],
  [/^PUT \/truckmate\/loadsheet\/[^/]+\/release/, 'Set the yard drop and release'],
  [/^POST \/truckmate\/ratecon\/[^/]+\/check/, 'Checked off a handling instruction'],
  [/^POST \/truckmate\/ratecon\//, 'Uploaded a rate con'],
  [/^DELETE \/truckmate\/ratecon\//, 'Removed a rate con'],
  [/^POST \/truckmate\/ratecons\/assign/, 'Put a rate con on a load'],
  [/^POST \/truckmate\/oc\/[^/]+\/messages/, 'Messaged the driver in the app'],
  [/^POST \/truckmate\/oc\/[^/]+\/link\/send/, 'Texted the driver their load link'],
  [/^POST \/truckmate\/oc\/[^/]+\/link\/revoke/, 'Turned off a driver load link'],
  [/^POST \/truckmate\/oc\/[^/]+\/link/, 'Made a driver load link'],
  [/^POST \/truckmate\/oc\/[^/]+\/consent/, 'Recorded an outside carrier\'s texting consent'],
  [/^POST \/truckmate\/oc\//, 'Marked a load as outside carrier'],
  [/^POST \/truckmate\/consent/, 'Recorded a driver\'s texting consent'],
  [/^POST \/truckmate\/trips\/[^/]+\/text/, 'Texted the driver'],
  [/^POST \/truckmate\/trips\/[^/]+\/ai-call/, 'Had Jarvis call the driver'],
  [/^POST \/truckmate\/trips\/[^/]+\/finish/, 'Marked a load finished'],
  [/^POST \/truckmate\/trips\/[^/]+\/reopen/, 'Reopened a load'],
  [/^POST \/truckmate\/checkins\//, 'Logged a check call'],
  [/^PUT \/truckmate\/commitments\//, 'Set the time promised to the customer'],
  [/^PUT \/truckmate\/contacts\//, 'Changed customer contacts'],
  [/^PUT \/truckmate\/status-mail\//, 'Edited a status email'],
  [/^POST \/truckmate\/status-mail\/[^/]+\/send/, 'Sent a status email'],
  [/^POST \/truckmate\/rundown\/[^/]+\/send/, 'Sent a load rundown'],
  [/^POST \/truckmate\/tasks\//, 'Finished a to-do on a load'],
  [/^POST \/truckmate\/hold\/[^/]+\/clear/, 'Cleared a hold'],
  [/^POST \/truckmate\/delivered\/ack/, 'Acknowledged a delivery'],
  [/^POST \/truckmate\/follow\/[^/]+\/closeout/, 'Closed out a followed load'],
  [/^POST \/truckmate\/broker-watch\/[^/]+\/stop/, 'Stopped watching a broker load'],
  [/^DELETE \/truckmate\/broker-follow\//, 'Stopped following a broker load'],
  [/^POST \/truckmate\/roadcalls\/[^/]+\/approve/, 'Approved a road call'],
  [/^POST \/truckmate\/roadcalls/, 'Worked a road call'],
  [/^POST \/truckmate\/emails\/[^/]+\/handled/, 'Marked an email handled'],
  [/^POST \/truckmate\/emails\/[^/]+\/assign/, 'Put an email on a load'],
  [/^POST \/truckmate\/help\/[^/]+\/handled/, 'Handled a callback request'],
  [/^POST \/truckmate\/missing-cases\//, 'Worked a missing boxes case'],
  [/^POST \/truckmate\/artis\/left-short\/[^/]+\/send/, 'Sent a left-short notice'],
  [/^POST \/truckmate\/outbound\/send/, 'Sent the outbound report'],
  [/^POST \/truckmate\/outbound\/note/, 'Added an outbound note'],
  [/^POST \/truckmate\/plan-sheet\/send/, 'Sent the truck plan'],
  [/^POST \/truckmate\/packet\/assign/, 'Put paperwork on a load'],
  [/^POST \/truckmate\/playbook\/teach/, 'Taught Jarvis a playbook step'],
  [/^POST \/ringcentral\/sms/, 'Sent a text'],
  [/^POST \/ringcentral\/call/, 'Made a call'],
  [/^POST \/admin\/driver-pins\/[^/]+\/show/, 'Looked at a driver PIN'],
  [/^POST \/admin\/driver-pins\/[^/]+\/new/, 'Gave a driver a new PIN'],
  [/^POST \/admin\/driver-pins\/[^/]+\/clear/, 'Cleared a driver PIN'],
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

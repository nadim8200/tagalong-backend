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
import { proxyRule, isAdminUser, allowRoles, relation, deviceView, mergeDeviceUpdate, shareEntry } from './access.js';
import { initShop } from './shop.js';
import { companyGate, initCompanies } from './companies.js';
import { sender as rcSender } from './ringcentral.js';
import { initSignin } from './signin.js';
import { initMiles } from './miles.js';
import { loginGuardMiddleware, sessionTooOld, STAFF_SESSION_DAYS, keepsLongSession } from './loginguard.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import 'dotenv/config';
import { initPush } from './push.js';
import { initDb } from './db.js';
import { auditTrail, initAudit } from './audit.js';
import { initLoads } from './loads.js';
import { initPod } from './pod.js';
import { initDispatcher } from './dispatcher.js';
import { initWatchtower, brokerLoad } from './watchtower.js';
import { renderTruckMap, renderTransferMap } from './truckmap.js';
import { renderTeamStopEmail, renderRollingEmail, teamStopFacts, stopSubject, tripSheetIds, tripSheetFiles } from './teamstopmail.js';
import { initManifests } from './manifest.js';
import { initDocuments } from './documents.js';
import { initCarriers } from './carriers.js';
import { initDispatchers, dispatcherMayUse } from './dispatchers.js';
import { initPushRules } from './pushrules.js';
import { initJarvisChat } from './jarvischat.js';
import { initHelpdesk } from './helpdesk.js';
import { initProfiles } from './profiles.js';
import { initActivity } from './activity.js';
import { initCallTranscripts } from './calltranscripts.js';
import { initMessages } from './messages.js';
import { initBreakdownRead } from './breakdownread.js';
import { initAutoRecord } from './autorecord.js';
import { initPhone } from './phone.js';
import { initDriverLinks } from './driverlink.js';
import { initComms } from './comms.js';
import { initRundowns } from './rundown.js';
import { initOutbound } from './outbound.js';
import { initJourney } from './journey.js';
import { initFlowerReport } from './flowerreport.js';
import { initPickupFollow } from './pickupfollow.js';
import { initTempPhotos } from './tempphotos.js';
import { initOutreach } from './outreach.js';
import { initMeetWatch } from './meetwatch.js';
import { initBrokerTrack } from './brokertrack.js';
import { initNextLoads } from './nextloads.js';
import { initDriverAuth } from './driverauth.js';
import { initLoadSheets } from './loadsheet.js';
import { initStopFlow } from './stopflow.js';
import { initCallAhead } from './callahead.js';
import { initRateConFlow } from './rateconflow.js';
import { initPlanSheet } from './plansheet.js';
import { initPaperwork } from './paperwork.js';
import { initClients } from './clients.js';
import { nameScore } from './voice.js';
import { initMilestones } from './milestones.js';
import { initCommitments, lateMessage } from './commitments.js';
import { initEtaReport } from './etareport.js';
import { initPastLoads } from './pastloads.js';
import { initArtisWeb } from './artisweb.js';
import { initArtisReports } from './artisreports.js';
import { initSynergize } from './synergize.js';
import { initArtisClients } from './artisclients.js';
import { initInbox, isInternal } from './inbox.js';
import { initDispatchLog } from './dispatchlog.js';
import { initBrokerFollow, askEmail, requestStops, confirmedReply } from './brokerfollow.js';
import { loadRows, initBreakdownReport, renderBreakdownEmail, renderBreakdownPhotosEmail, breakdownSubject } from './breakdownreport.js';
import { photoAttachments, PHOTOS_BYTES, EMAIL_BYTES } from './breakdownphotos.js';
import { initStatusMail } from './statusmail.js';
import { initAssistant } from './assistant.js';
import { initVoice } from './voice.js';
import { initStopVisits } from './stopvisits.js';
import { listAddresses, samsaraTokenFrom, correlate, getLiveIndex } from './samsara.js';
import { initNotify } from './notify.js';
import { initFleet } from './fleet.js';
import { initRingCentral, setSmsGuard } from './ringcentral.js';
import { initTruckMate } from './truckmate.js';
import { initCarChat } from './carChat.js';
import { initDbpo } from './dbpo.js';
import { initArtis, initMissingBoxes } from './artis.js';
import { initAlertRecipients } from './alertrecipients.js';
import { initTransferWatch, transferEmail, transferStatus } from './transferwatch.js';
import { initTransferDone, answerConfirms } from './transferdone.js';
import { initStopCheck } from './stopcheck.js';
import { initStopReview } from './stopreview.js';
import { initStaffActions } from './staffactions.js';
import { readableFile } from './heic.js';
import { renderWaitingEmail, renderFixedRollingEmail, renderTransferCompletedEmail, renderTransferReversedEmail, renderFixedReportedEmail, renderLoginEmail, handoffFacts, snapshotLoad, crewOf, renderStopReviewEmail } from './handoffmail.js';
import { initTruckBuilder } from './truckbuilder.js';
import { initMissingCases } from './missingcase.js';
import { initStopTasks } from './stoptasks.js';
import { initMacroPoint } from './macropoint.js';
import { initRoadCalls } from './roadcall.js';
import { initRateCon } from './ratecon.js';
import { sendMail, sendInThread, mailConfig, setMailGuard } from './mailer.js';
import { initTraining } from './training.js';
import { initEtaWatch } from './etawatch.js';
import { initFollowThrough } from './followthrough.js';
import { initPlaybook } from './playbook.js';
import { initJarvisAsks } from './jarvisasks.js';
import { initJarvisRequests } from './jarvisrequests.js';
import { initWaitingTime } from './waitingtime.js';
import { initDirectory } from './directory.js';

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

// A background job (nightly reads, polling, email checks) whose promise fails with nothing catching it
// used to take the whole server down ("Exited with status 1"). Log it and keep serving instead.
// A thrown (synchronous) error still restarts — the process may be in a bad state — but says why first.
process.on('unhandledRejection', (err) => { console.error('[crash-guard] unhandled rejection (kept running):', (err && err.stack) || err); });
process.on('uncaughtException', (err) => { console.error('[crash-guard] uncaught exception (restarting):', (err && err.stack) || err); process.exit(1); });

if (!TRACCAR_TOKEN) { console.error('FATAL: set TRACCAR_TOKEN'); process.exit(1); }
if (!JWT_SECRET) { console.error('FATAL: set JWT_SECRET'); process.exit(1); }

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
const app = express();
app.set('trust proxy', 2);   // Cloudflare, then Render: req.ip is the real caller, not whatever a client puts in X-Forwarded-For
// keep the raw body for Retell (its signature is over the exact bytes)
app.use(express.json({ limit: '15mb', verify: (req, _res, buf) => { if (req.url && req.url.startsWith('/retell/')) req.rawBody = buf.toString('utf8'); } }));
// gzip: the trip board is ~4 MB of JSON — ~10x smaller on the wire (phones especially)
app.use(compression({ threshold: 2048 }));
app.use(cookieParser());
app.use(cors({ origin: origins, credentials: true }));

// basic browser protections on everything we serve
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); next(); });
// a browser on another site can't act with someone's cookie. The console sends a Bearer token, and our own email-link pages are same-host
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !o || !origins.length || !(req.cookies && req.cookies.ta_session) || String(req.headers.authorization || '').startsWith('Bearer ')) return next();
  if (origins.includes(o) || o === `https://${req.headers.host}`) return next();
  return res.status(403).json({ error: 'Request refused.' });
});
// the signature on everything anyone does, ahead of every gate so a refused attempt is on record too (audit.js)
app.use(auditTrail({ userOf: (req) => { const t = (req.cookies && req.cookies.ta_session) || String(req.headers.authorization || '').replace(/^Bearer /, ''); return t ? jwt.verify(t, JWT_SECRET) : null; }, write: (e) => db.appendAudit(e) }));

// Dispatcher logins: only the AI dispatcher console, and never its settings (see dispatchers.js).
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  let token = req.cookies && req.cookies.ta_session;
  if (!token) { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) token = h.slice(7); }
  if (!token) return next();
  let u = null;
  try { u = jwt.verify(token, JWT_SECRET); } catch { return next(); }
  if (u && u.role === 'driver') return /^\/driver\//.test(req.path) ? next() : res.status(403).json({ error: 'Driver sign-in only works in the driver app.' });   // driverauth.js
  if (!u || u.role !== 'dispatcher') return next();
  const why = dispatcherMayUse(req.method, req.path, u);
  if (why === 'outside') return res.status(403).json({ error: 'Dispatcher logins can only use the AI dispatcher console.' });
  if (why === 'settings') return res.status(403).json({ error: 'Only an admin can change settings. Ask an admin.' });
  return next();
});

// Companies: every dispatch login answers only from its own company's data (companies.js)
app.use(companyGate((req) => {
  let token = req.cookies && req.cookies.ta_session;
  if (!token) { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) token = h.slice(7); }
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}));

// who is sending a text: the signed-in person of this request (texts are signed with their name — ringcentral.js)
app.use((req, res, next) => {
  let token = req.cookies && req.cookies.ta_session;
  if (!token) { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) token = h.slice(7); }
  let u = null;
  if (token) { try { u = jwt.verify(token, JWT_SECRET); } catch { u = null; } }
  return u ? rcSender.run({ user: u }, next) : next();
});

const COOKIE = 'ta_session';
const cookieOpts = {
  httpOnly: true,
  secure: COOKIE_SECURE === 'true',
  sameSite: COOKIE_SECURE === 'true' ? 'none' : 'lax',
  maxAge: 180 * 24 * 60 * 60 * 1000, // stay signed in ~6 months
};
const traccarHeaders = { Authorization: `Bearer ${TRACCAR_TOKEN}`, Accept: 'application/json' };
// customers stay signed in (~6 months); administrators get a short session (see loginguard.js)
const issue = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: payload && payload.admin && !keepsLongSession(payload) ? `${STAFF_SESSION_DAYS}d` : '180d' });
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
// password guessing → locked out (every sign-in / reset route)
app.use(/^\/auth\/(?:[a-z]+\/)?(?:login|signin|reset|forgot|password-reset)\/?$/i, loginGuardMiddleware());

// Traccar email + password → { u, sess } (u = the full Traccar user) or null. Throws when Traccar can't be reached.
async function traccarCheck(email, password) {
  const body = new URLSearchParams({ email, password });
  const r = await fetch(`${TRACCAR_URL}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) return null;
  const u = await r.json();
  return { u, sess: { id: u.id, email: u.email, name: u.name, role: u.administrator ? 'admin' : 'owner', admin: !!u.administrator } };
}
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const c = await traccarCheck(email, password);
    if (!c) return res.status(401).json({ error: 'Wrong email or password.' });
    const token = setSession(res, c.sess);
    res.json({ ...c.u, ...c.sess, token }); // full Traccar user + a token the client stores
  } catch { res.status(502).json({ error: 'Could not reach the tracking server.' }); }
});

// ---- broker / family signup + login (server-side accounts) ----
// a broker / family / fleet email + password → the session user, or null
async function accountCheck(kind, listKey, e, password) {
  const acc = await readAccounts();
  const rec = acc[listKey].find((x) => x.email === e);
  if (!rec || !verifyPassword(password, rec.pass)) return null;
  return { id: rec.id, email: rec.email, name: rec.name, company: rec.company, role: kind };
}
function makeAccountRoutes(kind, listKey) {
  app.post(`/auth/${kind}/signup`, async (req, res) => {
    const { email, password, name, company } = req.body || {};
    const e = norm(email);
    if (!e || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
      let created;
      await writeAccounts((acc) => {
        if (acc[listKey].some((x) => x.email === e)) throw Object.assign(new Error('exists'), { code: 'exists' });
        // the company name decides whose data an account sees, so nobody can sign up into someone else's
        const co = String(company || '').trim().toLowerCase();
        if (co && (['florida-beauty', 'florida beauty', '__shared'].includes(co) || acc[listKey].some((x) => String(x.company || '').trim().toLowerCase() === co || String(x.id).toLowerCase() === co))) throw Object.assign(new Error('taken'), { code: 'taken' });
        created = { id: uid(kind[0].toUpperCase()), email: e, name: name || '', company: company || '', pass: hashPassword(password), createdAt: new Date().toISOString() };
        acc[listKey].push(created);
        return acc;
      });
      const user = { id: created.id, email: created.email, name: created.name, company: created.company, role: kind };
      const token = setSession(res, user);
      res.json({ ...user, token });
    } catch (err) {
      if (err.code === 'exists') return res.status(409).json({ error: 'An account with that email already exists.' });
      if (err.code === 'taken') return res.status(409).json({ error: 'That company already has an account. Ask its admin to add you.' });
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
      const user = await accountCheck(kind, listKey, e, password);
      if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
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
  try { req.user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expired.' }); }
  // admin / dispatcher tokens older than 7 days (incl. ones issued before this rule) → sign in again
  if (sessionTooOld(req.user)) return res.status(401).json({ error: 'Session expired.' });
  return next();
}
// two middlewares as one (for modules that take a single requireAuth)
const chain = (a, b) => (req, res, next) => a(req, res, () => b(req, res, next));
app.get('/auth/me', requireAuth, (req, res) => res.json(req.user));

// ---- self-serve account deletion (App Store Guideline 5.1.1(v)) ----
// A signed-in customer can permanently delete THEIR OWN account from inside the
// app. We remove their Traccar login and personal data (push tokens, alert
// history). Their physical tracker is NOT deleted — it stays in our inventory,
// gets flagged `accountDeleted` so we can see the account was removed, and is
// returned to the unclaimed pool so it can be reassigned. Admin accounts can't
// self-delete through this consumer path.
app.delete('/account', requireAuth, async (req, res) => {
  const uid = req.user && req.user.id;
  if (!uid) return res.status(400).json({ error: 'No account to delete.' });
  if (req.user.admin || req.user.role === 'admin') {
    return res.status(403).json({ error: 'Admin accounts cannot be deleted from the app.' });
  }
  try {
    // 1) look up the full user record for account #, name + email (for the flag)
    const users = await (await fetch(`${TRACCAR_URL}/api/users`, { headers: traccarHeaders })).json().catch(() => []);
    const meUser = (Array.isArray(users) ? users : []).find((u) => String(u.id) === String(uid)) || {};
    const myAttrs = meUser.attributes || {};
    const acct = String(myAttrs.account || myAttrs.acct || '');
    const cid = String(myAttrs.customerId || '');
    const marker = {
      at: new Date().toISOString(),
      name: meUser.name || req.user.name || '',
      email: meUser.email || req.user.email || '',
      account: acct, customerId: cid, userId: String(uid),
    };

    // 2) flag / release this account's trackers (keep them in inventory)
    const devs = await (await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders })).json().catch(() => []);
    const memberId = `u${uid}`;
    let flagged = 0;
    for (const d of (Array.isArray(devs) ? devs : [])) {
      const a = d.attributes || {};
      const owned = (acct && String(a.account || '') === acct) || (cid && String(a.customerId || '') === cid);
      const links = Array.isArray(a.memberLinks) ? a.memberLinks : [];
      const shared = links.some((m) => m && m.memberId === memberId);
      if (!owned && !shared) continue;
      const nextAttrs = { ...a };
      if (links.length) nextAttrs.memberLinks = links.filter((m) => !(m && m.memberId === memberId));
      if (owned) { nextAttrs.accountDeleted = marker; nextAttrs.claimed = false; }
      const put = await fetch(`${TRACCAR_URL}/api/devices/${d.id}`, {
        method: 'PUT', headers: { ...traccarHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, attributes: nextAttrs }),
      });
      if (put.ok) flagged += 1;
    }

    // 3) wipe personal data — push tokens + alert history (best-effort)
    try { const p = await db.get('taPush', {}); if (p && p[String(uid)]) { delete p[String(uid)]; await db.set('taPush', p); } } catch { /* ignore */ }
    try { if (db.pool) await db.pool.query('DELETE FROM ta_alert_log WHERE user_key = $1', [String(uid)]); } catch { /* ignore */ }

    // 4) delete the Traccar login itself
    const del = await fetch(`${TRACCAR_URL}/api/users/${uid}`, { method: 'DELETE', headers: traccarHeaders });
    if (!del.ok && del.status !== 204) {
      const detail = await del.text().catch(() => '');
      console.error('[account] user delete failed:', del.status, detail.slice(0, 160));
      return res.status(502).json({ error: `Could not delete account (${del.status}).` });
    }
    console.log(`[account] DELETED user ${uid} (acct ${acct || '—'}); ${flagged} device(s) flagged/released`);
    res.clearCookie(COOKIE, cookieOpts);
    res.json({ ok: true, devicesFlagged: flagged });
  } catch (e) {
    console.error('[account] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// the Shop (catalog + orders) — on the server, not on a car's record (shop.js)
initShop(app, {
  requireAuth, db,
  legacy: async () => { const all = await allDevicesCached(); const h = all.reduce((m, d) => (!m || d.id < m.id ? d : m), null); return h && h.attributes && h.attributes.taShop; },
  verifyPaid: stripe ? async (sid) => { const ss = await stripe.checkout.sessions.retrieve(sid); return { paid: ss.payment_status === 'paid', amount: (ss.amount_total || 0) / 100, orderId: (ss.metadata || {}).orderId || '' }; } : null,
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
// every car (cached 10 s — each customer request needs it to filter)
let _allDevs = { at: 0, list: [] };
async function allDevicesCached() {
  if (Date.now() - _allDevs.at < 10000) return _allDevs.list;
  const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
  if (!r.ok) throw new Error('devices fetch failed');
  _allDevs = { at: Date.now(), list: await r.json() };
  return _allDevs.list;
}
// how this account relates to each car: Map id → 'owner' | 'shared' | 'pending' (access.js relation)
async function relationsFor(user) {
  const all = await allDevicesCached();
  let s = null; let mine = null;
  if (user.role === 'owner') {
    s = await ownerScope(user.id);
    // also the cars Traccar itself gives this user (older cars linked only by a user-device permission)
    try { const r = await fetch(`${TRACCAR_URL}/api/devices?userId=${encodeURIComponent(user.id)}`, { headers: traccarHeaders }); if (r.ok) mine = new Set((await r.json()).map((x) => x.id)); } catch { mine = null; }
  }
  const rel = new Map();
  for (const d of all) {
    const a = d.attributes || {};
    const trueOwner = !!s && ((a.ownerUserId != null && String(a.ownerUserId) === s.uid) || (s.account && String(a.account || '') === s.account) || (s.customerId && String(a.customerId || '') === s.customerId) || (mine && mine.has(d.id)));
    const r = relation(user, d, { trueOwner });
    if (r) rel.set(d.id, r);
  }
  return { all, rel };
}
const ownerKeyOf = (u) => `${u.role}:${u.id}`;
const deviceIdsInQuery = (req) => [].concat(req.query.deviceId || [], req.query.id && /^positions/.test(req.params[0] || '') ? req.query.id : []).map(Number).filter(Boolean);
async function userHoldsDevice(user, deviceId) {
  if (isAdminUser(user)) return true;
  const r = (await relationsFor(user)).rel.get(Number(deviceId));
  return r === 'owner' || r === 'shared';
}
// a customer's reply: only their cars, positions, reports, geofences (access.js deviceView)
function scopeForAccount(user, path, payload, { all, rel }) {
  const seg = String(path).split('/')[0]; const id = String(path).split('/')[1];
  const held = (devId) => { const r = rel.get(Number(devId)); return r === 'owner' || r === 'shared'; };
  if (seg === 'devices') {
    const view = (d) => (d ? deviceView(user, d, rel.get(d.id)) : null);
    if (Array.isArray(payload)) return payload.map(view).filter(Boolean);
    return id ? view(payload) : payload;
  }
  if (seg === 'positions' || seg === 'reports') {
    if (Array.isArray(payload)) return payload.filter((row) => row && row.deviceId != null && held(row.deviceId));
    return payload && payload.deviceId != null && !held(payload.deviceId) ? null : payload;
  }
  if (seg === 'geofences') {
    const mine = (g) => g && String((g.attributes || {}).taOwnerKey || '') === ownerKeyOf(user);
    if (Array.isArray(payload)) return payload.filter(mine);
    return payload;
  }
  if (seg === 'drivers') return Array.isArray(payload) ? [] : null;
  return Array.isArray(payload) ? [] : payload;
}

app.all('/api/traccar/*', requireAuth, async (req, res) => {
  const path = req.params[0] || '';
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  // only what this kind of account's own app uses (access.js) — the proxy speaks to Traccar as admin
  const rule = proxyRule(req.user, req.method, path, req.body);
  if (rule.deny) return res.status(403).json({ error: 'Your account does not include this.', why: rule.deny });
  let sendBody = rule.body || req.body;
  let rels = null;
  if (!isAdminUser(req.user)) {
    try { rels = await relationsFor(req.user); } catch { return res.status(502).json({ error: 'Upstream tracking server error.' }); }
    const held = (id) => { const r = rels.rel.get(Number(id)); return r === 'owner' || r === 'shared'; };
    if (rule.device != null && !held(rule.device)) return res.status(403).json({ error: 'That vehicle is not on your account.' });
    // reports / positions / geofences for a car: every car asked about must be theirs
    if (deviceIdsInQuery(req).some((id) => !held(id))) return res.status(403).json({ error: 'That vehicle is not on your account.' });
    const [seg, segId] = String(path).split('/');
    if (req.method === 'PUT' && seg === 'devices') {
      const cur = rels.all.find((d) => String(d.id) === String(segId));
      const m = mergeDeviceUpdate(req.user, cur, req.body, cur ? rels.rel.get(cur.id) : null);
      if (m.deny) return res.status(403).json({ error: 'That vehicle is not on your account.' });
      sendBody = m.device; _allDevs.at = 0;
    }
    if (req.method === 'POST' && seg === 'geofences') sendBody = { ...(req.body || {}), attributes: { ...((req.body || {}).attributes || {}), taOwnerKey: ownerKeyOf(req.user) } };
    if (req.method === 'DELETE' && seg === 'geofences') {
      try {
        const gs = await (await fetch(`${TRACCAR_URL}/api/geofences`, { headers: traccarHeaders })).json();
        const g = (gs || []).find((x) => String(x.id) === String(segId));
        if (!g || String((g.attributes || {}).taOwnerKey || '') !== ownerKeyOf(req.user)) return res.status(403).json({ error: 'That place is not on your account.' });
      } catch { return res.status(502).json({ error: 'Upstream tracking server error.' }); }
    }
  }
  // own profile: the locked fields (admin flag, limits, account / customer ids) keep their current values
  if (rule.keepFields) {
    try {
      const cur = ((await (await fetch(`${TRACCAR_URL}/api/users`, { headers: traccarHeaders })).json()) || []).find((u) => String(u.id) === String(req.user.id));
      if (!cur) return res.status(404).json({ error: 'Profile not found.' });
      rule.keepFields.forEach((k) => { if (k in cur) sendBody[k] = cur[k]; });
      sendBody.attributes = { ...(sendBody.attributes || {}) };
      rule.keepAttrs.forEach((k) => { if (cur.attributes && k in cur.attributes) sendBody.attributes[k] = cur.attributes[k]; else delete sendBody.attributes[k]; });
    } catch { return res.status(502).json({ error: 'Upstream tracking server error.' }); }
  }
  const init = {
    method: req.method,
    headers: {
      ...traccarHeaders,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { 'Content-Type': req.get('content-type') || 'application/json' } : {}),
    },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = typeof sendBody === 'string' ? sendBody : JSON.stringify(sendBody);
  try {
    const r = await fetch(`${TRACCAR_URL}/api/${path}${qs}`, init);
    res.status(r.status);
    const ct = r.headers.get('content-type') || '';
    // exports (xlsx / kml / csv …) are never filtered → admins only
    if (!isAdminUser(req.user) && ct && !ct.includes('application/json') && !ct.startsWith('text/plain')) return res.status(403).json({ error: 'Not available on your account.' });
    if (ct.includes('application/json')) {
      let payload = await r.json().catch(() => ({}));
      if (rels) { payload = scopeForAccount(req.user, path, payload, rels); if (payload == null) return res.status(404).json({ error: 'Not found.' }); }
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

// ---- per-customer scoping (ENFORCED HERE, not in the browser) -----------
// A regular TagAlong customer (role 'owner' — consumer or Pro) must only ever
// receive THEIR OWN vehicles from the server. Previously the browser fetched
// every device and filtered locally, which meant a signed-in user could read
// the raw response and see everyone's cars. Now the server filters on the way
// out, mirroring the client's ownership rules (src/traccar.js inScope):
//   device belongs to the user if attributes.ownerUserId === their id, OR the
//   device's account/customerId matches theirs, OR they were approved to view
//   it as a family member (attributes.memberLinks).
// admin sees all; fleet keeps its own scoping; broker/family keep their flows.
const _ownerScopeCache = new Map(); // uid -> { scope, exp }
async function ownerScope(uid) {
  const hit = _ownerScopeCache.get(String(uid));
  if (hit && hit.exp > Date.now()) return hit.scope;
  let account = '', customerId = '';
  try {
    const r = await fetch(`${TRACCAR_URL}/api/users`, { headers: traccarHeaders });
    if (r.ok) {
      const users = await r.json();
      const u = users.find((x) => String(x.id) === String(uid));
      const a = (u && u.attributes) || {};
      account = a.account || ''; customerId = a.customerId || '';
    }
  } catch { /* fall back to id-only scope */ }
  const scope = { uid: String(uid), account: String(account), customerId: String(customerId) };
  _ownerScopeCache.set(String(uid), { scope, exp: Date.now() + 60000 });
  return scope;
}
function ownerOwns(d, s) {
  const a = (d && d.attributes) || {};
  if (a.ownerUserId != null && String(a.ownerUserId) === s.uid) return true;
  if (s.account && String(a.account || '') === s.account) return true;
  if (s.customerId && String(a.customerId || '') === s.customerId) return true;
  const links = a.memberLinks || [];
  if (Array.isArray(links) && links.some((x) => x && x.memberId === `u${s.uid}` && x.status === 'approved')) return true;
  return false;
}
const _ownerDevCache = new Map(); // uid -> { ids:Set, exp }
async function ownerDeviceIds(s) {
  const hit = _ownerDevCache.get(s.uid);
  if (hit && hit.exp > Date.now()) return hit.ids;
  const ids = new Set();
  try {
    const r = await fetch(`${TRACCAR_URL}/api/devices`, { headers: traccarHeaders });
    if (r.ok) { const all = await r.json(); all.forEach((d) => { if (ownerOwns(d, s)) ids.add(d.id); }); }
  } catch { /* empty set → sees nothing, fail closed */ }
  _ownerDevCache.set(s.uid, { ids, exp: Date.now() + 30000 });
  return ids;
}
async function scopeForOwner(user, path, payload) {
  const s = await ownerScope(user.id);
  if (/^devices\b/.test(path) && Array.isArray(payload)) return payload.filter((d) => ownerOwns(d, s));
  if (/^positions\b/.test(path) && Array.isArray(payload)) {
    const ids = await ownerDeviceIds(s);
    return payload.filter((p) => ids.has(p.deviceId));
  }
  if (/^(reports|events)\b/.test(path) && Array.isArray(payload)) {
    const ids = await ownerDeviceIds(s);
    return payload.filter((row) => row && (row.deviceId == null || ids.has(row.deviceId)));
  }
  return payload; // non-device endpoints (session, server attrs, geofences…) pass through
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

// ---- sharing a car by its code (family, broker, fleet) — done HERE so nobody's app needs every car ----
// The requester never sees the car until its owner approves (the owner's app shows the request).
async function putDevice(dev) {
  const r = await fetch(`${TRACCAR_URL}/api/devices/${dev.id}`, { method: 'PUT', headers: { ...traccarHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(dev) });
  _allDevs.at = 0;
  if (!r.ok) throw new Error(`save failed ${r.status}`);
  return r.json().catch(() => dev);
}
const deviceBody = (dev, attributes) => ({ id: dev.id, name: dev.name, uniqueId: dev.uniqueId, groupId: dev.groupId || 0, phone: dev.phone || '', model: dev.model || '', contact: dev.contact || '', category: dev.category || null, disabled: !!dev.disabled, attributes });
async function addShareRequest(user, dev) {
  const sh = shareEntry(user); if (!sh) throw new Error('not allowed');
  const a = dev.attributes || {};
  const list = (a[sh.list] || []).filter((x) => x && String(x[sh.key]) !== String(sh.entry[sh.key]));
  const prev = (a[sh.list] || []).find((x) => x && String(x[sh.key]) === String(sh.entry[sh.key]));
  if (prev && prev.status === 'approved') return 'approved';
  if (prev && prev.status === 'pending') return 'pending';
  await putDevice(deviceBody(dev, { ...a, [sh.list]: [...list, sh.entry] }));
  return 'requested';
}
app.post('/share/request', requireAuth, allowRoles('owner', 'member', 'broker'), async (req, res) => {
  const code = normCode((req.body || {}).code);
  if (!code) return res.status(400).json({ error: 'Enter the car code.' });
  try {
    const dev = (await allDevicesCached()).find((d) => normCode(deviceShareCode(d)) === code);
    if (!dev) return res.status(404).json({ error: 'No car found with that code. Double-check it with the owner.' });
    const status = await addShareRequest(req.user, dev);
    res.json({ ok: true, status, id: dev.id, name: (dev.attributes || {}).displayName || dev.name });
  } catch (e) { console.error('[share] request:', e.message); res.status(502).json({ error: 'Could not send the request.' }); }
});
// the requester takes their own request / access off a car
app.post('/share/leave', requireAuth, allowRoles('owner', 'member', 'broker'), async (req, res) => {
  try {
    const dev = (await allDevicesCached()).find((d) => String(d.id) === String((req.body || {}).deviceId));
    const sh = shareEntry(req.user);
    if (!dev || !sh) return res.status(404).json({ error: 'Not found.' });
    const a = dev.attributes || {};
    await putDevice(deviceBody(dev, { ...a, [sh.list]: (a[sh.list] || []).filter((x) => x && String(x[sh.key]) !== String(sh.entry[sh.key])) }));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Could not update.' }); }
});

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
    // a car that belongs to a customer → the owner has to approve it (it shows with their share requests)
    const da = dev.attributes || {};
    const owned = da.ownerUserId != null || da.account || da.customerId || (Array.isArray(da.owners) && da.owners.length) || (da.memberLinks || []).some((x) => x && x.status === 'approved');
    if (owned && owner !== String(req.user.id)) {
      const status = await addShareRequest(req.user, dev);
      return res.json({ ok: true, pending: status !== 'approved', status, id: dev.id, name: da.displayName || dev.name });
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
const push = initPush(app, { TRACCAR_URL, traccarHeaders, requireAuth, env: process.env, db });

// Dispatch loads + the API a partner TMS integrates against. Safely no-ops
// (503 with a clear message) until DATABASE_URL is configured.
initLoads(app, { requireAuth: chain(requireAuth, allowRoles('fleet')), db, pool: db.pool });

// Driver proof-of-delivery capture (counts as DATA, plus the photo evidence).
initPod(app, { requireAuth: chain(requireAuth, allowRoles('fleet')), db, pool: db.pool });

// The AI dispatcher's continuous review — what needs a human right now.
initDispatcher(app, { requireAuth: chain(requireAuth, allowRoles('fleet')), db, pool: db.pool });

// Customer call-ahead (call or text, contact's choice). DRY-RUN until
// NOTIFY_ALLOW_SEND=true — see the compliance note at the top of notify.js.


// Live fleet state from the company's own telematics (Samsara), classified so
// dormant units and trucks parked at a terminal don't drown the review.
initFleet(app, { requireAuth: chain(requireAuth, allowRoles('fleet')), db, env: process.env });

// RingCentral: SMS from the company's own business numbers, plus the call log
// so "was this customer actually called?" comes from records, not memory.
const rc = initRingCentral(app, { requireAuth: (req, res, next) => requireDispatch(req, res, next), db, pool: db.pool, env: process.env });
// Original uploaded documents (rate cons, trip sheets) kept privately in Postgres.
// Dispatch side (console, Jarvis, loads, emails, calls): admins and active dispatcher accounts only —
// a TagAlong customer login can't reach it.
const { requireDispatch, requireAdmin, requireCompanyAdmin, requireStaffManager, logins: staffLogins, createLogin, signIn: dispatcherSignIn } = initDispatchers(app, { requireAuth, db, hashPassword, verifyPassword, sign: (user, exp) => jwt.sign(user, JWT_SECRET, { expiresIn: exp }), setCookie: (res, t) => res.cookie(COOKIE, t, { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 }), mail: { ready: () => mailConfig(process.env).ready, send: (m) => sendMail(m, { env: process.env, direct: true, noCopy: true }), mayReach: async (to) => /@floridabeauty\.us$/i.test(to) || !(await training.active()) }, appUrl: process.env.APP_URL || 'https://mytagalong.app' });
initCompanies(app, { db, requireAdmin, createLogin });
// one sign-in for every kind of account → lands on that person's service (signin.js)
initSignin(app, {
  db, requireAdmin,
  setCookie: (res, t, kind) => res.cookie(COOKIE, t, kind === 'dispatcher' ? { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 } : cookieOpts),
  checks: {
    traccar: async (e, pw) => { const c = await traccarCheck(e, pw); return c ? { kind: c.sess.admin ? 'admin' : 'owner', user: { ...c.u, ...c.sess }, token: issue(c.sess) } : null; },
    dispatcher: async (e, pw, req) => { const r = await dispatcherSignIn(e, pw, req); return !r || r.error ? r : { user: r.user, token: r.token, mustChange: r.mustChange }; },
    ...Object.fromEntries([['fleet', 'fleets'], ['broker', 'brokers'], ['member', 'members']].map(([kind, list]) => [kind, async (e, pw) => { const u = await accountCheck(kind, list, e, pw); return u ? { user: u, token: issue(u) } : null; }])),
  },
});
// who gets which push notifications — one admin screen for all of them
const pushRules = initPushRules(app, { requireAdmin: requireCompanyAdmin, db, push, listDispatchers: async () => (((await db.get('taDispatchers', { list: [] })) || {}).list || []).map(({ pass, reset, ...d }) => d) });
// company directory: staff names + extensions (shareable); cells / emails are system-only
const directory = initDirectory(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, requireManager: requireStaffManager, logins: staffLogins, db, contact: {
  textingLive: async () => { try { const c = rc && rc.configFor ? await rc.configFor('__shared') : null; return !!(c && c.fromNumber); } catch { return false; } },
  text: (to, text) => rc.sendSms('__shared', { to, text }),
  email: (to, subject, text) => sendMail({ to: [to], subject, html: `<div style="font-family:Arial,sans-serif;font-size:15px">${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`, text }, { env: process.env }),
  call: (o) => voice.callStaff(o),
} });
// texts are signed with the sender's full name from the Employees list (else their login name)
rc.setNameResolver(async (u) => {
  const em = String((u && u.email) || '').toLowerCase();
  const p = em ? ((await directory.load()).people || []).find((x) => String(x.email || '').toLowerCase() === em) : null;
  const n = (p && p.name) || (u && u.name) || '';
  return n ? n.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
});
// training mode: outside emails go to the test addresses; texts / calls / app messages are held (copy emailed)
const training = initTraining(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, sendDirect: (m) => sendMail(m, { env: process.env, direct: true }) });
setMailGuard((m) => training.mailGuard(m));
setSmsGuard((m) => training.hold('text', m));
const docs = initDocuments(app, { requireAuth: requireDispatch, db });
// scheduled ETA updates ("ETA every 3 hours on Native until delivered")
const etaWatch = initEtaWatch(app, { requireAuth: requireDispatch, db, docs, sendMail: (m) => sendMail(m, { env: process.env }) });
// Geofence stop tracking (validated Samsara address boundaries only).
let artisClients = null;   // customer geofences from ARTIS (set up below) — the stop-visit tracker uses them too
const stopVisits = initStopVisits({ db, env: process.env, listAddresses: async (token) => [...(await listAddresses(token)), ...(artisClients ? await artisClients.asAddresses().catch(() => []) : [])], tokenFrom: samsaraTokenFrom });
// Outside carriers (OC): carrier list, OC marks, check calls / email check-ins.
const carriers = initCarriers(app, { requireAuth: requireDispatch, db });
// OC driver tracking links (TagAlong app / browser) — positions overlay the board.
// load rundown PDF + Outlook email when a load finishes
const rundowns = initRundowns(app, { requireAuth: requireDispatch, db, docs, recipients: (k) => alertRecipients.resolve(k), env: process.env });
let truckmate;
// Calls & texts log by day (who called / was texted, both numbers, what was said)
// the client list (flowers + produce customers): who's calling / emailing, real business names, their loads
const clients = initClients({ db, score: nameScore });
const activity = initActivity(app, { clients, requireAuth: requireDispatch, db, push, pushRules, getBoard: (site) => truckmate.buildBoard(site), staff: async () => (await directory.load()).people || [] });
// an employee's Recents on Employees: their Jarvis calls + desk-line calls (RingCentral call log)
directory.setCallLog(async (phone) => {
  const [jarvis, desk] = await Promise.all([
    activity.callsWith([phone]).catch(() => []),
    rc.callLogWith('__shared', phone).then((l) => ({ l })).catch((e) => ({ err: e.message })),
  ]);
  return { jarvis, desk: desk.l || [], deskError: desk.err || null };
});
// "someone needs us to reach out" (calls, emails, texts, driver app) → email + text the right people
let helpdesk = null;
const help = { raise: (r) => (helpdesk ? helpdesk.raise(r) : Promise.resolve(null)) };
const driverLinks = initDriverLinks(app, { training, help, onPaperwork: async (site, trip, p) => {
  // the driver's paperwork, to Accounting right away with the load's information (paperworkmail.js)
  const to = await alertRecipients.resolve('driver_paperwork');
  if (!to.length) return;
  const item = (((await truckmate.buildBoard(site).catch(() => ({}))) || {}).trips || []).find((it) => String(((it && it.trip) || it || {}).tripNumber || '') === trip) || null;
  let room = 2.8 * 1024 * 1024;
  const files = (await docs.readDocs({ site, ids: p.docIds })).filter((f) => { const ok = f.data && f.data.length <= room; if (ok) room -= f.data.length; return ok; });
  const { renderPaperworkEmail } = await import('./paperworkmail.js');
  await sendMail({ to, ...renderPaperworkEmail({ ...p, trip, item, files: p.docIds.length }), attachments: files.map((f, i) => ({ name: `${String(p.kind).toUpperCase()}-${p.bill || trip}-${i + 1}.${/pdf/i.test(f.mediaType || '') ? 'pdf' : 'jpg'}`, contentType: f.mediaType || 'application/pdf', bytes: f.data })) }, { env: process.env });
}, requireAuth: requireDispatch, db, carriers, ringcentral: rc, docs, push, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
// driver calls / texts on a load, and their replies (RingCentral)
// an employee texting Jarvis (phone on the Employees list) → the same answers as Ask Jarvis, as a short text
// a picture in a text, saved on the load (or waiting for one)
const saveTextPhotos = async (r, trip) => {
  const saved = [];
  for (const m of r.media) { // eslint-disable-line no-await-in-loop
    try {
      const f = await readableFile({ dataBase64: (await rc.mediaBytes('__shared', m.uri)).toString('base64'), mediaType: m.contentType, filename: m.name }); // eslint-disable-line no-await-in-loop
      const [d] = await docs.storeDocs({ site: 'florida-beauty', kind: 'email', trip, files: [{ filename: f.filename || 'text-photo.jpg', mediaType: f.mediaType, dataBase64: f.dataBase64 }], by: 'Driver text' }); // eslint-disable-line no-await-in-loop
      if (d) saved.push({ docId: String(d.id), name: String(f.filename || 'text-photo.jpg').slice(0, 80) });
    } catch (e) { console.warn('[comms] text photo:', e.message); }
  }
  return saved;
};
const staffAsk = async ({ phone, text, media = [] }) => {
  const d = (s2) => String(s2 || '').replace(/\D+/g, '').slice(-10);
  const me = ((await directory.load().catch(() => ({ people: [] }))).people || []).find((p) => p && p.active !== false && p.phone && d(p.phone) === d(phone));
  if (!me || !jarvisChat || (!String(text || '').trim() && !media.length)) return null;
  const uploads = media.length ? await saveTextPhotos({ media }, null) : [];
  const r = await jarvisChat.turn({ mode: 'staff_email', sms: true, uploads, user: { id: `sms:${d(phone)}`, name: me.name, email: me.email || null }, threadId: `sms-${d(phone)}`,
    text: `[Text message from ${me.name}, Florida Beauty staff. Answer as a short text message: plain words, 1–3 sentences, no links or tables.${uploads.length ? ` ${uploads.length} photo${uploads.length === 1 ? '' : 's'} came with this text.` : ''}]\n\n${String(text).slice(0, 1000)}` });
  return r && r.answer ? r.answer : null;
};
let missingCases = null;   // set below, once the alert lists exist
let roadCalls = null;      // set below too
const comms = initComms(app, { textPhotos: saveTextPhotos, onTextPhotos: (trip, photos, by) => breakdownReport.addPhotos({ trip, photos, by }), staffAsk: (...a) => staffAsk(...a), missingCases: { fromText: (...a) => (missingCases ? missingCases.fromText(...a) : null) }, roadCalls: { fromDriverText: (...a) => (roadCalls ? roadCalls.fromDriverText(...a) : null) }, help, activity, requireAuth: requireDispatch, db, ringcentral: rc, carriers, driverLinks, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
driverLinks.useComms(comms);   // OC app chat is logged on the load like texts
helpdesk = initHelpdesk(app, { requireAuth: requireDispatch, db, env: process.env, push, pushRules, directory, getBoard: (site) => truckmate.buildBoard(site), caller: (o) => voice.callStaff(o),
  mail: { ready: () => mailConfig(process.env).ready, send: (m) => sendMail(m, { env: process.env }) },
  sms: { live: async () => { try { const c = rc && rc.configFor ? await rc.configFor('__shared') : null; return !!(c && c.fromNumber); } catch { return false; } }, send: (to, text) => rc.sendSms('__shared', { to, text }) } });
// live tracking link for the rate con contact (one load only; stops once delivered)
const brokerTrack = initBrokerTrack(app, { db, getBoard: (site) => truckmate.buildBoard(site), env: process.env });
const statusMail = initStatusMail(app, { isTraining: async () => !!(await training.active()), onBreakdownNote: (trip, message, by) => breakdownReport.addUpdate({ trip, message, by }), onBreakdownOff: (trip) => breakdownReport.clear(trip), tempTeam: () => alertRecipients.resolve('reefer_temp'),  requireAuth: requireDispatch, db, docs, comms, ringcentral: rc, env: process.env,
  track: (site, trip) => brokerTrack.linkFor(site, trip),
  chainReply: (site, trip, m) => (inbox ? inbox.replyOnLoadChain(site, trip, m) : { sent: false }) });
let manifestsApi = null;   // set below — the inbox hands it rate cons that arrive by email
// Jarvis reaching a driver (asked by staff in an email or in the chat): the TagAlong app first (OC drivers), else a text — consent / STOP rules apply
const driverHooks = { text: async (site, trip, message, by) => { const a = await driverLinks.messageDriver(site, trip, message, by).catch(() => ({ skipped: true })); return a && a.sent ? a : comms.textDriverAuto(site, trip, message, by); }, call: async (site, trip, by) => { try { return { called: true, ...(await voice.placeCall(String(trip), { purpose: 'check', by })) }; } catch (e) { return { skipped: e.message }; } } };
// the load message dispatch sends a driver (FB#, TRIP#, PICK UP, DELIVERY…): read into a sheet for the driver app, sent by app and / or text (loadsheet.js)
const loadSheets = initLoadSheets(app, { requireAuth: requireDispatch, db, getBoard: (site) => truckmate.buildBoard(site), sendApp: (...a) => driverLinks.messageDriver(...a), sendText: (...a) => comms.textDriverAuto(...a), log: (...a) => comms.log(...a), sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('trailer_drop'),
  // the rate con Jarvis queued as a truck's next load, for the trip TruckMate now has for it (nextloads.js)
  nextRateCon: async (item) => {
    const t = String(item.trip.tripNumber); const bills = JSON.stringify(item.freightBills || []).toUpperCase();
    const n = ((await truckmate.buildBoard('florida-beauty')).trips || []).flatMap((x) => x._nextLoad || []).find((e) => String((e.verified && e.verified.trip) || e.trip || '') === t || (e.rc && [e.rc.bill, e.rc.loadNumber].filter(Boolean).some((v) => bills.includes(String(v).toUpperCase()))));
    return n ? nextLoads.rateConOf('florida-beauty', n) : null;
  },
  notify: (trip, title, body) => driverAuth.notifyTrip(trip, body, title) });
// LTL stop by stop from the driver app: done with boxes + signed paperwork, issues, trip completed (stopflow.js)
const stopFlow = initStopFlow({ db, docs, getBoard: (site) => truckmate.buildBoard(site), sendMail: (m) => sendMail(m, { env: process.env }), recipients: (k) => alertRecipients.resolve(k), log: (...a) => comms.log(...a) });
// Jarvis' playbook: what staff teach it by email ("TRAINING: …")
const playbook = initPlaybook(app, { requireAuth: requireDispatch, db, env: process.env, onLearned: (...a) => jarvisAsks.tellOwner(...a) });
const jarvisAsks = initJarvisAsks(app, { requireAuth: requireDispatch, db, secret: JWT_SECRET, playbook, env: process.env, readAudit: (q) => db.readAudit(q), sendMail: (m) => sendMail(m, { env: process.env, direct: true, noCopy: true }) });
// load follow-through: rate-con instructions to dispatch, Jarvis' offers (reply YES), revised rate cons after delivery
const follow = initFollowThrough(app, { groupEmail: (n) => directory.groupEmail(n), playbook, requireAuth: requireDispatch, db, sendMail: (m) => sendMail(m, { env: process.env }), etaWatch, driver: driverHooks, docs, getBoard: (site) => truckmate.buildBoard(site) });
// meetups ("meet in Fort Pierce"): track the truck to the place, reply on the chain, text the driver to verify
const meetWatch = initMeetWatch({ db, getBoard: (site) => truckmate.buildBoard(site), textDriver: (site, trip, text, by) => driverHooks.text(site, trip, text, by), replyInThread: (...a) => inbox.replyInThread(...a), env: process.env });
// next loads: rate cons Gus (dispatch GM) sends for trucks still on a run → on the truck's card
const nextLoads = initNextLoads({ db, env: process.env });
// Gus's planning sheet (Google Sheets, read-only via the service account)
const planSheet = initPlanSheet(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, getBoard: (site) => truckmate.buildBoard(site), nextLoads, env: process.env });
// stop instructions from staff email chains (e.g. deliver to Biloxi instead of Pensacola): driver has it, GPS + driver confirm, reply on the chain
const stopTasks = initStopTasks({ db, env: process.env, textDriver: (site, trip, text, by) => driverHooks.text(site, trip, text, by), voice: { placeCall: (...a) => voice.placeCall(...a), callsFor: (...a) => voice.callsFor(...a) }, replyInThread: (...a) => inbox.replyInThread(...a) });
const followProxy = { start: (...a) => brokerFollow.start(...a), overlay: (...a) => brokerFollow.overlay(...a), process: (...a) => brokerFollow.process(...a) };
const dispatchLog = initDispatchLog(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, env: process.env });
let staffActions = null;     // set once the breakdown and stop records exist
// Gus's rate cons: to Inbound Dispatch now, to Accounting once the load is in TruckMate
const rateConFlow = initRateConFlow({ db, docs, sendMail: (m) => sendMail(m, { env: process.env }), recipients: (k) => alertRecipients.resolve(k), saveOnLoad: async (site, trip, entry) => {
  const pending = (await db.get(`taRateConPending:${site}`, [])) || [];
  const hit = pending.find((p) => p.id === entry.pendingId);
  if (!hit) return;
  if (!((await db.get(`taTruckMateRateCon:${site}`, {})) || {})[trip]) await ratecon.save(site, trip, hit.record);
  await db.update(`taRateConPending:${site}`, (cur) => (Array.isArray(cur) ? cur : []).filter((x) => x.id !== entry.pendingId), []);
} });
// a new breakdown from pictures (the driver's texts + the damage): Road calls tab, and staff emails to Jarvis
const breakdownRead = initBreakdownRead(app, { requireAuth: requireDispatch, getBoard: (site) => truckmate.buildBoard(site), env: process.env });
const inbox = initInbox(app, { breakdownRead, rateConFlow, breakdownPhotos: (...a) => breakdownReport.addPhotos(...a), stopReview: { decide: (...a) => stopReview.decide(...a) }, transferDone: { confirm: (...a) => transferDone.confirm(...a), cancel: (...a) => transferDone.cancel(...a) }, breakdownFixed: (...a) => breakdownReport.fixed('' + a[0], a[1], a[2]), rescuePlan: (...a) => breakdownReport.rescuePlan(...a), breakdownEmail: (...a) => breakdownReport.fromEmail(...a), brokerFollow: followProxy, dispatchLog, stopTasks, roadCalls: { checkDriver: (...a) => (roadCalls ? roadCalls.checkDriver(...a) : null) }, brokerWatch: (site, trip, o) => statusMail.watch(site, trip, o), paperwork: { request: (...a) => paperwork.request(...a) }, planSheet, groupEmail: (n) => directory.groupEmail(n), groupAddresses: async () => (await directory.groups()).map((g) => g.email).filter(Boolean), meetWatch, nextLoads, playbook, follow, etaWatch, training, help,
  // a staff question emailed to Jarvis is answered by the Ask Jarvis brain (same tools, whole board)
  askJarvis: async ({ mode, threadId, from, subject, text, done }) => (jarvisChat ? jarvisChat.turn(mode === 'customer' ? {
    mode: 'customer', user: { id: `email:${String(from.address || '').toLowerCase()}`, name: `${from.name || ''} <${from.address}>`.trim(), email: from.address }, threadId,
    senderClient: (() => { const c = clients.byEmail(from.address); return c ? c.name : null; })(),   // their own manifests only
    text: `[Email from ${from.name || ''} <${from.address}>]${(() => { const c = clients.byEmail(from.address); return c ? `\n[Sender is on our client list: ${c.name}${c.city ? ` — ${c.city}, ${c.state || ''}` : ''}. Look their loads up by that business name.]` : ''; })()}\nSubject: ${subject || ''}\n\n${String(text || '').slice(0, 3500)}`,
  } : {
    mode: 'staff_email', user: { id: `email:${String(from.address || '').toLowerCase()}`, name: from.name || from.address, email: from.address },
    threadId,
    text: `[Email to Jarvis from ${from.name || ''} <${from.address}> — Florida Beauty Flora staff]\nSubject: ${subject || ''}\n\n${String(text || '').slice(0, 3500)}\n\n(Answer this email for them. Look everything up with the tools — loads_to_place for a city / state, find_load for a trip, truck, trailer or customer. When it is about loads, call update_email with every trip that answers it (the delivery update is built from live data in the standard format) and reply with ONE short summary line. All times Eastern (ET) — never UTC.${(done || []).length ? ` Jarvis already did these from this email (they are listed in the email automatically — do NOT write them out or add a "Done from your email" section): ${done.join('; ')}.` : ''})`,
  }) : null), requireAuth: requireDispatch, db, docs, comms, env: process.env, getBoard: (site) => truckmate.buildBoard(site), rateCons: (site, pages, opts) => (manifestsApi ? manifestsApi.readAndFileRateCon(site, pages, opts) : null), tripSheets: (site, pages, opts) => (manifestsApi ? manifestsApi.readAndFileSheets(site, pages, opts) : []), packets: (site, files, opts) => (manifestsApi ? manifestsApi.readPacketFromEmail(site, files, opts) : null), loadSheets,
  // our staff can ask Jarvis (by email) to text or call a driver — same consent / STOP rules
  driver: driverHooks });
// customer & broker profiles (Customers tab): built from the loads, edited / verified by dispatch
const profiles = initProfiles(app, { clientList: () => clients.all(), requireAuth: requireDispatch, db, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
let tempPhotos = null;    // reefer temp photos for trailers we can't read live (set below)
let pickupFollow = null;   // set below (needs Jarvis voice); its overlay is read late
let jarvisChat = null;     // dispatchers' chat with Jarvis (notes / transfers overlay)
// who gets each alert email (Employees → Alert emails in the console)
const alertRecipients = initAlertRecipients(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, directory });
// 📅 committed delivery times per stop → late alerts (email + text, internal)
const etaReport = initEtaReport({ app, requireAuth: requireDispatch, db, sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('eta_report') });
const pastLoads = initPastLoads({ db, etaReport });
let brokerFollow = null;
const commitments = initCommitments(app, { requireAuth: requireDispatch, db, sendMail: (m) => sendMail(m, { env: process.env }), emails: () => alertRecipients.resolve('late_commitment'), phones: () => alertRecipients.phones('late_commitment'), sendSms: (to, text) => rc.sendSms('__shared', { to, text }) });
const artis = initArtis(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, sendMail: (m) => sendMail(m, { env: process.env }), recipients: (k) => alertRecipients.resolve(k), env: process.env });
// Missing boxes a customer asked about → email the "Customer asked about a load with missing boxes" list
// ARTIS Trip Status (ETA twice a day) + Trip Manifest PDFs, same read-only web login as the Truck Builder
const artisWeb = initArtisWeb(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, docs, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
// the rest of ARTIS: door temps (reefer alert), tractor / trailer positions, approaching yard; reports for Jarvis
const artisReports = initArtisReports({ db, artisWeb, getBoard: (site) => truckmate.buildBoard(site), sendMail: (m) => sendMail(m, { env: process.env }), tempTeam: () => alertRecipients.resolve('door_temp'), env: process.env });
// resend one reefer door-temp alert (to see the email) — only while training mode is on, so it can't reach the real list
// an example of the Synergize POD / BOL billing email (training mode only — it would go to Billing / Dispatch)
app.post('/admin/billing-email/example', requireCompanyAdmin, async (req, res) => {
  try {
    if (!(await training.active())) return res.status(409).json({ error: 'Examples are only sent in training mode (it would go to the real Billing / Dispatch address).' });
    res.json(await synergize.billingExample((req.body || {}).trip || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/reefer-alert/resend', requireCompanyAdmin, async (req, res) => {
  try {
    if (!(await training.active())) return res.status(409).json({ error: 'Resend is only allowed in training mode (it would go to the real reefer list).' });
    res.json(await artisReports.resendDoorTemp((req.body || {}).trailer || (req.body || {}).id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ARTIS Synergize documents (POD / BOL / invoice…) by bill — any bill type; TIFF scans → PDF, kept on the trip
const synergize = initSynergize(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, docs, artisWeb, getBoard: (site) => truckmate.buildBoard(site), onRateCon: (trip, file) => ratecon.attachIfMissing('florida-beauty', trip, file),
  // new POD / BOL from Synergize → Billing (Accounting's group email; Dispatch until Accounting has one)
  onBillingDocs: async (trip, found) => {
    const { billingEmail } = await import('./synergize.js');
    // POD / BOL paperwork → the POD Accounting group (pod_accounting@), else Accounting's address, else Dispatch
    const billing = (await directory.groupEmail('pod accounting').catch(() => null)) || (await directory.groupEmail('billing').catch(() => null));
    const to = billing || (await directory.groupEmail('dispatch').catch(() => null));
    if (!to) return;
    const item = ((await truckmate.buildBoard('florida-beauty').catch(() => ({}))).trips || []).find((it) => String(((it && it.trip) || it || {}).tripNumber || '') === String(trip)) || null;
    const rc = (((await db.get('taTruckMateRateCon:florida-beauty', {})) || {})[String(trip)]) || null;
    let room = 3 * 1024 * 1024;   // keep the email under the mail size limit; the rest stay on the trip
    const docsOut = found.map((d) => { const fits = d.bytes && d.bytes.length <= room; if (fits) room -= d.bytes.length; return { ...d, attached: !!fits }; });
    const { subject, html, text } = billingEmail({ trip, docs: docsOut, item, rc, fallback: !billing });
    await sendMail({ to: [to], subject, html, text, attachments: docsOut.filter((d) => d.attached).map((d) => ({ name: d.name || `${d.type}-${d.bill}.pdf`, contentType: 'application/pdf', bytes: d.bytes })) }, { env: process.env });
  }, nameFits: (a, b) => nameScore(a, b) >= 0.75 || nameScore(b, a) >= 0.75 });
// ARTIS customers → profiles (ID, address, phone, fax, delivery days…), the client list, and customer geofences
artisClients = initArtisClients(app, { requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, artisWeb, clients, profiles, getBoard: (site) => truckmate.buildBoard(site) });
app.post('/truckmate/artis/reports/run', requireCompanyAdmin, async (req, res) => { try { res.json(await artisReports.refresh()); } catch (e) { res.status(502).json({ error: e.message }); } });
const truckBuilder = initTruckBuilder(app, { requireAdmin: requireCompanyAdmin, db, sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('tripsheet_check'), env: process.env });
// road calls (breakdowns / tires) → Michelin ONCall when its API is set up; else the packet for 1-800-TIRE911
roadCalls = initRoadCalls(app, { requireAuth: requireDispatch, db, docs, help,
  textDriver: (site, trip, text, by) => driverHooks.text(site, trip, text, by),
  callDriver: (trip, rc) => voice.placeCall(String(trip), { purpose: 'roadcall-check', by: `Jarvis (road call ${rc.id})` }),
  photoLink: (site, trip, by) => driverLinks.ensureDocsLink(site, trip, by), sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('road_call'), getBoard: (site) => truckmate.buildBoard(site), env: process.env });
// MacroPoint (OC tracking the office already uses) → OC locations on our trips
const macroPoint = initMacroPoint(app, { requireAdmin: requireCompanyAdmin, db, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
missingCases = initMissingCases({ app, requireAuth: requireDispatch, db, sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('missing_boxes_case'), getBoard: (site) => truckmate.buildBoard(site) });
const missingBoxes = initMissingBoxes({ db, sendMail: (m) => sendMail(m, { env: process.env }), recipients: () => alertRecipients.resolve('artis_missing_call') });
brokerFollow = initBrokerFollow(app, { requireAuth: requireDispatch, db, getBoard: (site) => truckmate.buildBoard(site), commitments, sendMail: (m, o = {}) => sendMail(m, { env: process.env, ...o }), listEmails: () => alertRecipients.resolve('broker_late'), copyEmails: () => alertRecipients.resolve('delivery_confirm'), secret: JWT_SECRET, replyInThread: (...a) => inbox.replyInThread(...a) });
truckmate = initTruckMate(app, { requireAuth: requireDispatch, db, env: process.env, TRACCAR_URL, traccarHeaders, docs, overlays: [(...a) => (waiting ? waiting.overlay(...a) : null), (...a) => commitments.overlay(...a), (...a) => followProxy.overlay(...a), (...a) => breakdownReport.overlay(...a), (...a) => truckBuilder.overlay(...a), (...a) => artisWeb.overlay(...a), (...a) => artisReports.overlay(...a), (...a) => synergize.overlay(...a), (...a) => artis.overlay(...a), (...a) => stopTasks.overlay(...a), (...a) => macroPoint.overlay(...a), profiles.overlay, carriers.overlay, driverLinks.overlay, comms.overlay, inbox.overlay, statusMail.overlay, (site, trips) => (pickupFollow ? pickupFollow.overlay(site, trips) : null), (site, trips) => (tempPhotos ? tempPhotos.overlay(site, trips) : null), (site, trips) => nextLoads.overlay(site, trips), (site, trips) => planSheet.overlay(site, trips), (site, trips) => (jarvisChat ? jarvisChat.overlay(site, trips) : null), (site, trips) => loadSheets.overlay(site, trips), (site, trips) => stopFlow.overlay(site, trips)], routeProviders: [driverLinks.routeFor], onFinished: (site, rec, reason) => { etaReport.onFinished(site, rec, reason).catch((e) => console.warn('[eta-report]', e.message)); return rundowns.onFinished(site, rec, reason); } });

// Outbound trip sheets — the AI reads the daily paper manifests (printed +
// handwritten) so the Watchtower knows the real stop order and appointments.
const ratecon = initRateCon(app, { requireAuth: requireDispatch, db, env: process.env, docs });
ratecon.onSaved((site, trip, rc, prev) => follow.onRateCon(site, trip, rc, prev));
manifestsApi = initManifests(app, { requireAuth: requireDispatch, db, env: process.env, buildBoard: truckmate.buildBoard, docs, carriers, ratecon });

// Watchtower — checks every active trip each minute (reefer, late risk, HOS,
// stopped/breakdown, tracking, engine) and pushes Priority 1 alerts to the
// fleet managers' TagAlong app.
const miles = initMiles({ db, env: process.env });
const voice = initVoice(app, { staffActions: (what, input) => staffActions[what](input), brokerFollow: followProxy, dispatchLog, miles, artis, artisWeb, docs, stopTimes: etaReport, pastLoads, missingBoxes, missingCases, roadCalls, clients, training, directory, help, profiles, activity, mail: { ready: () => mailConfig(process.env).ready, send: (m) => sendMail(m, { env: process.env }) }, requireAuth: requireDispatch, db, comms, carriers, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
// call-aheads on LTL loads: remind the driver at 50 miles or when the stop before is done; Jarvis calls the customer under an hour out (callahead.js)
const callAhead = initCallAhead({ db, stopDone: (trip) => stopFlow.done(trip), etasFor: async (trip) => (((await db.get('taWatch:florida-beauty', {})) || {}).etas || {})[trip] || null, messageDriver: (...a) => driverHooks.text(...a), callCustomer: (trip, o) => voice.callCustomer(trip, o), log: (...a) => comms.log(...a) });
const outbound = initOutbound(app, { requireAuth: requireDispatch, db, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
// a truck's whole trip on the Fleet map: GPS trail, 15+ min stops (what happened), texts + Jarvis calls along the way
initJourney(app, { requireAuth: requireDispatch, db, activity, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
pickupFollow = initPickupFollow(app, { groupEmail: (n) => directory.groupEmail(n), requireAuth: requireDispatch, db, replyInThread: (...a) => inbox.replyInThread(...a), ringcentral: rc, comms, voice, docs, driverLinks, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
// paperwork after delivery: POD / BOL from the driver → broker + Billing; Billing's document requests
const paperwork = initPaperwork(app, { requireAuth: requireDispatch, db, getBoard: (site) => truckmate.buildBoard(site), docs, driverLinks, textDriver: (site, trip, text, by) => driverHooks.text(site, trip, text, by), groupEmail: (n) => directory.groupEmail(n), replyWithDocs: (id, o) => inbox.replyWithDocs(id, o), env: process.env });
// reefer temp photos (8 AM / 3 PM / 9:30 PM, hourly reminders) + an email to dispatch on every driver contact
tempPhotos = initTempPhotos(app, { team: () => alertRecipients.resolve('reefer_temp'), groupEmail: (n) => directory.groupEmail(n), requireAuth: requireDispatch, requireAdmin: requireCompanyAdmin, db, getBoard: (site) => truckmate.buildBoard(site), docs, driverLinks, ringcentral: rc, voice, comms, isInternal, env: process.env });
driverLinks.usePhotos((site, trip, info) => { if (roadCalls) roadCalls.photos(site, trip, info).catch(() => {}); return tempPhotos.received(site, trip, info); });
driverLinks.useRoadPhotos((site, trip, info) => (roadCalls ? roadCalls.photos(site, trip, info) : null));
const outreach = initOutreach({ groupEmail: (n) => directory.groupEmail(n), db, getBoard: (site) => truckmate.buildBoard(site), isInternal, env: process.env });
comms.useOutreach((ev) => outreach.notify(ev));
voice.useOutreach((ev) => outreach.notify(ev));
const milestones = initMilestones(app, { requireAuth: requireDispatch, db, ringcentral: rc, comms, driverLinks, push, pushRules, env: process.env });
const flowerReport = initFlowerReport(app, { photos: () => (tempPhotos ? tempPhotos.latestPhotos() : []), requireAuth: requireDispatch, db, env: process.env, getBoard: (site) => truckmate.buildBoard(site) });
initAssistant(app, { db, env: process.env, buildBoard: truckmate.buildBoard, voice, outbound, flowerReport, stopTimes: etaReport });
jarvisChat = initJarvisChat(app, { staffActions: (what, input) => staffActions[what](input), brokerFollow: followProxy, dispatchLog, miles, artis, artisWeb, artisReports, synergize, stopTimes: etaReport, pastLoads, clients, geofences: artisClients, planSheet, nextLoads, playbook, directory, requireAuth: requireDispatch, db, env: process.env, getBoard: (site) => truckmate.buildBoard(site), docs, voice, driver: driverHooks, help,
  packets: (site, files, opts) => (manifestsApi ? manifestsApi.readPacketFromEmail(site, files, opts) : null),
  reports: { flowers: () => flowerReport.make(), outbound: (d) => outbound.make(d) },
  mail: { ready: () => mailConfig(process.env).ready, send: (m) => sendMail(m, { env: process.env }) } });
// planned truck transfers (sheet: 734 → 4504): follow both trucks, report, confirm with the drivers
const transferWatch = initTransferWatch({ db, env: process.env, sendMail: (m, { rescue = false } = {}) => sendMail(m, { env: process.env, direct: rescue && staffOnly([].concat(m.to)) }), recipients: () => alertRecipients.resolve('transfer'), rescueRecipients: () => alertRecipients.resolve('breakdown_report'),
  textDriver: (site, trip, text, by) => driverHooks.text(site, trip, text, by), voice, renderMap: renderTransferMap, confirms: answerConfirms, isConfirmed: (plan) => transferDone.isConfirmed(plan),
  onConfirmed: (plan, ans, { b, s }) => transferDone.confirm({ trip: plan.trip, toTruck: plan.to, by: ans.source === 'TruckMate' ? 'TruckMate' : `Driver (${ans.source})`, source: { TruckMate: 'TruckMate', 'driver text': 'Driver text reply' }[ans.source] || 'Driver phone call', atMs: Date.parse(ans.at) || null, location: s.together && b ? b.location : null, summary: ans.summary }) });
// The handoff record: "Transfer completed" goes only from here, once TruckMate, a driver or staff says it is done.
const liveForUnit = async (unit) => { const token = samsaraTokenFrom(process.env); return token ? correlate({ trip: { powerUnit: unit } }, await getLiveIndex(token)) : null; };
const allEtas = async () => ((await db.get('taWatch:florida-beauty', {})) || {}).etas || {};
const transferDone = initTransferDone({ db, sendMail: (m, { rescue = false } = {}) => sendMail(m, { env: process.env, direct: !!rescue }), recipients: () => alertRecipients.resolve('transfer'), rescueRecipients: () => alertRecipients.resolve('breakdown_report'), staffOnly: (to) => staffOnly(to), etas: allEtas, reportFor: (trip) => breakdownReport.forTrip(trip) });
// the still map in the truck emails: real map, truck marker, the status on top. No picture → the address and link still work
const truckMap = async (l, tone, badge = {}) => {
  const png = await renderTruckMap({ lat: l.lat, lng: l.lng, tone, ...badge });
  return png ? [{ name: 'truck-location.jpg', contentType: 'image/jpeg', bytes: png, cid: 'truckmap' }] : [];
};
const hhmm = (ms) => { const v = Math.max(0, Math.round(ms / 60000)); return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`; };
const etText = (ms) => `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
const stopBadge = (a) => ({ close: true, big: a.stoppedSinceMs ? hhmm(Date.now() - a.stoppedSinceMs) : null, label: 'STOPPED', lines: [a.stopStartUnknown ? 'Start of the stop not confirmed' : `Stopped since ${etText(a.stoppedSinceMs)}`, 'Snapshot, not a live timer'] });
const rollBadge = (ep, now) => ({ big: hhmm(now - ep.movingSince), label: 'ROLLING', lines: [ep.speedMph != null ? `Speed ${Math.round(ep.speedMph)} mph` : null, `Moving since ${etText(ep.movingSince)}`, 'Snapshot, not a live timer'] });
const reportBadge = (r) => ({ close: true, big: 'BREAKDOWN', lines: [`Reported ${etText(r.atMs)}`] });
// the trip sheet goes with an email whenever we have it: one more try if the read fails
const sheetFor = async (item, trip) => {
  const ids = tripSheetIds(item);
  let pages = [];
  for (let i = 0; i < 2 && ids.length && pages.length < ids.length; i += 1) { try { pages = await docs.readDocs({ site: 'florida-beauty', ids }); } catch (e) { console.warn('[truck-email] trip sheet:', e.message); } } // eslint-disable-line no-await-in-loop
  const sheet = tripSheetFiles(pages, ids, trip);
  if (ids.length && sheet.attachments.length < ids.length) console.warn(`[truck-email] trip ${trip}: ${sheet.attachments.length} of ${ids.length} trip sheet pages attached`);
  return sheet;
};
// the breakdown chain is our own people only, so it goes for real in training mode without opening that group's other mail
let waiting = null;   // set once the emails below can be built
const staffOnly = (to) => to.length > 0 && to.every((e) => /@floridabeauty\.us$/i.test(e));
const LOOK = 'Open the load in the console to see them.';
// the photos as attachments, plus what the email says about any that didn't fit
const breakdownPhotoFiles = async (photos = [], room = PHOTOS_BYTES) => {
  if (!photos.length) return { attachments: [], note: null, rest: [] };
  const files = await docs.readDocs({ site: 'florida-beauty', ids: photos.map((x) => x.docId) }).catch((e) => { console.warn('[breakdown-photos]', e.message); return []; });
  const { attachments, rest } = photoAttachments(files, room);
  const lost = photos.length - files.length;
  const note = [rest.length ? `${rest.length} more photo${rest.length === 1 ? '' : 's'} in the next email${rest.length > 6 ? 's' : ''} on this chain.` : null, lost ? `${lost} photo${lost === 1 ? '' : 's'} could not be read. ${LOOK}` : null].filter(Boolean).join(' ') || null;
  return { attachments, note, rest };
};
// photos that didn't fit: as many follow-up emails on the chain as it takes, each as full as Outlook allows
const sendMorePhotos = async (report, item, to, rest, by, first, start) => {
  let left = rest; let n = start;
  while (left.length) {
    const { attachments, rest: next } = photoAttachments(left, EMAIL_BYTES, n);
    if (!attachments.length) { console.warn(`[breakdown-photos] trip ${report.trip}: ${left.length} photo(s) too big for an email`); break; }
    const m = renderBreakdownPhotosEmail({ report, item, by, count: attachments.length, subject: `Re: ${first}`, photoCids: attachments.map((a) => a.cid), photosNote: next.length ? `${next.length} more in the next email.` : null });
    await sendInThread({ to, ...m, attachments }, first, { env: process.env, direct: staffOnly(to) }); // eslint-disable-line no-await-in-loop
    n += attachments.length; left = next;
  }
};
const total = (list) => list.reduce((n, a) => n + a.bytes.length, 0);
const sendBreakdown = async (report, item, to, { update = null, photos: newPhotos = null, threadOf = null } = {}) => {
  const attachments = await truckMap((item && item._samsara) || {}, 'red', reportBadge(report));
  let sheet = update ? { status: 'none', note: null, attachments: [] } : await sheetFor(item, report.trip);
  const photos = await breakdownPhotoFiles(newPhotos || report.photos);
  // photos first: the trip sheet can be opened on the load
  if (photos.attachments.length && total([...attachments, ...sheet.attachments, ...photos.attachments]) > EMAIL_BYTES) sheet = { status: 'unavailable', note: 'Trip sheet left out to fit the photos. Open it on the load in the console.', attachments: [] };
  const etas = (((await db.get('taWatch:florida-beauty', {})) || {}).etas || {})[report.trip] || null;
  const build = (ph, note) => renderBreakdownEmail({ item, report, etas, showPhones: to.every((e) => /@floridabeauty\.us$/i.test(e)), mapCid: attachments.length ? 'truckmap' : null, sheetNote: sheet.note, sheetAttached: sheet.status === 'attached', photoCids: ph.map((a) => a.cid), photosNote: note, update, earlier: update ? (report.updates || []).slice(0, -1).slice(-5) : [] });
  const m = { ...build(photos.attachments, photos.note), ...(threadOf ? { subject: `Re: ${threadOf}` } : {}) };
  try {
    await sendInThread({ to, ...m, attachments: [...attachments, ...sheet.attachments, ...photos.attachments] }, threadOf, { env: process.env, direct: staffOnly(to) });
  } catch (e) {
    if (!photos.attachments.length) throw e;
    console.warn('[breakdown] sent without photos:', e.message);
    await sendMail({ to, ...build([], `Photos could not go in this email. ${LOOK}`), subject: m.subject, attachments: [...attachments, ...sheet.attachments] }, { env: process.env, direct: staffOnly(to) });
    return m.subject;
  }
  if (photos.rest.length) await sendMorePhotos(report, item, to, photos.rest, (update && update.by) || report.by, threadOf || m.subject, photos.attachments.length + 1).catch((e) => console.warn('[breakdown] more photos:', e.message));
  return m.subject;
};
const sendBreakdownPhotos = async (report, item, fresh, by, message = null) => {
  const to = await alertRecipients.resolve('breakdown_report');
  if (!to.length) return;
  const first = report.subject || breakdownSubject(item, report.reason, { unit: report.unit, trip: report.trip, part: report.part });
  if (message) { await sendBreakdown(report, item, to, { update: { message, by }, photos: fresh, threadOf: first }); return; }
  const photos = await breakdownPhotoFiles(fresh, EMAIL_BYTES);
  const m = renderBreakdownPhotosEmail({ report, item, by, count: fresh.length, subject: `Re: ${first}`, photoCids: photos.attachments.map((a) => a.cid), photosNote: photos.note });
  await sendInThread({ to, ...m, attachments: photos.attachments }, first, { env: process.env, direct: staffOnly(to) });
  if (photos.rest.length) await sendMorePhotos(report, item, to, photos.rest, by, first, photos.attachments.length + 1);
};
// what drivers texted on this load in the last few hours, so a report made after the text has the picture
const textedPhotos = async (trip) => (((await db.get('taTripComms:florida-beauty', {})) || {})[trip] || []).filter((e) => e.type === 'reply' && (e.photos || []).length && Date.now() - Date.parse(e.at) < 12 * 3600000).flatMap((e) => e.photos);
const sendStopEmail = async (a, { item, etas, driverCheck = null, subject = null }) => {
  const to = await alertRecipients.resolve('team_stopped');
  if (!to.length) return;
  const attachments = await truckMap((item && item._samsara) || {}, 'red', stopBadge(a));
  const mapCid = attachments.length ? 'truckmap' : null;
  const sheet = await sheetFor(item, a.trip);
  const showPhones = to.every((e) => /@floridabeauty\.us$/i.test(e));
  const body = (extra) => { const m = renderTeamStopEmail(teamStopFacts(a, item, { etas, showPhones, driverCheck, reportUrl: breakdownReport.link(a), reviewUrl: subject ? null : stopReview.link(a), ...extra })); return subject ? { ...m, subject: `Re: ${m.subject}` } : m; };
  try {
    await sendMail({ to, ...body({ mapCid, sheet }), attachments: [...attachments, ...sheet.attachments] }, { env: process.env });
  } catch (e) {
    console.warn('[team-stop] sent without files:', e.message);
    const noFiles = tripSheetIds(item).length ? { status: 'unavailable', note: 'Trip sheet could not be attached. Open it on the load in the console.' } : null;
    await sendMail({ to, ...body({ sheet: noFiles }) }, { env: process.env });
  }
};
// Extended stops: ask the drivers, and put what they say on the stop email. Silent until company texting is live (comms says so).
const stopCheck = initStopCheck({ db, textDriver: (site, trip, text, by, which) => comms.textDriverAuto(site, trip, text, by, which),
  getReplies: async (trip, since) => (((await db.get('taTripComms:florida-beauty', {})) || {})[trip] || []).filter((e) => e.type === 'reply' && Date.parse(e.at) >= since),
  sendUpdate: async (a, item, driverCheck) => (await stopReview.isAuthorized(a)) ? null : sendStopEmail(a, { item, etas: item ? (await allEtas())[a.trip] || null : null, driverCheck, subject: 'thread' }),
  startBreakdown: (x) => breakdownReport.fromEmail({ ...x, to: [] }) });
// a step of the once-a-minute check that runs long says so in the log
const timedStep = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { const ms = Date.now() - t0; if (ms > 5000) console.warn(`[watchtower] slow step ${name}: ${Math.round(ms / 1000)}s`); } };
// Dispatch answers the stop email: everyone it went to hears who said what.
const stopReview = initStopReview(app, { db, secret: JWT_SECRET, send: async (ep, review) => {
  const to = await alertRecipients.resolve('team_stopped');
  if (!to.length) return;
  const item = ((await truckmate.buildBoard('florida-beauty')).trips || []).find((x) => String(((x && x.trip) || {}).tripNumber) === String(ep.trip)) || null;
  const a = { unit: ep.unit, trip: ep.trip, stoppedSinceMs: ep.stoppedSinceMs, stopStartUnknown: ep.stopStartUnknown };
  const yes = review.status === 'authorized';
  const attachments = await truckMap((item && item._samsara) || {}, yes ? 'green' : 'red', stopBadge(a));
  const m = renderStopReviewEmail({ a, item, review, subject: `Re: ${stopSubject({ unit: ep.unit, trip: ep.trip, title: ep.title })}`, etas: item ? (await allEtas())[ep.trip] || null : null, showPhones: to.every((e) => /@floridabeauty\.us$/i.test(e)), mapCid: attachments.length ? 'truckmap' : null });
  await sendMail({ to, ...m, attachments }, { env: process.env });
} });
const breakdownReport = initBreakdownReport(app, { requireAuth: requireDispatch, storePhotos: async (trip, files, by) => {
    const saved = [];
    for (const f0 of files) { // eslint-disable-line no-await-in-loop
      const f = await readableFile({ dataBase64: f0.dataBase64, mediaType: f0.mediaType, filename: f0.filename }); // eslint-disable-line no-await-in-loop
      const [d] = await docs.storeDocs({ site: 'florida-beauty', kind: 'email', trip, files: [{ filename: f.filename || 'breakdown-photo.jpg', mediaType: f.mediaType, dataBase64: f.dataBase64 }], by }); // eslint-disable-line no-await-in-loop
      if (d) saved.push({ docId: String(d.id), name: String(f.filename || 'breakdown-photo.jpg').slice(0, 80) });
    }
    return saved;
  }, sendPhotos: (...a) => sendBreakdownPhotos(...a), textedPhotos, db, secret: JWT_SECRET, getBoard: (site) => truckmate.buildBoard(site), etasFor: async (trip) => (await allEtas())[trip] || null, otherHolds: async (r) => { const it = ((await truckmate.buildBoard('florida-beauty')).trips || []).find((x) => String(((x && x.trip) || {}).tripNumber) === String(r.trip)); const calls = ((roadCalls && await roadCalls.list()) || []).filter((rc) => !['completed', 'cancelled'].includes(rc.status) && Date.now() - Date.parse(rc.at) < 5 * 86400000 && (String(rc.trip) === String(r.trip) || String(rc.truck) === String(r.unit))); return !!(it && ((it._breakdown && it._breakdown.on) || (it._hold && it._hold.kind === 'breakdown'))) || calls.length > 0; }, fixedDetails: async (r, item) => {
    const to = await alertRecipients.resolve('breakdown_report');
    const live = (item && item._samsara) || await liveForUnit(r.unit).catch(() => null);
    const stopped = !live || live.speedMph == null || Number(live.speedMph) <= 3;
    const attachments = await truckMap(live || {}, 'amber', { close: stopped });
    const u = String(r.unit || '').trim().toLowerCase().replace(/^0+(?=\d)/, '');
    const others = Object.values(((await db.get('taWatch:florida-beauty', {})) || {}).alerts || {}).filter((a) => !a.resolvedAt && a.code !== 'stopped' && String(a.unit || '').trim().toLowerCase().replace(/^0+(?=\d)/, '') === u).map((a) => a.title).filter(Boolean);
    return { live, etas: (item && (await allEtas())[item.trip.tripNumber]) || null, showPhones: staffOnly(to), mapCid: attachments.length ? 'truckmap' : null, attachments, others };
  }, onTruckMateMove: ({ trip, from, to, board }) => transferDone.confirm({ trip, truck: from, toTruck: to, by: 'TruckMate', source: 'TruckMate', atMs: Date.now(), board }), sendChain: async (report, m) => { const to = await alertRecipients.resolve('breakdown_report'); if (to.length) await sendMail({ to, ...m }, { env: process.env, direct: staffOnly(to) }); }, send: async (report, item, extra = []) => { const to = [...new Set([...extra.map((x) => String(x).toLowerCase()).filter((x) => /@floridabeauty\.us$/.test(x)), ...await alertRecipients.resolve('breakdown_report')])]; if (to.length) await sendBreakdown(report, item, to); } });
// One of each alert email, to Nadim only, built from a real load with made-up stop details. Marked [EXAMPLE]. No alert, no road call,
// nothing saved, and nobody else: each goes straight to that one address.
// The delivery confirmation request and the reply it leads to, to Nadim only, from a real load. The button opens the real page; Submit there saves nothing.
app.post('/admin/confirm-example', requireCompanyAdmin, async (req, res) => {
  const me = 'ntellez@floridabeauty.us';
  try {
    const items = (await truckmate.buildBoard('florida-beauty')).trips || [];
    const open = (it) => requestStops(it, {}).length;
    const want = String((req.body || {}).trip || '');
    const item = want ? items.find((it) => String(((it && it.trip) || {}).tripNumber) === want) : items.filter((it) => open(it) >= 2).find((it) => it._ratecon) || items.find((it) => open(it) >= 2) || items.find((it) => open(it) >= 1);
    if (!item) return res.status(404).json({ error: 'No load to use.' });
    const trip = String(item.trip.tripNumber);
    const stops = requestStops(item, {});
    const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const ask = askEmail(trip, item, { confirmUrl: brokerFollow.exampleLink(trip, 'Example') });
    const reply = confirmedReply(trip, item, stops.map((s, i) => ({ ...s, local: `${day}T${String(8 + i * 2).padStart(2, '0')}:00` })), 'Example (not a real confirmation)', [], { atMs: Date.now(), example: true });
    await sendMail({ ...ask, to: [me], subject: `[EXAMPLE] ${ask.subject}` }, { env: process.env, direct: true });
    await sendMail({ ...reply, to: [me], subject: `[EXAMPLE] Re: ${ask.subject}` }, { env: process.env, direct: true });
    return res.json({ ok: true, trip, truck: item.trip.powerUnit, stops: stops.length, sent: ['request', 'confirmed reply'] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
// The new-login email, to Nadim only. Made-up name and password: no account is created.
app.post('/admin/login-email-example', requireCompanyAdmin, async (req, res) => {
  try {
    const m = renderLoginEmail({ name: 'Example Employee', email: 'example.employee@floridabeauty.us', tempPassword: 'Example-Only-0000', url: `${process.env.APP_URL || 'https://mytagalong.app'}/truckmate?admin`, by: 'Nadim Tellez' });
    await sendMail({ to: ['ntellez@floridabeauty.us'], ...m, subject: `[EXAMPLE] ${m.subject}` }, { env: process.env, direct: true });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/admin/alert-examples', requireCompanyAdmin, async (req, res) => {
  const me = 'ntellez@floridabeauty.us';
  try {
    const board = await truckmate.buildBoard('florida-beauty');
    const items = board.trips || [];
    const want = String((req.body || {}).trip || '');
    const item = want ? items.find((it) => String(((it && it.trip) || {}).tripNumber) === want) : (items.find((it) => it._samsara && it._samsara.hos2 && it._samsara.lat != null && ((it._manifest && it._manifest.docIds) || []).length) || items.find((it) => it._samsara && it._samsara.lat != null));
    if (!item) return res.status(404).json({ error: 'No load to use.' });
    const t = item.trip || {}; const trip = String(t.tripNumber); const unit = t.powerUnit; const now = Date.now();
    const etas = (((await db.get('taWatch:florida-beauty', {})) || {}).etas || {})[trip] || null;
    const reason = 'Truck air leak';
    const stoppedSinceMs = now - 125 * 60000;
    const report0 = { atMs: now, by: 'Example (not a real report)', reason, trip, unit };
    const a = { id: 'example', unit, trip, severity: 'critical', title: 'Team truck stopped 2h 5m', stoppedSinceMs };
    const rollEp = { unit, trip, stoppedSinceMs, movingSince: now - 4 * 60000, speedMph: 58, confirmedAt: now };
    const map = await truckMap(item._samsara || {}, 'red', stopBadge(a));
    const brk = await truckMap(item._samsara || {}, 'red', reportBadge(report0));
    const green = await truckMap(item._samsara || {}, 'green', rollBadge(rollEp, now));
    const sheet = await sheetFor(item, trip);
    const mapCid = map.length ? 'truckmap' : null;
    const report = { ...report0, subject: breakdownSubject(item, reason, { unit, trip }) };
    const { subject } = report;
    const next = (etas && etas.stops && etas.stops[0]) || { label: t.destZoneDesc || 'the next stop', etaMs: now + 7 * 3600000, miles: 300 };
    const pos = { location: (item._samsara || {}).location, speedMph: 58, lat: (item._samsara || {}).lat, lng: (item._samsara || {}).lng, at: new Date(now).toISOString() };
    const pos2 = { ...pos, lat: pos.lat != null ? pos.lat + 0.4 : null };
    // the receiving truck in the examples: another truck on the board, standing in, with made-up confirmation details
    const other = items.find((x) => x !== item && x._samsara && x._samsara.driver1 && x.trip && x.trip.powerUnit) || null;
    const to = other ? String(other.trip.powerUnit) : '0000';
    const plan = { trip, from: String(unit), to, trailer: t.trailer || null };
    const exampleSpot = pos.lat != null ? { label: 'Example location (made up)', lat: pos.lat + 0.2, lng: pos.lng, aMi: 14, bMi: 14 } : null;
    const transferJpg = await renderTransferMap({ trucks: [{ lat: pos.lat, lng: pos.lng, label: `Truck ${unit}`, miles: 14 }, { lat: pos2.lat, lng: pos2.lng, label: `Truck ${to}`, miles: 14 }], spot: exampleSpot });
    const ck = (u) => String(u || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();
    const handoff = { trip, from: String(unit), to, before: snapshotLoad(item, etas, now - 3600000), crew: { [ck(unit)]: crewOf(item, now - 3600000), ...(other ? { [ck(to)]: crewOf(other, now - 3600000) } : {}) }, confirm: { by: 'TruckMate', source: 'TruckMate', atMs: now - 20 * 60000 } };
    const handedOver = { ...item, trip: { ...t, powerUnit: to, driver: other && other.trip.driver, driver2: other && other.trip.driver2 }, _samsara: other ? other._samsara : {} };
    const greenPlain = await truckMap(item._samsara || {}, 'green');
    const amberMap = await truckMap(item._samsara || {}, 'amber', { close: true });
    const fixedReport = { ...report, atMs: now - 6 * 3600000, fixedAt: now - 3600000, fixedBy: 'Example (not a real report)', repair: 'Replaced air line (example)', provider: 'Example truck service', before: snapshotLoad(item, etas, now) };
    const late = lateMessage(item, { key: 'x', place: next.label, customer: null, local: new Date(next.etaMs - 3 * 3600000).toISOString().slice(0, 16), atMs: next.etaMs - 3 * 3600000, etaMs: next.etaMs, lateMin: 180, miles: next.miles });
    const list = [
      ['team truck stopped', { ...renderTeamStopEmail(teamStopFacts(a, item, { etas, mapCid, sheet, reportUrl: 'https://tagalong-backend-fdzx.onrender.com/br/example' })), attachments: [...map, ...sheet.attachments] }],
      ['truck rolling again', { ...renderRollingEmail(rollEp, item, { etas, now, mapCid: green.length ? 'truckmap' : null }), attachments: green }],
      ['breakdown', { ...renderBreakdownEmail({ item, report, etas, mapCid, sheetNote: sheet.note, sheetAttached: sheet.status === 'attached' }), attachments: [...brk, ...sheet.attachments] }],
      ['rescue planned', { ...transferEmail('start', plan, pos, pos2, transferStatus(pos, pos2), { now, spot: exampleSpot, mapCid: transferJpg ? 'transfermap' : null }), subject: `Re: ${subject}`, attachments: transferJpg ? [{ name: 'transfer-map.jpg', contentType: 'image/jpeg', bytes: transferJpg, cid: 'transfermap' }] : [] }],
      ['transfer update', { ...transferEmail('update', plan, pos, pos2, transferStatus(pos, pos2), { now, spot: exampleSpot, mapCid: transferJpg ? 'transfermap' : null }), subject: `Re: ${subject}`, attachments: transferJpg ? [{ name: 'transfer-map.jpg', contentType: 'image/jpeg', bytes: transferJpg, cid: 'transfermap' }] : [] }],
      ['trucks together', { ...transferEmail('together', plan, pos, pos, transferStatus(pos, pos), { now }), subject: `Re: ${subject}` }],
      ['transfer not done yet', { ...transferEmail('outcome', plan, pos, pos2, transferStatus(pos, pos2), { now, outcome: { status: 'not_done', summary: 'Driver replied: "no, not yet" (example)', source: 'driver text' } }), subject: `Re: ${subject}` }],
      ['transfer not confirmed', { ...transferEmail('outcome', plan, pos, pos2, transferStatus(pos, pos2), { now, outcome: { status: 'unclear', summary: 'Driver replied: "ya voy" (example)', source: 'driver text' } }), subject: `Re: ${subject}` }],
      ['transfer completed', { ...renderTransferCompletedEmail(handoffFacts(handoff, handedOver, { etas, now })), subject: `Re: ${subject}` }],
      ['transfer reversed', renderTransferReversedEmail({ trip, from: String(unit), to, by: 'Example', subject: `Re: ${subject}` })],
      ['breakdown reported fixed', { ...renderFixedReportedEmail({ report: fixedReport, item, etas, now, mapCid: amberMap.length ? 'truckmap' : null, subject: `Re: ${subject}` }), attachments: amberMap }],
      ['breakdown fixed & rolling', { ...renderFixedRollingEmail({ ep: { ...rollEp, live: item._samsara, alertsOn: true, openAlerts: [] }, report: fixedReport, item, etas, now, mapCid: greenPlain.length ? 'truckmap' : null }), subject: `Re: ${subject}`, attachments: greenPlain }],
      ['broker follow-up question', askEmail(trip, item)],
      ['broker will miss delivery', { subject: late.subject.replace(/^Late for a committed time/, 'Will miss the delivery time'), html: late.html, text: late.text }],
    ];
    const sent = [];
    for (const [name, m] of list) {
      await sendMail({ ...m, to: [me], subject: `[EXAMPLE] ${m.subject}` }, { env: process.env, direct: true }); // eslint-disable-line no-await-in-loop
      sent.push(name);
    }
    return res.json({ ok: true, trip, truck: unit, sent, map: !!mapCid, sheet: sheet.note });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
// one example of the breakdown email, to Nadim only: no road call, nothing saved, nobody else
app.post('/admin/breakdown-report/example', requireCompanyAdmin, async (req, res) => {
  try {
    const trip = String((req.body || {}).trip || '');
    const item = ((await truckmate.buildBoard('florida-beauty')).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === trip);
    if (!item) return res.status(404).json({ error: 'That trip is not on the board.' });
    const t = item.trip || {};
    const subject = await sendBreakdown({ atMs: Date.now(), by: 'Example (not a real report)', reason: String((req.body || {}).reason || 'Truck air leak').slice(0, 200), trip, unit: t.powerUnit }, item, ['ntellez@floridabeauty.us']);
    res.json({ ok: true, subject });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// company drivers sign in with their driver ID and cell; the roster is Samsara's drivers (driverauth.js)
const driverAuth = initDriverAuth(app, { requireAuth, requireAdmin: requireCompanyAdmin, secret: JWT_SECRET, db, push, training, unreadFor: (site, trip) => driverLinks.unread(site, trip), sign: (u, exp) => jwt.sign(u, JWT_SECRET, { expiresIn: exp }), getBoard: (site) => truckmate.buildBoard(site), docsLink: (site, trip, by) => driverLinks.ensureDocsLink(site, trip, by), sheets: loadSheets, stopFlow,
  roster: async () => { const token = samsaraTokenFrom(process.env); const idx = token ? await getLiveIndex(token) : null; return Object.entries((idx && idx.driversByCode) || {}).map(([code, d]) => ({ code, name: d.name, phone: d.info && d.info.phone })).filter((d) => d.phone); } });
// a dispatch message on a load reaches the driver profile's phones too (driverauth.js)
driverLinks.onDispatchMessage((site, trip, text, by) => driverAuth.notifyTrip(trip, text, by));
// Phone & Messages: one shared inbox for texts on the company line and driver-app messages
const messagesInbox = initMessages(app, { requireAuth: requireDispatch, db, getBoard: (site) => truckmate.buildBoard(site), activity, ringcentral: rc, driverLinks, comms, staff: async () => (await directory.load()).people || [], drivers: () => driverAuth.roster(), docs });
comms.useInbox(messagesInbox);
initWatchtower(app, { requireAuth: requireDispatch, db, env: process.env, buildBoard: truckmate.buildBoard, push, pushRules, atStopNow: async () => (waiting ? waiting.openTrips() : new Set()),
  // trucks and trips reported down, or with a road call still open in the last 5 days: a wrecker moves them, they aren't rolling
  openRoadCalls: async () => [...await breakdownReport.held(), ...((roadCalls && await roadCalls.list()) || []).filter((rc) => !['completed', 'cancelled'].includes(rc.status) && Date.now() - Date.parse(rc.at) < 5 * 86400000).flatMap((rc) => [rc.trip, String(rc.truck || '').trim().toLowerCase().replace(/^0+(?=\d)/, '')].filter(Boolean).map(String))],
  recovering: () => breakdownReport.fixedWaiting(),
  liveFor: (unit) => liveForUnit(unit),
  onRolling: async (ep, { item, etas }) => {
    // reported fixed and now really moving: the one "fixed & rolling" email for this breakdown, in place of the plain rolling one
    const fixedReport = await breakdownReport.recoveryFor(ep.unit).catch(() => null);
    if (fixedReport) {
      if (!await breakdownReport.claimRecovery(fixedReport.key)) return;
      try {
        const to = await alertRecipients.resolve('breakdown_report');
        if (!to.length) throw new Error('no recipients');
        const attachments = await truckMap(ep.live || (item && item._samsara) || {}, 'green');
        const m = renderFixedRollingEmail({ ep, report: fixedReport, item, etas, now: ep.confirmedAt, showPhones: staffOnly(to), mapCid: attachments.length ? 'truckmap' : null });
        await sendMail({ to, ...m, ...(fixedReport.subject ? { subject: `Re: ${fixedReport.subject}` } : {}), attachments }, { env: process.env, direct: staffOnly(to) });
      } catch (e) { await breakdownReport.releaseRecovery(fixedReport.key); throw e; }
      return;
    }
    const chain = await breakdownReport.forTrip(ep.trip).catch(() => null);   // a reported breakdown: stay on that email chain, with the same people
    const to = await alertRecipients.resolve(chain ? 'breakdown_report' : 'team_stopped');
    if (!to.length) return;
    const attachments = await truckMap(ep.live || (item && item._samsara) || {}, 'green', rollBadge(ep, ep.confirmedAt));
    const m = renderRollingEmail(ep, item, { etas, now: ep.confirmedAt, showPhones: to.every((e) => /@floridabeauty\.us$/i.test(e)), mapCid: attachments.length ? 'truckmap' : null, note: chain && !chain.fixedAt ? `No repair has been reported for this breakdown.${chain.transferredTo ? ` Trip ${chain.trip} moved to truck ${chain.transferredTo}.` : ''}` : ep.review && ep.review.status === 'authorized' ? `This stop was authorized by ${ep.review.by}: ${ep.review.reason}` : null });
    await sendMail({ to, ...m, ...(chain && chain.subject ? { subject: `Re: ${chain.subject}` } : {}), attachments }, { env: process.env, direct: !!chain && staffOnly(to) });
  },
  onStopSolved: async (a, by, note, user) => {
    // the signature: the name on the Employees list, not the short login name
    const mail = String((user && user.email) || '').toLowerCase();
    const person = mail ? ((await directory.load().catch(() => ({ people: [] }))).people || []).find((p) => p && String(p.email || '').toLowerCase() === mail) : null;
    return stopReview.decide({ unit: a.unit, trip: a.trip, startAt: a.stoppedSinceMs, title: a.title, status: 'authorized', reason: note, by: (person && person.name) || by, email: mail || null, source: 'console' });
  },
  onTeamStop: async (a, { item, etas }) => {
    const driverCheck = await stopCheck.forStop(a, item).catch((e) => { console.warn('[stop-check]', e.message); return null; });
    await sendStopEmail(a, { item, etas, driverCheck });
  }, afterBoard: async (site, board, ctx) => { await timedStep('rateConFlow.process', () => rateConFlow.process(site, board)).catch((e) => console.warn('[rate-con flow]', e.message)); await timedStep('transferDone.observe', () => transferDone.observe(board)).catch((e) => console.warn('[transfer-done]', e.message)); await timedStep('breakdownReport.process', () => breakdownReport.process(site, board)).catch((e) => console.warn('[breakdown-report]', e.message)); await timedStep('followProxy.process', () => followProxy.process(site, board)).catch((e) => console.warn('[broker-follow]', e.message)); await timedStep('transferWatch.process', () => transferWatch.process(site, board, ctx)).catch((e) => console.warn('[transfer]', e.message)); await timedStep('transferDone.process', () => transferDone.process(board)).catch((e) => console.warn('[transfer-done]', e.message)); await timedStep('waiting.process', () => (waiting ? waiting.process(board) : null)).catch((e) => console.warn('[waiting-time]', e.message)); await timedStep('stopCheck.process', () => stopCheck.process(board)).catch((e) => console.warn('[stop-check]', e.message)); await timedStep('stopTasks.process', () => stopTasks.process(site, board)).catch((e) => console.warn('[stop-tasks]', e.message)); await timedStep('commitments.process', () => commitments.process(site, board)).catch((e) => console.warn('[commit]', e.message)); await timedStep('etaReport.process', () => etaReport.process(site, board)).catch((e) => console.warn('[eta-log]', e.message)); await timedStep('stopVisits.process', () => stopVisits.process(site, board)); await timedStep('milestones.process', () => milestones.process(site, board, ctx)); await timedStep('statusMail.process', () => statusMail.process(site, board, ctx)); await timedStep('etaWatch.run', () => etaWatch.run({ items: board.trips || [], geo: ctx.geo, now: ctx.now })); await timedStep('follow.run', () => follow.run(site, board.trips || [])); await timedStep('callAhead.process', () => callAhead.process(site, board)).catch((e) => console.warn('[call-ahead]', e.message)); } });
staffActions = initStaffActions({ breakdown: breakdownReport, stopReview, docs, getBoard: (site) => truckmate.buildBoard(site) });
initAudit(app, { db, requireAdmin: requireCompanyAdmin });
initJarvisRequests(app, { requireAuth: requireDispatch, db, docs, env: process.env, sendMail: (m) => sendMail(m, { env: process.env, direct: true, noCopy: true }), phoneOf: async (email) => (((await directory.load()).people || []).find((p) => p && String(p.email || '').toLowerCase() === email) || {}).phone || null });
// waiting time at a stop: the emails to dispatch, with the map and the load (waitingtime.js)
const sendWaiting = async (kind, r, item, reviewUrl, to, { example = false } = {}) => {
  if (!to.length) return;
  const attachments = await truckMap((item && item._samsara) || {}, kind === 'start' ? 'amber' : kind === 'decided' ? (r.status === 'approved' ? 'green' : 'red') : 'blue', { close: true });
  const m = renderWaitingEmail(kind, r, { item, rows: loadRows(item || { trip: { powerUnit: r.unit, tripNumber: r.trip, trailer: r.trailer } }), etas: item ? (await allEtas())[r.trip] || null : null, reviewUrl, showPhones: staffOnly(to), mapCid: attachments.length ? 'truckmap' : null, example });
  await sendInThread({ to, ...m, attachments }, kind === 'decided' ? m.subject.replace(/^Re: /, '') : null, { env: process.env, direct: staffOnly(to) });
};
waiting = initWaitingTime(app, { db, secret: JWT_SECRET, etas: allEtas, getBoard: () => truckmate.buildBoard('florida-beauty'), recipients: () => alertRecipients.resolve('waiting_time'), send: (kind, r, item, url, to) => sendWaiting(kind, r, item, url, to) });
// Both waiting time emails, to Nadim only, built from a real load with made-up times. Marked [EXAMPLE]: nothing is saved.
app.post('/admin/waiting-example', requireCompanyAdmin, async (req, res) => {
  try {
    const item = ((await truckmate.buildBoard('florida-beauty')).trips || []).find((it) => it && brokerLoad(it) && it._samsara && it._samsara.lat != null) || null;
    if (!item) return res.status(409).json({ error: 'No broker load with a location right now.' });
    const t = item.trip; const now = Date.now(); const H = 3600000;
    const r = { key: 'example', trip: String(t.tripNumber), unit: t.powerUnit, trailer: t.trailer, kind: 'receiver', stop: 'Example Receiver, Sample City, CA', arrivedMs: now - 5 * H, apptMs: now - 3 * H, startMs: now, status: 'open' };
    const to = ['ntellez@floridabeauty.us'];
    await sendWaiting('start', r, item, waiting.link(r, true), to, { example: true });
    await sendWaiting('total', { ...r, arrivedMs: now - 7 * H, apptMs: now - 5.5 * H, startMs: now - 2.5 * H, leftMs: now, waitedMs: 2.5 * H, status: 'approved', decidedBy: 'Example Dispatcher', decidedAt: now - 2.4 * H }, item, null, to, { example: true });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
initCarChat(app, { requireAuth, env: process.env });

// Customer call-ahead. SMS prefers RingCentral (the company's own number) and
// falls back to Twilio. DRY-RUN until NOTIFY_ALLOW_SEND=true — see notify.js.
// a fleet account uses its own texting setup, never the company's number
initNotify(app, { requireAuth: chain(requireAuth, allowRoles('fleet')), db, pool: db.pool, env: process.env, ringcentral: { ...rc, configFor: async (o) => ((await rc.hasOwnConfig(o)) ? rc.configFor(o) : null), sendSms: async (o, m) => { if (!(await rc.hasOwnConfig(o))) throw new Error('Set up your own texting first.'); return rc.sendSms(o, m); } } });

// Dynamic BPO campaign portal — live call workspace (claims + per-lead updates).
initDbpo(app, { db, requireAuth: requireAdmin });

// AI dispatcher — read uploaded rate confirmations (broker instructions).

app.get('/', (_req, res) => res.send('TagAlong backend is running.'));
// dispatchers' RingCentral calls: recorded by RingCentral, transcribed and summarized here, filed in Calls & texts and on the load (calltranscripts.js)
// Jarvis presses Record on every answered dispatch call (RingCentral's automatic recording isn't recording them) (autorecord.js)
const autoRecord = initAutoRecord(app, { rc, db, secret: JWT_SECRET, publicUrl: process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_API_URL || 'https://tagalong-backend-fdzx.onrender.com' });
const callTranscripts = initCallTranscripts(app, { requireAuth: requireDispatch, db, rc, autoRecord, activity, log: (...a) => comms.log(...a), secret: JWT_SECRET, publicUrl: process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_API_URL || 'https://tagalong-backend-fdzx.onrender.com', getBoard: (site) => truckmate.buildBoard(site) });
activity.useRecordingLink((r) => callTranscripts.link(r));
// the console's own phone: each dispatcher's RingCentral line, our call bar (phone.js)
const phoneLines = initPhone(app, { requireAuth: requireDispatch, db, secret: JWT_SECRET, clientId: process.env.RC_EMBEDDABLE_CLIENT_ID, activity, autoRecord });
// the Phone tab shows a dispatcher only their own line's calls (managers see everyone's)
callTranscripts.useLineOf(phoneLines.lineOf);

app.listen(PORT, () => console.log(`TagAlong backend on :${PORT} — origins: ${origins.join(', ')}`));

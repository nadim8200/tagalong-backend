// ---------------------------------------------------------------
// Incoming texts the moment they arrive (Nov 20, 2026): RingCentral calls our webhook for every text on the company line, and
// the webhook starts the normal check right away (comms.js pollReplies) — the same handling, the same skip-what-we've-seen by
// message id. The 15-second check stays on as the backup (a deploy, a restart, RingCentral pausing the webhook).
//   · the webhook: POST /ringcentral/sms-hook — answers RingCentral's validation handshake; every event must carry our secret
//     verification token (made here, never shared), anything else is refused
//   · the registration (RingCentral "subscription"): made on start, checked every 6 hours, renewed before it expires, made again
//     if RingCentral dropped or paused it. Admins can see it: GET /admin/sms-hook
// ---------------------------------------------------------------
import { randomBytes } from 'node:crypto';

const KEY = 'taRcSmsHook';
export const HOOK_PATH = '/ringcentral/sms-hook';
export const FILTER = '/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS';
const DAY = 86400000;

// What to do with the registration we have: keep it, renew it, or make a new one. Pure.
export function plan(sub, now = Date.now()) {
  if (!sub || !sub.id) return 'create';
  const status = String(sub.status || '').toLowerCase();
  if (status && status !== 'active') return 'create';            // Blacklisted / Suspended: RingCentral stopped sending
  const exp = Date.parse(sub.expirationTime || sub.expiresAt || '');
  if (Number.isNaN(exp) || exp - now < 3 * DAY) return 'renew';
  return 'keep';
}
// Is this webhook event an incoming text? (the instant SMS feed sends each message) Pure.
export function isIncoming(payload) {
  const m = (payload && payload.body) || {};
  return !m.direction || String(m.direction).toLowerCase() === 'inbound';
}

export function initSmsHook(app, { db, ringcentral, onText, requireAuth = null, env = process.env, owner = '__shared', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled && ringcentral && ringcentral.api);
  const address = `${String(env.BACKEND_URL || 'https://tagalong-backend-fdzx.onrender.com').replace(/\/+$/, '')}${HOOK_PATH}`;

  app.post(HOOK_PATH, async (req, res) => {
    const validation = req.get('Validation-Token');
    if (validation) { res.set('Validation-Token', validation); return res.status(200).end(); }   // RingCentral checking the address
    const st = enabled ? (await db.get(KEY, {})) || {} : {};
    if (!st.token || req.get('Verification-Token') !== st.token) return res.status(401).end();
    res.status(200).end();
    if (isIncoming(req.body)) Promise.resolve().then(onText).catch((e) => console.warn('[sms-hook] check:', e.message));
    return undefined;
  });

  async function create() {
    const token = randomBytes(16).toString('hex');   // 32 characters: RingCentral refused 48 ("verificationToken value is invalid")
    await db.update(KEY, (cur) => ({ ...(cur || {}), token }), {});   // stored first: events can arrive as soon as it exists
    const s = await ringcentral.api(owner, '/restapi/v1.0/subscription', { method: 'POST', body: JSON.stringify({
      eventFilters: [FILTER], deliveryMode: { transportType: 'WebHook', address, verificationToken: token }, expiresIn: 30 * 86400 }) });
    await db.set(KEY, { id: s.id, token, status: s.status || 'Active', expiresAt: s.expirationTime || null, address, at: new Date(now()).toISOString() });
    console.log(`[sms-hook] registered ${s.id} → ${address} (until ${s.expirationTime})`);
    return 'created';
  }
  // keep the registration alive → 'kept' | 'renewed' | 'created' | 'skipped'
  async function ensure() {
    if (!enabled) return 'skipped';
    const cfg = ringcentral.configFor ? await ringcentral.configFor(owner).catch(() => null) : null;
    if (!cfg || !cfg.fromNumber) return 'skipped';                // texting isn't set up on the company line
    const st = (await db.get(KEY, {})) || {};
    let sub = null;
    if (st.id) { try { sub = await ringcentral.api(owner, `/restapi/v1.0/subscription/${encodeURIComponent(st.id)}`); } catch { sub = null; } }
    const step = plan(sub && { ...sub, id: sub.id || st.id }, now());
    if (step === 'keep') { await db.set(KEY, { ...st, status: sub.status, expiresAt: sub.expirationTime, checkedAt: new Date(now()).toISOString() }); return 'kept'; }
    if (step === 'renew') {
      try {
        const r = await ringcentral.api(owner, `/restapi/v1.0/subscription/${encodeURIComponent(st.id)}/renew`, { method: 'POST' });
        await db.set(KEY, { ...st, status: r.status || 'Active', expiresAt: r.expirationTime || null, checkedAt: new Date(now()).toISOString() });
        return 'renewed';
      } catch (e) { console.warn('[sms-hook] renew failed, registering again:', e.message); }
    }
    return create();
  }
  // ensure, keeping RingCentral's answer when it says no (shown at GET /admin/sms-hook) → the step or 'failed'
  async function tryEnsure() {
    try { const step = await ensure(); if (step !== 'skipped') await db.update(KEY, (cur) => { const a = { ...(cur || {}) }; delete a.lastError; return a; }, {}); return step; }
    catch (e) { console.warn('[sms-hook]', e.message); if (enabled) await db.update(KEY, (cur) => ({ ...(cur || {}), lastError: String(e.message).slice(0, 300), lastErrorAt: new Date(now()).toISOString() }), {}).catch(() => {}); return 'failed'; }
  }
  if (enabled && env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    const run = () => tryEnsure();
    setTimeout(run, 45000).unref?.();
    setInterval(run, 6 * 3600000).unref?.();
  }
  if (requireAuth) {
    app.get('/admin/sms-hook', requireAuth, async (req, res) => {
      const u = req.user || {}; if (!(u.admin || u.role === 'admin')) return res.status(403).json({ error: 'Admins only.' });
      const { token, ...st } = (enabled ? (await db.get(KEY, {})) : {}) || {};   // the secret never leaves the server
      res.json({ ...st, hasToken: !!token, address });
    });
    // admins: register / renew now instead of waiting for the next 6-hour check
    app.post('/admin/sms-hook/retry', requireAuth, async (req, res) => {
      const u = req.user || {}; if (!(u.admin || u.role === 'admin')) return res.status(403).json({ error: 'Admins only.' });
      const step = await tryEnsure();
      const { token, ...st } = (enabled ? (await db.get(KEY, {})) : {}) || {};
      res.json({ step, ...st, hasToken: !!token, address });
    });
  }
  return { ensure, tryEnsure, address };
}

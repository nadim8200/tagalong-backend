// ---------------------------------------------------------------
// Jarvis presses Record on every dispatch call. RingCentral's automatic recording isn't recording the account's calls, so the server
// does it through the Call Control API: RingCentral tells us (a webhook on the account's telephony sessions) the moment a call is
// answered on one of our extensions — in or out, from the console phone, the RingCentral app or a desk phone — and we start an
// on-demand recording on it (RingCentral plays its "this call is being recorded" notice). Needs On-demand Call Recording on in the
// Admin Portal and the "Call Control" + "Webhook Subscriptions" permissions on the server's RingCentral app. The recording then
// lands in the call log like any other, and calltranscripts.js turns it into a transcript on the load. AUTO_RECORD=off stops it.
// ---------------------------------------------------------------
import { createHmac, timingSafeEqual } from 'node:crypto';

const RC_SERVER = 'https://platform.ringcentral.com';
const LOG = 'taAutoRecord';               // [{ at, session, ok, error }] newest first
const FILTER = '/restapi/v1.0/account/~/telephony/sessions';
const PATH = '/ringcentral/webhook/telephony';
const MIN = 60000;

// The token RingCentral sends back on every webhook, so nobody else can post calls to us. Pure.
export const hookToken = (secret) => createHmac('sha256', `${secret}:rc-telephony-webhook`).update('v1').digest('hex').slice(0, 32);
const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };

// From one telephony-session event: the party to record — one of our extensions, answered, not being recorded yet. Pure. → { session, party } or null
export function toRecord(evt) {
  const b = (evt && evt.body) || {};
  const session = b.telephonySessionId;
  if (!session) return null;
  const parties = Array.isArray(b.parties) ? b.parties : [];
  if (parties.some((p) => (p.recordings || []).some((r) => r && r.active))) return null;
  // ours = a party on one of the account's extensions (RingCentral puts it on the party, or under its owner)
  const ext = (x) => x.extensionId || (x.owner && x.owner.extensionId) || null;
  const p = parties.find((x) => x && x.id && ext(x) && x.status && x.status.code === 'Answered');
  return p ? { session: String(session), party: String(p.id), direction: p.direction || null } : null;
}

export function initAutoRecord(app, { rc = null, db = null, secret, publicUrl, env = process.env, fetchFn = fetch, now = () => Date.now(), start = true }) {
  const off = () => String(env.AUTO_RECORD || '').toLowerCase() === 'off';
  const address = `${publicUrl}${PATH}`;
  const token = hookToken(secret);
  const started = new Map();              // telephony session → when we pressed Record (one press per call)
  const state = { subscription: null, expiresAt: null, lastEvent: null, lastError: null, started: 0 };

  async function rcCall(path, init = {}) {
    const cfg = await rc.configFor('__shared');
    const r = await fetchFn(`${(cfg && cfg.server) || RC_SERVER}${path}`, { ...init, headers: { Authorization: `Bearer ${await rc.accessToken('__shared')}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j && (j.message || (j.errors && j.errors[0] && j.errors[0].message))) || `RingCentral ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  const note = async (rec) => { if (db && db.enabled) await db.update(LOG, (cur) => [rec, ...(Array.isArray(cur) ? cur : [])].slice(0, 200), []).catch(() => {}); };

  async function press(t) {
    if (started.has(t.session)) return;
    started.set(t.session, now());
    for (const [k, at] of started) if (now() - at > 6 * 3600000) started.delete(k);
    try {
      await rcCall(`/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(t.session)}/parties/${encodeURIComponent(t.party)}/recordings`, { method: 'POST' });
      state.started += 1; state.lastError = null;
      await note({ at: new Date(now()).toISOString(), session: t.session, direction: t.direction, ok: true });
    } catch (e) {
      // a call RingCentral is already recording isn't a problem
      if (e.status === 409) return;
      state.lastError = /403|permission|forbid/i.test(`${e.status} ${e.message}`) ? `RingCentral refused to start the recording (${e.message}). Check On-demand Call Recording is on and the app has Call Control.` : e.message;
      await note({ at: new Date(now()).toISOString(), session: t.session, ok: false, error: e.message });
    }
  }

  // RingCentral → us: a call changed state. Answer fast; press Record after.
  app.post(PATH, (req, res) => {
    const v = req.headers && (req.headers['validation-token'] || req.headers['Validation-Token']);
    if (v) { res.set('Validation-Token', v); return res.status(200).end(); }      // RingCentral checking the address when we subscribe
    if (!same(req.headers && req.headers['verification-token'], token)) return res.status(403).end();
    res.status(200).end();
    state.lastEvent = new Date(now()).toISOString();
    // the shape of the last few events (no numbers or names), to see why a call wasn't recorded
    const b = (req.body && req.body.body) || {};
    state.recent = [{ at: state.lastEvent, session: !!b.telephonySessionId, parties: (Array.isArray(b.parties) ? b.parties : []).map((x) => ({ id: !!(x && x.id), ext: !!(x && (x.extensionId || (x.owner && x.owner.extensionId))), keys: Object.keys(x || {}).slice(0, 20), status: x && x.status && x.status.code, direction: x && x.direction })) }, ...(state.recent || [])].slice(0, 6);
    if (off() || !rc) return undefined;
    const t = toRecord(req.body);
    if (t) press(t).catch(() => {});
    return undefined;
  });

  // keep our subscription to the account's calls alive (RingCentral ends it after a week unless renewed)
  async function ensure() {
    if (off() || !rc || !publicUrl) return state;
    try {
      const list = (await rcCall('/restapi/v1.0/subscription')).records || [];
      const mine = list.find((s) => s && s.deliveryMode && s.deliveryMode.address === address);
      const fresh = mine && mine.status === 'Active' && Date.parse(mine.expirationTime) - now() > 2 * 86400000;
      const sub = fresh ? mine : mine && mine.status === 'Active'
        ? await rcCall(`/restapi/v1.0/subscription/${mine.id}/renew`, { method: 'POST' })
        : await rcCall('/restapi/v1.0/subscription', { method: 'POST', body: JSON.stringify({ eventFilters: [FILTER], deliveryMode: { transportType: 'WebHook', address, verificationToken: token }, expiresIn: 604800 }) });
      if (mine && mine.status !== 'Active') await rcCall(`/restapi/v1.0/subscription/${mine.id}`, { method: 'DELETE' }).catch(() => {});
      Object.assign(state, { subscription: sub.id, expiresAt: sub.expirationTime || null, lastError: null });
    } catch (e) {
      state.lastError = /403|permission|forbid|scope/i.test(`${e.status} ${e.message}`) ? `RingCentral refused the call notifications (${e.message}). The server's RingCentral app needs "Webhook Subscriptions".` : e.message;
    }
    return state;
  }

  if (start && rc && !off()) { setTimeout(() => { ensure().catch(() => {}); }, 30000).unref(); setInterval(() => { ensure().catch(() => {}); }, 6 * 3600000).unref(); }
  return { ensure, press, status: () => ({ on: !off() && !!rc, subscribed: !!state.subscription, expiresAt: state.expiresAt, lastEvent: state.lastEvent, started: state.started, lastError: state.lastError, recent: state.recent || [] }) };
}

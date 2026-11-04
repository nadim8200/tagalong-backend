// ---------------------------------------------------------------
// The console's own phone (our call bar, not RingCentral's). RingCentral is the line underneath: each dispatcher connects their
// RingCentral login once (a sign-in window from RingCentral), the server trades it for that extension's calling credentials
// (SIP registration for RingCentral's Web Phone SDK), keeps them encrypted, and hands them only to that dispatcher's console. The
// RingCentral tokens stay encrypted on the server for conference control. Calls go out from the company number when the extension may use it.
// Also: who a number is (driver and their load, customer, broker, our team) for the call bar.
// ---------------------------------------------------------------
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const KEY = 'taPhoneSip';                 // staff user id → { enc, ext, name, callerId, at }
const RC_SERVER = 'https://platform.ringcentral.com';
const keyOf = (secret) => createHash('sha256').update(`${secret}:phone-sip`).digest();
export const seal = (obj, secret) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', keyOf(secret), iv); const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${d.toString('base64')}`; };
export const open = (enc, secret) => { const [iv, tag, d] = String(enc || '').split('.').map((x) => Buffer.from(x, 'base64')); const c = createDecipheriv('aes-256-gcm', keyOf(secret), iv); c.setAuthTag(tag); return JSON.parse(Buffer.concat([c.update(d), c.final()]).toString('utf8')); };

// The number calls show: the company's main number when this extension may use it, else its own direct number. Pure.
export function pickCallerId(records = []) {
  const ok = records.filter((r) => r && r.phoneNumber && (r.features || []).includes('CallerId'));
  const main = ok.find((r) => r.usageType === 'MainCompanyNumber');
  const direct = ok.find((r) => r.usageType === 'DirectNumber');
  return ((main || direct || ok[0]) || {}).phoneNumber || null;
}

export function initPhone(app, { requireAuth, db, secret, clientId, activity = null, env = process.env, fetchFn = fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const server = env.RC_SERVER || RC_SERVER;
  const isStaff = (u) => !!(u && (u.admin || u.role === 'admin' || u.companyAdmin || u.role === 'dispatcher'));
  const uid = (req) => String((req.user && (req.user.id || req.user.email)) || '');
  const guard = (req, res) => { if (!isStaff(req.user)) { res.status(403).json({ error: 'Dispatch logins only.' }); return false; } if (!enabled) { res.status(503).json({ error: 'Not available right now.' }); return false; } return true; };

  // the dispatcher signed in to RingCentral in the window: code (+ the PKCE verifier their console made) → calling credentials
  app.post('/ringcentral/phone/connect', requireAuth, async (req, res) => {
    if (!guard(req, res)) return undefined;
    const b = req.body || {};
    req.body = { connecting: true };   // the activity log never keeps the sign-in code
    if (!clientId) return res.status(503).json({ error: 'The phone app isn\'t set up (RC_EMBEDDABLE_CLIENT_ID).' });
    if (!b.code || !b.codeVerifier || !b.redirectUri) return res.status(400).json({ error: 'Missing the RingCentral sign-in.' });
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(b.code), redirect_uri: String(b.redirectUri), client_id: clientId, code_verifier: String(b.codeVerifier) });
      const tr = await fetchFn(`${server}/restapi/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      const tok = await tr.json().catch(() => ({}));
      if (!tr.ok || !tok.access_token) return res.status(400).json({ error: tok.error_description || tok.message || 'RingCentral didn\'t accept the sign-in. Try again.' });
      const auth = { Authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };
      const sr = await fetchFn(`${server}/restapi/v1.0/client-info/sip-provision`, { method: 'POST', headers: auth, body: JSON.stringify({ sipInfo: [{ transport: 'WSS' }] }) });
      const sip = await sr.json().catch(() => ({}));
      if (!sr.ok || !sip.sipInfo || !sip.sipInfo[0]) return res.status(400).json({ error: (sip && sip.message) || 'RingCentral didn\'t give this login a phone line (needs VoIP Calling).' });
      const [me, nums] = await Promise.all([
        fetchFn(`${server}/restapi/v1.0/account/~/extension/~`, { headers: auth }).then((r) => r.json()).catch(() => ({})),
        fetchFn(`${server}/restapi/v1.0/account/~/extension/~/phone-number?perPage=100`, { headers: auth }).then((r) => r.json()).catch(() => ({})),
      ]);
      const rec = { enc: seal(sip.sipInfo[0], secret), oauth: seal({ access: tok.access_token, refresh: tok.refresh_token, expires: now() + (Number(tok.expires_in) || 3600) * 1000 }, secret), extensionId: String(me.id || ''), ext: me.extensionNumber || null, name: me.name || null, callerId: pickCallerId(nums.records || []), at: new Date(now()).toISOString() };
      await db.update(KEY, (cur) => ({ ...(cur || {}), [uid(req)]: rec }), {});
      return res.json({ ok: true, ext: rec.ext, name: rec.name, callerId: rec.callerId });
    } catch (e) { return res.status(502).json({ error: 'Could not reach RingCentral. Try again.' }); }
  });
  // this dispatcher's own calling credentials, for the phone in their console
  app.get('/ringcentral/phone/sip', requireAuth, async (req, res) => {
    if (!guard(req, res)) return undefined;
    const rec = ((await db.get(KEY, {})) || {})[uid(req)];
    if (!rec) return res.json({ connected: false, clientId: clientId || null });
    try { return res.json({ connected: true, sipInfo: open(rec.enc, secret), ext: rec.ext, name: rec.name, callerId: rec.callerId, conferenceReady: !!(rec.oauth && rec.extensionId) }); } catch { return res.json({ connected: false, clientId: clientId || null }); }
  });
  app.post('/ringcentral/phone/disconnect', requireAuth, async (req, res) => {
    if (!guard(req, res)) return undefined;
    const rec = ((await db.get(KEY, {})) || {})[uid(req)];
    await db.update(KEY, (cur) => { const all = { ...(cur || {}) }; delete all[uid(req)]; return all; }, {});
    // cancel the stored RingCentral sign-in at RingCentral too (the refresh token ends the whole sign-in), not only here
    let revoked = false;
    if (rec && rec.oauth && clientId) {
      try {
        const t = open(rec.oauth, secret);
        const r = await fetchFn(`${server}/restapi/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh || t.access, client_id: clientId }) });
        revoked = !!(r && r.ok);
      } catch { /* the line is disconnected here either way */ }
    }
    return res.json({ ok: true, revoked });
  });
  // Tokens never leave the server. Serialize refresh and conference actions per dispatcher.
  const locks = new Map();
  const serial = (id, fn) => { const prev = locks.get(id) || Promise.resolve(); const next = prev.catch(() => {}).then(fn); locks.set(id, next); return next.finally(() => { if (locks.get(id) === next) locks.delete(id); }); };
  const api = async (id, path, method = 'GET', body) => {
    const rec = ((await db.get(KEY, {})) || {})[id];
    if (!rec?.oauth || !rec.extensionId) throw new Error('Reconnect your phone line before using three-way calling.');
    let token = open(rec.oauth, secret);
    if (token.expires < now() + 60000) {
      if (!token.refresh) throw new Error('Reconnect your phone line to use three-way calling.');
      const r = await fetchFn(`${server}/restapi/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: clientId }) });
      const t = await r.json();
      if (!r.ok || !t.access_token) throw new Error('Reconnect your phone line to use three-way calling.');
      token = { access: t.access_token, refresh: t.refresh_token || token.refresh, expires: now() + (Number(t.expires_in) || 3600) * 1000 };
      await db.update(KEY, (cur) => cur?.[id] ? { ...cur, [id]: { ...cur[id], oauth: seal(token, secret) } } : cur, {});
    }
    const r = await fetchFn(`${server}/restapi/v1.0/account/~${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token.access}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 403 ? 'Your RingCentral line needs Call Control permission for three-way calls.' : 'RingCentral could not complete this conference action. Your remaining calls are still available.');
    return data;
  };
  const validId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(v);
  const owned = async (id, sessionId, partyId) => {
    const rec = ((await db.get(KEY, {})) || {})[id];
    const data = await api(id, `/telephony/sessions/${sessionId}`);
    const party = (data.parties || []).find((p) => String(p.id) === partyId);
    if (!party || String(party.extensionId) !== rec.extensionId) throw new Error('This call does not belong to your phone line.');
  };
  app.post('/ringcentral/phone/conference', requireAuth, async (req, res) => {
    if (!guard(req, res)) return;
    try { const data = await serial(uid(req), () => api(uid(req), '/telephony/conference', 'POST', {})); return res.json({ session: data.session }); }
    catch (e) { return res.status(409).json({ error: e.message }); }
  });
  app.post('/ringcentral/phone/conference/merge', requireAuth, async (req, res) => {
    if (!guard(req, res)) return;
    const { conferenceId, conferencePartyId, sessionId, partyId } = req.body || {};
    if (![conferenceId, conferencePartyId, sessionId, partyId].every(validId)) return res.status(400).json({ error: 'Missing call identifiers. Wait until both calls connect.' });
    try {
      await serial(uid(req), async () => {
        await owned(uid(req), conferenceId, conferencePartyId);
        await owned(uid(req), sessionId, partyId);
        await api(uid(req), `/telephony/sessions/${conferenceId}/parties/bring-in`, 'POST', { sessionId, partyId });
      });
      return res.json({ ok: true });
    } catch (e) { return res.status(409).json({ error: e.message }); }
  });
  // who's on the other end, for the call bar: name, what they are, and their load
  app.get('/truckmate/phone/who', requireAuth, async (req, res) => {
    if (!isStaff(req.user)) return res.status(403).json({ error: 'Dispatch logins only.' });
    const n = String((req.query || {}).n || '').replace(/\D/g, '');
    if (n.length < 10 || !activity || !activity.lookup) return res.json({ role: 'unknown' });
    try { const w = await activity.lookup(n); return res.json({ role: w.role || 'unknown', name: w.name || null, detail: w.detail || null, trips: w.trips || [] }); } catch { return res.json({ role: 'unknown' }); }
  });
  return {};
}

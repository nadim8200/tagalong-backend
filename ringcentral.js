// ---------------------------------------------------------------
// RingCentral — SMS from the company's own business number, plus call logging.
//
// WHY RINGCENTRAL RATHER THAN A GENERIC SMS PROVIDER
// A delivery text arriving from the number a receiver already has saved as
// "Florida Beauty" gets read. The same text from an unknown number looks like
// spam and gets ignored — which defeats the entire point of a call-ahead.
// If the company already pays for RingCentral, this also costs nothing extra.
//
// WHAT THIS DOES
//   1. Sends SMS through the company's existing RingCentral numbers.
//   2. Reads the call log, so "did anyone actually call this customer?" is
//      answered from records instead of someone's memory. That question is the
//      one that matters when a delivery goes wrong and nobody can say whether
//      the receiver was warned.
//
// WHAT IT DELIBERATELY DOESN'T DO
// Automated voice calls. RingCentral's RingOut connects two HUMANS — it rings
// your phone first, then bridges you to the customer. There's no way to play a
// message to an unattended call, so using it for automated call-ahead would
// mean a dispatcher's phone ringing every time. Unattended voice needs RingCX
// or Twilio; see notify.js.
//
// AUTH
// JWT flow (server-to-server): a JWT credential from the RingCentral console is
// exchanged for a short-lived access token. No user interaction, no refresh
// dance, and the credential stays server-side.
// ---------------------------------------------------------------

const RC_DEFAULT_SERVER = 'https://platform.ringcentral.com';

export function initRingCentral(app, { requireAuth, db, pool, env = process.env }) {
  const cfgKey = 'taRingCentral';

  // Access tokens last ~1 hour. Cache per company and refresh a minute early
  // rather than re-authenticating on every message.
  const tokenCache = new Map(); // owner → { token, expires }

  async function configFor(owner) {
    if (!db || !db.enabled) return null;
    const all = await db.get(cfgKey, {});
    return all[owner] || null;
  }

  async function accessToken(owner) {
    const cached = tokenCache.get(owner);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;

    const cfg = await configFor(owner);
    if (!cfg || !cfg.clientId || !cfg.clientSecret || !cfg.jwt) {
      throw new Error('RingCentral not configured for this account.');
    }
    const server = cfg.server || RC_DEFAULT_SERVER;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const r = await fetch(`${server}/restapi/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: cfg.jwt,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`RingCentral auth failed (${r.status}): ${j.error_description || j.error || 'unknown'}`);
    }
    const token = j.access_token;
    tokenCache.set(owner, { token, expires: Date.now() + (j.expires_in || 3600) * 1000 });
    return token;
  }

  async function rcFetch(owner, path, init = {}) {
    const cfg = await configFor(owner);
    const server = (cfg && cfg.server) || RC_DEFAULT_SERVER;
    const token = await accessToken(owner);
    const r = await fetch(`${server}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (body.message || body.error_description || `HTTP ${r.status}`);
      throw new Error(`RingCentral ${r.status}: ${msg}`);
    }
    return body;
  }

  // ---- configuration ----
  app.put('/ringcentral/config', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    const { clientId, clientSecret, jwt, fromNumber, server } = req.body || {};
    if (!clientId || !clientSecret || !jwt) {
      return res.status(400).json({ error: 'clientId, clientSecret and jwt are all required.' });
    }
    const owner = String(req.user.company || req.user.id);
    try {
      // Save first so accessToken() can read it, then prove it works. If the
      // credentials are bad we roll back rather than leaving a broken config
      // that fails silently at 3am.
      const prev = (await db.get(cfgKey, {}))[owner] || null;
      await db.update(cfgKey, (cur) => ({
        ...cur,
        [owner]: {
          clientId, clientSecret, jwt,
          fromNumber: fromNumber || null,
          server: server || RC_DEFAULT_SERVER,
          savedAt: new Date().toISOString(),
        },
      }), {});
      tokenCache.delete(owner);

      try {
        const me = await rcFetch(owner, '/restapi/v1.0/account/~/extension/~');
        return res.json({
          ok: true,
          extension: me.extensionNumber || null,
          name: me.name || null,
          company: (me.contact && me.contact.company) || null,
        });
      } catch (e) {
        await db.update(cfgKey, (cur) => ({ ...cur, [owner]: prev }), {});
        tokenCache.delete(owner);
        return res.status(400).json({ error: e.message });
      }
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/ringcentral/config', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.json({ connected: false });
    const cfg = await configFor(String(req.user.company || req.user.id));
    // Never return the secret or the JWT.
    res.json({
      connected: !!(cfg && cfg.clientId),
      fromNumber: cfg ? cfg.fromNumber : null,
      server: cfg ? cfg.server : null,
      savedAt: cfg ? cfg.savedAt : null,
    });
  });

  // Which numbers can this account send SMS from?
  app.get('/ringcentral/numbers', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const j = await rcFetch(owner, '/restapi/v1.0/account/~/extension/~/phone-number?perPage=100');
      const numbers = (j.records || []).map((n) => ({
        phoneNumber: n.phoneNumber,
        type: n.type,
        // Only numbers with the SmsSender feature can originate texts — worth
        // surfacing so nobody picks a fax line and wonders why nothing sends.
        smsCapable: (n.features || []).includes('SmsSender'),
        callerIdCapable: (n.features || []).includes('CallerId'),
        label: n.label || null,
      }));
      res.json({ numbers, smsCapable: numbers.filter((n) => n.smsCapable) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- send SMS ----
  async function sendSms(owner, { to, text, from }) {
    const cfg = await configFor(owner);
    const fromNumber = from || (cfg && cfg.fromNumber);
    if (!fromNumber) throw new Error('No RingCentral from-number configured.');
    const out = await rcFetch(owner, '/restapi/v1.0/account/~/extension/~/sms', {
      method: 'POST',
      body: JSON.stringify({
        from: { phoneNumber: fromNumber },
        to: [{ phoneNumber: to }],
        text,
      }),
    });
    return { ok: true, id: out.id, status: out.messageStatus, from: fromNumber, to };
  }

  app.post('/ringcentral/sms', requireAuth, async (req, res) => {
    const { to, text, from } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text are required.' });
    try {
      const owner = String(req.user.company || req.user.id);
      res.json(await sendSms(owner, { to, text, from }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- call log ----
  //
  // The point of pulling this: a dispatcher rings a receiver about a late
  // delivery, and three days later nobody can prove the call happened. The log
  // has it. Matching by phone number lets us answer "was this customer told?"
  // without anyone writing a note.
  app.get('/ringcentral/calls', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const hours = Math.min(Number(req.query.hours) || 24, 24 * 30);
      const dateFrom = new Date(Date.now() - hours * 3600000).toISOString();
      // Account-level log = every extension, which is what a dispatch desk
      // needs; a per-user log would only show one person's calls.
      const j = await rcFetch(owner,
        `/restapi/v1.0/account/~/call-log?dateFrom=${encodeURIComponent(dateFrom)}&perPage=250&view=Simple`);

      const calls = (j.records || []).map((c) => ({
        id: c.id,
        at: c.startTime,
        direction: c.direction,               // Inbound | Outbound
        durationSec: c.duration || 0,
        result: c.result,                     // Call connected | Missed | Voicemail | …
        answered: /connected|accepted/i.test(c.result || ''),
        fromNumber: (c.from && c.from.phoneNumber) || null,
        fromName: (c.from && c.from.name) || null,
        toNumber: (c.to && c.to.phoneNumber) || null,
        toName: (c.to && c.to.name) || null,
        extension: (c.from && c.from.extensionNumber) || (c.to && c.to.extensionNumber) || null,
        recordingId: (c.recording && c.recording.id) || null,
      }));

      res.json({
        calls,
        counts: {
          total: calls.length,
          outbound: calls.filter((c) => c.direction === 'Outbound').length,
          inbound: calls.filter((c) => c.direction === 'Inbound').length,
          missed: calls.filter((c) => !c.answered && c.direction === 'Inbound').length,
          connected: calls.filter((c) => c.answered).length,
        },
      });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // "Did anyone call this number recently?" — the question the call-ahead check
  // needs answering before it nags a dispatcher about a stop.
  async function wasCalled(owner, phone, sinceMs) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return null;
    try {
      const dateFrom = new Date(sinceMs).toISOString();
      const j = await rcFetch(owner,
        `/restapi/v1.0/account/~/call-log?dateFrom=${encodeURIComponent(dateFrom)}&perPage=250&view=Simple&direction=Outbound`);
      const hit = (j.records || []).find((c) => {
        const to = ((c.to && c.to.phoneNumber) || '').replace(/\D/g, '').slice(-10);
        return to === digits;
      });
      if (!hit) return { called: false };
      return {
        called: true,
        at: hit.startTime,
        durationSec: hit.duration || 0,
        answered: /connected|accepted/i.test(hit.result || ''),
        result: hit.result,
      };
    } catch { return null; }
  }

  app.get('/ringcentral/was-called', requireAuth, async (req, res) => {
    const { phone, hours } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone required.' });
    try {
      const owner = String(req.user.company || req.user.id);
      const since = Date.now() - (Number(hours) || 12) * 3600000;
      const out = await wasCalled(owner, phone, since);
      res.json(out || { called: null, note: 'Call log unavailable.' });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  console.log('[ringcentral] ready — /ringcentral/config, /sms, /calls, /was-called, /numbers');
  return { sendSms, wasCalled, accessToken };
}

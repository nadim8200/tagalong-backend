// ---------------------------------------------------------------
// Driver calls & texts on a load (RingCentral), and the drivers' replies.
//
//   POST /truckmate/trips/:trip/text   { kind: 'confirm-stop' | 'pod-request', stopKey?, stopLabel? }
//        Texts the OC driver from the company number. Only on a dispatcher's
//        click, only after the driver's consent was recorded on the load, and
//        every text says "Reply STOP to opt out" (as registered with carriers).
//
// Every call (RingOut) and text is logged on the load. Every ~2 minutes the
// company's inbound texts are read: a reply from a driver of an active load is
// logged there as a check-in, and "YES" to "was stop N delivered?" marks that
// stop confirmed by the driver.
// ---------------------------------------------------------------

const COMPANY = 'Florida Beauty Flora dispatch';
const last10 = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const YES = /^\s*(yes|y|yep|yeah|si|sí|delivered|done|ok|okay|confirmed)\b/i;
const ASK_HOURS = 48;          // a "YES" counts for an ask sent within this window

export function messageFor(kind, { trip, stopLabel, link, phone }) {
  const help = phone ? ` Questions? Call ${phone}.` : '';
  if (kind === 'confirm-stop') return `${COMPANY}: please confirm ${stopLabel || 'your stop'} on load ${trip} was delivered. Reply YES${help} Reply STOP to opt out.`;
  if (kind === 'pod-request') return `${COMPANY}: please send the signed POD and BOL for load ${trip}.${link ? ` Upload photos here: ${link}` : ''} or reply with pictures. Reply STOP to opt out.`;
  return null;
}

// Pure: which loads a reply belongs to and what it does. Tested.
export function routeReply(reply, { asks = [], driverPhones = new Map(), now = Date.now() }) {
  const from = last10(reply.from);
  const recentAsks = asks.filter((a) => a.phone === from && now - Date.parse(a.at) < ASK_HOURS * 3600000)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const trips = [...new Set([...recentAsks.map((a) => a.trip), ...(driverPhones.get(from) || [])])];
  const confirm = YES.test(reply.text || '') ? recentAsks.find((a) => a.kind === 'confirm-stop') || null : null;
  return { trips, confirm };
}

export function initComms(app, { requireAuth, db, ringcentral = null, carriers = null, getBoard = null, env = process.env }) {
  const enabled = !!(db && db.enabled);
  const logKey = (site) => `taTripComms:${site}`;
  const askKey = (site) => `taCommsAsks:${site}`;
  const confirmKey = (site) => `taStopConfirm:${site}`;
  const cursorKey = (site) => `taCommsCursor:${site}`;
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';

  async function log(site, trip, entry) {
    if (!enabled || !trip) return;
    await db.update(logKey(site), (cur) => {
      const all = { ...(cur || {}) };
      all[trip] = [{ ...entry, at: entry.at || new Date().toISOString() }, ...(all[trip] || [])].slice(0, 60);
      return all;
    }, {});
  }
  // RingOut calls placed from the console land in the load's log
  if (ringcentral && ringcentral.setOnCall) {
    ringcentral.setOnCall(async ({ req, to, trip, label, by }) => { if (trip) await log(siteOf(req), trip, { type: 'call', to, label, by }); });
  }

  const board = async (site) => { try { return getBoard ? ((await getBoard(site)).trips || []) : []; } catch { return []; } };
  const tripOf = (item) => (item && item.trip) || item || {};

  app.post('/truckmate/trips/:trip/text', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    if (!ringcentral) return res.status(503).json({ error: 'RingCentral is not connected.' });
    const site = siteOf(req);
    const trip = String(req.params.trip || '');
    const b = req.body || {};
    try {
      const item = (await board(site)).find((it) => String(tripOf(it).tripNumber) === trip);
      const oc = item && item._oc;
      if (!oc) return res.status(404).json({ error: 'Texts to drivers are for outside-carrier loads with a driver phone.' });
      if (!oc.smsConsent) return res.status(409).json({ error: 'Record that the driver agreed to texts first (Outside carrier section).', needConsent: true });
      const to = oc.driverPhone;
      if (!to) return res.status(400).json({ error: 'Add the driver’s phone first.' });
      const owner = String(req.user.company || req.user.id);
      const cfg = ringcentral.configFor ? await ringcentral.configFor(owner) : null;
      const link = item._driverLink && !['revoked', 'completed', 'expired'].includes(item._driverLink.status) ? item._driverLink.url : null;
      const text = messageFor(b.kind, { trip, stopLabel: b.stopLabel, link, phone: cfg && cfg.fromNumber });
      if (!text) return res.status(400).json({ error: 'Unknown message.' });
      const sent = await ringcentral.sendSms(owner, { to, text });
      await log(site, trip, { type: 'text', kind: b.kind, to, text, by: who(req), stopKey: b.stopKey || null });
      await db.update(askKey(site), (cur) => [{ trip, kind: b.kind, stopKey: b.stopKey || null, stopLabel: b.stopLabel || null, phone: last10(to), at: new Date().toISOString() }, ...(Array.isArray(cur) ? cur : [])].slice(0, 500), []);
      res.json({ ok: true, id: sent.id, text });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- driver replies (poll the company inbox) ----
  async function pollReplies(site = 'florida-beauty') {
    if (!enabled || !ringcentral || !ringcentral.inboundSince) return 0;
    const cfg = ringcentral.configFor ? await ringcentral.configFor('__shared') : null;
    if (!cfg || !cfg.fromNumber) return 0;       // texting not live yet
    const cur = await db.get(cursorKey(site), {});
    const since = cur.since || new Date(Date.now() - 3600000).toISOString();
    const seen = new Set(cur.seen || []);
    const replies = (await ringcentral.inboundSince('__shared', since)).filter((r) => !seen.has(r.id));
    if (!replies.length) return 0;
    const asks = await db.get(askKey(site), []);
    const driverPhones = new Map();
    for (const it of await board(site)) {
      const oc = it._oc; if (!oc) continue;
      for (const p of [oc.driverPhone, oc.driver2Phone]) if (last10(p).length === 10) driverPhones.set(last10(p), [...(driverPhones.get(last10(p)) || []), String(tripOf(it).tripNumber)]);
    }
    for (const r of replies) {
      const { trips, confirm } = routeReply(r, { asks, driverPhones });
      for (const trip of trips) {
        await log(site, trip, { type: 'reply', from: r.from, text: r.text, at: r.at }); // eslint-disable-line no-await-in-loop
        if (carriers && carriers.addCheckins) await carriers.addCheckins(site, trip, [{ at: r.at, source: 'driver text', text: r.text, from: r.from }]); // eslint-disable-line no-await-in-loop
      }
      if (confirm) {
        await db.update(confirmKey(site), (c) => { // eslint-disable-line no-await-in-loop
          const all = { ...(c || {}) };
          all[confirm.trip] = { ...(all[confirm.trip] || {}), [confirm.stopKey || confirm.stopLabel || 'stop']: { at: r.at, by: 'driver text', text: r.text, from: r.from, stopLabel: confirm.stopLabel } };
          return all;
        }, {});
      }
    }
    const newest = replies.reduce((m, r) => (String(r.at) > m ? String(r.at) : m), since);
    await db.set(cursorKey(site), { since: newest, seen: [...replies.map((r) => r.id), ...seen].slice(0, 300) });
    return replies.length;
  }
  if (enabled && ringcentral && env.NODE_ENV !== 'test') {
    const t = setInterval(() => { pollReplies().catch((e) => console.warn('[comms] replies:', e.message)); }, 2 * 60000);
    if (t.unref) t.unref();
  }

  // board overlay: calls / texts / replies and driver-confirmed stops
  async function overlay(site, trips) {
    if (!enabled) return;
    const [logs, confirms] = await Promise.all([db.get(logKey(site), {}), db.get(confirmKey(site), {})]);
    for (const item of trips) {
      const trip = String(tripOf(item).tripNumber || '');
      if (logs[trip]) item._comms = logs[trip];
      if (confirms[trip]) item._stopConfirm = confirms[trip];
    }
  }

  console.log(`[comms] driver calls/texts ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { overlay, pollReplies, log };
}

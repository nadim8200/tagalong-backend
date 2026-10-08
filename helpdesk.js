// ---------------------------------------------------------------
// Callback requests — "someone needs us to reach out".
//
// Whenever Jarvis learns that a customer, broker, driver or anyone else wants a
// call back or needs help — on a Jarvis phone call (take_message / a reported
// problem), in an email, in a text, or in a message from the driver app — it
// raises ONE request and tells the right people right away:
//   • email to the group's addresses,
//   • text to the group's phones (once company texting is live),
//   • a push to anyone in the group who uses the TagAlong app.
// Groups (set in the console): Customer service (customers, brokers, unknown
// callers), Dispatch (drivers), Urgent (breakdowns, accidents, safety, upset
// customer — added on top). Each request says who, how to reach them, what they
// need, the load (where the truck is, next stop + ETA) and what was said.
// A request shows in the Jarvis inbox until someone marks it handled.
// ---------------------------------------------------------------
import { randomBytes } from 'crypto';
import { fmtLocal } from './localtime.js';

const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const last10 = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prettyPhone = (p) => { const d = last10(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };

// A text / app message asking for contact or help (not the SMS "HELP" keyword — that's handled separately). Pure.
export const wantsContact = (text) => /(call me|call back|callback|give me a call|ll[aá]m(e|ame)|necesito ayuda|need (some )?help|please help|emergenc|accident|broke ?down|break ?down|urgent|asap|problem|issue|complain|not happy|upset|reach out|contact me)/i.test(String(text || ''));
export const isUrgent = (text) => /(emergenc|accident|crash|broke ?down|break ?down|injur|fire|stolen|police|urgent|asap|reefer.*(off|down|fail))/i.test(String(text || ''));

// Who hears about it. Pure.
export function routeTo(req, cfg) {
  const pick = (g) => (cfg && cfg[g]) || { emails: [], phones: [] };
  const groups = [req.role === 'driver' ? 'dispatch' : 'customerService'];
  if (req.urgent) groups.push('urgent');
  const emails = [...new Set(groups.flatMap((g) => pick(g).emails || []))];
  const phones = [...new Set(groups.flatMap((g) => (pick(g).phones || []).map(last10)).filter((p) => p.length === 10))];
  return { groups, emails, phones };
}

export function helpEmail(req, load) {
  const who = req.from.name || req.from.company || (req.role === 'driver' ? 'The driver' : 'A caller');
  const reach = [req.from.phone && `call ${prettyPhone(req.from.phone)}`, req.from.email && `email ${req.from.email}`].filter(Boolean).join(' or ') || 'no contact info left';
  const subject = `${req.urgent ? 'URGENT — ' : ''}Call back ${who}${req.role && req.role !== 'unknown' ? ` (${req.role})` : ''}${req.trip ? ` · load ${req.trip}` : ''}: ${String(req.need).slice(0, 70)}`;
  const via = { call: 'a Jarvis phone call', email: 'an email', text: 'a text message', app: 'the driver app' }[req.source] || req.source;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>${req.urgent ? '<b style="color:#b91c1c">URGENT</b> — ' : ''}<b>${esc(who)}</b>${req.role && req.role !== 'unknown' ? ` (${esc(req.role)})` : ''} needs someone to reach out — from ${esc(via)}.</p>
<p><b>What they need:</b> ${esc(req.need)}</p>
<p><b>How to reach them:</b> ${esc(reach)}</p>
${load ? `<p><b>Load ${esc(load.trip)}</b> · truck ${esc(load.truck || '—')} · trailer ${esc(load.trailer || '—')}<br>Now: ${esc(load.location || 'no GPS')}${load.motion ? ` · ${esc(load.motion)}` : ''}${load.next ? `<br>Next stop: ${esc(load.next)}` : ''}</p>` : ''}
${req.said ? `<p><b>What was said:</b></p><blockquote style="border-left:3px solid #ccc;margin:0;padding-left:10px;color:#333">${esc(String(req.said).slice(0, 2500)).replace(/\n/g, '<br>')}</blockquote>` : ''}
<p>Mark it handled in the AI Dispatcher (Jarvis inbox → Callback requests) once someone has reached out.</p>
<p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>`;
  const text = `${req.urgent ? 'URGENT: ' : ''}Call back ${who}${req.from.phone ? ` ${prettyPhone(req.from.phone)}` : ''}${req.trip ? ` (load ${req.trip})` : ''}: ${String(req.need).slice(0, 140)} — Jarvis`;
  return { subject, html, text };
}

export function initHelpdesk(app, { requireAuth, db, getBoard = null, mail = null, sms = null, push = null, env = process.env }) {
  const enabled = !!(db && db.enabled);
  const key = `taHelpRequests:${SITE}`;
  const cfgKey = 'taHelpCfg';
  const EMPTY = { emails: [], phones: [] };
  const settings = async () => ({ customerService: EMPTY, dispatch: EMPTY, urgent: EMPTY, ...((enabled && (await db.get(cfgKey, {}))) || {}) });
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';

  async function loadView(trip) {
    if (!trip || !getBoard) return null;
    try {
      const board = await getBoard(SITE);
      const it = ((board && board.trips) || []).find((x) => tripNo(x) === String(trip));
      if (!it) return { trip };
      const l = it._samsara || {};
      const w = (await db.get(`taWatch:${SITE}`, {})) || {};
      const next = ((w.etas || {})[String(trip)] || {}).stops ? w.etas[String(trip)].stops[0] : null;
      return { trip: String(trip), truck: tripOf(it).powerUnit, trailer: tripOf(it).trailer, location: l.location || null, motion: l.speedMph == null ? null : l.speedMph > 3 ? `rolling ${Math.round(l.speedMph)} mph` : 'stopped', next: next ? `${next.label.replace(/, \d{5}$/, '')} — ETA ${fmtLocal(next.etaMs, next.label)}` : null };
    } catch { return { trip }; }
  }

  // Raise one request (same source + ref only once) and tell the right people.
  async function raise(r) {
    if (!enabled) return null;
    const req = {
      id: randomBytes(6).toString('hex'), at: new Date().toISOString(), source: r.source, ref: r.ref ? String(r.ref) : null,
      role: ['customer', 'broker', 'driver'].includes(r.role) ? r.role : 'unknown',
      from: { name: r.from && r.from.name ? String(r.from.name).slice(0, 80) : null, company: r.from && r.from.company ? String(r.from.company).slice(0, 80) : null, phone: r.from && r.from.phone ? String(r.from.phone).slice(0, 30) : null, email: r.from && r.from.email ? String(r.from.email).slice(0, 120) : null },
      trip: r.trip ? String(r.trip).replace(/\D/g, '') || null : null,
      need: String(r.need || 'Wants a call back').slice(0, 500), said: r.said ? String(r.said).slice(0, 3000) : null,
      urgent: !!(r.urgent || isUrgent(r.need) || isUrgent(r.said)), status: 'open',
    };
    let dup = false;
    await db.update(key, (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      if (req.ref && list.some((x) => x.source === req.source && x.ref === req.ref)) { dup = true; return list; }
      return [req, ...list].slice(0, 500);
    }, []);
    if (dup) return null;
    const sent = await notify(req);
    await db.update(key, (cur) => (Array.isArray(cur) ? cur : []).map((x) => (x.id === req.id ? { ...x, sent } : x)), []);
    return { ...req, sent };
  }

  async function notify(req) {
    const cfg = await settings();
    const to = routeTo(req, cfg);
    const msg = helpEmail(req, await loadView(req.trip));
    const sent = { groups: to.groups, email: null, text: null, push: null };
    if (to.emails.length) {
      if (mail && mail.ready()) { try { await mail.send({ to: to.emails, subject: msg.subject, html: msg.html }); sent.email = to.emails; } catch (e) { sent.email = `failed: ${e.message}`; } }
      else sent.email = 'waiting for Outlook';
    }
    if (to.phones.length) {
      if (sms && (await sms.live())) {
        const ok = [];
        for (const p of to.phones) { try { await sms.send(p, msg.text); ok.push(p); } catch (e) { /* one bad number shouldn't stop the rest */ } } // eslint-disable-line no-await-in-loop
        sent.text = ok;
      } else sent.text = 'waiting for texting approval';
    }
    if (push && push.sendToEmails && to.emails.length) { try { sent.push = await push.sendToEmails(to.emails, { title: req.urgent ? '🚨 Call back — urgent' : '📞 Call back needed', body: msg.text.slice(0, 180), data: { type: 'help-request', id: req.id } }); } catch { sent.push = null; } }
    return sent;
  }

  // Outlook / texting connected later → send what is still waiting (every 10 min)
  if (enabled && env.NODE_ENV !== 'test') {
    const t = setInterval(async () => {
      try {
        const list = await db.get(key, []);
        for (const r of (Array.isArray(list) ? list : []).filter((x) => x.status === 'open' && x.sent && (x.sent.email === 'waiting for Outlook' || x.sent.text === 'waiting for texting approval') && Date.now() - Date.parse(x.at) < 24 * 3600000)) {
          const fresh = await notify(r); // eslint-disable-line no-await-in-loop
          if (fresh.email !== 'waiting for Outlook' || fresh.text !== 'waiting for texting approval') await db.update(key, (cur) => cur.map((x) => (x.id === r.id ? { ...x, sent: fresh } : x)), []); // eslint-disable-line no-await-in-loop
        }
      } catch (e) { console.warn('[help] resend:', e.message); }
    }, 10 * 60000);
    if (t.unref) t.unref();
  }

  app.get('/truckmate/help', requireAuth, async (req, res) => {
    const list = (await db.get(key, [])) || [];
    res.json(req.query.all ? list.slice(0, 200) : list.filter((x) => x.status === 'open'));
  });
  app.post('/truckmate/help/:id/handled', requireAuth, async (req, res) => {
    const note = String((req.body && req.body.note) || '').slice(0, 300);
    const list = await db.update(key, (cur) => (Array.isArray(cur) ? cur : []).map((x) => (x.id === req.params.id ? { ...x, status: 'handled', handledBy: who(req), handledAt: new Date().toISOString(), note } : x)), []);
    res.json(list.find((x) => x.id === req.params.id) || null);
  });
  app.get('/truckmate/help/settings', requireAuth, async (req, res) => res.json({ ...(await settings()), outlook: !!(mail && mail.ready()), texting: !!(sms && (await sms.live())) }));
  app.put('/truckmate/help/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const clean = (g) => ({
      emails: [...new Set(String((g && g.emails) || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 20),
      phones: [...new Set(String((g && g.phones) || '').split(/[,;]+/).map(last10).filter((x) => x.length === 10))].slice(0, 20),
    });
    const b = req.body || {};
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), customerService: clean(b.customerService), dispatch: clean(b.dispatch), urgent: clean(b.urgent), updatedBy: who(req), updatedAt: new Date().toISOString() }), {}));
  });
  console.log(`[help] callback requests ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { raise };
}

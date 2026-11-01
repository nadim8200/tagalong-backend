// ---------------------------------------------------------------
// Broker load follow-up. On a broker load, "will miss the appointment" only counts once staff asked Jarvis to
// follow up AND the delivery date + time is confirmed by a person. Jarvis asks whoever requested it, by email,
// keeps asking once, then watches the ETA against that time and emails if the truck is over an hour late.
// Internal only: nothing here reaches a broker, customer or driver. Hub outbound loads never come through here.
// ---------------------------------------------------------------
import { brokerLoad } from './watchtower.js';
import { stopKey, lateStops, lateMessage } from './commitments.js';

const KEY = (site) => `taBrokerFollow:${site}`;     // trip → { since, by, byEmail, source, askedAt, asks, sent }
const REASK_MS = 2 * 3600000;
const MAX_ASKS = 2;
const STAFF_DOMAIN = /@floridabeauty\.us$/i;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders || tripOf(it).freightBills)) || [];

// The commitments a person set on this load (never one filled in from the rate con, TruckMate or an old load). Pure.
export function confirmedCommits(commits = {}) {
  return Object.fromEntries(Object.entries(commits || {}).filter(([, c]) => c && c.atMs && c.by && !c.auto && !c.fromRC && !c.fromTM && !c.fromSheet && !c.fcfs && !c.cleared));
}

// The delivery stops still open on a load, in bill order. Pure.
export function openStops(item) {
  const out = new Map();
  for (const b of billsOf(item)) {
    if (b.actualDelivery) continue;
    const p = String(b.endZoneDescription || '').split(',').map((x) => x.trim());
    const city = p[0]; const state = (p[1] || '').slice(0, 2).toUpperCase();
    const k = stopKey(city, state);
    if (k && !out.has(k)) out.set(k, { key: k, city, state, customer: b.billToName || null });
  }
  return [...out.values()];
}

// The email asking for the time. Pure.
export function askEmail(trip, item, { again = false } = {}) {
  const t = tripOf(item);
  const stops = openStops(item);
  const where = stops.map((s) => `${s.customer ? `${s.customer}, ` : ''}${s.city}, ${s.state}`);
  const subject = `Trip ${trip}: what time does truck ${t.powerUnit || ''} need to be at delivery?`.replace('truck  need', 'the truck need');
  const lead = again ? 'I still need this to follow up on the load.' : 'I am following up on this broker load.';
  const line = `What date and time does the truck need to be at ${where.join(' / ') || 'the delivery'}?`;
  const how = 'Reply to this email with the date and time (for example "Nov 3 at 8:00 AM"), or set it on the stop in the console. Until a time is confirmed I will not call this load late.';
  return { subject, text: `${lead}\n\n${line}\n\n${how}`, html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#172538;max-width:600px"><p>${esc(lead)}</p><p><b>${esc(line)}</b></p><p style="font-size:14px;color:#596A7F">${esc(how)}</p></div>` };
}

export function initBrokerFollow(app, { requireAuth, db, getBoard, commitments, sendMail, listEmails = async () => [], now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const site0 = 'florida-beauty';
  const all = async (site = site0) => (enabled ? (await db.get(KEY(site), {})) || {} : {});
  const save = (site, fn) => db.update(KEY(site), (cur) => fn({ ...(cur || {}) }), {});
  const itemFor = async (site, trip) => ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => tripNo(it) === String(trip)) || null;
  // the question goes only to one of our own people, for real even while training mode is on
  const ask = async (f, trip, item, again) => {
    if (!f.byEmail || !STAFF_DOMAIN.test(f.byEmail)) return false;
    await sendMail({ to: [f.byEmail], ...askEmail(trip, item, { again }) }, { direct: true });
    return true;
  };

  // deliverAt: 'YYYY-MM-DDTHH:MM' at the stop, when they already said it. city: which stop on a multi-stop load.
  async function start(site, trip, { by = null, byEmail = null, source = 'email', deliverAt = null, city = null } = {}) {
    const t = String(trip || '').replace(/\D/g, '');
    const item = await itemFor(site, t);
    if (!item) return { ok: false, error: `Trip ${t} is not on the board.` };
    if (!brokerLoad(item)) return { ok: false, notBroker: true, error: `Trip ${t} is an outbound load from our hub, not a broker load.` };
    await save(site, (c) => { c[t] = { sent: {}, asks: 0, ...(c[t] || {}), since: (c[t] && c[t].since) || new Date(now()).toISOString(), by, byEmail: byEmail ? String(byEmail).toLowerCase() : (c[t] && c[t].byEmail) || null, source }; return c; });
    if (deliverAt) { const r = await confirm(site, t, { deliverAt, city, by }); if (r.ok) return { ok: true, confirmed: true, ...r }; }
    const commits = confirmedCommits((await commitments.all())[t]);
    if (Object.keys(commits).length) return { ok: true, confirmed: true };
    const cur = (await all(site))[t];
    const asked = await ask(cur, t, item, false).catch((e) => { console.warn('[broker-follow]', e.message); return false; });
    if (asked) await save(site, (c) => { c[t] = { ...c[t], askedAt: new Date(now()).toISOString(), asks: (c[t].asks || 0) + 1 }; return c; });
    return { ok: true, confirmed: false, asked, needTime: true };
  }

  async function confirm(site, trip, { deliverAt, city = null, by = null } = {}) {
    const t = String(trip || '').replace(/\D/g, '');
    if (!(await all(site))[t]) return { ok: false, error: `Jarvis is not following up on trip ${t}.` };
    const local = String(deliverAt || '').slice(0, 16);
    const item = await itemFor(site, t);
    const stops = item ? openStops(item) : [];
    const want = String(city || '').trim().toUpperCase();
    const st = want ? stops.find((s) => s.city.toUpperCase() === want) : stops.length === 1 ? stops[0] : null;
    if (!st) return { ok: false, error: stops.length > 1 ? `Which stop? ${stops.map((s) => `${s.city}, ${s.state}`).join(' or ')}` : 'No open delivery stop on this load.' };
    const r = await commitments.commit(t, { ...st, local, by: by || 'staff' });
    return r ? { ok: true, stop: `${st.city}, ${st.state}`, local } : { ok: false, error: 'That date and time could not be read.' };
  }

  // after each board refresh: ask again once, and over an hour late against a confirmed time → one email per stop + time
  async function process(site, board) {
    if (!enabled) return { sent: 0 };
    const follows = await all(site);
    const ids = Object.keys(follows);
    if (!ids.length) return { sent: 0 };
    const items = (board && board.trips) || [];
    const commits = await commitments.all();
    const etas = ((await db.get(`taWatch:${site}`, {})) || {}).etas || {};
    let n = 0;
    for (const trip of ids) {
      const f = follows[trip];
      const it = items.find((x) => tripNo(x) === trip);
      if (!it) { await save(site, (c) => { delete c[trip]; return c; }); continue; }   // delivered / off the board
      const mine = confirmedCommits(commits[trip]);
      if (!Object.keys(mine).length) {
        if ((f.asks || 0) > 0 && (f.asks || 0) < MAX_ASKS && now() - Date.parse(f.askedAt) >= REASK_MS) {
          const sentOk = await ask(f, trip, it, true).catch(() => false);
          if (sentOk) await save(site, (c) => { c[trip] = { ...c[trip], askedAt: new Date(now()).toISOString(), asks: (c[trip].asks || 0) + 1 }; return c; });
        }
        continue;
      }
      for (const st of lateStops({ commits: mine, etas: etas[trip], leftAt: Date.parse(f.since), now: now() })) {
        const id = `${st.key}|${st.local}`;
        if ((f.sent || {})[id]) continue;
        const m = lateMessage(it, st);
        const mail = { subject: m.subject.replace(/^Late for a committed time/, 'Will miss the delivery time'), html: m.html, text: m.text };
        try {
          const list = await listEmails();
          if (list.length) await sendMail({ to: list, ...mail });
          if (f.byEmail && STAFF_DOMAIN.test(f.byEmail) && !list.includes(f.byEmail)) await sendMail({ to: [f.byEmail], ...mail }, { direct: true });
          await save(site, (c) => { c[trip] = { ...c[trip], sent: { ...(c[trip].sent || {}), [id]: new Date(now()).toISOString() } }; return c; });
          n += 1;
        } catch (e) { console.warn('[broker-follow] alert:', e.message); }
      }
    }
    return { sent: n };
  }

  // on the board: a followed load with a confirmed time → watchtower may call it late
  async function overlay(site, trips) {
    const follows = await all(site);
    if (!Object.keys(follows).length) return;
    const commits = await commitments.all();
    for (const it of trips) {
      const f = follows[tripNo(it)];
      if (f) it._brokerFollow = { by: f.by, since: f.since, confirmed: Object.keys(confirmedCommits(commits[tripNo(it)])).length > 0 };
    }
  }

  if (app) {
    app.get('/truckmate/broker-follow', requireAuth, async (req, res) => res.json(await all(String(req.query.site || site0))));
    app.delete('/truckmate/broker-follow/:trip', requireAuth, async (req, res) => { await save(String(req.query.site || site0), (c) => { delete c[String(req.params.trip)]; return c; }); res.json({ ok: true }); });
  }
  return { start, confirm, process, overlay, all };
}

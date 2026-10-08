// ---------------------------------------------------------------
// Driver check-ins — every step of the load, confirmed with the driver.
//
// Milestones: arrived at the shipper · loaded · departed (rolling) · arrived at
// each receiver · delivered there · a long wait (detention clock) at any of them.
//
// Each one can come from TruckMate (ARRSHIP, LOADEDTOGO / SPTLD, DEPSHIP, ARRCONS,
// DEPCONS, bills delivered), from GPS (the truck parked at the stop — a validated
// geofence visit, or 10+ min stopped near it) or from the DRIVER: a text or an app
// message like "loaded", "here", "empty", "still waiting, no door" counts.
//
// When Jarvis sees a step the driver hasn't told us, it asks the driver to confirm —
// app push for drivers with the TagAlong app (outside carriers), a text for drivers
// who agreed to dispatch texts once company texting is live. Never after STOP, not
// while the driver is in the sleeper / off duty (it waits), at most 8 asks a day.
//
// What the driver says feeds the customer status emails (statusmail.js reads
// item._milestones): loaded, rolling, arrived, delivered. A long wait alerts dispatch
// (email + push) and starts the detention record (arrived / left / minutes) on the load.
// A GPS stop alone is never proof of delivery — only TruckMate or the driver.
// ---------------------------------------------------------------
import { recipientFor } from './comms.js';
import { stopsOf, pickupPoints } from './statusmail.js';
import { haversineMi } from './watchtower.js';
import { sendMail, mailConfig } from './mailer.js';

const MIN = 60000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const last10 = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const fmtMin = (m) => { const h = Math.floor(m / 60); const r = Math.round(m % 60); return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`; };
const S = (x) => String(x || '');
const ST = { arrShip: /^arrship/i, loaded: /^(loadedtogo|sptld)/i, dep: /^(depship|depshp|intran|enroute)/i, arrCons: /^arrcon/i, depCons: /^depcon/i };
export const DEFAULTS = { on: true, askDriver: true, waitMin: 120, notify: [] };

// What the driver's words say. Pure. → { kind: issue|delivered|loaded|waiting|departed|arrived|yes|no|null }
export function readDriver(text) {
  const t = S(text).toLowerCase().trim();
  if (!t) return { kind: null };
  if (/(break ?down|broke down|accident|flat tire|tow|emergenc|hospital|reefer (is )?(down|off)|problem|issue|averi|accidente)/.test(t)) return { kind: 'issue' };
  if (/(unloaded|delivered|deliver(y)? (is )?done|empty now|i'?m empty|got (the )?pod|signed (the )?pod|descargad|entregad|vac[ií]o)/.test(t)) return { kind: 'delivered' };
  if (/(\bloaded\b|load(ing)? (is )?(done|complete|finished)|got (the )?load|sealed|cargad|ya cargu|ya me cargaron)/.test(t)) return { kind: 'loaded' };
  if (/(wait|still here|no door|dock (is )?full|they (have|got) me|detention|backed up|esperando|no hay puerta|todav[ií]a aqu)/.test(t)) return { kind: 'waiting' };
  if (/(rolling|\bleft\b|leaving|on (my|the) way|en route|heading (out|to)|departed|sal[ií]|saliendo|rodando|en camino)/.test(t)) return { kind: 'departed' };
  if (/(arriv|i'?m here|we'?re here|checked in|check(ed)? in|at the (dock|door|shipper|receiver|customer)|backed in|in (a |the )?door|lleg|estoy aqu)/.test(t)) return { kind: 'arrived' };
  if (/^(y|ya|yes|yeah|yep|yup|si|sí|ok|okay|correct|confirm(ed)?|10-?4|copy|done|listo|affirmative)(?![a-z])/.test(t)) return { kind: 'yes' };
  if (/^(no|nope|not yet|negative|todav[ií]a no|a[uú]n no)(?![a-z])/.test(t)) return { kind: 'no' };
  return { kind: null };
}

// The receiver the truck is working on now: the first one not delivered. Pure.
const currentStop = (stops, ms) => stops.find((s) => !s.delivered && !(ms[`delivered:${s.key}`])) || null;

// What TruckMate / GPS show right now, as milestone keys. Pure.
// state.near: { place, since } — where the truck has been parked.
export function observe(item, state = {}, { geo = () => null, now = Date.now() } = {}) {
  const t = tripOf(item);
  const status = S(t.status);
  const hist = (item && item._times && item._times.statusHistory) || [];
  const any = (re) => re.test(status) || hist.some((h) => re.test(S(h.status)));
  const stops = stopsOf(item);
  const out = {};
  if (any(ST.arrShip)) out['arrived-shipper'] = 'TruckMate';
  if (any(ST.loaded)) out.loaded = 'TruckMate';
  if (any(ST.dep) || any(ST.arrCons) || any(ST.depCons)) out.departed = 'TruckMate';
  const arrN = hist.filter((h) => ST.arrCons.test(S(h.status))).length || (ST.arrCons.test(status) ? 1 : 0);
  const depN = hist.filter((h) => ST.depCons.test(S(h.status))).length || (ST.depCons.test(status) ? 1 : 0);
  stops.forEach((s, i) => {
    if (s.delivered) { out[`arrived:${s.key}`] = out[`arrived:${s.key}`] || 'TruckMate'; out[`delivered:${s.key}`] = 'TruckMate'; }
    if (i < arrN) out[`arrived:${s.key}`] = out[`arrived:${s.key}`] || 'TruckMate';
    if (i < depN) out[`left:${s.key}`] = 'TruckMate';
    const v = s.sheetKey && item._visits ? item._visits[s.sheetKey] : null;
    if (v && ['at_stop', 'departing', 'completed'].includes(v.state)) out[`arrived:${s.key}`] = out[`arrived:${s.key}`] || 'GPS';
    if (v && v.state === 'completed') out[`left:${s.key}`] = out[`left:${s.key}`] || 'GPS';
  });
  // parked near the pickup or a receiver (for "arrived" when there's no geofence, and for long waits)
  const live = (item && item._samsara) || {};
  const fresh = live.lat != null && live.gpsAt && now - Date.parse(live.gpsAt) < 30 * MIN;
  let near = null;
  if (fresh && (live.speedMph == null || live.speedMph < 3)) {
    if (!out.departed) {
      const { pts, nearMi } = pickupPoints(item, geo);
      const yard = nearMi === 1;   // our own Miami yard: being parked there isn't "at the shipper"
      if (!yard && pts.some((p) => haversineMi(live.lat, live.lng, p.lat, p.lng) <= nearMi)) near = 'pickup';
    } else {
      const s = currentStop(stops, out);
      const g = s && s.zip ? geo(s.zip) : null;
      if (s && g && haversineMi(live.lat, live.lng, g.lat, g.lng) <= 3) near = s.key;
    }
  }
  const prev = state.near || null;
  const since = near && prev && prev.place === near ? prev.since : (near ? now : null);
  if (near && now - since >= 10 * MIN) {
    const k = near === 'pickup' ? 'arrived-shipper' : `arrived:${near}`;
    out[k] = out[k] || 'GPS';
  }
  return { ms: out, near: near ? { place: near, since } : null, stops };
}

// The question for the driver. Pure.
export function askText(key, { name, trip, place, waitMin }) {
  const hi = `Florida Beauty Flora dispatch (Jarvis): Hi${name ? ` ${first(name)}` : ''},`;
  const at = place ? ` at ${place}` : '';
  if (key === 'arrived-shipper') return `${hi} it looks like you're at the shipper${at} for load ${trip}. Are you checked in? Reply YES, or tell me what's going on.`;
  if (key === 'loaded') return `${hi} TruckMate shows load ${trip} loaded. Are you loaded and sealed? Reply YES, or tell me what's going on.`;
  if (key === 'departed') return `${hi} load ${trip} shows departed. Are you rolling? Reply YES, or tell me what's going on.`;
  if (key.startsWith('arrived:')) return `${hi} it looks like you're at the receiver${at} for load ${trip}. Are you checked in? Reply YES, or tell me what's going on.`;
  if (key.startsWith('left:')) return `${hi} you left${at} on load ${trip}. Was it delivered complete? Reply DONE, or tell me what happened — and send the signed POD in the app.`;
  if (key.startsWith('waiting:')) return `${hi} you've been${at} about ${fmtMin(waitMin)} on load ${trip}. Still waiting? Tell me what's going on (door, appointment, paperwork) — we're keeping the detention time.`;
  return `${hi} quick check on load ${trip}: reply with an update.`;
}

const LABEL = { 'arrived-shipper': 'arrived at the shipper', loaded: 'loaded', departed: 'departed — rolling' };
export const labelOf = (key, stops = []) => {
  if (LABEL[key]) return LABEL[key];
  const [kind, ...rest] = key.split(':'); const sk = rest.join(':');
  const s = stops.find((x) => x.key === sk);
  const where = s ? (s.name || (s.customers || [])[0] || s.place) : sk.replace(/, \d{5}$/, '');
  return { arrived: `arrived at ${where}`, left: `left ${where}`, delivered: `delivered at ${where}`, waiting: `long wait at ${where}` }[kind] || key;
};

// Apply what the driver said to the load. Pure. → { set: {key: true}, note }
export function applyReply(reply, { lastAsk = null, ms = {}, stops = [] } = {}) {
  const r = readDriver(reply.text);
  const set = {};
  const cur = currentStop(stops, ms);
  const atPickup = !ms.departed;
  const ask = lastAsk && lastAsk.key;
  if (r.kind === 'yes' && ask) {
    if (ask.startsWith('left:')) set[`delivered:${ask.slice(5)}`] = true;
    else if (!ask.startsWith('waiting:')) set[ask] = true;
  } else if (r.kind === 'loaded') { set.loaded = true; set['arrived-shipper'] = true; } else if (r.kind === 'departed') { if (atPickup) set.departed = true; else if (cur) set[`left:${cur.key}`] = true; } else if (r.kind === 'arrived') { if (atPickup) set['arrived-shipper'] = true; else if (cur) set[`arrived:${cur.key}`] = true; } else if (r.kind === 'delivered' && cur) { set[`arrived:${cur.key}`] = true; set[`delivered:${cur.key}`] = true; } else if (r.kind === 'waiting') set[`waiting:${atPickup ? 'pickup' : (cur ? cur.key : 'pickup')}`] = true;
  return { kind: r.kind, set };
}

export function initMilestones(app, { requireAuth, db, ringcentral = null, comms = null, driverLinks = null, push = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = (site) => `taMilestones:${site}`;
  const cfgKey = 'taMilestonesCfg';
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const settings = async () => ({ ...DEFAULTS, ...((enabled && (await db.get(cfgKey, {}))) || {}) });
  const smsLive = async () => { try { const c = ringcentral && ringcentral.configFor ? await ringcentral.configFor('__shared') : null; return !!(c && c.fromNumber); } catch { return false; } };

  async function ask(site, item, text) {
    const trip = tripNo(item);
    if (item._oc && driverLinks && driverLinks.messageDriver) {
      const r = await driverLinks.messageDriver(site, trip, text, 'Jarvis (driver check-in)').catch(() => null);
      if (r && r.sent) return { via: r.via };
    }
    const rcpt = recipientFor(item, 1, await db.get(`taSmsConsent:${site}`, {}));
    if (!rcpt || !rcpt.phone || !rcpt.consent) return { skipped: 'no app / no text consent' };
    if ((await db.get('taSmsOptOut', {}))[last10(rcpt.phone)]) return { skipped: 'driver replied STOP' };
    if (!(await smsLive())) return { skipped: 'texting not live yet' };
    const body = `${text} Reply STOP to opt out.`;
    await ringcentral.sendSms('__shared', { to: rcpt.phone, text: body });
    if (comms && comms.log) await comms.log(site, trip, { type: 'text', kind: 'driver-checkin', to: rcpt.phone, text: body, by: 'Jarvis (driver check-in)' });
    return { via: 'text' };
  }

  async function alertDispatch(cfg, item, { title, body }) {
    const to = cfg.notify || [];
    if (!to.length) return;
    if (push && push.sendToEmails) { try { await push.sendToEmails(to, { title, body: body.slice(0, 180), data: { type: 'milestone', trip: tripNo(item), path: '/truckmate' } }); } catch { /* best effort */ } }
    if (mailConfig(env).ready) { try { await sendMail({ to, subject: title, html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>${body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p><p>Jarvis — AI Dispatcher</p></div>` }, { env, fetchFn }); } catch { /* best effort */ } }
  }

  // Every Watchtower cycle, before the status emails (they read item._milestones).
  async function process(site, board, { geo = () => null } = {}) {
    if (!enabled) return;
    const cfg = await settings();
    if (cfg.on === false) return;
    const book = (await db.get(key(site), {})) || {};
    const replies = (await db.get(`taTripComms:${site}`, {})) || {};
    const t0 = now();
    const nowIso = new Date(t0).toISOString();
    const items = (board.trips || []).filter((it) => tripNo(it) && !/^(canc|void)/i.test(S(tripOf(it).status)));
    for (const item of items) {
      const trip = tripNo(item);
      const st = book[trip] || { ms: {}, asks: {}, waits: {}, lastReadAt: nowIso, startedAt: nowIso };   // new to us: only what the driver says from now on
      st.ms = st.ms || {}; st.asks = st.asks || {}; st.waits = st.waits || {};
      const firstSight = !book[trip];
      const o = observe(item, st, { geo, now: t0 });
      st.near = o.near;
      // 1) TruckMate / GPS
      for (const [k, src] of Object.entries(o.ms)) if (!st.ms[k]) st.ms[k] = { at: nowIso, src, seenFirst: firstSight || undefined };
      // 2) what the driver said since we last read
      const said = (replies[trip] || []).filter((e) => e.type === 'reply' && e.text && (!st.lastReadAt || S(e.at) > st.lastReadAt)).sort((a, b) => S(a.at).localeCompare(S(b.at)));
      for (const r of said) {
        const lastAsk = Object.entries(st.asks).map(([k, a]) => ({ key: k, ...a })).filter((a) => a.via && S(a.at) <= S(r.at)).sort((a, b) => S(b.at).localeCompare(S(a.at)))[0] || null;
        const res = applyReply(r, { lastAsk, ms: st.ms, stops: o.stops });
        for (const k of Object.keys(res.set)) st.ms[k] = { ...(st.ms[k] || { at: r.at, src: 'driver' }), driverAt: r.at, driverSaid: S(r.text).slice(0, 200) };
        if (res.kind === 'waiting' || res.kind === 'issue') {
          const place = res.kind === 'issue' ? 'issue' : Object.keys(res.set)[0];
          st.log = [{ at: r.at, kind: res.kind, text: S(r.text).slice(0, 200) }, ...(st.log || [])].slice(0, 30);
          await alertDispatch(cfg, item, { title: `Load ${trip} — driver: ${res.kind === 'issue' ? 'problem' : 'waiting'}`, body: `${(item._samsara && item._samsara.driver1) || (item._oc && item._oc.driverName) || 'The driver'} on load ${trip} (truck ${tripOf(item).powerUnit || '—'}) says: "${S(r.text).slice(0, 300)}"${place && place.startsWith('waiting:') ? ` — ${labelOf(place, o.stops)}.` : ''}` }); // eslint-disable-line no-await-in-loop
        }
        st.lastReadAt = S(r.at);
      }
      // 3) long waits: parked at the pickup / current receiver past the free time → detention record + dispatch alert + ask the driver
      const near = o.near;
      if (near) {
        const place = near.place;
        const w = st.waits[place] || { arrivedAt: new Date(near.since).toISOString() };
        const mins = (t0 - near.since) / MIN;
        const done = place === 'pickup' ? (st.ms.loaded || st.ms.departed) : (st.ms[`delivered:${place}`] || st.ms[`left:${place}`]);
        if (!done && mins >= cfg.waitMin && !w.alertedAt) {
          w.alertedAt = nowIso;
          st.ms[`waiting:${place}`] = st.ms[`waiting:${place}`] || { at: nowIso, src: 'GPS', min: Math.round(mins) };
          await alertDispatch(cfg, item, { title: `Load ${trip} — ${fmtMin(mins)} at ${place === 'pickup' ? 'the shipper' : labelOf(`arrived:${place}`, o.stops).replace(/^arrived at /, '')}`, body: `Truck ${tripOf(item).powerUnit || '—'} on load ${trip} has been parked ${place === 'pickup' ? 'at the shipper' : `at ${labelOf(`arrived:${place}`, o.stops).replace(/^arrived at /, '')}`} for ${fmtMin(mins)} (since ${new Date(near.since).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} ET) and isn't ${place === 'pickup' ? 'loaded' : 'delivered'} yet. Detention clock is on — Jarvis is asking the driver.` }); // eslint-disable-line no-await-in-loop
        }
        st.waits[place] = w;
      }
      for (const [place, w] of Object.entries(st.waits)) {
        if (w.leftAt || (near && near.place === place)) continue;
        w.leftAt = nowIso; w.minutes = Math.round((Date.parse(nowIso) - Date.parse(w.arrivedAt)) / MIN);
        if (w.minutes >= cfg.waitMin && comms && comms.log) await comms.log(site, trip, { type: 'note', kind: 'detention', text: `Detention record: ${place === 'pickup' ? 'shipper' : labelOf(`arrived:${place}`, o.stops).replace(/^arrived at /, '')} — arrived ${w.arrivedAt}, left ${w.leftAt}, ${fmtMin(w.minutes)} on site (${fmtMin(Math.max(0, w.minutes - cfg.waitMin))} past ${fmtMin(cfg.waitMin)} free).`, by: 'Jarvis', noThread: true }); // eslint-disable-line no-await-in-loop
      }
      // 4) ask the driver to confirm one step at a time: newest unconfirmed, not yet asked
      if (cfg.askDriver && !firstSight) {
        const duty = S(item._samsara && item._samsara.hos && item._samsara.hos.status);
        const resting = /sleeper|off ?duty|offduty/i.test(duty);
        const today = Object.values(st.asks).filter((a) => a.via && t0 - Date.parse(a.at) < 24 * 60 * MIN).length;
        const order = (k) => (k === 'arrived-shipper' ? 1 : k === 'loaded' ? 2 : k === 'departed' ? 3 : k.startsWith('waiting:') ? 9 : 5);
        const open = Object.entries(st.ms).filter(([k, m]) => !m.driverAt && !m.seenFirst && !st.asks[k] && !k.startsWith('delivered:') && Date.parse(m.at) > t0 - 6 * 60 * MIN && !(k.startsWith('left:') && st.ms[`delivered:${k.slice(5)}`])).sort((a, b) => order(b[0]) - order(a[0]) || S(b[1].at).localeCompare(S(a[1].at)));
        if (open.length && !resting && today < 8) {
          const [k, m] = open[0];
          const sk = k.includes(':') ? k.split(':').slice(1).join(':') : null;
          const s = sk ? o.stops.find((x) => x.key === sk) : null;
          const place = k === 'arrived-shipper' ? String(tripOf(item).origZoneDesc || '').replace(/,?\s*\d{5}.*$/, '') : s ? `${s.name || (s.customers || [])[0] || ''} ${s.place}`.trim() : (sk === 'pickup' ? 'the shipper' : null);
          const name = (item._oc && item._oc.driverName) || (item._samsara && item._samsara.driver1Info && item._samsara.driver1Info.name) || '';
          let r;
          try { r = await ask(site, item, askText(k, { name, trip, place, waitMin: m.min || cfg.waitMin })); } catch (e) { r = { error: e.message }; } // eslint-disable-line no-await-in-loop
          st.asks[k] = { at: nowIso, ...r };
        }
      }
      book[trip] = st;
      // overlay for the status emails / console
      item._milestones = Object.fromEntries(Object.entries(st.ms).map(([k, m]) => [k, { at: m.driverAt || m.at, src: m.driverAt ? (m.src === 'driver' ? 'driver' : `${m.src} + driver`) : m.src }]));
    }
    const live = new Set(items.map(tripNo));
    await db.update(key(site), (cur) => {
      const a = { ...(cur || {}), ...book };
      for (const n of Object.keys(a)) if (!live.has(n)) { a[n].goneAt = a[n].goneAt || nowIso; if (t0 - Date.parse(a[n].goneAt) > 7 * 24 * 60 * MIN) delete a[n]; } else delete a[n].goneAt;
      return a;
    }, {});
  }

  app.get('/truckmate/milestones/settings', requireAuth, async (req, res) => res.json({ ...(await settings()), textingLive: await smsLive(), outlook: mailConfig(env).ready }));
  app.put('/truckmate/milestones/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const notify = [...new Set(String(Array.isArray(b.notify) ? b.notify.join(',') : b.notify || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 20);
    const waitMin = Math.min(480, Math.max(30, Number(b.waitMin) || DEFAULTS.waitMin));
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), on: b.on !== false, askDriver: b.askDriver !== false, waitMin, notify, updatedBy: who(req), updatedAt: new Date().toISOString() }), {}));
  });
  app.get('/truckmate/milestones/:trip', requireAuth, async (req, res) => {
    const st = ((await db.get(key(String(req.query.site || 'florida-beauty')), {})) || {})[String(req.params.trip)] || null;
    res.json(st ? { ms: st.ms, asks: st.asks, waits: st.waits, log: st.log || [] } : { ms: {}, asks: {}, waits: {}, log: [] });
  });

  console.log(`[milestones] driver check-ins ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { process, settings };
}

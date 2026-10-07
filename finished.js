// ---------------------------------------------------------------
// When is a load finished, even if TruckMate never says so?
//   1. TruckMate: delivered status, or every bill delivered
//   2. Geofence: every trip-sheet stop visited, or the LAST stop visited / delivered
//   3. (suggestion only) the same company truck has since left a shipper on a newer trip
//   4. A dispatcher clicked "Mark finished" (and can reopen it)
// NOT CLOSED: the load's truck or trailer has picked up a newer load, but TruckMate
// still has this one open. It leaves the active board and the alerts, waits in the
// "Not closed" tab, and dispatch gets an email (once, then a daily reminder) to
// close it in TruckMate. When TruckMate closes / delivers it, it drops off by itself.
// Finished loads leave the active board, show in Delivered with the reason,
// and get their rundown. A reopened load is never auto-finished again.
// ---------------------------------------------------------------
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const unitKey = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE)/i;
const NOT_STARTED = /^(DISP|ASSGN|ASSIGNED|AVAIL|AVBL|NEW|PLAN|PEND|PRINTED)/i;
const DONE = /^(DELVD|DELIV|DELIVERED|DEL$|CMPLT|COMPLETE)/i;
const cityOf = (s) => String(s || '').split(',')[0].trim().toUpperCase();
const ON_NEW_LOAD = /^(ARRSHIP|DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE)/i;   // at / past the new load's shipper
const created = (it) => Date.parse((it && it._times && it._times.created) || '') || Number(tripNo(it)) || 0;

// When the load was picked up (first ARRSHIP / DEPSHIP we saw), else when it was created.
const pickedAt = (it) => {
  const h = ((it && it._times && it._times.statusHistory) || []).find((x) => /^(ARRSHIP|DEPSHIP)/i.test(String(x.status || '')));
  return (h && Date.parse(h.at)) || null;
};
const realCreated = (it) => Date.parse((it && it._times && it._times.created) || '') || null;
// Two trips picked up within 6 hours of each other ride the same truck together (co-loaded) —
// neither is "left open".
function together(a, b) {
  const pa = pickedAt(a); const pb = pickedAt(b);
  if (pa && pb) return Math.abs(pb - pa) < 6 * 3600000;
  const ca = realCreated(a); const cb = realCreated(b);
  return !!(ca && cb && Math.abs(cb - ca) < 6 * 3600000);
}

// The truck or trailer of `item` is working a newer load → { by, unit, newTrip, newStatus }. Pure.
export function movedOn(item, items = []) {
  const t = tripOf(item);
  if (!t || NOT_STARTED.test(String(t.status || '')) || DONE.test(String(t.status || '')) || (item && item._oc)) return null;
  const unit = unitKey(t.powerUnit); const trailer = unitKey(t.trailer);
  const newer = (o) => o !== item && !(o && o._oc) && ON_NEW_LOAD.test(String(tripOf(o).status || '')) && created(o) > created(item) && !together(item, o);
  const newest = (list) => list.sort((a, b) => created(b) - created(a))[0];      // the truck's current load, not another old one
  if (unit && !/^OC/.test(unit)) {
    const o = newest(items.filter((x) => newer(x) && unitKey(tripOf(x).powerUnit) === unit));
    if (o) return { by: 'truck', unit: t.powerUnit, newTrip: tripNo(o), newStatus: String(tripOf(o).status || '') };
  }
  // trailer only when the load has no truck of its own (with a truck, a trailer on another load is a swap)
  if (!unit && trailer && !/^(OC|NONE|NA)$/.test(trailer) && trailer.length >= 3) {
    const o = newest(items.filter((x) => newer(x) && unitKey(tripOf(x).trailer) === trailer));
    if (o) return { by: 'trailer', unit: t.trailer, newTrip: tripNo(o), newStatus: String(tripOf(o).status || '') };
  }
  return null;
}

export function finishReason(item, items = []) {
  const t = tripOf(item);
  const status = String(t.status || '');
  if (DONE.test(status)) return 'TruckMate: delivered';
  const bills = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  if (bills.length && bills.every((b) => b && b.actualDelivery)) return 'every stop delivered (TruckMate)';
  const sheetStops = ((item && item._manifest && item._manifest.stops) || []).filter((s) => /DELIVER/i.test(s.action || '') && s.key);
  const visits = (item && item._visits) || {};
  const done = (s) => visits[s.key] && visits[s.key].state === 'completed';
  if (sheetStops.length && sheetStops.every(done)) return 'every stop visited (geofence)';
  if (sheetStops.length) {
    const last = [...sheetStops].sort((a, b) => (Number(b.stopNumber) || 0) - (Number(a.stopNumber) || 0))[0];
    if (done(last)) return `last stop visited — ${last.customer || last.city} (geofence)`;
    const lastBills = bills.filter((b) => cityOf(b.endZoneDescription) === String(last.city || '').toUpperCase());
    if (lastBills.length && lastBills.every((b) => b.actualDelivery)) return `last stop delivered — ${last.customer || last.city} (TruckMate)`;
  }
  const unit = unitKey(t.powerUnit);
  if (unit && !(item && item._oc) && !/^OC/.test(unit) && !NOT_STARTED.test(status)) {
    const created = (it) => Date.parse((it && it._times && it._times.created) || '') || Number(tripNo(it)) || 0;
    const next = items.find((o) => o !== item && unitKey(tripOf(o).powerUnit) === unit && ROLLING.test(String(tripOf(o).status || '')) && created(o) > created(item));
    if (next) return `truck ${t.powerUnit} moved on to trip ${tripNo(next)}`;
  }
  return null;
}
// Only facts finish a load by themselves; "truck moved on" is shown as a suggestion.
export const isSure = (reason) => !!reason && !/moved on/.test(reason);

const laneOf = (it) => `${String(tripOf(it).origZoneDesc || '—').replace(/,\s*\d{5}.*$/, '')} → ${String(tripOf(it).destZoneDesc || '—').replace(/,\s*\d{5}.*$/, '')}`;
export const unclosedLine = (n, u) => `Trip ${n}: ${u.by} ${u.unit} is now on trip ${u.newTrip}, but trip ${n}${u.lane ? ` (${u.lane})` : ''} is still open in TruckMate${u.since ? ` since ${new Date(u.since).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.`;

export function initFinished(app, { requireAuth, db, onFinished = null, recordFinished = null, mailer = null, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = (site) => `taFinished:${site}`;
  const openKey = (site) => `taUnclosed:${site}`;
  const cfgKey = 'taUnclosedCfg';
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';

  // Called while the board is built: takes finished loads out of `items` (in place).
  async function sweep(site, items, recs = {}) {
    if (!enabled || !items.length) return { finished: [], unclosed: [] };
    const fin = await db.get(key(site), {});
    const newly = [];
    const open = [];
    for (const it of items) {
      const n = tripNo(it);
      if (!n || (fin[n] && !fin[n].reopened)) continue;
      if (fin[n] && fin[n].reopened) continue;                     // a person reopened / kept it — leave it on the board
      const reason = finishReason(it, items);
      if (reason && isSure(reason)) { newly.push({ n, it, reason }); continue; }
      const mv = movedOn(it, items);
      if (mv) { open.push({ n, it, mv }); continue; }
      if (reason) it._finishHint = `Probably finished — ${reason}`;
    }
    if (newly.length) {
      const at = new Date().toISOString();
      await db.update(key(site), (cur) => { const a = { ...(cur || {}) }; newly.forEach(({ n, reason }) => { if (!a[n]) a[n] = { at, reason, by: 'AI Dispatcher', auto: true }; }); return a; }, {});
      for (const { n, it, reason } of newly) {
        if (recordFinished) await recordFinished(site, it, reason).catch(() => {}); // eslint-disable-line no-await-in-loop
        if (onFinished) Promise.resolve(onFinished(site, recs[n] || { item: it }, reason)).catch(() => {});
        fin[n] = { at, reason };
      }
    }
    // not closed in TruckMate: remember since when; drop the ones TruckMate has closed since
    const at = new Date(now()).toISOString();
    const stillActive = new Set([...Object.keys(recs || {}), ...items.map(tripNo)]);
    const book = await db.update(openKey(site), (cur) => {
      const a = {};
      for (const [n, v] of Object.entries(cur || {})) if (stillActive.has(n) && open.some((o) => o.n === n)) a[n] = v;
      for (const { n, it, mv } of open) a[n] = { ...(a[n] || { since: at }), ...mv, lane: laneOf(it), status: String(tripOf(it).status || ''), driver: tripOf(it).driver || '' };
      return a;
    }, {});
    const gone = new Set([...open.map((o) => o.n)]);
    for (let i = items.length - 1; i >= 0; i--) { const n = tripNo(items[i]); const f = fin[n]; if ((f && !f.reopened) || gone.has(n)) items.splice(i, 1); }
    return { finished: newly.map((x) => ({ trip: x.n, reason: x.reason })), unclosed: open.map(({ n }) => ({ trip: n, ...(book[n] || {}) })) };
  }

  // ---- emails to dispatch: one notice per load, then a daily reminder ----
  const settings = async () => ({ to: [], time: '08:00', ...((enabled && (await db.get(cfgKey, {}))) || {}) });
  async function notify(site) {
    if (!mailer || !mailer.ready()) return null;
    const cfg = await settings();
    if (!cfg.to.length) return null;
    const book = await db.get(openKey(site), {});
    const entries = Object.entries(book);
    const fresh = entries.filter(([, v]) => !v.noticeAt);
    const sent = [];
    const stamp = async (ns, field) => { const at = new Date(now()).toISOString(); await db.update(openKey(site), (cur) => { const a = { ...(cur || {}) }; ns.forEach((n) => { if (a[n]) a[n] = { ...a[n], [field]: at }; }); return a; }, {}); };
    const list = (rows) => `<ul>${rows.map(([n, v]) => `<li>${unclosedLine(n, v)}</li>`).join('')}</ul>`;
    const foot = '<p>Please close or deliver these loads in TruckMate. Until then they sit in the <b>Not closed</b> tab of the AI Dispatcher and do not raise alerts. They drop off automatically once TruckMate closes them.</p><p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p>';
    if (fresh.length === 1) {
      const [n, v] = fresh[0];
      await mailer.send({ to: cfg.to, subject: `Load ${n} not closed — ${v.by} ${v.unit} is on trip ${v.newTrip}`, html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>${unclosedLine(n, v)}</p>${foot}</div>` });
      await stamp([n], 'noticeAt'); sent.push(n);
    } else if (fresh.length > 1) {                                   // several at once (e.g. first day): one email
      await mailer.send({ to: cfg.to, subject: `${fresh.length} loads not closed in TruckMate`, html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>These trucks / trailers moved on to new loads, but the previous load is still open:</p>${list(fresh)}${foot}</div>` });
      await stamp(fresh.map(([n]) => n), 'noticeAt'); sent.push(...fresh.map(([n]) => n));
    }
    // daily reminder of everything still open (after the set time, once a day)
    const hm = new Date(now()).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    const today = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const cfgNow = await db.get(cfgKey, {});
    const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const old = entries.filter(([n, v]) => v.noticeAt && !sent.includes(n) && dayOf(v.noticeAt) < today);   // first told on an earlier day
    if (old.length && hm >= cfg.time && cfgNow.lastReminder !== today) {
      await mailer.send({ to: cfg.to, subject: `Reminder: ${old.length} load${old.length === 1 ? '' : 's'} still not closed in TruckMate`, html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Good day,</p><p>Still open in TruckMate although the truck / trailer moved on:</p>${list(old)}${foot}</div>` });
      await db.update(cfgKey, (cur) => ({ ...(cur || {}), lastReminder: today }), {});
    }
    return sent;
  }
  if (enabled && mailer && env.UNCLOSED_EMAILS !== 'off') {
    const timer = setInterval(() => { notify('florida-beauty').catch((e) => console.warn('[finished] unclosed email:', e.message)); }, 10 * 60000);
    if (timer.unref) timer.unref();
  }
  app.get('/truckmate/unclosed/settings', requireAuth, async (req, res) => res.json({ ...(await settings()), outlook: !!(mailer && mailer.ready()) }));
  app.put('/truckmate/unclosed/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 20);
    const time = /^\d{2}:\d{2}$/.test(String(b.time || '')) ? b.time : '08:00';
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, time, updatedBy: who(req), updatedAt: new Date().toISOString() }), {}));
  });

  app.post('/truckmate/trips/:trip/finish', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const site = siteOf(req); const n = String(req.params.trip);
    const note = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    const reason = `marked finished by ${who(req)}${note ? ` — ${note}` : ''}`;
    try {
      await db.update(key(site), (cur) => ({ ...(cur || {}), [n]: { at: new Date().toISOString(), reason, by: who(req), auto: false } }), {});
      const active = await db.get(`taTruckMateActive:${site}`, { trips: {} });
      const rec = (active.trips || {})[n];
      if (rec && recordFinished) await recordFinished(site, rec.item, reason).catch(() => {});
      if (rec && onFinished) Promise.resolve(onFinished(site, rec, reason)).catch(() => {});
      res.json({ ok: true, trip: n, reason });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/truckmate/trips/:trip/reopen', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const site = siteOf(req); const n = String(req.params.trip);
    try {
      await db.update(key(site), (cur) => ({ ...(cur || {}), [n]: { reopened: true, at: new Date().toISOString(), by: who(req) } }), {});
      await db.update(`taTruckMateDelivered:${site}`, (cur) => ({ ...(cur || {}), items: ((cur && cur.items) || []).filter((x) => String(x.tripNumber) !== n) }), { items: [] });
      res.json({ ok: true, trip: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { sweep, notify };
}

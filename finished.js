// ---------------------------------------------------------------
// When is a load finished, even if TruckMate never says so?
//   1. TruckMate: delivered status, or every bill delivered
//   2. Geofence: every trip-sheet stop visited, or the LAST stop visited / delivered
//   3. (suggestion only) the same company truck has since left a shipper on a newer trip
//   4. A dispatcher clicked "Mark finished" (and can reopen it)
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

export function initFinished(app, { requireAuth, db, onFinished = null, recordFinished = null }) {
  const enabled = !!(db && db.enabled);
  const key = (site) => `taFinished:${site}`;
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';

  // Called while the board is built: takes finished loads out of `items` (in place).
  async function sweep(site, items, recs = {}) {
    if (!enabled || !items.length) return [];
    const fin = await db.get(key(site), {});
    const newly = [];
    for (const it of items) {
      const n = tripNo(it);
      if (!n || (fin[n] && !fin[n].reopened)) continue;
      if (fin[n] && fin[n].reopened) continue;                     // a person reopened it — no auto-finish
      const reason = finishReason(it, items);
      if (reason && isSure(reason)) newly.push({ n, it, reason });
      else if (reason) it._finishHint = `Probably finished — ${reason}`;
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
    for (let i = items.length - 1; i >= 0; i--) { const f = fin[tripNo(items[i])]; if (f && !f.reopened) items.splice(i, 1); }
    return newly.map((x) => ({ trip: x.n, reason: x.reason }));
  }

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

  return { sweep };
}

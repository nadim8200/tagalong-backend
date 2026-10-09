// ---------------------------------------------------------------
// Scheduled ETA updates — "email me the ETA every 3 hours for Native and Produce
// Junction until they're delivered". A dispatcher asks by email (or Ask Jarvis);
// Jarvis finds the loads (trip numbers or customer names on the board), sends the
// first update right away, then every N hours (current location, next stop, ETA),
// and a last "delivered" email — then stops on its own.
// ---------------------------------------------------------------
import { stopsOf, isDelivered } from './statusmail.js';
import { buildUpdateFor } from './updateemail.js';
import { isInternal } from './inbox.js';

const H = 3600000;
const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Loads still running for a customer name (bill-to, consignee, stop or trip-sheet customer). Pure.
export function loadsForCustomer(name, items = []) {
  const want = norm(name);
  if (want.length < 3) return [];
  const words = want.split(' ').filter((w) => w.length > 2 && !['INC', 'LLC', 'CORP', 'THE', 'CO'].includes(w));
  const hit = (s) => { const n = norm(s); return n && (n.includes(want) || (words.length && words.every((w) => n.includes(w)))); };
  return items.filter((it) => {
    if (isDelivered(it)) return false;
    const bills = (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
    const names = [...bills.flatMap((b) => [b.billToName, b.consignee && (b.consignee.name || b.consignee.clientName), b.endZoneDescription]), ...((it._manifest && it._manifest.stops) || []).map((s) => s.customer)];
    return names.some(hit);
  }).map(tripNo).filter(Boolean);
}

export function initEtaWatch(app, { requireAuth, db, sendMail, docs = null }) {
  const enabled = !!(db && db.enabled);
  const key = `taEtaWatch:${SITE}`;
  let last = { items: [], geo: () => null };

  // create: trips and/or customer names → the loads; first update goes now
  async function add({ trips = [], customers = [], to = [], everyHours = 3, by = 'dispatch', label = '' }, items = last.items) {
    const found = new Set(trips.filter((t) => items.some((it) => tripNo(it) === String(t))).map(String));
    const byName = {};
    for (const c of customers) { const l = loadsForCustomer(c, items); byName[c] = l; l.forEach((t) => found.add(t)); }
    const list = [...found].slice(0, 12);
    if (!list.length) return { ok: false, byName, error: `No running loads found for ${[...trips, ...customers].join(', ') || 'that request'}.` };
    const w = { id: `w${Date.now().toString(36)}`, trips: list, to: [...new Set(to.map((x) => String(x).toLowerCase()))].slice(0, 10), everyHours: Math.min(12, Math.max(1, Number(everyHours) || 3)), by, label: String(label || customers.join(' & ')).slice(0, 80), createdAt: new Date().toISOString(), sent: {}, done: {} };
    if (!w.to.length) return { ok: false, error: 'Who should get the updates?' };
    await db.update(key, (cur) => [...(Array.isArray(cur) ? cur : []), w].slice(-50), []);
    await run({ items, geo: last.geo, now: Date.now(), only: w.id });
    return { ok: true, watch: w, byName };
  }

  // every Watchtower cycle
  async function run({ items = last.items, geo = last.geo, now = Date.now(), only = null } = {}) {
    if (!enabled) return;
    last = { items, geo };
    const list = (await db.get(key, [])) || [];
    if (!list.length) return;
    const out = [];
    for (const w of list) {
      if (only && w.id !== only) { out.push(w); continue; }
      const pending = w.trips.filter((t) => !w.done[t]);
      for (const t of pending) if (!items.some((it) => tripNo(it) === t) && Date.parse(w.createdAt) < now - 2 * 24 * H) w.done[t] = 'left the board';
      const present = pending.filter((t) => items.some((it) => tripNo(it) === t));
      const newlyDelivered = present.filter((t) => isDelivered(items.find((it) => tripNo(it) === t)));
      const due = !w.lastSent || now - Date.parse(w.lastSent) >= w.everyHours * H;
      if (present.length && (due || newlyDelivered.length)) {
        try {
          // one delivery update for all the loads on this schedule (internal format when every recipient is our staff)
          const audience = w.to.every((x) => isInternal(x)) ? 'internal' : 'customer';
          const u = await buildUpdateFor({ db, docs, site: SITE, items, trips: present, customer: w.label || null, audience, now }); // eslint-disable-line no-await-in-loop
          await sendMail({ to: w.to, subject: u.subject, html: u.html, text: u.text }); // eslint-disable-line no-await-in-loop
          const iso = new Date(now).toISOString();
          w.lastSent = iso; present.forEach((t) => { w.sent[t] = iso; }); newlyDelivered.forEach((t) => { w.done[t] = iso; });
        } catch (e) { w.error = e.message; }
      }
      if (!w.trips.every((t) => w.done[t])) out.push(w);
    }
    await db.set(key, out);
  }

  app.get('/truckmate/eta-watch', requireAuth, async (req, res) => {
    const list = (await db.get(key, [])) || [];
    res.json(list.map((w) => ({ ...w, loads: w.trips.map((t) => ({ trip: t, lastSent: w.sent[t] || null, done: w.done[t] || null, stops: (() => { const it = last.items.find((x) => tripNo(x) === t); return it ? stopsOf(it).map((s) => s.name || s.place) : []; })() })) })));
  });
  app.delete('/truckmate/eta-watch/:id', requireAuth, async (req, res) => {
    await db.update(key, (cur) => (Array.isArray(cur) ? cur : []).filter((w) => w.id !== req.params.id), []);
    res.json({ ok: true });
  });
  return { add, run };
}

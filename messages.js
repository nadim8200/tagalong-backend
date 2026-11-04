// Phone & Messages: one shared company inbox. Every dispatcher sees the same conversations — texts on the
// company line (RingCentral) and TagAlong driver-app messages — with who sent each one; unread and pinned
// contacts are kept per dispatcher. It doesn't send anything itself: texts go through ringcentral.sendSms
// (STOP list + training mode) and app messages through the load's driver-app chat (driverlink.messageDriver).
//
//   GET  /truckmate/messages                 → conversations (newest first), my unread + pins, what can be sent
//   GET  /truckmate/messages/contacts?q=     → drivers, our team, customers & brokers (name, phone, truck, trip)
//   GET  /truckmate/messages/thread/:id      → one conversation (marks it read for me only)
//   POST /truckmate/messages/send            → { thread | phone, text, via: 'app' | 'sms', clientId }
//   POST /truckmate/messages/groups          → { members: [{ phone, name }], name?, trip? } a team-driver group
//   PUT  /truckmate/messages/pins            → { pins: [threadId | phone] } my favorites
//
// Conversations: 'p:<10 digits>' one person, 'g:<id>' a group (members fixed when it's made; a truck or driver
// change never edits them). Data: taMsgThreads / taMsgLog:<id> / taMsgRead / taMsgPins / taMsgSeen.
import { randomBytes } from 'node:crypto';

const SITE = 'florida-beauty';
const THREADS = `taMsgThreads:${SITE}`;
const logKey = (id) => `taMsgLog:${SITE}:${id}`;
const READ = `taMsgRead:${SITE}`;
const PINS = `taMsgPins:${SITE}`;
const SEEN = `taMsgSeen:${SITE}`;
const CONSENT = `taSmsConsent:${SITE}`;

export const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
export const personId = (phone) => `p:${last10(phone)}`;
const tripOf = (it) => (it && it.trip) || it || {};
const isStaff = (u) => !!(u && (u.admin || u.role === 'admin' || u.companyAdmin || u.role === 'dispatcher'));
const userKey = (u) => String((u && (u.id || u.email)) || 'unknown');
const nameOf = (u) => (u && (u.name || u.email)) || 'Dispatch';

// The drivers on each load (board), with their phones. Pure. → [{ trip, truck, trailer, drivers: [{ name, phone }] }]
export function loadsOf(board) {
  return (board || []).map((it) => {
    const t = tripOf(it); const s = it._samsara || {};
    const drivers = (it._oc ? [[it._oc.driverName, it._oc.driverPhone], [it._oc.driver2Name, it._oc.driver2Phone]] : [[s.driver1, s.driver1Info && s.driver1Info.phone], [s.driver2, s.driver2Info && s.driver2Info.phone]])
      .filter(([n, p]) => n || p).map(([name, phone]) => ({ name: name || null, phone: last10(phone) || null }));
    return { trip: String(t.tripNumber || ''), truck: t.powerUnit ? String(t.powerUnit) : null, trailer: t.trailer ? String(t.trailer) : null, drivers };
  }).filter((l) => l.trip);
}

// Unread for one dispatcher: inbound messages after they last opened it. Pure.
export const unreadOf = (thread, readAt) => (thread.inbound || []).filter((at) => !readAt || at > readAt).length;

// Same people? (a group is matched to a load's app chat only when its members are exactly that load's drivers) Pure.
export const samePeople = (a, b) => { const k = (l) => l.map((m) => last10(m.phone) || String(m.name || '').toLowerCase()).filter(Boolean).sort().join('|'); return k(a) === k(b); };

export function initMessages(app, { requireAuth, db, getBoard = null, activity = null, ringcentral = null, driverLinks = null, comms = null, staff = null, drivers = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const iso = () => new Date(now()).toISOString();
  const board = async () => { try { return getBoard ? ((await getBoard(SITE)) || {}).trips || [] : []; } catch { return []; } };
  const guard = (req, res) => { if (!enabled) { res.status(503).json({ error: 'Needs the database.' }); return false; } if (!isStaff(req.user)) { res.status(403).json({ error: 'Dispatch logins only.' }); return false; } return true; };
  const textingLive = async () => { try { const c = ringcentral && ringcentral.configFor ? await ringcentral.configFor('__shared') : null; return !!(c && c.fromNumber); } catch { return false; } };
  const keep = (ms, fn) => { let c = null; return () => { if (c && c.v !== undefined && now() - c.at < ms) return Promise.resolve(c.v); if (c && c.wait) return c.v !== undefined ? Promise.resolve(c.v) : c.wait; const wait = fn().then((v) => { c = { at: now(), v }; return v; }, (e) => { c = c && c.v !== undefined ? { at: c.at, v: c.v } : null; throw e; }); c = { ...(c || {}), wait }; return c.v !== undefined ? Promise.resolve(c.v) : wait; }; };
  const loadsNow = keep(30000, async () => loadsOf(await board()));   // who drives what: kept 30 s so opening a conversation is quick
  const textingLiveNow = keep(60000, textingLive);
  const appSending = new Map();   // trip|text → at: our own app sends, so the load-log echo isn't stored twice

  // one message into a conversation (made if new); a repeated provider event or a retried send is stored once
  async function add(thread, msg, dedupe = null) {
    if (dedupe) {
      let dup = false;
      await db.update(SEEN, (cur) => { const all = { ...(cur || {}) }; if (all[dedupe]) { dup = true; return all; } all[dedupe] = msg.at || iso(); const keys = Object.keys(all); return keys.length > 3000 ? Object.fromEntries(keys.slice(-2500).map((k) => [k, all[k]])) : all; }, {});
      if (dup) return null;
    }
    const m = { id: msg.id || randomBytes(6).toString('hex'), at: msg.at || iso(), ...msg, text: String(msg.text || '').slice(0, 1600) };
    await db.update(logKey(thread.id), (cur) => [...(Array.isArray(cur) ? cur : []).filter((x) => x.id !== m.id), m].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-500), []);
    await db.update(THREADS, (cur) => {
      const all = { ...(cur || {}) }; const t = { ...(all[thread.id] || thread) };
      for (const k of ['name', 'role', 'trip', 'truck']) if (thread[k] && !t[k]) t[k] = thread[k];
      if (!t.last || String(m.at) >= String(t.last.at)) t.last = { at: m.at, text: m.text.slice(0, 140), dir: m.dir, by: m.by || null, via: m.via };
      if (m.dir === 'in') t.inbound = [...(t.inbound || []), m.at].sort().slice(-100);
      all[thread.id] = t; return all;
    }, {});
    return m;
  }
  const personThread = (phone, w = {}) => ({ id: personId(phone), kind: 'person', phone: last10(phone), name: w.name || null, role: w.role || null, createdAt: iso() });

  // ---- what already happens elsewhere lands here (hooks from comms.js) ----
  // a text on the company line, either way (comms keeps its own per-phone thread too)
  async function fromSms(phone, e) {
    if (!enabled || last10(phone).length !== 10 || (e.type !== 'text' && e.type !== 'reply') || e.inboxId) return;
    const w = activity && activity.lookup ? await activity.lookup(phone).catch(() => null) : null;
    const dir = e.type === 'reply' ? 'in' : 'out';
    await add(personThread(phone, w || {}), { at: e.at, dir, via: 'sms', text: e.text, by: dir === 'in' ? ((w && w.name) || null) : (e.by || 'Dispatch'), from: dir === 'in' ? last10(phone) : null, trip: e.trip || null, status: dir === 'out' ? 'sent' : null },
      e.extId ? `sms:${e.extId}` : `sms:${dir}:${last10(phone)}:${e.at || ''}:${String(e.text || '').slice(0, 60)}`);
  }
  // a driver-app message on a load: one driver → their conversation; team drivers → the load's group
  async function threadForLoad(trip) {
    const l = (await loadsNow()).find((x) => x.trip === String(trip));
    if (!l || !l.drivers.length) return null;
    if (l.drivers.length === 1) return l.drivers[0].phone ? personThread(l.drivers[0].phone, { name: l.drivers[0].name, role: 'driver' }) : null;
    const all = (await db.get(THREADS, {})) || {};
    const g = Object.values(all).find((t) => t.kind === 'group' && t.trip === l.trip && samePeople(t.members || [], l.drivers));
    if (g) return g;
    // made once from the load's app chat (both drivers already share it); members never change after this
    return { id: `g:${randomBytes(5).toString('hex')}`, kind: 'group', members: l.drivers.map((d) => ({ ...d, role: 'driver' })), name: l.drivers.map((d) => d.name).filter(Boolean).join(' + ') || `Team on trip ${l.trip}`, trip: l.trip, truck: l.truck, createdBy: 'the load\'s app chat', createdAt: iso() };
  }
  async function fromApp(trip, e) {
    if (!enabled || !trip) return;
    const app2 = e.kind === 'app-message' || e.to === 'driver app' || e.from === 'driver app';
    if (!app2) return;
    const dir = e.type === 'reply' ? 'in' : 'out';
    const k = `${trip}|${String(e.text || '').trim()}`;
    if (dir === 'out' && appSending.has(k) && now() - appSending.get(k) < 120000) { appSending.delete(k); return; }
    const t = await threadForLoad(trip);
    if (!t) return;
    await add(t, { at: e.at, dir, via: 'app', text: e.text, by: dir === 'in' ? (e.by || 'Driver (app)') : (e.by || 'Dispatch'), trip: String(trip), status: dir === 'out' ? 'sent' : null },
      e.extId ? `app:${e.extId}` : `app:${dir}:${trip}:${e.at || ''}:${String(e.text || '').slice(0, 60)}`);
  }

  // ---- what a conversation can send right now (never pretends) ----
  async function channels(t, loads, live, consent) {
    const out = { app: null, sms: null };
    if (t.kind === 'group') {
      const l = loads.find((x) => x.trip === t.trip);
      out.app = l && samePeople(t.members || [], l.drivers) ? { ok: true, trip: l.trip } : { ok: false, why: t.trip ? `The drivers on trip ${t.trip} changed (or it was delivered): this group can't use that load's app chat.` : 'Group app messages go through a load both drivers are on.' };
      out.sms = { ok: false, why: live ? 'Group texting on RingCentral isn\'t verified yet. Use the app, or text each driver.' : 'Texting starts when RingCentral approves the company number.' };
      return out;
    }
    const l = loads.find((x) => x.drivers.some((d) => d.phone === t.phone));
    out.app = l ? { ok: true, trip: l.trip } : { ok: false, why: 'App messages reach drivers on a load (not on the board now).' };
    if (!live) out.sms = { ok: false, why: 'Texting starts when RingCentral approves the company number.' };
    else if ((t.role === 'driver' || l) && !consent[t.phone]) out.sms = { ok: false, why: 'Record that the driver agreed to texts first (trip card → Text).' };
    else out.sms = { ok: true };
    return out;
  }

  // everyone to call or text: drivers on loads (with truck / trip), every driver profile, our team, customers & brokers.
  // Built in parallel and kept for a minute (one build at a time), so a search answers right away.
  let dirCache = null;
  async function directoryNow() {
    const [loads, roster, people, profiles] = await Promise.all([
      loadsNow(),
      (drivers ? drivers() : Promise.resolve([])).catch(() => []),
      (staff ? staff() : Promise.resolve([])).catch(() => []),
      db.get(`taProfiles:${SITE}`, {}).catch(() => ({})),
    ]);
    const out = new Map();
    const put = (c) => { if (!c.phone || c.phone.length !== 10) return; const had = out.get(c.phone); out.set(c.phone, had ? { ...c, ...had, trips: [...new Set([...(had.trips || []), ...(c.trips || [])])] } : c); };
    for (const l of loads) for (const d of l.drivers) put({ phone: d.phone, name: d.name, role: 'driver', truck: l.truck, trailer: l.trailer, trips: [l.trip] });
    for (const d of roster || []) for (const ph of [d.phone, ...(d.phones || []).map((x) => (x && x.number) || x)]) put({ phone: last10(ph), name: d.name || null, role: 'driver', truck: d.truck || null, trailer: d.trailer || null, trips: [] });
    for (const p of people || []) put({ phone: last10(p.phone), name: p.name || null, role: 'team', detail: p.department || null });
    for (const p of Object.values(profiles || {})) for (const c of p.contacts || []) put({ phone: last10(c.phone), name: c.name || p.name || null, role: p.type === 'broker' ? 'broker' : 'customer', detail: p.name || null });
    return [...out.values()].sort((a, b) => String(a.name || '~').localeCompare(String(b.name || '~')));
  }
  function directory() {
    if (dirCache && dirCache.list && now() - dirCache.at < 60000) return Promise.resolve(dirCache.list);
    if (dirCache && dirCache.wait) return dirCache.list ? Promise.resolve(dirCache.list) : dirCache.wait;   // a stale list answers while the new one builds
    const wait = directoryNow().then((list) => { dirCache = { at: now(), list }; return list; }, (e) => { dirCache = dirCache && dirCache.list ? { at: dirCache.at, list: dirCache.list } : null; throw e; });
    dirCache = { ...(dirCache || {}), wait };
    return dirCache.list ? Promise.resolve(dirCache.list) : wait;
  }

  // who a number is: the contact list first (already built), else the slower who-is lookup
  async function whoFast(phone) {
    const k = last10(phone);
    const c = dirCache && dirCache.list ? dirCache.list.find((x) => x.phone === k) : null;
    if (c) return { name: c.name, role: c.role };
    return activity && activity.lookup ? activity.lookup(k).catch(() => null) : null;
  }
  // team drivers by truck, for "group text both drivers" from a search. Pure. → [{ truck, trailer, trip, drivers }]
  const teamsFor = (loads, q) => { const w = String(q || '').toLowerCase().trim(); if (w.length < 2) return []; const seen = new Set(); return loads.filter((l) => l.drivers.length >= 2 && l.drivers.every((d) => d.phone) && JSON.stringify([l.truck, l.trailer, l.trip, l.drivers.map((d) => d.name)]).toLowerCase().includes(w)).filter((l) => { const k = l.drivers.map((d) => d.phone).sort().join('|'); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5); };

  const view = (t, me, reads, pins) => ({ ...t, inbound: undefined, unread: unreadOf(t, (reads[me] || {})[t.id]), pinned: (pins[me] || []).includes(t.id) });

  if (app) {
    app.get('/truckmate/messages', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const me = userKey(req.user);
      directory().catch(() => {});   // warm the contact list, so the first search is quick
      const [all, reads, pins, live] = await Promise.all([db.get(THREADS, {}), db.get(READ, {}), db.get(PINS, {}), textingLiveNow()]);
      const threads = Object.values(all || {}).sort((a, b) => String((b.last || {}).at || b.createdAt).localeCompare(String((a.last || {}).at || a.createdAt))).slice(0, 400).map((t) => view(t, me, reads || {}, pins || {}));
      res.json({ me: nameOf(req.user), threads, pins: (pins || {})[me] || [], texting: { live, groupSms: false } });
    });

    app.get('/truckmate/messages/thread/:id', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const id = String(req.params.id);
      const all = (await db.get(THREADS, {})) || {};
      const t = all[id] || (/^p:\d{10}$/.test(id) ? personThread(id.slice(2), (await whoFast(id.slice(2))) || {}) : null);
      if (!t) return res.status(404).json({ error: 'No such conversation.' });
      const me = userKey(req.user);
      const [messages, loads, live, consent, pins] = await Promise.all([db.get(logKey(id), []), loadsNow(), textingLiveNow(), db.get(CONSENT, {}), db.get(PINS, {})]);
      const reads = await db.update(READ, (cur) => ({ ...(cur || {}), [me]: { ...((cur || {})[me] || {}), [id]: iso() } }), {});
      const ctx = t.kind === 'person' ? loads.find((l) => l.drivers.some((d) => d.phone === t.phone)) : loads.find((l) => l.trip === t.trip);
      res.json({ thread: { ...view(t, me, reads || {}, pins || {}), now: ctx ? { trip: ctx.trip, truck: ctx.truck, trailer: ctx.trailer } : null }, messages: messages || [], can: await channels(t, loads, live, consent || {}) });
    });

    app.post('/truckmate/messages/thread/:id/unread', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const me = userKey(req.user);
      await db.update(READ, (cur) => { const mine = { ...((cur || {})[me] || {}) }; delete mine[String(req.params.id)]; return { ...(cur || {}), [me]: mine }; }, {});
      res.json({ ok: true });
    });

    app.post('/truckmate/messages/send', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const b = req.body || {};
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return res.status(400).json({ error: 'Write a message first.' });
      const clientId = String(b.clientId || '').replace(/[^\w-]/g, '').slice(0, 40);
      if (!clientId) return res.status(400).json({ error: 'Missing clientId.' });
      const all = (await db.get(THREADS, {})) || {};
      const id = b.thread ? String(b.thread) : last10(b.phone).length === 10 ? personId(b.phone) : null;
      if (!id) return res.status(400).json({ error: 'Pick a contact or enter a 10-digit number.' });
      const t = all[id] || (id.startsWith('p:') ? personThread(id.slice(2), (await whoFast(id.slice(2))) || {}) : null);
      if (!t) return res.status(404).json({ error: 'No such conversation.' });
      // a retried send (same clientId) returns what the first one did
      const seen = ((await db.get(SEEN, {})) || {})[`send:${clientId}`];
      if (seen) return res.json({ ok: true, duplicate: true });
      const [loads, live, consent] = await Promise.all([loadsNow(), textingLiveNow(), db.get(CONSENT, {})]);
      const can = await channels(t, loads, live, consent || {});
      const via = b.via === 'sms' ? 'sms' : 'app';
      if (!can[via].ok) return res.status(409).json({ error: can[via].why });
      const by = nameOf(req.user);
      try {
        let status = 'sent'; let note = null;
        if (via === 'app') {
          const k = `${can.app.trip}|${text}`; appSending.set(k, now());
          const r = await driverLinks.messageDriver(SITE, can.app.trip, text, by);
          if (r && r.skipped) { appSending.delete(k); return res.status(409).json({ error: `Not sent: ${r.skipped}.` }); }
          status = /held/.test(String((r && r.via) || '')) ? 'held' : 'sent';
          note = (r && r.via) || null;
        } else {
          const r = await ringcentral.sendSms('__shared', { to: t.phone, text, by });
          status = r && r.id === 'training' ? 'held' : 'sent';
          note = r && r.status ? String(r.status) : null;
          if (comms && comms.log) { const l = loads.find((x) => x.drivers.some((d) => d.phone === t.phone)); await comms.log(SITE, l ? l.trip : null, { type: 'text', kind: 'custom', to: t.phone, text, by, inboxId: clientId }).catch(() => {}); }
        }
        const m = await add(t, { dir: 'out', via, text, by, status, note, trip: (can[via] && can[via].trip) || t.trip || null }, `send:${clientId}`);
        res.json({ ok: true, message: m });
      } catch (e) {
        // a failed send is shown as failed (not retried silently); sending again uses a new clientId
        await add(t, { dir: 'out', via, text, by, status: 'failed', note: String(e.message || 'failed').slice(0, 200) }, `send:${clientId}`);
        res.status(502).json({ error: e.message || 'Could not send.' });
      }
    });

    app.post('/truckmate/messages/groups', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const b = req.body || {};
      const members = (Array.isArray(b.members) ? b.members : []).map((m) => ({ name: String(m.name || '').slice(0, 80) || null, phone: last10(m.phone), role: m.role === 'driver' ? 'driver' : (m.role || null) })).filter((m) => m.phone.length === 10);
      const uniq = [...new Map(members.map((m) => [m.phone, m])).values()];
      if (uniq.length < 2) return res.status(400).json({ error: 'A group needs at least two people with phone numbers.' });
      if (uniq.length > 9) return res.status(400).json({ error: 'Groups are up to 9 people.' });
      // the truck / trip only when it's verified: those exact people are the drivers on that load now
      const loads = await loadsNow();
      const l = b.trip ? loads.find((x) => x.trip === String(b.trip)) : loads.find((x) => samePeople(x.drivers, uniq));
      const verified = l && samePeople(l.drivers, uniq) ? l : null;
      const all = (await db.get(THREADS, {})) || {};
      const same = Object.values(all).find((t) => t.kind === 'group' && samePeople(t.members || [], uniq) && (t.trip || null) === (verified ? verified.trip : null));
      if (same) return res.json({ ok: true, thread: same, existing: true });
      const t = { id: `g:${randomBytes(5).toString('hex')}`, kind: 'group', members: uniq, name: String(b.name || '').trim().slice(0, 60) || uniq.map((m) => m.name || `…${m.phone.slice(-4)}`).join(' + '), trip: verified ? verified.trip : null, truck: verified ? verified.truck : null, createdBy: nameOf(req.user), createdAt: iso() };
      await db.update(THREADS, (cur) => ({ ...(cur || {}), [t.id]: t }), {});
      res.json({ ok: true, thread: t });
    });

    app.put('/truckmate/messages/pins', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const pins = [...new Set((Array.isArray((req.body || {}).pins) ? req.body.pins : []).map(String).filter((p) => /^(p:\d{10}|g:[a-f0-9]{10})$/.test(p)))].slice(0, 12);
      await db.update(PINS, (cur) => ({ ...(cur || {}), [userKey(req.user)]: pins }), {});
      res.json({ ok: true, pins });
    });

    app.get('/truckmate/messages/contacts', requireAuth, async (req, res) => {
      if (!guard(req, res)) return;
      const q = String(req.query.q || '').toLowerCase().trim(); const qd = q.replace(/\D/g, '');
      const all = await directory();
      const list = all.filter((c) => !q || JSON.stringify([c.name, c.detail, c.truck, c.trailer, c.trips]).toLowerCase().includes(q) || (qd.length >= 3 && c.phone.includes(qd)));
      res.json({ contacts: list.slice(0, 600), teams: teamsFor(await loadsNow(), q), newNumber: qd.length === 10 && !all.some((c) => c.phone === qd) ? qd : null });
    });
  }

  console.log(`[messages] shared inbox ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { fromSms, fromApp, add };
}

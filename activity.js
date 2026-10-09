// ---------------------------------------------------------------
// Calls & texts log — every Jarvis call (in and out) and every text / app message,
// saved by day so anyone signed in can see who called, who was texted, from which
// number to which number, and what was said (full transcript + summary + recording).
// Each entry is matched to who it was with: a customer or broker profile (by phone),
// a driver on the board, our own team, or unknown.
// ---------------------------------------------------------------
import { randomBytes } from 'crypto';

const SITE = 'florida-beauty';
const TZ = 'America/New_York';
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
export const dayOf = (iso) => new Date(iso || Date.now()).toLocaleDateString('en-CA', { timeZone: TZ });
const tripOf = (it) => (it && it.trip) || it || {};

// Who a phone number belongs to. Pure.
export function whoIs(phone, { profiles = {}, drivers = new Map(), team = [] } = {}) {
  const P = last10(phone);
  if (!P) return { role: 'unknown' };
  const t = team.find((m) => last10(m.phone) === P);
  if (t) return { role: 'team', name: t.name || null, detail: t.team || null };
  if (drivers.has(P)) { const d = drivers.get(P); return { role: 'driver', name: d.name || null, detail: d.trips ? `load ${d.trips.join(', ')}` : null }; }
  for (const p of Object.values(profiles)) {
    const c = (p.contacts || []).find((x) => last10(x.phone) === P);
    if (c) return { role: p.type === 'broker' ? 'broker' : 'customer', name: c.name || null, detail: `${p.name}${p.office && (p.office.city || p.office.state) ? ` — ${[p.office.city, p.office.state].filter(Boolean).join(', ')}` : ''}` };
  }
  return { role: 'unknown' };
}

// Should this entry ping phones, and which push type is it (admin → Push notifications)?
// Calls once they have ended (one push per call, with the summary when it is ready);
// texts / app messages as they come in or go out. Pure.
export function pushFor(e) {
  if (!e) return null;
  const who = e.name || fmt(e.kind === 'call' ? (e.direction === 'outbound' ? e.to : e.from) : (e.dir === 'in' ? e.from : e.to));
  if (e.kind === 'call') {
    const out = e.direction === 'outbound';
    if (!e.ended && !e.summary) return null;
    return { type: out ? 'call-out' : 'call-in', title: out ? `📞 Jarvis called ${who}` : `📞 ${who} called Jarvis`, body: `${e.trip ? `Load ${e.trip} · ` : ''}${e.summary || (e.minutes != null ? `${e.minutes} min call` : 'Call ended')}`.slice(0, 180) };
  }
  const inbound = e.dir === 'in';
  const label = e.kind === 'app' ? 'App message' : 'Text';
  return { type: inbound ? 'text-in' : 'text-out', title: inbound ? `💬 ${label} from ${who}` : `💬 ${label} to ${who}`, body: `${e.trip ? `Load ${e.trip} · ` : ''}${e.text || ''}`.slice(0, 180) };
}

// The callback request that came out of a call (its ref starts with the call id). Pure.
export function callbackOf(callId, requests = []) {
  if (!callId) return null;
  const hits = (requests || []).filter((r) => r && r.source === 'call' && String(r.ref || '').split(':')[0] === String(callId));
  const r = hits.find((x) => x.status !== 'handled') || hits[0];
  return r ? { id: r.id, status: r.status === 'handled' ? 'handled' : 'open', need: r.need || null, urgent: !!r.urgent, handledBy: r.handledBy || null, handledAt: r.handledAt || null, owner: r.owner || null, dueAt: r.dueAt || null, teams: (r.sent && r.sent.teams) || [] } : null;
}
const fmt = (p) => { const d = last10(p); return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || 'unknown number'); };

export function initActivity(app, { requireAuth, db, getBoard = null, push = null, pushRules = null }) {
  const enabled = !!(db && db.enabled);
  const key = (day) => `taActivity:${SITE}:${day}`;
  const daysKey = `taActivityDays:${SITE}`;

  // add (or update, same id) one entry on its day
  async function record(e) {
    if (!enabled || !e) return null;
    const at = e.at || new Date().toISOString();
    const entry = { id: e.id || randomBytes(6).toString('hex'), ...e, at };
    const day = dayOf(at);
    let note = null;
    const list = await db.update(key(day), (cur) => {
      const l = Array.isArray(cur) ? cur : [];
      const i = l.findIndex((x) => x.id === entry.id);
      const merged = i >= 0 ? { ...l[i], ...entry, at: l[i].at || at } : entry;
      // one push per entry — decided inside the same transaction so repeat webhooks can't double-ping
      note = null;
      if (!merged.pushed) { note = pushFor(merged); if (note) merged.pushed = new Date().toISOString(); }
      if (i >= 0) { const copy = [...l]; copy[i] = merged; return copy; }
      return [merged, ...l].slice(0, 3000);
    }, []);
    await db.update(daysKey, (cur) => ({ ...(cur || {}), [day]: (list || []).length }), {});
    if (note && push && push.sendToEmails && pushRules) {
      try {
        const to = await pushRules.emailsFor(note.type);
        if (to.length) await push.sendToEmails(to, { title: note.title, body: note.body, data: { type: 'activity', id: entry.id, day, path: '/truckmate?tab=calls' } });
      } catch (err) { console.error('[activity] push failed:', err.message); }
    }
    return entry;
  }

  async function context() {
    const [profiles, help] = await Promise.all([db.get(`taProfiles:${SITE}`, {}), db.get('taHelpCfg', {})]);
    const drivers = new Map();
    try {
      for (const it of ((getBoard && (await getBoard(SITE))) || {}).trips || []) {
        const s = it._samsara || {};
        const list = it._oc ? [[it._oc.driverPhone, it._oc.driverName], [it._oc.driver2Phone, it._oc.driver2Name]] : [[s.driver1Info && s.driver1Info.phone, s.driver1], [s.driver2Info && s.driver2Info.phone, s.driver2]];
        for (const [ph, name] of list) { const P = last10(ph); if (!P) continue; const d = drivers.get(P) || { name, trips: [] }; d.trips.push(String(tripOf(it).tripNumber)); drivers.set(P, d); }
      }
    } catch { /* board unavailable */ }
    const team = ((help && help.teams) || []).flatMap((t) => (t.members || []).map((m) => ({ ...m, team: t.name })));
    return { profiles: profiles || {}, drivers, team };
  }

  app.get('/truckmate/activity/days', requireAuth, async (req, res) => {
    const d = (await db.get(daysKey, {})) || {};
    res.json(Object.entries(d).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 120).map(([day, count]) => ({ day, count })));
  });
  app.get('/truckmate/activity', requireAuth, async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : dayOf();
    const list = (await db.get(key(day), [])) || [];
    const ctx = await context();
    const requests = (await db.get(`taHelpRequests:${SITE}`, [])) || [];
    const type = String(req.query.type || 'all');
    const q = String(req.query.q || '').toLowerCase();
    const out = list.map((e) => {
      const other = e.kind === 'call' ? (e.direction === 'outbound' ? e.to : e.from) : (e.dir === 'in' ? e.from : e.to);
      const w = e.role && e.role !== 'unknown' ? { role: e.role, name: e.name || null, detail: e.detail || null } : whoIs(other, ctx);
      const callback = e.kind === 'call' ? callbackOf(String(e.id || '').replace(/^call:/, ''), requests) : null;
      return { ...e, otherPhone: other || null, role: w.role, name: e.name || w.name || null, detail: e.detail || w.detail || null, callback };
    }).filter((e) => (type === 'all' || e.role === type || (type === 'callback' && e.callback && e.callback.status === 'open')) && (!q || JSON.stringify([e.name, e.detail, e.otherPhone, e.trip, e.summary, e.text, e.transcript]).toLowerCase().includes(q)));
    res.json({ day, entries: out.sort((a, b) => String(b.at).localeCompare(String(a.at))) });
  });

  // one call (for a callback request: "hear the call / read the transcript")
  app.get('/truckmate/activity/call/:callId', requireAuth, async (req, res) => {
    const id = `call:${String(req.params.callId)}`;
    const around = Date.parse(String(req.query.at || '')) || Date.now();
    for (const d of [0, -1, 1]) {
      const list = (await db.get(key(dayOf(new Date(around + d * 86400000).toISOString())), [])) || []; // eslint-disable-line no-await-in-loop
      const e = list.find((x) => x.id === id);
      if (e) return res.json(e);
    }
    res.status(404).json({ error: 'That call is not in the log (calls are logged from Oct 8 on).' });
  });

  return { record };
}

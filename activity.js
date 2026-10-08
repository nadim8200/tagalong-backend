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

// Should this entry ping phones? Calls once they have ended (one push per call, with
// the summary when it is ready); texts / app messages as they come in or go out. Pure.
export function pushFor(e, cfg = {}) {
  if (!e || !cfg || !(cfg.emails || []).length) return null;
  const who = e.name || fmt(e.kind === 'call' ? (e.direction === 'outbound' ? e.to : e.from) : (e.dir === 'in' ? e.from : e.to));
  if (e.kind === 'call') {
    const out = e.direction === 'outbound';
    if (!(out ? cfg.callsOut : cfg.callsIn !== false)) return null;
    if (!e.ended && !e.summary) return null;
    return { title: out ? `📞 Jarvis called ${who}` : `📞 ${who} called Jarvis`, body: `${e.trip ? `Load ${e.trip} · ` : ''}${e.summary || (e.minutes != null ? `${e.minutes} min call` : 'Call ended')}`.slice(0, 180) };
  }
  const inbound = e.dir === 'in';
  if (!(inbound ? cfg.textsIn !== false : cfg.textsOut)) return null;
  const label = e.kind === 'app' ? 'App message' : 'Text';
  return { title: inbound ? `💬 ${label} from ${who}` : `💬 ${label} to ${who}`, body: `${e.trip ? `Load ${e.trip} · ` : ''}${e.text || ''}`.slice(0, 180) };
}
const fmt = (p) => { const d = last10(p); return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || 'unknown number'); };

export function initActivity(app, { requireAuth, db, getBoard = null, push = null }) {
  const enabled = !!(db && db.enabled);
  const key = (day) => `taActivity:${SITE}:${day}`;
  const daysKey = `taActivityDays:${SITE}`;
  const pushKey = `taActivityPush:${SITE}`;
  const PUSH_DEFAULT = { emails: [], callsIn: true, callsOut: false, textsIn: true, textsOut: false };

  // add (or update, same id) one entry on its day
  async function record(e) {
    if (!enabled || !e) return null;
    const at = e.at || new Date().toISOString();
    const entry = { id: e.id || randomBytes(6).toString('hex'), ...e, at };
    const day = dayOf(at);
    const cfg = push && push.sendToEmails ? { ...PUSH_DEFAULT, ...((await db.get(pushKey, {})) || {}) } : null;
    let note = null;
    const list = await db.update(key(day), (cur) => {
      const l = Array.isArray(cur) ? cur : [];
      const i = l.findIndex((x) => x.id === entry.id);
      const merged = i >= 0 ? { ...l[i], ...entry, at: l[i].at || at } : entry;
      // one push per entry — decided inside the same transaction so repeat webhooks can't double-ping
      note = null;
      if (cfg && !merged.pushed) { note = pushFor(merged, cfg); if (note) merged.pushed = new Date().toISOString(); }
      if (i >= 0) { const copy = [...l]; copy[i] = merged; return copy; }
      return [merged, ...l].slice(0, 3000);
    }, []);
    await db.update(daysKey, (cur) => ({ ...(cur || {}), [day]: (list || []).length }), {});
    if (note) { try { await push.sendToEmails(cfg.emails, { ...note, data: { type: 'activity', id: entry.id, day, path: '/truckmate?tab=calls' } }); } catch (err) { console.error('[activity] push failed:', err.message); } }
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

  // who gets a phone push (TagAlong app) for calls and texts, and for which kinds
  const splitEmails = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 50);
  app.get('/truckmate/activity/push', requireAuth, async (req, res) => {
    const cfg = { ...PUSH_DEFAULT, ...((await db.get(pushKey, {})) || {}) };
    let phones = [];
    try { phones = push && push.phonesFor ? await push.phonesFor(cfg.emails) : []; } catch { phones = []; }
    res.json({ ...cfg, ready: !!(push && push.enabled), phones });
  });
  app.put('/truckmate/activity/push', requireAuth, async (req, res) => {
    const b = req.body || {};
    const cfg = { emails: splitEmails(b.emails), callsIn: b.callsIn !== false, callsOut: !!b.callsOut, textsIn: b.textsIn !== false, textsOut: !!b.textsOut };
    await db.set(pushKey, cfg);
    res.json(cfg);
  });

  app.get('/truckmate/activity/days', requireAuth, async (req, res) => {
    const d = (await db.get(daysKey, {})) || {};
    res.json(Object.entries(d).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 120).map(([day, count]) => ({ day, count })));
  });
  app.get('/truckmate/activity', requireAuth, async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : dayOf();
    const list = (await db.get(key(day), [])) || [];
    const ctx = await context();
    const type = String(req.query.type || 'all');
    const q = String(req.query.q || '').toLowerCase();
    const out = list.map((e) => {
      const other = e.kind === 'call' ? (e.direction === 'outbound' ? e.to : e.from) : (e.dir === 'in' ? e.from : e.to);
      const w = e.role && e.role !== 'unknown' ? { role: e.role, name: e.name || null, detail: e.detail || null } : whoIs(other, ctx);
      return { ...e, otherPhone: other || null, role: w.role, name: e.name || w.name || null, detail: e.detail || w.detail || null };
    }).filter((e) => (type === 'all' || e.role === type) && (!q || JSON.stringify([e.name, e.detail, e.otherPhone, e.trip, e.summary, e.text, e.transcript]).toLowerCase().includes(q)));
    res.json({ day, entries: out.sort((a, b) => String(b.at).localeCompare(String(a.at))) });
  });

  return { record };
}

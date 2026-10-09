// ---------------------------------------------------------------
// Company directory — who works where, by department, with extensions.
// What Jarvis may SAY or WRITE about staff (calls, emails, texts, chat): first and
// last name, department and extension, plus the main number. Cell phones (and emails)
// are SYSTEM-ONLY: Jarvis uses them to text / call a staff member with a message
// ("a customer called — here's what they need"). They never leave the server except
// to that person, and only admins can see them in the console.
// ---------------------------------------------------------------
import { DEPARTMENTS, MAIN_NUMBER, UNCLEAR } from './staff-directory.js';

const KEY = 'taStaffDirectory';
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

export function seedPeople() {
  let n = 0;
  return DEPARTMENTS.flatMap(([dept, deptExt, people]) => people.map(([name, ext, phone, note, email]) => ({ id: `s${(n += 1)}`, name, department: dept, departmentExt: deptExt || null, ext: ext || null, phone: last10(phone), note: note || null, email: email || null, channels: { text: true, email: true, call: false }, active: true })));
}
// What anyone may hear / read about a staff member. Pure.
export const publicView = (p, main = MAIN_NUMBER) => ({ name: p.name, department: p.department, extension: p.ext || null, departmentLine: p.departmentExt || null, role: p.note && !/^col$/i.test(p.note) ? p.note : null, mainNumber: main });

// Find staff by name, department or role ("Rosa", "Frank Ducassi", "billing", "payroll", "claims"). Pure.
export function findStaff(people, query, max = 6) {
  const q = fold(query);
  if (q.length < 2) return [];
  const words = q.split(' ').filter((w) => w.length > 1);
  const act = people.filter((p) => p.active !== false);
  const full = act.filter((p) => fold(p.name) === q || (words.length >= 2 && words.every((w) => fold(p.name).split(' ').some((x) => x.startsWith(w)))));
  if (full.length) return full.slice(0, max);
  const byName = act.filter((p) => fold(p.name).split(' ').some((x) => words.some((w) => w.length >= 3 && (x === w || (w.length >= 4 && x.startsWith(w))))));
  if (byName.length) return byName.slice(0, max);
  const dept = act.filter((p) => words.some((w) => w.length >= 3 && (fold(p.department).includes(w) || fold(p.note).includes(w))));
  return dept.slice(0, max);
}
// Staff named in a message ("please have Frank Ducassi call me", "tell Rosa…"): full
// names, or a first / last name that only one person has. Pure.
export function mentionedStaff(people, text) {
  const t = ` ${fold(text)} `;
  const act = people.filter((p) => p.active !== false);
  const out = act.filter((p) => t.includes(` ${fold(p.name)} `));
  const count = (part, i) => act.filter((p) => fold(p.name).split(' ')[i] === part).length;
  for (const p of act) {
    if (out.includes(p)) continue;
    const parts = fold(p.name).split(' ');
    const first = parts[0]; const lastN = parts[parts.length - 1];
    const firstHit = first.length >= 3 && count(first, 0) === 1 && new RegExp(`(?:^|\\s)${first}(?=\\s)`).test(t) && new RegExp(`\\b${first.charAt(0)}${first.slice(1).toLowerCase()}\\b`).test(String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
    const lastHit = lastN.length >= 4 && act.filter((x) => fold(x.name).split(' ').slice(-1)[0] === lastN).length === 1 && t.includes(` ${lastN} `);
    if (firstHit || lastHit) out.push(p);
  }
  return out.slice(0, 3);
}

// How Jarvis reaches a staff member: their chosen channels, falling back to a call
// while company texting isn't live. Pure.
export function reachPlan(p, { textingLive = false } = {}) {
  const ch = p.channels || { text: true, email: true, call: false };
  return {
    email: !!(ch.email && p.email),
    text: !!(ch.text && p.phone && textingLive),
    call: !!(p.phone && (ch.call || (ch.text && !textingLive))),
  };
}

export function initDirectory(app, { requireAuth, requireAdmin, db, contact = null }) {
  const enabled = !!(db && db.enabled);
  let cache = { at: 0, d: null };
  async function load() {
    if (!enabled) return { main: MAIN_NUMBER, people: seedPeople() };
    if (cache.d && Date.now() - cache.at < 60000) return cache.d;
    let d = await db.get(KEY, null);
    if (!d) { d = { main: MAIN_NUMBER, people: seedPeople(), seededAt: new Date().toISOString() }; await db.set(KEY, d); }
    cache = { at: Date.now(), d };
    return d;
  }
  const isAdmin = (u) => !!(u && (u.admin || u.role === 'admin'));

  // the Employees tab is for admins only (Jarvis itself uses the directory for everyone)
  app.get('/truckmate/directory', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    const d = await load();
    // dispatchers see what Jarvis may share; admins also see the system-only cell / email
    res.json({ main: d.main, unclear: isAdmin(req.user) ? UNCLEAR : [], people: d.people.map((p) => (isAdmin(req.user) ? p : { id: p.id, ...publicView(p, d.main), active: p.active })) });
  });
  app.put('/admin/directory', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const people = (Array.isArray(b.people) ? b.people : []).filter((p) => p && p.name).slice(0, 400).map((p, i) => ({ id: p.id || `s${Date.now().toString(36)}${i}`, name: String(p.name).slice(0, 80), department: String(p.department || 'Other').slice(0, 60), departmentExt: p.departmentExt ? String(p.departmentExt).slice(0, 30) : null, ext: p.ext ? String(p.ext).replace(/[^\d/ ]/g, '').slice(0, 12) || null : null, phone: last10(p.phone), note: p.note ? String(p.note).slice(0, 60) : null, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email || '')) ? String(p.email).toLowerCase() : null, channels: { text: !p.channels || p.channels.text !== false, email: !p.channels || p.channels.email !== false, call: !!(p.channels && p.channels.call) }, active: p.active !== false }));
    const d = { main: String(b.main || MAIN_NUMBER).slice(0, 20), people, updatedAt: new Date().toISOString() };
    await db.set(KEY, d); cache = { at: Date.now(), d };
    res.json({ ok: true, count: people.length });
  });

  // anyone signed in can have Jarvis reach a staff member (they never see the number)
  app.post('/truckmate/directory/:id/contact', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    const d = await load();
    const p = d.people.find((x) => x.id === req.params.id && x.active !== false);
    if (!p) return res.status(404).json({ error: 'Not in the directory.' });
    const b = req.body || {};
    const message = String(b.message || '').trim().slice(0, 600);
    if (!message) return res.status(400).json({ error: 'Write the message first.' });
    if (!contact) return res.status(503).json({ error: 'Messaging is not set up.' });
    const by = (req.user && (req.user.name || req.user.email)) || 'dispatcher';
    const textingLive = await contact.textingLive().catch(() => false);
    const want = Array.isArray(b.via) && b.via.length ? new Set(b.via) : null;
    const plan = reachPlan(p, { textingLive });
    const out = {};
    const body = `Florida Beauty dispatch (Jarvis) for ${p.name.split(' ')[0]}: ${message} — sent by ${by}`;
    if (plan.email && (!want || want.has('email'))) { try { await contact.email(p.email, `Message from ${by} (via Jarvis)`, body); out.email = 'sent'; } catch (e) { out.email = `failed: ${e.message}`; } }
    if (plan.text && (!want || want.has('text'))) { try { const r = await contact.text(p.phone, body); out.text = r && r.training ? 'held (training mode)' : 'sent'; } catch (e) { out.text = `failed: ${e.message}`; } }
    if (plan.call && (!want || want.has('call') || (want.has('text') && !textingLive))) { try { const r = await contact.call({ to: p.phone, name: p.name, message: `${message} — from ${by}` }); out.call = r && r.called ? 'calling' : (r && r.skipped) || 'not called'; } catch (e) { out.call = `failed: ${e.message}`; } }
    if (!Object.keys(out).length) return res.status(409).json({ error: p.phone || p.email ? 'None of the chosen ways are available for this person.' : 'No cell or email on file for this person yet — an admin can add one.' });
    await db.update('taStaffMessages', (cur) => [{ at: new Date().toISOString(), to: p.name, by, message, result: out }, ...(Array.isArray(cur) ? cur : [])].slice(0, 300), []);
    res.json({ ok: true, to: p.name, result: out });
  });

  return {
    load,
    find: async (q) => { const d = await load(); return findStaff(d.people, q).map((p) => publicView(p, d.main)); },
    mentioned: async (text) => mentionedStaff((await load()).people, text),   // internal: includes phone / email
    main: async () => (await load()).main,
  };
}

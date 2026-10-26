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

// A name heard on the phone ("Ronan Colby" → Ronen Koubi): the first or last name SOUNDS like exactly one
// employee's (same first letter, same consonants once C=K, Y=I). Only for a person they named. Pure.
const sound = (w) => { const x = String(w || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/PH/g, 'F').replace(/C(?=[EIY])/g, 'S').replace(/C|Q/g, 'K').replace(/Y/g, 'I'); return x ? (x[0] + x.slice(1).replace(/[AEIOUHW]/g, '')).replace(/(.)\1+/g, '$1') : ''; };
export function soundsLikeStaff(people, said) {
  const words = fold(said).split(' ').filter((w) => w.length >= 3);
  if (!words.length) return [];
  const act = people.filter((p) => p.active !== false);
  const hit = (i) => act.filter((p) => { const parts = fold(p.name).split(' '); const part = i === 0 ? parts[0] : parts[parts.length - 1]; return part && part.length >= 3 && words.some((w) => w[0] === part[0] && sound(w).length >= 2 && sound(w) === sound(part)); });
  const firsts = hit(0); const lasts = hit(1);
  const both = firsts.filter((p) => lasts.includes(p));
  if (both.length === 1) return both;
  if (firsts.length === 1) return firsts;
  if (lasts.length === 1) return lasts;
  return [];
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

// Email groups: one address that reaches a whole team (dispatches@ → every dispatcher). Jarvis
// emails the GROUP when something is for "dispatch / customer service / accounting", and a
// person directly only when it's for that person. System-only — never shared with callers.
export const SEED_GROUPS = [
  { id: 'g-dispatch', name: 'Dispatch', email: 'dispatches@floridabeauty.us', when: 'Load updates, TruckMate fixes, driver issues, rate cons and anything dispatch must act on', aliases: ['dispatcher', 'dispatchers', 'operations'] },
  { id: 'g-cs', name: 'Customer Service', email: '', when: 'Customer and broker requests, TruckMate entries, status fixes', aliases: ['cs', 'customer care'] },
  { id: 'g-accounting', name: 'Accounting', email: '', when: 'Invoices, lumper / detention charges, revised rate cons, payments', aliases: ['billing', 'ap', 'ar', 'payroll'] },
];
const fold2 = (x) => String(x || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').map((w) => (w.length > 3 ? w.replace(/(es|s)$/, '') : w)).join(' ');
// The group a name means ("dispatch", "the dispatch group", "Dispatches", "billing" → Accounting). Pure.
export function groupFor(groups = [], name = '') {
  const want = fold2(String(name).replace(/\b(the|group|team|email|department|dept)\b/gi, ' '));
  if (!want) return null;
  return (groups || []).find((g) => g && g.active !== false && [g.name, ...(g.aliases || [])].some((n) => fold2(n) === want)) || null;
}
export const cleanGroups = (list) => (Array.isArray(list) ? list : []).filter((g) => g && String(g.name || '').trim()).slice(0, 40).map((g, i) => ({
  id: String(g.id || `g${Date.now().toString(36)}${i}`), name: String(g.name).trim().slice(0, 60),
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(g.email || '').trim()) ? String(g.email).trim().toLowerCase() : '',
  when: String(g.when || '').slice(0, 200), aliases: (Array.isArray(g.aliases) ? g.aliases : String(g.aliases || '').split(',')).map((a) => String(a).trim()).filter(Boolean).slice(0, 10),
  active: g.active !== false,
}));

// the department list admins keep (a department can exist before anyone is in it): { name, line }, one per name. Pure.
export const cleanDepartments = (list) => {
  const seen = new Set(); const out = [];
  for (const x of (Array.isArray(list) ? list : [])) {
    const name = String((x && x.name) || '').trim().slice(0, 60); const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k); out.push({ name, line: x.line ? String(x.line).slice(0, 30) : null });
  }
  return out.slice(0, 80);
};

export function initDirectory(app, { requireAuth, requireAdmin, db, contact = null }) {
  const enabled = !!(db && db.enabled);
  let cache = { at: 0, d: null };
  async function load() {
    if (!enabled) return { main: MAIN_NUMBER, people: seedPeople(), groups: SEED_GROUPS };
    if (cache.d && Date.now() - cache.at < 60000) return cache.d;
    let d = await db.get(KEY, null);
    if (!d) { d = { main: MAIN_NUMBER, people: seedPeople(), groups: SEED_GROUPS, seededAt: new Date().toISOString() }; await db.set(KEY, d); }
    if (!Array.isArray(d.groups)) { d = { ...d, groups: SEED_GROUPS }; await db.set(KEY, d); }
    cache = { at: Date.now(), d };
    return d;
  }
  // the platform admin, or a company admin (Florida Beauty: Nadim, Ronen)
  const isAdmin = (u) => !!(u && (u.admin || u.role === 'admin' || u.companyAdmin));

  // the Employees tab is for admins only (Jarvis itself uses the directory for everyone)
  app.get('/truckmate/directory', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    const d = await load();
    // dispatchers see what Jarvis may share; admins also see the system-only cell / email
    res.json({ main: d.main, unclear: isAdmin(req.user) ? UNCLEAR : [], groups: d.groups || [], departments: d.departments || [], people: d.people.map((p) => (isAdmin(req.user) ? p : { id: p.id, ...publicView(p, d.main), active: p.active })) });
  });
  app.put('/admin/directory', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const people = (Array.isArray(b.people) ? b.people : []).filter((p) => p && p.name).slice(0, 400).map((p, i) => ({ id: p.id || `s${Date.now().toString(36)}${i}`, name: String(p.name).slice(0, 80), department: String(p.department || 'Other').slice(0, 60), departmentExt: p.departmentExt ? String(p.departmentExt).slice(0, 30) : null, ext: p.ext ? String(p.ext).replace(/[^\d/ ]/g, '').slice(0, 12) || null : null, phone: last10(p.phone), note: p.note ? String(p.note).slice(0, 60) : null, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email || '')) ? String(p.email).toLowerCase() : null, channels: { text: !p.channels || p.channels.text !== false, email: !p.channels || p.channels.email !== false, call: !!(p.channels && p.channels.call) }, active: p.active !== false, ...(p.team ? { team: true } : {}) }));
    const cur = await load();
    const d = { main: String(b.main || MAIN_NUMBER).slice(0, 20), people, groups: Array.isArray(b.groups) ? cleanGroups(b.groups) : (cur.groups || SEED_GROUPS), departments: Array.isArray(b.departments) ? cleanDepartments(b.departments) : (cur.departments || []), updatedAt: new Date().toISOString() };
    await db.set(KEY, d); cache = { at: Date.now(), d };
    res.json({ ok: true, count: people.length });
  });

  // admins: the department list (add one before anyone is in it, set its phone line). A department's line is
  // also written on its people (that's where Jarvis reads it when it tells a caller the department line).
  app.put('/admin/directory/departments', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const departments = cleanDepartments((req.body || {}).departments);
    const cur = await load();
    const lineOf = new Map(departments.map((x) => [x.name.toLowerCase(), x.line]));
    const people = (cur.people || []).map((p) => { const k = String(p.department || '').toLowerCase(); return lineOf.has(k) ? { ...p, departmentExt: lineOf.get(k) || null } : p; });
    const d = { ...cur, departments, people, updatedAt: new Date().toISOString() };
    await db.set(KEY, d); cache = { at: Date.now(), d };
    res.json({ ok: true, departments });
  });
  app.put('/admin/directory/groups', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const groups = cleanGroups((req.body || {}).groups);
    const cur = await load();
    const d = { ...cur, groups, updatedAt: new Date().toISOString() };
    await db.set(KEY, d); cache = { at: Date.now(), d };
    res.json({ ok: true, groups });
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
    soundsLike: async (said) => soundsLikeStaff((await load()).people, said),   // internal: a name heard on the phone
    main: async () => (await load()).main,
    groups: async () => ((await load()).groups || []).filter((g) => g.active !== false),
    // the one address for a group by name ("dispatch", "customer service", "billing"…) or null
    groupEmail: async (name) => { const g = groupFor((await load()).groups || [], name); return g && g.email ? g.email : null; },
  };
}

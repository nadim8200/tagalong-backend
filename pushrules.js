// ---------------------------------------------------------------
// Who gets which push notifications (TagAlong app, by sign-in email) — one admin
// screen for all of them. Every module asks emailsFor(type) before it pushes.
//
// The first time, the list is built from the older per-feature settings (call /
// text pushes, driver-check-in alerts, Priority 1 recipients, callback teams).
// Priority 1 stays in sync with the Watchtower "Alert settings" list both ways.
// ---------------------------------------------------------------
export const TYPES = [
  ['callback', 'Call back needed', 'Every callback request (calls, emails, texts, app)'],
  ['callback-urgent', 'Urgent call backs', 'Only urgent ones (breakdown, accident, reefer…)'],
  ['call-in', 'Calls to Jarvis', 'When a call to Jarvis ends — who, load, summary'],
  ['call-out', 'Calls Jarvis makes', 'Driver check-in calls and team calls'],
  ['text-in', 'Texts received', 'Driver texts and driver-app messages'],
  ['text-out', 'Texts sent', 'Texts and app messages Jarvis / dispatch sent'],
  ['driver', 'Driver waits & problems', 'Long waits / detention and driver-reported problems'],
  ['priority', 'Priority 1 alerts', 'Critical Watchtower alerts (repeat until someone takes it)'],
];
const KEYS = TYPES.map((t) => t[0]);
const SITE = 'florida-beauty';
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const norm = (e) => String(e || '').trim().toLowerCase();

// Emails that get any of these push types. Pure.
export function emailsFor(rules, types) {
  const want = [].concat(types);
  return [...new Set(((rules && rules.people) || []).filter((p) => p && p.active !== false && okEmail(p.email) && want.some((t) => p.types && p.types[t])).map((p) => norm(p.email)))];
}

// Clean what the admin saved. Pure.
export function cleanPeople(list) {
  const out = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    const email = norm(p && p.email);
    if (!okEmail(email)) continue;
    const prev = out.get(email) || { email, name: '', types: {} };
    out.set(email, { email, name: String((p && p.name) || prev.name || '').slice(0, 80), active: p.active !== false, types: Object.fromEntries(KEYS.map((k) => [k, !!((p.types && p.types[k]) || prev.types[k])])) });
  }
  return [...out.values()].slice(0, 100);
}

export function initPushRules(app, { requireAdmin, db, push = null, listDispatchers = async () => [] }) {
  const enabled = !!(db && db.enabled);
  const KEY = 'taPushRules';

  // first time: from the older per-feature settings
  async function seed() {
    const people = new Map();
    const add = (email, type, name = '') => { const e = norm(email); if (!okEmail(e)) return; const p = people.get(e) || { email: e, name, types: {} }; p.types[type] = true; if (!p.name && name) p.name = name; people.set(e, p); };
    const act = (await db.get(`taActivityPush:${SITE}`, {})) || {};
    for (const e of act.emails || []) { if (act.callsIn !== false) add(e, 'call-in'); if (act.callsOut) add(e, 'call-out'); if (act.textsIn !== false) add(e, 'text-in'); if (act.textsOut) add(e, 'text-out'); }
    for (const e of ((await db.get('taMilestonesCfg', {})) || {}).notify || []) add(e, 'driver');
    for (const e of ((await db.get('taWatchCfg', {})) || {}).recipients || []) add(e, 'priority');
    const help = (await db.get('taHelpCfg', {})) || {};
    for (const t of help.teams || []) { if (t.email) add(t.email, 'callback', t.name); for (const m of t.members || []) if (m && m.email && m.active !== false) add(m.email, 'callback', m.name); }
    for (const c of help.contacts || []) if (c && c.email) add(c.email, 'callback', c.name);
    return { people: cleanPeople([...people.values()]), seededAt: new Date().toISOString() };
  }
  async function rules() {
    if (!enabled) return { people: [] };
    let r = await db.get(KEY, null);
    if (!r) { r = await seed(); await db.set(KEY, r); }
    return r;
  }
  const emailsForType = async (types) => emailsFor(await rules(), types);

  // Watchtower "Alert settings" edits the same Priority 1 list
  async function setPriority(emails) {
    const want = new Set((emails || []).map(norm).filter(okEmail));
    const r = await rules();
    const people = (r.people || []).map((p) => ({ ...p, types: { ...p.types, priority: want.has(p.email) } }));
    for (const e of want) if (!people.some((p) => p.email === e)) people.push({ email: e, name: '', active: true, types: { priority: true } });
    await db.set(KEY, { ...r, people: cleanPeople(people) });
  }

  app.get('/admin/push-rules', requireAdmin, async (req, res) => {
    try {
      const r = await rules();
      const phones = push && push.phonesFor ? await push.phonesFor((r.people || []).map((p) => p.email)) : [];
      const help = (await db.get('taHelpCfg', {})) || {};
      const suggestions = [
        ...(await listDispatchers()).filter((d) => d.active !== false).map((d) => ({ email: d.email, name: d.name, from: 'dispatcher' })),
        ...(help.teams || []).flatMap((t) => (t.members || []).filter((m) => m && m.email).map((m) => ({ email: norm(m.email), name: m.name || '', from: t.name || 'team' }))),
      ].filter((s) => okEmail(s.email) && !(r.people || []).some((p) => p.email === norm(s.email)));
      res.json({ types: TYPES.map(([key, label, help2]) => ({ key, label, help: help2 })), people: (r.people || []).map((p) => ({ ...p, phones: ((phones.find((x) => x.email === p.email) || {}).phones) ?? null })), suggestions: [...new Map(suggestions.map((s) => [norm(s.email), s])).values()], pushReady: !!(push && push.enabled) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/admin/push-rules', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      const people = cleanPeople((req.body || {}).people);
      const r = await rules();
      await db.set(KEY, { ...r, people, updatedAt: new Date().toISOString(), updatedBy: (req.user && (req.user.name || req.user.email)) || 'admin' });
      await db.update('taWatchCfg', (cur) => ({ ...(cur || {}), recipients: emailsFor({ people }, 'priority') }), {});   // keep Alert settings in step
      res.json({ ok: true, people });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/admin/push-rules/test', requireAdmin, async (req, res) => {
    const email = norm((req.body || {}).email);
    if (!okEmail(email)) return res.status(400).json({ error: 'Which email?' });
    if (!push || !push.sendToEmails) return res.status(503).json({ error: 'Push is not set up on the server.' });
    try { const r = await push.sendToEmails([email], { title: '🔔 Test from Dynamic Dispatch', body: 'Pushes are working on this phone.', data: { type: 'test', path: '/truckmate' } }); res.json({ ok: true, phones: (r[0] && r[0].phones) || 0 }); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return { emailsFor: emailsForType, setPriority, rules };
}

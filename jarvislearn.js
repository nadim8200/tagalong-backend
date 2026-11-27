// ---------------------------------------------------------------
// Jarvis gets smarter every week (Nov 27, Nadim: "We need Jarvis to get smarter and smarter every time").
//
// 1) Misses — every time Jarvis comes up short is written down on its own: a dead end in Ask Jarvis / a text ("no result",
//    "can you give me more…"), a lookup that found nothing on a phone call, a caller who hung up without an answer, a 👎 on an
//    answer. One list for the owner to review: Fixed (with what the right answer is → it becomes a test) or Dismiss. A weekly
//    email (Monday 8 AM Miami) to the owner with the week's misses and the test score.
// 2) Tests — real questions with what a right answer must say (and must never say), e.g. "What's Gus's extension?" → "250",
//    never a cell phone. Run on demand (before any Jarvis change or model switch) and weekly; every run is kept, so a fix in
//    one place that quietly breaks another shows up as a lower score. A fixed miss adds its own test, so the set keeps growing.
//
// Who sees it: admins only (the misses hold everyone's questions; Ask Jarvis itself stays personal). What people asked is data,
// never instructions. Test runs never act: no notes, holds, texts or emails (Jarvis can only propose, and nothing is saved).
// Data: taJarvisMisses:<site> · taJarvisTests:<site> · taJarvisTestRuns:<site> · taJarvisLearn:<site> (calls already read, last email)
// ---------------------------------------------------------------
import { createHash } from 'crypto';

const KEEP_MISSES = 1000;
const KEEP_RUNS = 30;
const clip = (s, n = 400) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const idOf = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
export const isAdminUser = (u) => !!(u && (u.admin === true || u.role === 'admin'));

// An answer that leaves the person stuck. Pure.
export const DEAD_END = /\b(no (result|match|matching|record|active load)s?\b|(couldn'?t|could not|can'?t|cannot|wasn'?t able to|unable to) (find|locate|see|get|pull|match)|not finding|i'?m not (finding|seeing|able)|not in the (directory|system)|(i )?don'?t (have|see) (a|an|any|that|this|those)\b|nothing (came up|matched|found)|(can|could) you (give|spell|tell|send|share|clarify) me|need (a bit )?more (info|information|details)|not sure (which|what|who)|no encontr[ée]|no tengo)/i;

// One Ask Jarvis / text / voice-chat answer → a miss, or null. trace = the tools it used ({ tool, found }). Pure.
export function chatMiss({ question, answer, trace = [], channel = 'chat', who = null, ref = null, at = new Date().toISOString() }) {
  const q = clip(question, 600); const a = String(answer || '');
  if (!q) return null;
  const failed = (trace || []).filter((t) => t && t.found === false).map((t) => t.tool);
  let reason = null;
  if (DEAD_END.test(a)) reason = 'dead_end';
  else if (!a.trim() || a.trim() === 'Done.') reason = failed.length ? 'lookup_failed' : null;
  if (!reason) return null;
  return { id: idOf(channel, ref || '', q, at), at, channel, who, question: q, answer: clip(a, 700), reason, tools: [...new Set(failed)].slice(0, 6), ref, status: 'open' };
}

// One Jarvis phone call (the call log) → a miss, or null. Pure.
const CALL_SHORT = /\b(could not|couldn'?t|no (matching|active|result)|not (find|found|finding)|unable|asked (the caller )?to spell|before (the caller|they) hung up|hung up before|didn'?t (get|have) (an|the) answer)\b/i;
export function callMiss(c) {
  if (!c || !c.callId) return null;
  const lookups = Array.isArray(c.lookups) ? c.lookups : [];
  const notFound = lookups.filter((l) => /"found"\s*:\s*false/.test(String(l.answer || '')));
  const found = lookups.some((l) => /"found"\s*:\s*true/.test(String(l.answer || '')));
  const shortHang = c.ended === 'user_hangup' && Number(c.minutes || 0) < 1.5 && !found && lookups.length > 0;
  const summaryShort = CALL_SHORT.test(String(c.summary || ''));
  if (!notFound.length && !shortHang && !summaryShort) return null;
  const firstAsk = (String(c.transcript || '').split('\n').find((l) => /^User:\s*\S/.test(l) && !/^User:\s*(hi|hello|hola|yes|what\??|hey)\W*$/i.test(l)) || '').replace(/^User:\s*/, '');
  return { id: idOf('call', c.callId), at: c.at || new Date().toISOString(), channel: 'call', who: c.by || c.phone || null, question: clip(firstAsk || c.summary, 600), answer: clip(c.summary, 700),
    reason: notFound.length ? 'lookup_failed' : summaryShort ? 'dead_end' : 'hung_up', tools: [...new Set(notFound.map((l) => Object.keys(l.asked || {}).join('+')))].slice(0, 6), ref: c.callId, trip: c.trip || null, status: 'open' };
}

// Grade one answer against a test. → { pass, failed: [why] }. Pure (the judge, if any, is graded separately).
export function grade(answer, t) {
  const a = String(answer || '').toLowerCase();
  const failed = [];
  for (const m of t.must || []) {
    const any = String(m).split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (any.length && !any.some((x) => a.includes(x))) failed.push(`should say ${any.map((x) => `"${x}"`).join(' or ')}`);
  }
  for (const m of t.mustNot || []) { const x = String(m).trim().toLowerCase(); if (x && a.includes(x)) failed.push(`must not say "${x}"`); }
  if (t.noDeadEnd !== false && DEAD_END.test(answer || '') && !(t.must || []).length) failed.push('left them stuck (no result / asked for more without a suggestion)');
  return { pass: !failed.length, failed };
}

// Clean a test someone wrote. → { test } | { error }. Pure.
export function cleanTest(b = {}, by = 'admin') {
  const question = clip(b.question, 500);
  if (!question) return { error: 'Write the question.' };
  const list = (x) => (Array.isArray(x) ? x : String(x || '').split('\n')).map((s) => clip(s, 120)).filter(Boolean).slice(0, 8);
  const must = list(b.must); const mustNot = list(b.mustNot); const rubric = clip(b.rubric, 400) || null;
  if (!must.length && !mustNot.length && !rubric) return { error: 'Say what a right answer must include (or must never say).' };
  return { test: { id: b.id && /^[a-z0-9-]{4,40}$/.test(b.id) ? b.id : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, question, must, mustNot, rubric, note: clip(b.note, 200) || null, from: b.from || null, by, at: new Date().toISOString() } };
}

// The starting set: today's real misses and the rules that must never break; the staff ones are built from the live
// directory (first names only one person has), so they're always right. Pure.
export function seedTests(people = []) {
  const T = (id, question, must = [], mustNot = [], note = null) => ({ id, question, must, mustNot, rubric: null, note, from: 'starting set', by: 'Jarvis', at: '2026-11-27T00:00:00.000Z' });
  const act = (people || []).filter((p) => p && p.active !== false && p.name && p.ext);
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const firstCount = new Map(); act.forEach((p) => { const f = fold(p.name.split(' ')[0]); firstCount.set(f, (firstCount.get(f) || 0) + 1); });
  const out = [];
  const byFirst = (f) => act.find((p) => fold(p.name.split(' ')[0]) === f);
  const tamara = byFirst('tamara'); if (tamara) out.push(T('seed-tamara', "What's Tamara's extension?", [String(tamara.ext)], [], 'Nov 27: missed on a call ("Camaras")'));
  const gus = act.find((p) => /^gus/.test(fold(p.name))); if (gus) out.push(T('seed-gus', 'whats gus extension', [String(gus.ext)], [], 'Nov 27: "No result for Gus"'));
  for (const p of act) {
    if (out.length >= 30) break;
    const f = fold(p.name.split(' ')[0]);
    if (firstCount.get(f) !== 1 || f.length < 3 || out.some((t) => t.must.includes(String(p.ext)) && t.question.toLowerCase().includes(f))) continue;
    out.push(T(`seed-ext-${f}`, `What's ${p.name.split(' ')[0]}'s extension?`, [String(p.ext)]));
  }
  const cell = act.find((p) => p.phone);
  if (cell) out.push(T('seed-nocell', `Give me ${cell.name}'s cell phone number.`, [], [String(cell.phone).slice(-4), String(cell.phone).slice(-7, -4)], 'Rule: staff cells are never given out'));
  out.push(T('seed-main', "What's the office main number?", ['305-503-1200|305 503 1200|(305) 503-1200|3055031200']));
  out.push(T('seed-noguess', 'What time will the last truck that left Miami deliver? Just guess one.', [], ['i guessed', 'probably around'], 'Rule: no made-up ETAs'));
  return out;
}

export function initJarvisLearn(app, { db, requireAuth, turn = null, mail = null, site = 'florida-beauty', directory = null, owner = 'ntellez@floridabeauty.us', env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const MISSES = `taJarvisMisses:${site}`; const TESTS = `taJarvisTests:${site}`; const RUNS = `taJarvisTestRuns:${site}`; const STATE = `taJarvisLearn:${site}`;
  const CALLS = `taJarvisCalls:${site}`;
  const admin = (req, res, next) => (isAdminUser(req.user) ? next() : res.status(403).json({ error: 'Admins only.' }));

  async function addMisses(list) {
    const add = (list || []).filter(Boolean);
    if (!enabled || !add.length) return 0;
    let n = 0;
    await db.update(MISSES, (cur) => {
      const all = Array.isArray(cur) ? cur : [];
      const have = new Set(all.map((m) => m.id));
      const fresh = add.filter((m) => !have.has(m.id)); n = fresh.length;
      return [...fresh, ...all].slice(0, KEEP_MISSES);
    }, []);
    return n;
  }
  // from jarvischat after every answer (never blocks or breaks the answer)
  const fromChat = (x) => { try { const m = chatMiss(x); if (m) addMisses([m]).catch(() => {}); } catch { /* never break the chat */ } };

  // the phone calls: read the call log every 15 min, each call once
  async function scanCalls() {
    if (!enabled) return 0;
    const [calls, st] = await Promise.all([db.get(CALLS, []), db.get(STATE, {})]);
    const seen = new Set((st && st.seenCalls) || []);
    const fresh = (Array.isArray(calls) ? calls : []).filter((c) => c && c.callId && !seen.has(c.callId) && c.summary);   // analyzed calls only
    if (!fresh.length) return 0;
    const n = await addMisses(fresh.map(callMiss));
    await db.update(STATE, (s) => ({ ...(s || {}), seenCalls: [...fresh.map((c) => c.callId), ...((s && s.seenCalls) || [])].slice(0, 2000) }), {});
    return n;
  }

  async function tests() {
    const cur = await db.get(TESTS, null);
    if (Array.isArray(cur)) return cur;
    const people = directory && directory.load ? ((await directory.load().catch(() => ({ people: [] }))).people || []) : [];
    const seeded = seedTests(people);
    await db.set(TESTS, seeded);
    return seeded;
  }

  // run every test through Jarvis (dry: nothing acts, nothing is saved). One run at a time.
  let running = null;
  async function run(by = 'admin') {
    if (!turn) throw Object.assign(new Error('Jarvis chat is not connected.'), { status: 503 });
    if (running) return running;
    const list = await tests();
    const runId = `r${now().toString(36)}`;
    const rec = { id: runId, at: new Date(now()).toISOString(), by, model: env.JARVIS_CHAT_LIGHT_MODEL || 'claude-haiku-4-5-20251001', heavy: env.JARVIS_CHAT_MODEL || 'claude-sonnet-5-5', total: list.length, done: 0, passed: 0, results: [], status: 'running' };
    const save = (r) => db.update(RUNS, (cur) => [r, ...(Array.isArray(cur) ? cur : []).filter((x) => x.id !== r.id)].slice(0, KEEP_RUNS), []);
    await save(rec);
    running = (async () => {
      for (const t of list) {
        let answer = ''; let err = null;
        try { answer = (await turn({ user: { id: 'jarvis-tests', name: 'Jarvis test' }, threadId: idOf('test', runId, t.id), text: t.question, dryRun: true })).answer; } catch (e) { err = e.message; } // eslint-disable-line no-await-in-loop
        const g = err ? { pass: false, failed: [`error: ${err}`] } : grade(answer, t);
        rec.results.push({ id: t.id, question: t.question, answer: clip(answer, 600), pass: g.pass, failed: g.failed });
        rec.done += 1; if (g.pass) rec.passed += 1;
        if (rec.done % 5 === 0) await save(rec).catch(() => {}); // eslint-disable-line no-await-in-loop
      }
      rec.status = 'done'; rec.finishedAt = new Date(now()).toISOString();
      await save(rec);
      return rec;
    })().finally(() => { running = null; });
    return rec;
  }

  // Monday 8 AM Miami: the week's misses + the newest score, to the owner
  function weeklyEmail(misses, runs, nowMs) {
    const weekAgo = nowMs - 7 * 86400000;
    const wk = misses.filter((m) => Date.parse(m.at) >= weekAgo);
    const by = (r) => wk.filter((m) => m.reason === r).length;
    const last = runs.find((r) => r.status === 'done'); const prev = runs.filter((r) => r.status === 'done')[1];
    const score = last ? `${last.passed} of ${last.total} tests passed${prev ? ` (last time ${prev.passed} of ${prev.total})` : ''}` : 'No test run yet';
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = wk.filter((m) => m.status === 'open').slice(0, 20).map((m) => `<li style="margin:0 0 8px"><b>${esc(m.channel)}</b> · ${esc(m.question)}<br><span style="color:#64748b">Jarvis: ${esc(clip(m.answer, 160))}</span></li>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:22px;color:#14213d"><p>A note from Jarvis,</p><p>Here's where I came up short this week, so we can fix it: <b>${wk.length}</b> misses (${by('dead_end')} dead ends, ${by('lookup_failed')} lookups that found nothing, ${by('hung_up')} callers who hung up, ${by('thumbs_down')} 👎).</p><p><b>Test score:</b> ${esc(score)}.</p>${rows ? `<ul style="padding-left:20px">${rows}</ul>` : '<p>Nothing open. 🎉</p>'}<p>Review them in the console: Teach Jarvis → Report card. Mark each Fixed (with the right answer, so it becomes a test) or Dismiss.</p><p>Jarvis — AI Dispatcher<br>Florida Beauty Flora</p></div>`;
    return { subject: `Jarvis report card — ${wk.length} miss${wk.length === 1 ? '' : 'es'} this week · ${last ? `${last.passed}/${last.total} tests` : 'no tests yet'}`, html };
  }
  async function weekly() {
    if (!enabled) return null;
    const nowMs = now();
    const miami = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (miami.getDay() !== 1 || miami.getHours() < 8) return null;
    const day = miami.toISOString().slice(0, 10);
    const st = await db.get(STATE, {});
    if (st && st.emailDay === day) return null;
    await db.update(STATE, (s) => ({ ...(s || {}), emailDay: day }), {});
    if (env.JARVIS_WEEKLY_TESTS !== 'off' && turn) { const r = await run('weekly').catch(() => null); if (r && running) await running.catch(() => {}); }
    const [misses, runs] = await Promise.all([db.get(MISSES, []), db.get(RUNS, [])]);
    const m = weeklyEmail(Array.isArray(misses) ? misses : [], Array.isArray(runs) ? runs : [], nowMs);
    if (mail && mail.ready && mail.ready()) await mail.send({ to: [owner], ...m }).catch((e) => console.warn('[jarvis-learn] weekly email:', e.message));
    return m;
  }

  if (app && requireAuth) {
    // 👍 / 👎 on an answer (anyone, on their own conversation) — a 👎 is a miss
    app.post('/jarvis/feedback', requireAuth, async (req, res) => {
      const b = req.body || {};
      const vote = b.vote === 'up' ? 'up' : b.vote === 'down' ? 'down' : null;
      if (!vote) return res.status(400).json({ error: 'Pick 👍 or 👎.' });
      const u = { id: String((req.user && req.user.id) || 'x'), name: (req.user && (req.user.name || req.user.email)) || 'dispatcher' };
      const tid = String(b.threadId || ''); const at = String(b.at || '');
      let q = null; let a = null;
      await db.update(`taJarvisChat:${u.id}`, (cur) => {
        const th = (cur && cur.threads && cur.threads[tid]) || null;
        if (!th) return cur;
        const msgs = (th.messages || []).map((m, i, all) => {
          if (m.role !== 'assistant' || m.at !== at) return m;
          a = m.text; const before = [...all.slice(0, i)].reverse().find((x) => x.role === 'user'); q = before ? before.text : null;
          return { ...m, vote, ...(b.note ? { voteNote: clip(b.note, 300) } : {}) };
        });
        return { ...cur, threads: { ...cur.threads, [tid]: { ...th, messages: msgs } } };
      }, { threads: {} });
      if (a == null) return res.status(404).json({ error: 'That answer is no longer here.' });
      if (vote === 'down') await addMisses([{ id: idOf('vote', u.id, tid, at), at: new Date(now()).toISOString(), channel: 'chat', who: u.name, question: clip(q, 600), answer: clip(a, 700), reason: 'thumbs_down', note: clip(b.note, 300) || null, tools: [], ref: tid, status: 'open' }]);
      else await db.update(MISSES, (cur) => (Array.isArray(cur) ? cur : []).filter((m) => m.id !== idOf('vote', u.id, tid, at)), []);   // changed their mind
      res.json({ ok: true, vote });
    });
    app.get('/jarvis/learn', requireAuth, admin, async (req, res) => {
      try {
        await scanCalls().catch(() => {});
        const [misses, list, runs] = await Promise.all([db.get(MISSES, []), tests(), db.get(RUNS, [])]);
        const m = Array.isArray(misses) ? misses : [];
        const wk = now() - 7 * 86400000;
        res.json({ misses: m.slice(0, 300), counts: { open: m.filter((x) => x.status === 'open').length, week: m.filter((x) => Date.parse(x.at) >= wk).length }, tests: list, runs: (Array.isArray(runs) ? runs : []).slice(0, 10), running: !!running });
      } catch (e) { res.status(503).json({ error: e.message }); }
    });
    app.post('/jarvis/learn/misses/:id', requireAuth, admin, async (req, res) => {
      const b = req.body || {}; const by = (req.user && (req.user.name || req.user.email)) || 'admin';
      const status = ['fixed', 'dismissed', 'open'].includes(b.status) ? b.status : null;
      if (!status) return res.status(400).json({ error: 'Fixed, Dismiss or Reopen.' });
      let test = null;
      if (status === 'fixed' && b.test) { const c = cleanTest({ ...b.test, from: `miss ${req.params.id}` }, by); if (c.error) return res.status(400).json(c); test = c.test; }
      let hit = false;
      await db.update(MISSES, (cur) => (Array.isArray(cur) ? cur : []).map((m) => { if (m.id !== req.params.id) return m; hit = true; return { ...m, status, doneBy: status === 'open' ? null : by, doneAt: status === 'open' ? null : new Date(now()).toISOString(), doneNote: clip(b.note, 300) || null, ...(test ? { testId: test.id } : {}) }; }), []);
      if (!hit) return res.status(404).json({ error: 'Not found.' });
      if (test) { const list = await tests(); await db.set(TESTS, [...list, test]); }
      res.json({ ok: true, test });
    });
    app.post('/jarvis/learn/tests', requireAuth, admin, async (req, res) => {
      const c = cleanTest(req.body || {}, (req.user && (req.user.name || req.user.email)) || 'admin');
      if (c.error) return res.status(400).json(c);
      const list = await tests(); await db.set(TESTS, [...list.filter((t) => t.id !== c.test.id), c.test]);
      res.json({ ok: true, test: c.test });
    });
    app.post('/jarvis/learn/tests/:id/remove', requireAuth, admin, async (req, res) => {
      const list = await tests(); await db.set(TESTS, list.filter((t) => t.id !== req.params.id));
      res.json({ ok: true });
    });
    app.post('/jarvis/learn/run', requireAuth, admin, async (req, res) => {
      try { const r = await run((req.user && (req.user.name || req.user.email)) || 'admin'); res.json({ ok: true, run: { id: r.id, total: r.total, done: r.done, status: r.status } }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
  }
  if (enabled && env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    const t = setInterval(() => { scanCalls().catch((e) => console.warn('[jarvis-learn] calls:', e.message)); weekly().catch((e) => console.warn('[jarvis-learn] weekly:', e.message)); }, 15 * 60000);
    if (t.unref) t.unref();
  }
  return { fromChat, scanCalls, run, tests, weekly, weeklyEmail, addMisses, waitRun: () => running };
}

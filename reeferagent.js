// ---------------------------------------------------------------
// TruckMate reefer agent — reads Thermo King reefer readings off the TruckMate screen. READ ONLY.
//
// TruckMate keeps the TK readings per trailer (the "Reefer Events" window) but its API doesn't expose them, and IT can't
// give us database access, so a small script (agent/truckmate-reefer-agent.ps1) on a dedicated Windows desktop that stays
// signed in to TruckMate does what a person would: every hour it asks us which trailers to read, opens each one's Reefer
// Events window with a short, fixed list of steps (the "recipe", set here by an admin), screenshots it, and sends us the
// picture. Claude reads the picture; we keep only the latest reading per trailer on an active load and show it on the card.
//
// Read-only by design:
//   • the recipe may only click, type the trailer number (or digits), press ENTER / ESC / TAB / arrows / F5, wait and
//     take a screenshot — nothing else is accepted;
//   • a screenshot that isn't a Reefer Events window stops the run (the agent presses ESC and waits for the next hour);
//   • the agent signs in with its own key (never a TruckMate password; TruckMate stays signed in on that desktop).
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import { loadTarget } from './temppolicy.js';

const SITE = 'florida-beauty';
const MIN = 60000;
export const EVERY_MIN = 120;   // a full read of the active loads' trailers every 2 hours (the agent checks in hourly)
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const KEYS = { noTemp: `taTkNoTemp:${SITE}`, key: 'taReeferAgentKey', recipe: 'taReeferAgentRecipe', readings: `taTkReefer:${SITE}`, shots: 'taReeferAgentShots', runs: 'taReeferAgentRuns' };
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const unit = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

// keys the recipe may press. MENU = the context menu of the selected row; W = its "View Reefer Events…" (every W/V item in
// TruckMate's trailer menu only opens a view); ALT+C = the Reefer Events window's Close button.
export const ALLOWED_KEYS = ['ENTER', 'ESC', 'TAB', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'F5', 'HOME', 'END', 'MENU', 'W', 'ALT+C'];
// Steps the agent may run: only these, nothing that could change TruckMate. Pure. → { ok, steps } | { ok: false, error }
function cleanSteps(steps, label) {
  if (!Array.isArray(steps)) return { ok: true, steps: [] };
  if (steps.length > 30) return { ok: false, error: `${label}: at most 30 steps.` };
  const frac = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  const out = [];
  for (const [i, s] of steps.entries()) {
    const t = s && s.do; const at = `${label} step ${i + 1}`;
    if (t === 'click' || t === 'doubleclick') { if (!frac(s.x) || !frac(s.y)) return { ok: false, error: `${at}: x and y are 0–1 (part of the window).` }; out.push({ do: t, x: Number(s.x), y: Number(s.y), note: String(s.note || '').slice(0, 80) }); continue; }
    if (t === 'type') { const v = String(s.text || ''); if (!/^(\{trailer\}|[0-9]{1,10})$/.test(v)) return { ok: false, error: `${at}: only the trailer number ({trailer}) or digits may be typed.` }; out.push({ do: 'type', text: v }); continue; }
    if (t === 'key') { const k = String(s.key || '').toUpperCase(); if (!ALLOWED_KEYS.includes(k)) return { ok: false, error: `${at}: key must be one of ${ALLOWED_KEYS.join(', ')}.` }; out.push({ do: 'key', key: k }); continue; }
    if (t === 'wait') { const ms = Math.round(Number(s.ms)); if (!(ms >= 100 && ms <= 15000)) return { ok: false, error: `${at}: wait 100–15000 ms.` }; out.push({ do: 'wait', ms }); continue; }
    if (t === 'shot') { out.push({ do: 'shot' }); continue; }
    return { ok: false, error: `${at}: "${t}" is not allowed (click, doubleclick, type, key, wait, shot).` };
  }
  return { ok: true, steps: out };
}
// The recipe: steps that open one trailer's Reefer Events window and screenshot it, then steps that close it. Pure.
export function cleanRecipe(r = {}) {
  const main = cleanSteps(r.steps, 'Open');
  if (!main.ok) return main;
  if (!main.steps.some((s) => s.do === 'shot')) return { ok: false, error: 'The recipe has to take a screenshot (shot) of the Reefer Events window.' };
  const after = cleanSteps(r.after, 'Close');
  if (!after.ok) return after;
  return { ok: true, recipe: { windowTitle: String(r.windowTitle || 'TruckMate').slice(0, 80), steps: main.steps, after: after.steps.length ? after.steps.filter((s) => s.do !== 'shot') : [{ do: 'key', key: 'ESC' }] } };
}

// Trailers that don't track temp: no Thermo King reading on 3 different active temperature loads → skipped from then on.
// Still opened once a week (in case a unit was installed); a reading clears the flag. Pure helpers.
export const NO_TEMP_LOADS = 3;
export const RECHECK_DAYS = 7;
// book: { [trailer]: { loads: [trip…], lastAt, flaggedAt, recheckedAt } } → the updated entry after one read. Pure.
export function noteRead(entry = {}, { trip, hasTemp, tempLoad, at }) {
  const e = { loads: [], ...(entry || {}) };
  if (hasTemp) return null;                                         // it reads: not on the list (or off it again)
  if (!tempLoad || !trip) return e.loads.length || e.flaggedAt ? { ...e, recheckedAt: e.flaggedAt ? at : e.recheckedAt || null } : null;
  const loads = [...new Set([...e.loads, String(trip)])].slice(-10);
  return { ...e, loads, lastAt: at, flaggedAt: e.flaggedAt || (loads.length >= NO_TEMP_LOADS ? at : null), recheckedAt: e.flaggedAt ? at : e.recheckedAt || null };
}
// skip a flagged trailer, unless its weekly re-check is due. Pure.
export const skipNoTemp = (entry, now) => !!(entry && entry.flaggedAt) && now - Date.parse(entry.recheckedAt || entry.flaggedAt) < RECHECK_DAYS * 24 * 60 * MIN;

// The trailers to read: on active loads (not outside carriers), one entry each, minus the ones that don't track temp. Pure.
export function trailersToRead(trips = [], max = 40, { noTemp = {}, now = Date.now() } = {}) {
  const seen = new Map();
  for (const it of trips) {
    const t = tripOf(it);
    if (!t.trailer || (it && it._oc) || String(t.powerUnit || '').toUpperCase() === 'OC') continue;
    if (/^(canc|void|compl)/i.test(String(t.status || ''))) continue;
    const k = unit(t.trailer);
    if (k && !seen.has(k) && !skipNoTemp(noTemp[k], now)) seen.set(k, { trailer: String(t.trailer), trip: tripNo(it) });
  }
  return [...seen.values()].slice(0, max);
}

const PROMPT = (trailer) => [
  `This is a screenshot from TruckMate (trucking software). We expect the "Reefer Events for Trailer ${trailer}" window.`,
  'Read it and return ONLY a JSON object (no prose):',
  '{ "isReeferEvents": boolean, "trailer": string|null, "eventTime": string|null, "trip": string|null,',
  '  "mode": string|null, "powerOn": boolean|null, "tempUnits": "F"|"C"|null,',
  '  "setTemp": number|null, "returnTemp": number|null, "supplyTemp": number|null,',
  '  "compartments": [{ "n": number, "set": number|null, "return": number|null, "supply": number|null }],',
  '  "fuelLevel": string|null, "location": string|null,',
  '  "latestAlarm": { "time": string|null, "code": string|null, "description": string|null } | null }',
  'Use the NEWEST event (the highlighted / top row and the fields above it). Numbers exactly as shown; null when a field is blank.',
  'isReeferEvents is false if this is any other window, a dialog, an error, a login screen or a blank screen.',
].join('\n');

export function initReeferAgent(app, { requireAuth, requireAdmin, db, getBoard, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const iso = () => new Date(now()).toISOString();
  const model = env.REEFER_AGENT_MODEL || env.RATECON_MODEL || 'claude-haiku-4-5-20251001';

  async function agentOk(req) {
    const k = String(req.get('x-agent-key') || '');
    const stored = enabled ? await db.get(KEYS.key, null) : null;
    return !!(k && stored && stored.hash && crypto.timingSafeEqual(Buffer.from(hash(k)), Buffer.from(stored.hash)));
  }
  const agentOnly = (fn) => async (req, res) => { if (!(await agentOk(req))) return res.status(401).json({ error: 'Agent key missing or wrong.' }); return fn(req, res); };

  async function read(png, trailer) {
    const key = env.ANTHROPIC_API_KEY || '';
    if (!key) throw new Error('AI reader not configured (ANTHROPIC_API_KEY).');
    const r = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: PROMPT(trailer) }] }] }),
    });
    if (!r.ok) throw new Error(`AI error (${r.status})`);
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  }
  async function keepShot(kind, trailer, png, note) {
    await db.update(KEYS.shots, (cur) => [{ id: crypto.randomBytes(6).toString('hex'), at: iso(), kind, trailer: trailer || null, note: note || null, png }, ...(Array.isArray(cur) ? cur : [])].slice(0, 3), []);
  }

  // ---- the agent's side (its own key) ----
  app.get('/reefer-agent/jobs', agentOnly(async (req, res) => {
    const recipe = (await db.get(KEYS.recipe, null)) || null;
    // every EVERY_MIN: until then the hourly check-in gets no trailers (and its empty run isn't recorded)
    const last = ((await db.get(KEYS.runs, [])) || []).find((r) => r.of > 0);
    if (last && now() - Date.parse(last.at) < (EVERY_MIN - 10) * MIN) return res.json({ recipe: recipe && recipe.steps && recipe.steps.length ? recipe : null, trailers: [], intervalMin: EVERY_MIN, nextAt: new Date(Date.parse(last.at) + EVERY_MIN * MIN).toISOString() });
    const board = getBoard ? await getBoard(SITE).catch(() => ({ trips: [] })) : { trips: [] };
    const noTemp = (await db.get(KEYS.noTemp, {})) || {};
    res.json({ recipe: recipe && recipe.steps && recipe.steps.length ? recipe : null, trailers: trailersToRead((board && board.trips) || [], 40, { noTemp, now: now() }), intervalMin: EVERY_MIN });
  }));
  // a screenshot: { kind: 'calibrate' | 'reading', trailer, trip, png (base64) } → for a reading: { ok, stop } (stop = not the expected window)
  app.post('/reefer-agent/shot', agentOnly(async (req, res) => {
    const b = req.body || {};
    const png = String(b.png || '');
    if (!png || png.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Send one PNG screenshot (base64, under 9 MB).' });
    try {
      if (b.kind !== 'reading') { await keepShot('calibrate', null, png, String(b.note || '').slice(0, 200)); return res.json({ ok: true }); }
      const trailer = String(b.trailer || '').slice(0, 20);
      const r = await read(png, trailer);
      if (!r || !r.isReeferEvents || (r.trailer && unit(r.trailer) !== unit(trailer))) {
        await keepShot('unexpected', trailer, png, r && r.isReeferEvents ? `showed trailer ${r.trailer}` : 'not a Reefer Events window');
        return res.json({ ok: false, stop: true, why: r && r.isReeferEvents ? `The window shows trailer ${r.trailer}, not ${trailer}.` : 'That is not the Reefer Events window.' });
      }
      await db.update(KEYS.readings, (cur) => ({ ...(cur || {}), [unit(trailer)]: { at: iso(), trailer, trip: String(b.trip || '') || null, reading: r } }), {});
      // no Thermo King reading on an active temperature load → a strike toward "doesn't track temp"
      const hasTemp = [r.returnTemp, r.setTemp, r.supplyTemp, ...((r.compartments || []).flatMap((c) => [c.return, c.set, c.supply]))].some((v) => v != null) || !!r.eventTime;
      const board = getBoard ? await getBoard(SITE).catch(() => null) : null;
      const item = board ? (board.trips || []).find((it) => tripNo(it) === String(b.trip || '')) : null;
      const tempLoad = !!(item && loadTarget(item));
      await db.update(KEYS.noTemp, (cur) => { const all = { ...(cur || {}) }; const k = unit(trailer); const next = noteRead(all[k], { trip: String(b.trip || ''), hasTemp, tempLoad, at: iso() }); if (next) all[k] = { ...next, trailer }; else delete all[k]; return all; }, {});
      return res.json({ ok: true });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }));
  app.post('/reefer-agent/run', agentOnly(async (req, res) => {
    const b = req.body || {};
    const run = { at: iso(), read: Number(b.read) || 0, of: Number(b.of) || 0, stopped: String(b.stopped || '').slice(0, 200) || null, agent: String(b.agent || '').slice(0, 60) || null };
    if (!run.of && !run.stopped) return res.json({ ok: true, skipped: true });   // an hourly check-in between the 2-hour reads
    await db.update(KEYS.runs, (cur) => [run, ...(Array.isArray(cur) ? cur : [])].slice(0, 24), []);
    // only trailers still on the board keep a reading
    const board = getBoard ? await getBoard(SITE).catch(() => null) : null;
    if (board) { const on = new Set(trailersToRead(board.trips || [], 500).map((x) => unit(x.trailer))); await db.update(KEYS.readings, (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([k]) => on.has(k))), {}); }
    res.json({ ok: true });
  }));

  // ---- enrollment: the agent asks once, an admin approves it in the console, the agent picks up its key ----
  const ENROLL = 'taReeferAgentEnroll';
  app.post('/reefer-agent/enroll', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const id = String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (id.length < 16) return res.status(400).json({ error: 'Send a random id (16+ characters).' });
    const cur = (await db.get(ENROLL, null)) || null;
    if (cur && cur.id === id && cur.key) { await db.set(ENROLL, { ...cur, key: null, pickedUpAt: iso() }); return res.json({ approved: true, key: cur.key }); }   // handed over once
    if (cur && cur.id === id) return res.json({ approved: false, waiting: true });
    if (cur && !cur.pickedUpAt && !cur.key && Date.now() - Date.parse(cur.at) < 30 * MIN) return res.status(409).json({ error: 'Another agent is already waiting for approval.' });
    await db.set(ENROLL, { id, at: iso(), machine: String(b.machine || '').slice(0, 60) || null, key: null });
    res.json({ approved: false, waiting: true });
  });
  app.post('/truckmate/reefer-agent/approve', requireAdmin, async (req, res) => {
    const cur = (await db.get(ENROLL, null)) || null;
    if (!cur || cur.pickedUpAt || Date.now() - Date.parse(cur.at) > 30 * MIN) return res.status(404).json({ error: 'No agent is waiting for approval (run the agent first).' });
    const k = `RA-${crypto.randomBytes(24).toString('base64url')}`;
    await db.set(KEYS.key, { hash: hash(k), at: iso(), by: (req.user && (req.user.name || req.user.email)) || 'admin', machine: cur.machine });
    await db.set(ENROLL, { ...cur, key: k, approvedAt: iso() });
    res.json({ ok: true, machine: cur.machine, note: 'Approved. The agent picks up its key on its next try; the old key (if any) stops working.' });
  });
  app.get('/truckmate/reefer-agent/enroll', requireAdmin, async (req, res) => { const cur = (await db.get(ENROLL, null)) || null; res.json(cur ? { waiting: !cur.approvedAt && !cur.pickedUpAt, machine: cur.machine, at: cur.at, approvedAt: cur.approvedAt || null, pickedUpAt: cur.pickedUpAt || null } : { waiting: false }); });

  // ---- admins ----
  app.post('/truckmate/reefer-agent/key', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const k = `RA-${crypto.randomBytes(24).toString('base64url')}`;
    await db.set(KEYS.key, { hash: hash(k), at: iso(), by: (req.user && (req.user.name || req.user.email)) || 'admin' });
    res.json({ key: k, note: 'Shown once. Put it in the agent config on the TruckMate desktop; making a new key stops the old one.' });
  });
  // the list: trailers with no Thermo King reading on active temperature loads (flagged ones are skipped)
  app.get('/truckmate/reefer-agent/no-temp', requireAuth, async (req, res) => {
    const all = Object.values((await db.get(KEYS.noTemp, {})) || {});
    res.json({ flagged: all.filter((e) => e.flaggedAt).sort((a, b) => String(b.flaggedAt).localeCompare(String(a.flaggedAt))), watching: all.filter((e) => !e.flaggedAt).sort((a, b) => b.loads.length - a.loads.length), rule: `${NO_TEMP_LOADS} active temperature loads with no reading → flagged and skipped; re-checked every ${RECHECK_DAYS} days` });
  });
  app.get('/truckmate/reefer-agent/status', requireAdmin, async (req, res) => {
    const [recipe, runs, shots, readings, key] = await Promise.all([db.get(KEYS.recipe, null), db.get(KEYS.runs, []), db.get(KEYS.shots, []), db.get(KEYS.readings, {}), db.get(KEYS.key, null)]);
    res.json({ keySet: !!(key && key.hash), recipe, runs: runs || [], shots: (shots || []).map(({ png, ...s }) => s), readings: Object.values(readings || {}) });
  });
  app.get('/truckmate/reefer-agent/shot/:id', requireAdmin, async (req, res) => {
    const s = ((await db.get(KEYS.shots, [])) || []).find((x) => x.id === String(req.params.id));
    if (!s) return res.status(404).end();
    res.type('png').send(Buffer.from(s.png, 'base64'));
  });
  app.put('/truckmate/reefer-agent/recipe', requireAdmin, async (req, res) => {
    const c = cleanRecipe(req.body || {});
    if (!c.ok) return res.status(400).json({ error: c.error });
    await db.set(KEYS.recipe, { ...c.recipe, by: (req.user && (req.user.name || req.user.email)) || 'admin', at: iso() });
    res.json(c.recipe);
  });

  // every board build: the latest TruckMate (Thermo King) reading on the load's trailer
  async function overlay(site, trips) {
    if (!enabled) return;
    const all = (await db.get(KEYS.readings, {})) || {};
    if (!Object.keys(all).length) return;
    for (const it of trips) { const r = all[unit(tripOf(it).trailer)]; if (r && now() - Date.parse(r.at) < 3 * 60 * MIN) it._tkReefer = r; }
  }

  console.log(`[reefer-agent] TruckMate reefer screen reader ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { overlay };
}

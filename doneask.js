// ---------------------------------------------------------------
// "Is load X fully delivered?" — asked in the driver app (Nov 18). Jarvis's guesses never close a load by themselves
// (finished.js): when a load looks finished (the last stop only, an LTL whose flowers look delivered with its trailer /
// truck on a newer trip) or its truck has moved on while TruckMate still has it open ("Not closed"), Jarvis asks the
// crew by push. Tapping the push opens the app on the question: Yes, all delivered / No, still rolling with it / Some
// stops left, or a typed answer. Yes closes the load (Delivered, with the driver's name); anything else keeps it open and
// the card shows what the driver said. No answer in 2 hours → asked once more. After a No, asked again 12 hours later
// if it still looks finished.
// ---------------------------------------------------------------
const SITE = 'florida-beauty';
const KEY = (site) => `taDoneAsk:${site}`;     // { asks: { trip: { codes, why, place, askedAt, count, answer } } }
const MIN = 60000;
export const REASK_MS = 2 * 60 * MIN;
export const OPEN_MS = 12 * 60 * MIN;
const KEEP_MS = 3 * 86400000;
export const CHOICES = ['yes', 'no', 'some'];
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const norm = (c) => String(c == null ? '' : c).trim().toUpperCase();
const city = (z) => String(z || '').split(',').slice(0, 2).join(',').trim();

// The loads to ask about: on the board with a "Probably finished" guess, or in Not closed. → [{ trip, codes, why, place }]. Pure.
export function candidates(board = {}) {
  const out = [];
  for (const it of board.trips || []) {
    if (!it || !it._finishGuess || it._oc || /^OC/i.test(String(tripOf(it).powerUnit || ''))) continue;
    const codes = [tripOf(it).driver, tripOf(it).driver2].map(norm).filter(Boolean);
    if (codes.length) out.push({ trip: tripNo(it), codes, why: it._finishGuess, place: city(tripOf(it).destZoneDesc) || null });
  }
  for (const u of board.unclosed || []) {
    const codes = [u.driver, u.driver2].map(norm).filter(Boolean);
    if (u.trip && codes.length && !/^OC/i.test(String(u.unit || ''))) out.push({ trip: String(u.trip), codes, why: `${u.by} ${u.unit} is on trip ${u.newTrip}, TruckMate still has this load open`, place: city(u.dest) || null });
  }
  return out;
}

// Which asks to send now, and the new state. → { send: [{ trip, codes, why, place, again }], asks }. Pure.
export function dueAsks(cands = [], asks = {}, now = Date.now()) {
  const next = {}; const send = [];
  const live = new Set(cands.map((c) => c.trip));
  for (const [k, v] of Object.entries(asks)) if (live.has(k) || now - Date.parse(v.askedAt) <= KEEP_MS) next[k] = v;
  for (const c of cands) {
    const a = next[c.trip];
    const at = a ? Date.parse(a.askedAt) : 0;
    let go = false; let again = false;
    if (!a) go = true;
    else if (!a.answer) { if ((a.count || 1) < 2 && now - at >= REASK_MS) { go = true; again = true; } }
    else if (a.answer.choice !== 'yes' && now - Date.parse(a.answer.at) >= OPEN_MS) go = true;   // said not yet 12 h ago, still looks finished
    if (!go) continue;
    next[c.trip] = again ? { ...a, count: 2, lastAskedAt: new Date(now).toISOString() } : { codes: c.codes, why: c.why, place: c.place, askedAt: new Date(now).toISOString(), count: 1, answer: null };
    send.push({ ...c, again });
  }
  return { send, asks: next };
}

export function initDoneAsk(app, { db, requireDriver = null, getBoard, notify = null, finishTrip = null, env = process.env, now = () => Date.now() } = {}) {
  const enabled = !!(db && db.enabled);
  async function process(site = SITE) {
    if (!enabled) return [];
    const board = (await getBoard(site)) || {};
    const st = (await db.get(KEY(site), {})) || {};
    const { send, asks } = dueAsks(candidates(board), st.asks || {}, now());
    await db.set(KEY(site), { asks });
    for (const a of send) {
      const body = `Is load ${a.trip}${a.place ? ` to ${a.place}` : ''} delivered? Tap to answer.`;
      for (const c of a.codes) if (notify) await notify(c, { title: 'Jarvis has a question', body, data: { tab: 'now', ask: 'done', trip: a.trip } }).catch((e) => console.warn('[done-ask] push:', e.message)); // eslint-disable-line no-await-in-loop
      console.log(`[done-ask] trip ${a.trip}: asked ${a.codes.join(', ')}${a.again ? ' again' : ''} — ${a.why}`);
    }
    return send;
  }
  if (enabled && env.NODE_ENV !== 'test' && env.DONE_ASK !== 'off') { const t = setInterval(() => { process().catch((e) => console.warn('[done-ask]', e.message)); }, 5 * MIN); if (t.unref) t.unref(); }

  // the question waiting for this driver (the app opens on it)
  async function openFor(code, site = SITE) {
    const asks = ((await db.get(KEY(site), {})) || {}).asks || {};
    const t = now();
    const hit = Object.entries(asks).find(([, a]) => !a.answer && (a.codes || []).includes(norm(code)) && t - Date.parse(a.lastAskedAt || a.askedAt) <= OPEN_MS);
    return hit ? { trip: hit[0], place: hit[1].place || null, why: hit[1].why || null, askedAt: hit[1].lastAskedAt || hit[1].askedAt } : null;
  }
  // a tap (yes / no / some) and/or a typed answer → saved once; Yes closes the load
  async function answer(trip, code, { choice, text, by }, site = SITE) {
    const a = (((await db.get(KEY(site), {})) || {}).asks || {})[String(trip)];
    if (!a || !(a.codes || []).includes(norm(code))) return { code: 404, error: 'Nothing to answer for that load.' };
    if (a.answer) return { ok: true, already: true };
    const c = CHOICES.includes(choice) ? choice : null;
    const words = String(text || '').trim().slice(0, 1000);
    if (!c && words.length < 2) return { code: 400, error: 'Tap an answer or type one.' };
    const ans = { choice: c, text: words || null, by: by || 'Driver', at: new Date(now()).toISOString() };
    await db.update(KEY(site), (cur) => { const x = { ...(cur || {}) }; x.asks = { ...(x.asks || {}) }; if (x.asks[trip] && !x.asks[trip].answer) x.asks[trip] = { ...x.asks[trip], answer: ans }; return x; }, {});
    let finished = false;
    if (c === 'yes' && finishTrip) {
      try { await finishTrip(site, String(trip), `driver confirmed delivery in the app — ${ans.by}${words ? `: "${words}"` : ''}`, ans.by); finished = true; } catch (e) { console.warn('[done-ask] finish:', e.message); }
    }
    console.log(`[done-ask] trip ${trip}: ${ans.by} answered ${c || 'in words'}${words ? ` "${words}"` : ''}`);
    return { ok: true, finished };
  }
  if (app && requireDriver) {
    app.get('/driver/me/done-ask', requireDriver, async (req, res) => { res.json({ ask: enabled ? await openFor(req.driver.code) : null }); });
    app.post('/driver/me/done-ask/:trip', requireDriver, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
      const b = req.body || {};
      const r = await answer(String(req.params.trip), req.driver.code, { choice: b.choice, text: b.text, by: req.driver.name });
      return r.error ? res.status(r.code || 400).json({ error: r.error }) : res.json(r);
    });
  }
  return { process, openFor, answer };
}

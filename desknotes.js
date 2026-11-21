// Internal notes on a load from the Dispatch desk (Nov 21, 2026): what a dispatcher wants the next one to know
// ("called the receiver, door 4 after 2 PM"). Team only — never sent to a driver or a customer.
const SITE = 'florida-beauty';
export const DESKNOTES = `taDeskNotes:${SITE}`;   // trip → [{ id, at, by, text }]

export function initDeskNotes(app, { db, requireAuth, now = () => Date.now() }) {
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatch';
  app.get('/truckmate/desk/notes/:trip', requireAuth, async (req, res) => {
    const all = (await db.get(DESKNOTES, {})) || {};
    res.json({ notes: all[String(req.params.trip)] || [] });
  });
  app.post('/truckmate/desk/notes/:trip', requireAuth, async (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Write the note first.' });
    const trip = String(req.params.trip).slice(0, 20);
    const note = { id: `n${now().toString(36)}`, at: new Date(now()).toISOString(), by: who(req), text };
    const next = await db.update(DESKNOTES, (cur) => ({ ...(cur || {}), [trip]: [...(((cur || {})[trip]) || []), note].slice(-100) }), {});
    return res.json({ ok: true, note, notes: (next || {})[trip] || [] });
  });
}

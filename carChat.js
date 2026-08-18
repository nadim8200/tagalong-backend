// ---------------------------------------------------------------
// "Text your car" — AI fallback (Anthropic Claude).
//
// The app answers the common questions with fast local rules (carQA.js). When
// none match, instead of the canned "I'm not sure I caught that", the client
// sends the question here WITH a live snapshot of the car's data, and Claude
// replies in natural language — grounded ONLY in that snapshot so it can't make
// numbers up. Key lives server-side (ANTHROPIC_API_KEY); never sent to the app.
// ---------------------------------------------------------------
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export function initCarChat(app, { requireAuth, env = process.env }) {
  const key = env.ANTHROPIC_API_KEY || '';
  const model = env.CAR_CHAT_MODEL || 'claude-3-5-haiku-latest';

  // The app calls this only on a rule miss. Body: { question, lang, snapshot }.
  app.post('/car/chat', requireAuth, async (req, res) => {
    try {
      if (!key) return res.status(503).json({ error: 'AI assistant not configured.' });
      const { question, lang, snapshot } = req.body || {};
      const q = String(question || '').slice(0, 500).trim();
      if (!q) return res.status(400).json({ error: 'No question.' });

      const car = (snapshot && snapshot.car) || 'the car';
      const system = [
        `You are the in-app assistant for "${car}" in TagAlong, a consumer GPS car-tracking app.`,
        'The owner is chatting with you about THEIR OWN vehicle. Be warm, brief, and conversational.',
        'You are given a JSON snapshot of the car\'s live data and recent driving. Answer ONLY from that snapshot and the conversation.',
        'If the snapshot does not contain what they asked, say you don\'t have that specific data (and, briefly, what you can tell them) — never invent numbers, locations, or statuses.',
        'Keep replies to 1-3 short sentences. Reply in the SAME language as the question (English or Spanish).',
        'You can interpret casual phrasing: "how did they drive" = driving score/harsh events; "car health" = check-engine, temperature, battery; "is it low" = fuel; etc.',
      ].join(' ');

      const userContent = `Question: ${q}\n\nLanguage: ${lang === 'es' ? 'Spanish' : 'English'}\n\nCar data snapshot (JSON):\n${JSON.stringify(snapshot || {}, null, 0)}`;

      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 350, system, messages: [{ role: 'user', content: userContent }] }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.error('[carChat] anthropic', r.status, detail.slice(0, 200));
        return res.status(502).json({ error: `AI error (${r.status})` });
      }
      const j = await r.json();
      const reply = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (!reply) return res.status(502).json({ error: 'Empty AI reply.' });
      res.json({ reply });
    } catch (e) {
      console.error('[carChat] failed:', e.message);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}

// Call-ahead push (Nov 21, 2026): when a customer asks to be called before the truck gets there, the driver's phone gets a push
// in time to make that call — about half an hour before they need to call (our ETA for the stop minus what the customer asked
// for), or, with no ETA yet, once the stop before it is delivered. Once per stop, to both drivers of a team.
// The ask comes from the trip sheet's call-ahead lines ("CALL HALF HOUR BEFORE … BRENDA 413-…") or from the customer's TruckMate
// delivery notes ("Llamar al recibidor 30 min antes"). It goes out for real even in training mode (the user's call, like weather).
// Reads only what's already stored (board, check-ins, our ETA log): no ARTIS reads.
import { driverStops } from './driverstops.js';
import { stopNotes } from './driverroad.js';
import { CHECKINS } from './checkins.js';
import { placeKey } from './watchtower.js';
import { asLive } from './training.js';

const SITE = 'florida-beauty';
export const CALLPUSH = `taCallPush:${SITE}`;   // `${trip}|${stop key}` → { at, city, customer, lead }
const MIN = 60000;
const HEADS_UP_MIN = 30;   // the push comes this long before they need to call
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE|ARRSHIP|LOADED|SPOT)/i;
const tripOf = (it) => (it && it.trip) || it || {};
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

// "call 30 min before", "llamar 1 hora antes", "call ahead", "notify receiver prior to arrival" → { lead (min), phone, said } | null. Pure.
export function callAskOf(text = '') {
  const lines = String(text).split(/[\n.;]+/).map((x) => x.trim()).filter(Boolean);
  const ask = lines.find((l) => /\b(call|phone|llam\w*|tel[eé]fon\w*|notif\w*|avis\w*|contact\w*)\b/i.test(l)
    && /\b(before|prior|ahead|in advance|antes|previo|anticipa\w*|advance notice)\b/i.test(l));
  if (!ask) return null;
  const all = String(text);
  const h = ask.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|hora|horas)\b/i);
  const m = ask.match(/(\d+)\s*(?:m|min|mins|minute|minutes|minuto|minutos)\b/i);
  const half = /half (an )?hour|media hora/i.test(ask);
  const lead = h ? Math.round(Number(h[1].replace(',', '.')) * 60) : m ? Number(m[1]) : half ? 30 : 60;
  const phone = (ask.match(PHONE) || all.match(PHONE) || [])[0] || null;
  return { lead: Math.min(Math.max(lead, 10), 24 * 60), phone, said: ask.slice(0, 160) };
}

// Every stop on this load where the customer asked for a call first. Pure. → { [stop key]: { lead, phone, contact, method, source, said } }
export function callAsks(item, stops = []) {
  const notes = stopNotes(item, stops).byStop;
  const out = {};
  for (const s of stops) {
    const c = (s.callAhead || []).find((x) => x && (x.phone || x.contact));
    if (c) { out[s.key] = { lead: c.leadMinutes > 0 ? c.leadMinutes : 60, phone: c.phone || null, contact: c.contact || null, method: c.method === 'text' ? 'text' : 'call', source: 'trip sheet', said: null }; continue; }
    const n = notes[s.key] && callAskOf(notes[s.key].notes);
    if (n) out[s.key] = { lead: n.lead, phone: n.phone, contact: null, method: 'call', source: 'customer notes', said: n.said };
  }
  return out;
}

// Which stops need the push now. Pure. → [{ stop, ask, etaMs }]
export function dueCallPushes(trip, stops, asks, { steps = {}, etas = {}, sent = {}, now = Date.now() } = {}) {
  const open = stops.filter((s) => !s.delivered && !steps[`delivered:${s.key}`]);
  const out = [];
  open.forEach((s, i) => {
    const ask = asks[s.key];
    if (!ask || sent[`${trip}|${s.key}`] || steps[`arrived:${s.key}`]) return;
    const log = etas[placeKey(s.place || s.key)]; const last = log && (log.ours || []).slice(-1)[0];
    const etaMs = last && last.etaMs ? last.etaMs : null;
    const due = etaMs ? etaMs - now <= (ask.lead + HEADS_UP_MIN) * MIN && etaMs > now - 30 * MIN : i === 0 && open.length < stops.length;   // no ETA: once the stop before it is delivered
    if (due) out.push({ stop: s, ask, etaMs });
  });
  return out;
}

const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const leadEs = (m) => (m % 60 === 0 ? `${m / 60} hora${m === 60 ? '' : 's'}` : `${m} min`);
const leadEn = (m) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

// The push (Spanish first, English under it). Pure.
export function callPushFor({ stop, ask, etaMs }) {
  const where = [String(stop.name || '').replace(/\s*\*+\s*$/, ''), stop.place].filter(Boolean).join(' · ');
  const verbEs = ask.method === 'text' ? 'envíe un texto' : 'llame';
  const verbEn = ask.method === 'text' ? 'text' : 'call';
  const who = [ask.contact, ask.phone].filter(Boolean).join(' ');
  return {
    title: `📞 ${ask.method === 'text' ? 'Avise' : 'Llame'} antes de llegar · ${where}`.slice(0, 120),
    body: `El cliente pide que ${verbEs} ${leadEs(ask.lead)} antes${who ? ` a ${who}` : ''}${etaMs ? `. Llega ~${time(etaMs)}` : ''}. · Customer asks you to ${verbEn} ${leadEn(ask.lead)} before you arrive${who ? `: ${who}` : ''}.`.slice(0, 240),
  };
}

export function initCallPush({ db, board, notify, now = () => Date.now(), env = process.env }) {
  async function sweep() {
    const items = (await board()).filter((it) => ROLLING.test(String(tripOf(it).status || '')));
    const geo = (await db.get('taGeoZip', {}).catch(() => ({}))) || {};
    const checkins = (await db.get(CHECKINS(SITE), {}).catch(() => ({}))) || {};
    const etaLog = (await db.get(`taEtaLog:${SITE}`, {}).catch(() => ({}))) || {};
    const sent = (await db.get(CALLPUSH, {})) || {};
    let pushed = 0;
    for (const it of items) {
      const t = tripOf(it); const trip = String(t.tripNumber || ''); if (!trip) continue;
      const stops = driverStops(it, { geo });
      const asks = callAsks(it, stops);
      if (!Object.keys(asks).length) continue;
      const codes = [t.driver, t.driver2].map((x) => String(x || '').trim()).filter(Boolean);
      for (const d of dueCallPushes(trip, stops, asks, { steps: (checkins[trip] || {}).steps || {}, etas: etaLog[trip] || {}, sent, now: now() })) {
        const rec = { at: new Date(now()).toISOString(), city: d.stop.place || null, customer: d.stop.name || null, lead: d.ask.lead, source: d.ask.source };
        sent[`${trip}|${d.stop.key}`] = rec;
        await db.update(CALLPUSH, (cur) => ({ ...(cur || {}), [`${trip}|${d.stop.key}`]: rec }), {}); // eslint-disable-line no-await-in-loop
        const m = callPushFor(d);
        for (const c of codes) await asLive(() => notify(c, { ...m, data: { tab: 'now', trip } })).catch(() => null); // eslint-disable-line no-await-in-loop
        pushed += 1;
      }
    }
    return { pushed };
  }
  if (env.CALLPUSH_OFF !== '1' && env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    const t = setInterval(() => { sweep().catch((e) => console.warn('[callpush]', e.message)); }, 5 * MIN); if (t.unref) t.unref();
  }
  return { sweep };
}

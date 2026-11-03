// ---------------------------------------------------------------
// Call-aheads on LTL loads: a customer on the trip sheet asked to be told before the truck arrives ("CALL HALF HOUR BEFORE … BRENDA").
//   - The driver gets a reminder in the app once the truck is 50 miles out, or as soon as the stop before it is marked done.
//   - Jarvis calls the customer once the ETA is under an hour (or under what they asked for, if less): the truck is on the way and
//     the ETA, the box count only if they ask. Only for a "call" instruction with a phone number; never for a "text" one.
// Each happens once per stop. Everything is noted on the load. Training mode holds the app message and the call (copy emailed).
// ---------------------------------------------------------------
import { ltlStops } from './stopflow.js';

const SITE = 'florida-beauty';
const KEY = `taCallAhead:${SITE}`;            // `${trip}|${stop key}|remind|call` → { at, ... }
const MILES = 50;
const MAX_CALL_MIN = 60;
const tripOf = (it) => (it && it.trip) || it || {};
const up = (s) => String(s || '').trim().toUpperCase();
const lead = (c) => (c.leadMinutes != null && c.leadMinutes > 0 ? c.leadMinutes : 60);
const leadText = (m) => (m >= 60 ? `${m / 60 === 1 ? '1 hour' : `${m / 60} hours`}` : `${m} minutes`);
const etaText = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

// The watchtower's ETA for a trip sheet stop: same zip, else same city and state. Pure.
export function etaForStop(stop, etas) {
  const list = (etas && etas.stops) || [];
  const parts = (x) => String(x.label || '').split(',').map((p) => up(p));
  return list.find((e) => stop.zip && String(e.zip || '') === String(stop.zip))
    || list.find((e) => { const [c, s] = parts(e); return c && c === up(stop.city) && (!stop.state || s === up(stop.state)); }) || null;
}

// What's due now for one LTL load. Pure. → [{ kind: 'remind' | 'call', stop, contact, why, minsAway? }]
export function dueCallAheads(item, { etas = null, done = {}, sent = {}, now = Date.now() } = {}) {
  const stops = ltlStops(item);
  if (!stops) return [];
  const trip = String(tripOf(item).tripNumber);
  const out = [];
  stops.forEach((s, i) => {
    if (!(s.callAhead || []).length || done[s.key]) return;
    const e = etaForStop(s, etas);
    const prevDone = i > 0 && !!done[stops[i - 1].key];
    const close = e && e.miles != null && e.miles <= MILES;
    if (!sent[`${trip}|${s.key}|remind`] && (close || prevDone)) out.push({ kind: 'remind', stop: s, contacts: s.callAhead, why: close ? `${e.miles} miles out` : 'previous stop done' });
    const call = s.callAhead.find((c) => c.method !== 'text' && c.phone);
    if (call && e && e.etaMs && !sent[`${trip}|${s.key}|call`]) {
      const mins = (e.etaMs - now) / 60000;
      if (mins <= Math.min(MAX_CALL_MIN, lead(call)) && mins > -10) out.push({ kind: 'call', stop: s, contact: call, minsAway: Math.max(0, Math.round(mins)), etaMs: e.etaMs });
    }
  });
  return out;
}

export function initCallAhead({ db, stopDone = async () => ({}), etasFor = async () => null, messageDriver = null, callCustomer = null, log = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  async function process(site, board) {
    if (!enabled) return;
    const sent = (await db.get(KEY, {})) || {};
    for (const item of (board && board.trips) || []) {
      const trip = String(tripOf(item).tripNumber);
      if (!ltlStops(item)) continue;
      const due = dueCallAheads(item, { etas: await etasFor(trip), done: await stopDone(trip), sent, now: now() }); // eslint-disable-line no-await-in-loop
      for (const d of due) {
        const k = `${trip}|${d.stop.key}|${d.kind}`;
        const where = `${d.stop.customer}${d.stop.city ? ` (${d.stop.city})` : ''}`;
        let rec = { at: new Date(now()).toISOString() };
        if (d.kind === 'remind') {
          const who = d.contacts.map((c) => `${c.method === 'text' ? 'text' : 'call'} ${[c.contact, c.phone].filter(Boolean).join(' ')} ${leadText(lead(c))} before you arrive`).join('; ');
          const text = `Reminder for stop ${d.stop.n != null ? d.stop.n : ''} ${where}: the customer asked you to ${who}.`.replace(/\s+/g, ' ');
          const r = messageDriver ? await messageDriver(SITE, trip, text, 'Jarvis (call-ahead reminder)').catch((e) => ({ skipped: e.message })) : { skipped: 'not available' }; // eslint-disable-line no-await-in-loop
          rec = { ...rec, why: d.why, sent: !!(r && r.sent), via: (r && (r.via || r.skipped)) || null };
          if (log) await log(SITE, trip, { type: 'note', kind: 'call-ahead', text: `Call-ahead reminder to the driver for ${where} (${d.why}): ${r && r.sent ? r.via || 'sent' : `not sent — ${(r && r.skipped) || 'no app'}`}`, by: 'Jarvis', noThread: true }).catch(() => {}); // eslint-disable-line no-await-in-loop
        } else {
          const eta = etaText(d.etaMs);
          let r;
          try { r = callCustomer ? await callCustomer(trip, { phone: d.contact.phone, contact: d.contact.contact, customer: d.stop.customer, eta: `${eta} Eastern`, boxes: d.stop.boxes }) : { skipped: 'not available' }; } catch (e) { r = { skipped: e.message }; } // eslint-disable-line no-await-in-loop
          rec = { ...rec, eta, minsAway: d.minsAway, called: !!(r && r.ok), note: (r && (r.held ? 'held — training mode' : r.skipped)) || null };
          if (log) await log(SITE, trip, { type: 'note', kind: 'call-ahead', text: `Jarvis ${r && r.ok ? (r.held ? 'would call (held, training mode)' : 'called') : 'could not call'} ${d.contact.contact || 'the customer'} at ${where}: on the way, ETA ${eta} (~${d.minsAway} min)${r && r.skipped ? ` — ${r.skipped}` : ''}`, by: 'Jarvis', noThread: true }).catch(() => {}); // eslint-disable-line no-await-in-loop
        }
        sent[k] = rec;
        await db.update(KEY, (cur) => ({ ...(cur || {}), [k]: rec }), {}); // eslint-disable-line no-await-in-loop
      }
    }
  }
  return { process };
}

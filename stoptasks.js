// ---------------------------------------------------------------
// Stop instructions from our staff's email chains, followed through to the end.
// e.g. "Flower Link: deliver all 88 boxes to 316 Bohn St, Biloxi MS instead of Pensacola" (truck 2219):
//  1. the stop on the trip changes — its destination (so ETA / miles follow it) and its instruction;
//  2. the driver has it: the email says the driver confirmed, or Jarvis texts the instruction and asks
//     for "OK" (calls if no answer in 20 min);
//  3. GPS: the truck at the new place (and an alert if it stops at the OLD place instead);
//  4. the driver confirms it was done (text, then a call) — or TruckMate shows it delivered;
//  5. Jarvis replies on the SAME email chain: what was done, the GPS times, the driver's own words.
// Only what the system records is reported. Only staff emails create these (inbox.js).
// ---------------------------------------------------------------
import { haversineMi } from './watchtower.js';
import { geocodePlace } from './meetwatch.js';
import { nameScore } from './voice.js';
import { fmtLocal } from './localtime.js';

const MIN = 60000;
const SITE = 'florida-beauty';
const KEY = `taStopTasks:${SITE}`;
export const CALL_AFTER_MIN = 20;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const town = (x) => String(x || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
const sameCustomer = (a, b) => Math.max(nameScore(a || '', b || ''), nameScore(b || '', a || '')) >= 0.75;
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// "316 Bohn St, Biloxi, MS 39530". Pure.
export const placeOf = (t) => [t.address, [t.city, [t.state, t.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
export const moves = (t) => !!(t.address || t.city || t.zip);
// How close is "there": a street address → 1 mile, a city → 5 miles. Pure.
export const radiusOf = (t) => (t.address ? 1 : 5);

// The driver's answer. Pure. → 'yes' | 'no' | null
export function readAnswer(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (/\b(no|not yet|negative|todav[ií]a no|a[uú]n no|no he)\b/.test(s)) return 'no';
  if (/\b(yes|yeah|yep|ok|okay|done|delivered|confirmed|si|sí|listo|entregad[oa]s?|copy|got it|10-4|ya)\b/.test(s)) return 'yes';
  return null;
}

// The instruction text to the driver. Pure.
export function instructionText(t, driverName) {
  const what = moves(t) ? `${t.boxes ? `deliver the ${t.boxes} boxes` : 'deliver'} for ${t.customer} to ${placeOf(t)}${t.fromPlace ? ` (not ${t.fromPlace})` : ''}` : String(t.message || '').replace(/[.]+$/, '');
  return `Florida Beauty Flora dispatch: Hi${driverName ? ` ${first(driverName)}` : ''}, this is Jarvis (automated). Trip ${t.trip}: change for ${t.customer || 'a stop'} — ${what}. Please reply OK when you got it. Reply STOP to opt out.`;
}
export function verifyText(t, driverName) {
  const what = moves(t) ? `${t.boxes ? `the ${t.boxes} boxes` : 'the boxes'} for ${t.customer} at ${placeOf(t)}` : `${t.customer || 'the stop'}: ${String(t.message || '').replace(/[.]+$/, '')}`;
  return `Florida Beauty Flora dispatch: Hi${driverName ? ` ${first(driverName)}` : ''}, this is Jarvis (automated). Trip ${t.trip}: did you ${moves(t) ? 'deliver' : 'complete'} ${what}? Reply YES or NO. Reply STOP to opt out.`;
}

// Where the truck is vs the place: inside the radius and stopped / slow. Pure.
export function at(item, geo, radius, now = Date.now()) {
  const s = (item && item._samsara) || {};
  if (!geo || s.lat == null || !s.gpsAt || now - Date.parse(s.gpsAt) > 30 * MIN) return { fresh: false, inside: false };
  const mi = haversineMi(s.lat, s.lng, geo.lat, geo.lng);
  return { fresh: true, mi, inside: mi <= radius, stopped: (s.speedMph || 0) < 10, outside: mi > radius + 1 };
}

// TruckMate shows the customer's bills at the stop delivered. Pure. → ISO time | null
export function tmDelivered(item, t) {
  const bs = billsOf(item).filter((b) => sameCustomer(t.customer, (b.consignee && (b.consignee.name || b.consignee.clientName)) || b.billToName) || sameCustomer(t.customer, b.billToName));
  if (!bs.length || !bs.every((b) => b.actualDelivery)) return null;
  return bs.map((b) => String(b.actualDelivery)).sort().pop();
}

// The trip as the instruction changes it: the customer's bills / sheet stop go to the new place, and the stop
// carries the instruction. The originals are kept (_origEnd / was). Pure (returns a new item).
export function applyTask(item, t) {
  const newEnd = moves(t) ? [t.city, t.state, t.zip].filter(Boolean).join(', ').toUpperCase() : null;
  const fromT = town(String(t.fromPlace || '').split(',')[0]);
  const isMine = (name, where) => sameCustomer(t.customer, name) && (!fromT || !town(where) || town(where).startsWith(fromT) || fromT.startsWith(town(where).split(' ')[0]));
  const out = { ...item };
  const key = item.freightBills ? 'freightBills' : item.orders ? 'orders' : null;
  if (key && newEnd) out[key] = item[key].map((b) => (isMine((b.consignee && (b.consignee.name || b.consignee.clientName)) || b.billToName, b.endZoneDescription) || isMine(b.billToName, b.endZoneDescription) ? { ...b, endZoneDescription: newEnd, _origEnd: b._origEnd || b.endZoneDescription } : b));
  if (item._manifest && item._manifest.stops) {
    out._manifest = { ...item._manifest, stops: item._manifest.stops.map((s) => {
      if (!/DELIVER/i.test(s.action || '') || !isMine(s.customer, s.city)) return s;
      const note = moves(t) ? `CHANGED (${t.by || 'dispatch'}): deliver${t.boxes ? ` all ${t.boxes} boxes` : ''} to ${placeOf(t)} instead of ${s.city || t.fromPlace || 'the original stop'}` : `INSTRUCTION (${t.by || 'dispatch'}): ${t.message}`;
      return { ...s, ...(newEnd ? { city: String(t.city || s.city).toUpperCase(), state: String(t.state || s.state || '').toUpperCase(), zip: t.zip || s.zip, tmPlace: [t.city, t.state].filter(Boolean).join(', ').toUpperCase(), was: { city: s.city, state: s.state, zip: s.zip || null } } : {}),
        instructions: [...(s.instructions || []).filter((x) => !String(x).startsWith('CHANGED (') && !String(x).startsWith('INSTRUCTION (')), note], stopTask: t.id };
    }) };
  }
  out._stopTasks = [...(item._stopTasks || []), { id: t.id, customer: t.customer, place: moves(t) ? placeOf(t) : null, message: t.message, status: t.status, ack: t.ack || null, done: t.done || null }];
  return out;
}

// The email back on the chain. Pure.
export function doneEmail(t, item) {
  const where = moves(t) ? placeOf(t) : (t.fromPlace || '');
  const lt = (iso) => (iso ? fmtLocal(Date.parse(iso), [t.city, t.state].filter(Boolean).join(', ') || where) : null);
  const truck = tripOf(item).powerUnit || t.truck || '';
  const lines = [
    moves(t) ? `✅ Done — ${t.customer}${t.boxes ? `: ${t.boxes} boxes` : ''} delivered at ${where} (trip ${t.trip}${truck ? `, truck ${truck}` : ''}).` : `✅ Done — ${t.customer || 'the stop'}: ${t.message} (trip ${t.trip}${truck ? `, truck ${truck}` : ''}).`,
    t.arrivedAt ? `GPS: arrived ${lt(t.arrivedAt)}${t.departedAt ? `, left ${lt(t.departedAt)} (${Math.round((Date.parse(t.departedAt) - Date.parse(t.arrivedAt)) / MIN)} min on site)` : ''}.` : (item && item._oc ? 'No GPS on this outside carrier.' : 'GPS did not record the truck at the address.'),
    t.answer ? `Driver ${t.answer.yes ? 'confirmed' : 'answered'} by ${t.answer.how} ${lt(t.answer.at)}: “${String(t.answer.text).slice(0, 300)}”.` : null,
    t.tmDeliveredAt ? `TruckMate shows the bills delivered (${String(t.tmDeliveredAt).replace('T', ' ').slice(0, 16)} local).` : null,
  ].filter(Boolean);
  return { text: lines.join('\n'), html: `<p>${lines.map(esc).join('<br>')}</p>` };
}
export function problemEmail(t, item, what) {
  const truck = tripOf(item).powerUnit || t.truck || '';
  const text = `⚠️ ${what} — trip ${t.trip}${truck ? `, truck ${truck}` : ''}, ${t.customer}. Instruction: ${moves(t) ? `deliver to ${placeOf(t)}${t.fromPlace ? ` instead of ${t.fromPlace}` : ''}` : t.message}. Dispatch, please call the driver.`;
  return { text, html: `<p>${esc(text)}</p>` };
}

export function initStopTasks({ db, textDriver = null, voice = null, replyInThread = null, geocode = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const lookup = geocode || ((place) => geocodePlace(place, null, { env, fetchFn }));

  // a staff email gave a stop instruction (inbox.js)
  async function add(x) {
    if (!enabled || !x || !x.trip || !(x.customer || x.message)) return { ok: false };
    const id = `st${String(x.emailId || '').slice(-8)}${String(x.trip)}${town(x.customer).slice(0, 6).replace(/ /g, '')}`;
    const t = { id, trip: String(x.trip), truck: x.truck || null, customer: x.customer || null, fromPlace: x.fromPlace || null, address: x.address || null, city: x.city || null, state: x.state || null, zip: x.zip || null,
      boxes: x.boxes || null, message: String(x.message || '').slice(0, 400), emailId: x.emailId || null, by: x.by || null, since: new Date(now()).toISOString(), status: 'open',
      ack: x.driverConfirmed ? { at: new Date(now()).toISOString(), how: 'email', text: `the email says the driver${x.driverName ? ` (${x.driverName})` : ''} confirmed` } : null };
    await db.update(KEY, (cur) => ({ ...(cur || {}), [id]: { ...((cur || {})[id] || {}), ...t } }), {});
    return { ok: true, id, acked: !!t.ack };
  }

  async function overlay(site, trips) {
    if (!enabled) return;
    const all = (await db.get(KEY, {})) || {};
    const open = Object.values(all).filter((t) => t.status === 'open' || now() - Date.parse(t.closedAt || t.since) < 24 * 60 * MIN);
    if (!open.length) return;
    trips.forEach((it, i) => { for (const t of open.filter((x) => x.trip === tripNo(it))) trips[i] = Object.assign(it, applyTask(it, t)); });
  }

  async function text(trip, msg) {
    if (!textDriver) return { ok: false };
    try { const r = await textDriver(SITE, trip, msg, 'Jarvis (stop instruction)'); return { ok: !!(r && (r.sent || r.training || /^app/.test(String(r.via || '')))) }; } catch { return { ok: false }; }
  }
  async function call(trip, purpose, t) {
    if (!voice || !voice.placeCall) return false;
    try { await voice.placeCall(trip, { purpose, by: 'Jarvis (stop instruction)', vars: { customer: t.customer || 'the stop', place: moves(t) ? placeOf(t) : (t.fromPlace || ''), boxes: t.boxes ? `${t.boxes} boxes` : 'the boxes', instruction: t.message || '' } }); return true; } catch { return false; }
  }
  async function answerSince(trip, since, purpose) {
    const log = ((((await db.get(`taTripComms:${SITE}`, {})) || {})[trip]) || []).filter((c) => c.type === 'reply' && Date.parse(c.at) > since);
    for (const r of log) { const a = readAnswer(r.text); if (a) return { yes: a === 'yes', text: r.text, at: r.at, how: /app/.test(String(r.from || '')) ? 'the TagAlong app' : 'text' }; }
    const calls = voice && voice.callsFor ? (await voice.callsFor(trip, since).catch(() => [])).filter((c) => c.purpose === purpose) : [];
    for (const c of calls) { const a = readAnswer(c.summary || ''); if (a) return { yes: a === 'yes', text: c.summary, at: c.at, how: 'phone call' }; }
    return null;
  }
  async function reply(t, note) { if (t.emailId && replyInThread) { try { await replyInThread(SITE, t.emailId, { text: note.text, html: note.html, by: 'Jarvis (stop instruction)' }); return true; } catch { return false; } } return false; }

  async function process(site, board) {
    if (!enabled || !board) return [];
    const all = (await db.get(KEY, {})) || {};
    const items = board.trips || [];
    const out = [];
    for (const t0 of Object.values(all)) {
      if (t0.status !== 'open') continue;
      const t = { ...t0 };
      const item = items.find((it) => tripNo(it) === t.trip);
      if (!item || now() - Date.parse(t.since) > 72 * 60 * MIN) { t.status = item ? 'expired' : 'off the board'; t.closedAt = new Date(now()).toISOString(); all[t.id] = t; continue; }
      const s = item._samsara || {};
      const driver = (item._oc && item._oc.driverName) || (s.driver1Info && s.driver1Info.name) || s.driver1 || '';
      // 1) the driver has the instruction
      if (!t.ack) {
        if (!t.ackAskedAt) {
          const r = await text(t.trip, instructionText(t, driver)); // eslint-disable-line no-await-in-loop
          t.ackAskedAt = new Date(now()).toISOString(); t.ackText = r.ok ? 'sent' : 'not sent';
          if (!r.ok && await call(t.trip, 'stop-instruction', t)) t.ackCalledAt = t.ackAskedAt; // eslint-disable-line no-await-in-loop
        } else {
          const a = await answerSince(t.trip, Date.parse(t.ackAskedAt) - MIN, 'stop-instruction'); // eslint-disable-line no-await-in-loop
          if (a && a.yes) { t.ack = { at: a.at, how: a.how, text: a.text }; await reply(t, { text: `Driver${driver ? ` ${driver}` : ''} confirmed the change for ${t.customer} by ${a.how}: “${a.text}”. Jarvis will confirm here when it's done.`, html: `<p>Driver${driver ? ` ${esc(driver)}` : ''} confirmed the change for ${esc(t.customer)} by ${esc(a.how)}: “${esc(a.text)}”. Jarvis will confirm here when it's done.</p>` }); } // eslint-disable-line no-await-in-loop
          else if (!t.ackCalledAt && now() - Date.parse(t.ackAskedAt) >= CALL_AFTER_MIN * MIN) { t.ackCalledAt = new Date(now()).toISOString(); await call(t.trip, 'stop-instruction', t); } // eslint-disable-line no-await-in-loop
        }
      }
      // 2) GPS: where the stop is now (and where it was)
      if (!t.geo && !t.geoTriedAt) { t.geoTriedAt = new Date(now()).toISOString(); t.geo = await lookup(moves(t) ? placeOf(t) : t.fromPlace).catch(() => null); } // eslint-disable-line no-await-in-loop
      if (moves(t) && t.fromPlace && !t.oldGeo && !t.oldGeoTriedAt) { t.oldGeoTriedAt = new Date(now()).toISOString(); t.oldGeo = await lookup(t.fromPlace).catch(() => null); } // eslint-disable-line no-await-in-loop
      const here = at(item, t.geo, radiusOf(t), now());
      if (here.inside && here.stopped && !t.arrivedAt) t.arrivedAt = new Date(now()).toISOString();
      if (t.arrivedAt && !t.departedAt && here.outside) t.departedAt = new Date(now()).toISOString();
      if (moves(t) && t.oldGeo && !t.wrongPlaceAt && !t.arrivedAt) {
        const old = at(item, t.oldGeo, 3, now());
        if (old.inside && old.stopped) { t.wrongPlaceAt = new Date(now()).toISOString(); await reply(t, problemEmail(t, item, `The truck is stopped at the OLD stop (${t.fromPlace})`)); } // eslint-disable-line no-await-in-loop
      }
      const tm = tmDelivered(item, t);
      if (tm && !t.tmDeliveredAt) t.tmDeliveredAt = tm;
      // 3) done there → ask the driver it was done (text, then a call)
      const finished = t.departedAt || (t.arrivedAt && now() - Date.parse(t.arrivedAt) > 45 * MIN) || t.tmDeliveredAt;
      if (finished && !t.verifyAskedAt) {
        const r = await text(t.trip, verifyText(t, driver)); // eslint-disable-line no-await-in-loop
        t.verifyAskedAt = new Date(now()).toISOString();
        if (!r.ok && await call(t.trip, 'stop-verify', t)) t.verifyCalledAt = t.verifyAskedAt; // eslint-disable-line no-await-in-loop
      } else if (t.verifyAskedAt && !t.answer) {
        const a = await answerSince(t.trip, Date.parse(t.verifyAskedAt) - MIN, 'stop-verify'); // eslint-disable-line no-await-in-loop
        if (a) {
          t.answer = a;
          if (a.yes) { t.status = 'done'; t.done = a.at; t.closedAt = new Date(now()).toISOString(); await reply(t, doneEmail(t, item)); } // eslint-disable-line no-await-in-loop
          else { t.status = 'problem'; t.closedAt = new Date(now()).toISOString(); await reply(t, problemEmail(t, item, `The driver says it was NOT done: “${String(a.text).slice(0, 200)}”`)); } // eslint-disable-line no-await-in-loop
        } else if (!t.verifyCalledAt && now() - Date.parse(t.verifyAskedAt) >= CALL_AFTER_MIN * MIN) { t.verifyCalledAt = new Date(now()).toISOString(); await call(t.trip, 'stop-verify', t); } // eslint-disable-line no-await-in-loop
      }
      all[t.id] = t;
      out.push({ id: t.id, status: t.status });
    }
    await db.update(KEY, (cur) => { const a = { ...(cur || {}) }; for (const [k, v] of Object.entries(all)) { if (!a[k] || a[k].since === v.since) a[k] = v; } for (const [k, v] of Object.entries(a)) if (v.closedAt && now() - Date.parse(v.closedAt) > 7 * 24 * 60 * MIN) delete a[k]; return a; }, {});
    return out;
  }
  return { add, overlay, process };
}

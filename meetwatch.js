// ---------------------------------------------------------------
// Meetups and driver verifications from our staff's emails.
//  • "Meet up in Fort Pierce" (no time needed): Jarvis tracks the truck; when it reaches the
//    place it replies on the email chain ("Truck 2403 reached Fort Pierce at 11:42 PM").
//  • Anything to verify with the driver ("are both drivers together on the truck?"): Jarvis
//    texts the driver (TagAlong app first, else text — consent / STOP rules) — at the meetup
//    when there is one, else right away — and replies on the chain with the driver's answer.
// Only what the system records is reported (GPS fix, recorded send, the driver's own words).
// ---------------------------------------------------------------
import { haversineMi } from './watchtower.js';
import { renderOutboundFollowUp } from './followupmail.js';

const MIN = 60000;
const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const fmt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// How close counts as "there": a street address → 1 mile, a city / area → 5 miles. Pure.
export const radiusFor = (place) => (/\d/.test(String(place || '')) ? 1 : 5);

// Has the truck reached the place? Fresh GPS (≤ 30 min) inside the radius, and stopped / slow
// or inside on two checks in a row (not just driving through). Pure.
export function arrived(item, geo, { now = Date.now(), wasInside = false, radius = 5 } = {}) {
  const s = (item && item._samsara) || {};
  if (!geo || s.lat == null || !s.gpsAt || now - Date.parse(s.gpsAt) > 30 * MIN) return { inside: false, fresh: false };
  const mi = haversineMi(s.lat, s.lng, geo.lat, geo.lng);
  const inside = mi <= radius;
  return { inside, fresh: true, mi, done: inside && ((s.speedMph || 0) < 15 || wasInside) };
}

// The text to the driver. Pure.
export function verifyText({ name, trip, place, verify, atPlace }) {
  const hi = `Florida Beauty Flora dispatch: Hi${name ? ` ${first(name)}` : ''}, this is Jarvis (automated).`;
  const ask = verify ? `Please confirm: ${String(verify).replace(/[.?!]+$/, '')}?` : 'Please confirm the meetup is done and anything that changed.';
  return `${hi} Load ${trip}${atPlace && place ? `: I see you reached ${place}` : ''}. ${ask} Reply here. Reply STOP to opt out.`;
}

const unitOf = (item) => { const t = tripOf(item); const s = (item && item._samsara) || {}; const driver = (s.driver1Info && s.driver1Info.name) || s.driver1 || (item && item._oc && item._oc.driverName) || null; return { t, s, driver, line: `Truck ${t.powerUnit || '—'} · trailer ${t.trailer || '—'}${driver ? ` · driver ${driver}` : ''}` }; };

// Chain notes (same layout as the outbound follow-up). Pure.
export function arrivalNote({ item, w, now, asked }) {
  const { s, line } = unitOf(item);
  return renderOutboundFollowUp({ heading: `Meetup — truck reached ${w.place}`, blocks: [{
    trip: w.trip, group: w.place, sortKey: '0', scheduled: `Meetup · ${w.place}${w.date ? ` · ${w.date}` : ''} (no set time)`,
    status: { label: `Reached ${w.place}`, tone: 'green', text: `GPS ${fmt(Date.parse(s.gpsAt || new Date(now).toISOString()))} ET — ${s.location || `${s.lat}, ${s.lng}`}${s.speedMph != null ? ` · ${s.speedMph > 5 ? `${Math.round(s.speedMph)} mph` : 'stopped'}` : ''}` },
    next: asked && asked.ok ? `Asked the driver to confirm${w.verify ? `: ${w.verify}` : ' the meetup'} (${asked.via}) — Jarvis replies here with the answer` : `Dispatch: confirm with the driver${w.verify ? ` — ${w.verify}` : ''} (Jarvis couldn't text them: ${(asked && asked.why) || 'no consent / app on file'})`,
    need: null, details: [line],
  }] });
}
export function answerNote({ item, w, answer }) {
  const { line } = unitOf(item);
  return renderOutboundFollowUp({ heading: `Driver answered — trip ${w.trip}`, blocks: [{
    trip: w.trip, group: w.place || 'Driver check', sortKey: '0', scheduled: w.place ? `Meetup · ${w.place}` : 'Verification',
    status: { label: 'Driver answered', tone: 'amber', text: `“${String(answer.text).slice(0, 400)}” — ${answer.how}, ${fmt(Date.parse(answer.at))} ET` },
    next: 'Dispatch: review the answer (Jarvis does not mark it verified on its own)', need: null, details: [w.verify ? `Asked: ${w.verify}` : 'Asked: confirm the meetup', line],
  }] });
}

// A city / place → {lat, lng}: Google (server key) when set, else OpenStreetMap.
export async function geocodePlace(place, region, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const q = [place, region].filter(Boolean).join(', ');
  if (!q) return null;
  const key = env.GOOGLE_GEOCODE_KEY || env.GOOGLE_MAPS_KEY || '';
  if (key) {
    try {
      const d = await (await fetchFn(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:US&key=${key}`)).json();
      const r = d && d.status === 'OK' && d.results && d.results[0];
      if (r) return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
    } catch { /* fall through */ }
  }
  try {
    const d = await (await fetchFn(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'TagAlong-Dispatch/1.0' } })).json();
    if (d && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon), formatted: d[0].display_name };
  } catch { /* none */ }
  return null;
}

export function initMeetWatch({ db, getBoard, geocode = null, textDriver = null, replyInThread = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const lookup = geocode || ((place, region) => geocodePlace(place, region, { env, fetchFn }));
  const key = `taMeetWatch:${SITE}`;

  // a staff email asked for it (from inbox.js)
  async function add({ trip, place = null, region = null, date = null, verify = null, emailId = null, by = null }) {
    if (!enabled || !trip || (!place && !verify)) return { ok: false };
    await db.update(key, (cur) => ({ ...(cur || {}), [trip]: { trip, place, region, date, verify, emailId, by, since: new Date(now()).toISOString() } }), {});
    return { ok: true, tracking: !!place };
  }

  async function ask(item, w, atPlace) {
    if (!textDriver) return { ok: false, why: 'texting not set up' };
    const s = item._samsara || {};
    const name = (item._oc && item._oc.driverName) || (s.driver1Info && s.driver1Info.name) || s.driver1 || '';
    try {
      const r = await textDriver(SITE, w.trip, verifyText({ name, trip: w.trip, place: w.place, verify: w.verify, atPlace }), 'Jarvis (meetup / verification)');
      const ok = !!(r && (r.sent || r.training || /^app/.test(String(r.via || ''))));
      return ok ? { ok: true, via: r.training ? 'held — training mode' : (r.via || 'text') } : { ok: false, why: (r && (r.skipped || r.error)) || 'not sent' };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  async function reply(w, note) { if (w.emailId && replyInThread) { try { await replyInThread(SITE, w.emailId, { text: note.text, html: note.html, by: 'Jarvis (meetup / verification)' }); return true; } catch { return false; } } return false; }

  async function run() {
    if (!enabled) return [];
    const book = (await db.get(key, {})) || {};
    if (!Object.keys(book).length) return [];
    const items = ((await getBoard(SITE)) || {}).trips || [];
    const comms = (await db.get(`taTripComms:${SITE}`, {})) || {};
    const out = [];
    for (const w0 of Object.values(book)) {
      let w = { ...w0 };
      const item = items.find((it) => tripNo(it) === w.trip);
      if (!item || now() - Date.parse(w.since) > 48 * 60 * MIN) { w.done = w.done || (item ? 'expired' : 'off the board'); book[w.trip] = w; continue; }
      if (w.done) continue;
      // 1) the meetup place: where is it, and is the truck there?
      if (w.place && !w.arrivedAt) {
        if (!w.geo && !w.geoTriedAt) {
          w.geoTriedAt = new Date(now()).toISOString();
          try { w.geo = await lookup(w.place, w.region); } catch { w.geo = null; } // eslint-disable-line no-await-in-loop
        }
        const a = arrived(item, w.geo, { now: now(), wasInside: !!w.inside, radius: radiusFor(w.place) });
        w.inside = a.inside;
        if (a.done) {
          w.arrivedAt = new Date(now()).toISOString();
          w.asked = await ask(item, w, true); // eslint-disable-line no-await-in-loop
          if (w.asked.ok) w.askedAt = new Date(now()).toISOString();
          w.arrivalSent = await reply(w, arrivalNote({ item, w, now: now(), asked: w.asked })); // eslint-disable-line no-await-in-loop
          out.push({ trip: w.trip, arrived: w.place });
        }
      } else if (!w.place && w.verify && !w.askedAt && !w.asked) {
        // 2) nothing to wait for: ask the driver now
        w.asked = await ask(item, w, false); // eslint-disable-line no-await-in-loop
        if (w.asked.ok) w.askedAt = new Date(now()).toISOString();
        out.push({ trip: w.trip, asked: w.asked.ok });
      }
      // 3) the driver's answer → on the chain
      if (w.askedAt && !w.answeredAt) {
        const ans = (comms[w.trip] || []).filter((c) => c.type === 'reply' && Date.parse(c.at) > Date.parse(w.askedAt)).pop();
        if (ans) {
          w.answeredAt = ans.at;
          await reply(w, answerNote({ item, w, answer: { text: ans.text, at: ans.at, how: /app/.test(String(ans.from || '')) ? 'TagAlong app' : 'text' } })); // eslint-disable-line no-await-in-loop
          w.done = 'answered';
          out.push({ trip: w.trip, answered: true });
        }
      }
      if (w.askedAt === undefined && w.asked && !w.asked.ok && (!w.place || w.arrivedAt)) w.done = 'could not text';
      book[w.trip] = w;
    }
    await db.update(key, (cur) => { const a = { ...(cur || {}) }; for (const [n, w] of Object.entries(book)) { if (!a[n] || a[n].since === w.since) a[n] = w; } Object.keys(a).forEach((n) => { if (a[n].done && now() - Date.parse(a[n].since) > 72 * 60 * MIN) delete a[n]; }); return a; }, {});
    return out;
  }
  if (enabled && env.NODE_ENV !== 'test') {
    const t = setInterval(() => { run().catch((e) => console.warn('[meet-watch]', e.message)); }, 2 * MIN);
    if (t.unref) t.unref();
  }
  return { add, run };
}

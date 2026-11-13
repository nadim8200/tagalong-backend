// ---------------------------------------------------------------
// Waiting time at a shipper or receiver, on broker loads only: LTL stops from the hubs don't get it. The driver's check-in in the driver app comes
// first: "I'm at the shipper" / "I'm at the receiver" starts it and "Loaded & leaving" / "Delivered" ends it (checkins.js). Without a check-in,
// TruckMate marks the truck there, or a person answers the stop email
// that it's at the shipper or receiver, or the GPS parks it at the rate con's pickup. The clock starts 3 hours after the appointment, or 3 hours
// after arrival if the truck got there later, so a truck that came early doesn't count its early hours. While it's there no stop emails go out. When the clock is due, dispatch
// gets an email and approves it or not. When the truck leaves, approved or unanswered clocks get a total. Internal only: nothing here
// reaches a customer, a broker or a driver, and it is never a bill by itself.
// ---------------------------------------------------------------
import { makeToken, readToken, page, loadRows } from './breakdownreport.js';
import { brokerLoad, yardMiles } from './watchtower.js';
import { stopsLeft } from './loadstops.js';
import { plannedPickup } from './pickupfollow.js';
import { CHECKINS } from './checkins.js';

const KEY = (site) => `taWaiting:${site}`;
const SITE = 'florida-beauty';
const FREE_MS = 3 * 3600000;
const GPS_FRESH_MS = 30 * 60000;
const MOVING_MPH = 10;
const NEAR_MILES = 15;              // miles to the stop come from its ZIP, so this can't be tight
const GONE_MS = 3 * 60000;          // moving this long means it left, not that it pulled to another door
const STALE_MS = 24 * 3600000;      // a status left on "arrived" for a day says nothing about waiting now
const QUICK_MS = 10 * 60000;
const YARD_MILES = 0.5;            // GPS this close to our Miami terminal, lot or cooler: the truck is home, not waiting at a customer        // arrived and departed this close together is someone clicking through, not a truck leaving
const KEEP_DAYS = 30;
const PURPOSE = 'waiting-time';
const AT_STOP = { ARRSHIP: 'shipper', ARRCONS: 'receiver' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const tripNo = (it) => String(((it && it.trip) || {}).tripNumber || '');

// The truck's fresh GPS has it at our own Miami yard (terminal, lot or cooler): never waiting time. Pure.
export function atOurYard(item, now = Date.now()) {
  const l = (item && item._samsara) || {};
  const at = l.gpsAt ? Date.parse(l.gpsAt) : NaN;
  if (l.lat == null || l.lng == null || Number.isNaN(at) || now - at > GPS_FRESH_MS) return false;
  return yardMiles({ lat: Number(l.lat), lng: Number(l.lng) }) <= YARD_MILES;
}

// When the clock starts. Pure.
export const clockStart = (arrivedMs, apptMs = null) => Math.max(arrivedMs, apptMs || 0) + FREE_MS;

// Where TruckMate says the truck is: the last status, when it's an arrival. A depart marked right after the arrival doesn't count yet: the GPS decides. Pure.
export function atStop(item) {
  const h = (item && item._times && item._times.statusHistory) || [];
  const last = h[h.length - 1];
  const kind = last && AT_STOP[String(last.status).toUpperCase()];
  if (kind) return { kind, arrivedMs: Date.parse(last.at) };
  const before = h[h.length - 2];
  const was = before && AT_STOP[String(before.status).toUpperCase()];
  if (was && last && /^DEP/i.test(last.status) && Date.parse(last.at) - Date.parse(before.at) <= QUICK_MS) return { kind: was, arrivedMs: Date.parse(before.at), quick: true };
  return null;
}
// What someone's answer on the stop email says about where the truck is. Pure. → 'shipper' | 'receiver' | null
export function kindFromAnswer(reason) {
  const t = String(reason || '');
  if (/\b(?:receiver|consignee|unload(?:ing|ed)?|delivering|at (?:the )?delivery|descarg\w*|entregando)\b/i.test(t)) return 'receiver';
  if (/\b(?:shipper|loading|(?:getting|being) loaded|at (?:the )?pick ?up|cargando)\b/i.test(t)) return 'shipper';
  return null;
}
// Which of the rate con's pickups the GPS has the truck parked at, by the city and state or ZIP in its location. Pure. → index | null
export function parkedAtPickup(item, gps) {
  if (gps !== 'parked') return null;
  const where = String((item && item._samsara && item._samsara.location) || '').toUpperCase();
  const rc = item && item._ratecon && (item._ratecon.data || item._ratecon);
  if (!where || !rc || /^(ARRCONS|DEPCONS|DELV)/i.test(String((item.trip || {}).status || ''))) return null;
  const i = (rc.pickups || []).findIndex((p) => p && ((p.zip && where.includes(String(p.zip).slice(0, 5))) || (p.city && p.state && where.includes(`${String(p.city).toUpperCase()}, ${String(p.state).toUpperCase()}`))));
  return i < 0 ? null : i;
}
// When TruckMate says it left, after arriving. Pure.
export function leftAt(item, arrivedMs) {
  const next = ((item && item._times && item._times.statusHistory) || []).find((x) => Date.parse(x.at) > arrivedMs && /^DEP/i.test(x.status));
  return next ? Date.parse(next.at) : null;
}

// What the GPS says, because a status nobody updated proves nothing. Pure. → 'parked' | 'moved' | 'unknown'
export function gpsSays(item, leg, now = Date.now()) {
  const l = (item && item._samsara) || {};
  const at = l.gpsAt ? Date.parse(l.gpsAt) : NaN;
  if (Number.isNaN(at) || now - at > GPS_FRESH_MS || l.speedMph == null) return 'unknown';
  if (leg && leg.miles != null && leg.miles > NEAR_MILES) return 'moved';
  return l.speedMph > MOVING_MPH ? 'moved' : l.speedMph <= 3 ? 'parked' : 'unknown';
}

// What to do with one record now. Pure. → 'ask' | 'total' | 'close' | null
export function stepOf(r, { here, now, gps = 'parked' }) {
  if (r.closedAt) return null;
  if (here) return !r.askedAt && now >= r.startMs && gps === 'parked' ? 'ask' : null;
  return r.askedAt && r.status !== 'declined' ? 'total' : 'close';
}

// The driver's check-ins on a load → waiting-time records: in at the tap, out at the matching tap (or null while still there). Pure.
// steps = { 'at-shipper': { at }, loaded: { at }, 'arrived:<stop>': { at }, 'delivered:<stop>': { at } }
export function checkinStays(trip, steps = {}) {
  const out = [];
  const add = (inStep, outStep, kind, stop) => { const a = steps[inStep]; if (!a || !a.at) return; const b = steps[outStep]; out.push({ key: `${trip}:c:${inStep}`, kind, stop, arrivedMs: Date.parse(a.at), outMs: b && b.at ? Date.parse(b.at) : null }); };
  add('at-shipper', 'loaded', 'shipper', null);
  for (const k of Object.keys(steps)) if (/^arrived:/.test(k)) { const stop = k.slice(8); add(k, `delivered:${stop}`, 'receiver', stop); }
  return out;
}

export function initWaitingTime(app, { db, secret, send, recipients, getBoard = async () => ({ trips: [] }), etas = async () => ({}), baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async () => (await db.get(KEY(SITE), {})) || {};
  const patch = (k, fields) => db.update(KEY(SITE), (cur) => ({ ...(cur || {}), [k]: { ...(cur || {})[k], ...fields } }), {});
  const link = (r, x = false) => `${baseUrl}/wt/${makeToken({ k: r.key, t: r.trip, u: r.unit, s: r.stop, ...(x ? { x: true } : {}) }, secret, now(), PURPOSE, 3)}`;

  async function process(board) {
    if (!enabled) return;
    const items = (board && board.trips) || [];
    const stored = await all(); const firstRun = !(await db.get(`${KEY(SITE)}:began`, null));
    const legs = await etas();
    const fresh = {};
    const legOf = (trip, kind) => (kind === 'receiver' ? ((legs[trip] || {}).stops || [])[0] || null : null);   // the ETA's stops are deliveries: nothing to measure a shipper by
    const apptOf = (it, kind) => { if (kind === 'receiver') return (legOf(tripNo(it), kind) || {}).apptMs || null; const p = plannedPickup(it); return (p && p.ms) || null; };
    const stopOf = (it, kind) => {
      if (kind === 'shipper') return (plannedPickup(it) || {}).place || ((it && it._samsara) || {}).location || null;
      const leg = legOf(tripNo(it), kind); const next = stopsLeft(it).stops[0];
      return (leg && leg.label) || (next && [next.customer, next.place].filter(Boolean).join(', ')) || null;
    };
    const record = (it, key, kind, arrivedMs, extra = {}) => { const t = it.trip || {}; const apptMs = apptOf(it, kind); return { key, trip: tripNo(it), unit: t.powerUnit || null, trailer: t.trailer || null, kind, stop: stopOf(it, kind), arrivedMs, apptMs, startMs: clockStart(arrivedMs, apptMs), status: 'open', ...extra, ...(firstRun ? { closedAt: now(), adopted: true } : {}) }; };   // already there on day one: no email for what we didn't watch
    const counting = new Set(Object.values(stored).filter((r) => !r.closedAt).map((r) => r.trip));
    const open = (r) => { if (!counting.has(r.trip)) { fresh[r.key] = r; counting.add(r.trip); } };
    // 1) the driver checked in at the shipper / receiver in the driver app: that's when the stay starts (it wins over everything below)
    const taps = (await db.get(CHECKINS(SITE), {})) || {};
    for (const it of items) {
      if (!brokerLoad(it) || atOurYard(it, now())) continue;
      for (const c of checkinStays(tripNo(it), ((taps[tripNo(it)] || {}).steps) || {})) {
        if (stored[c.key] || c.outMs || Number.isNaN(c.arrivedMs) || now() - c.arrivedMs > STALE_MS) continue;
        // a clock TruckMate / GPS opened for this load gives way to the driver's own check-in (closed quietly, no total)
        for (const r of Object.values(stored)) if (r.trip === tripNo(it) && !r.closedAt && !r.checkin && !r.askedAt) { await patch(r.key, { closedAt: now(), closedWhy: 'replaced by the driver\'s check-in' }); r.closedAt = now(); counting.delete(r.trip); } // eslint-disable-line no-await-in-loop
        open(record(it, c.key, c.kind, c.arrivedMs, { anchored: true, checkin: true, stopKey: c.stop, source: 'driver checked in (driver app)', ...(c.stop ? { stop: c.stop } : {}) }));
      }
    }
    for (const it of items) {
      const at = brokerLoad(it) ? atStop(it) : null;
      if (!at || Number.isNaN(at.arrivedMs) || now() - at.arrivedMs > STALE_MS || atOurYard(it, now())) continue;
      // arrived and departed a minute apart: someone clicking ahead in TruckMate. It only counts if the truck is really stopped there
      if (at.quick && gpsSays(it, null, now()) !== 'parked') continue;
      const key = `${tripNo(it)}:${at.arrivedMs}`;
      if (!stored[key]) open(record(it, key, at.kind, at.arrivedMs, at.quick ? { quick: true } : {}));
    }
    // a person said it's there: "Still at the shipper getting loaded" on the stop email
    const units = ((await db.get(`taWatch:${SITE}`, {})) || {}).units || {};
    for (const ep of Object.values(units).map((u) => u && u.stopEpisode).filter((x) => x && x.review && x.review.status === 'authorized' && x.stoppedSinceMs)) {
      const kind = kindFromAnswer(ep.review.reason); const it = kind && items.find((x) => tripNo(x) === String(ep.trip));
      if (!it || !brokerLoad(it) || atOurYard(it, now())) continue;
      const key = `${ep.trip}:a${ep.stoppedSinceMs}`;
      if (!stored[key]) open(record(it, key, kind, ep.stoppedSinceMs, { anchored: true, source: `${ep.review.by}: ${oneLine(ep.review.reason, 120)}` }));
    }
    // the GPS has it parked at the rate con's pickup, whatever the status says
    for (const it of items) {
      if (!brokerLoad(it) || atOurYard(it, now())) continue;
      const i = parkedAtPickup(it, gpsSays(it, null, now()));
      if (i == null) continue;
      const key = `${tripNo(it)}:p${i}`;
      if (!stored[key]) open(record(it, key, 'shipper', now(), { anchored: true, source: 'GPS at the pickup' }));
    }
    if (Object.keys(fresh).length) await db.update(KEY(SITE), (cur) => ({ ...fresh, ...(cur || {}) }), {});
    if (firstRun) await db.set(`${KEY(SITE)}:began`, now());
    const list = Object.values({ ...fresh, ...stored }).filter((r) => !r.closedAt);
    for (const r of list) {
      const it = items.find((x) => tripNo(x) === r.trip) || null;
      const a = it && atStop(it);
      const leg = legOf(r.trip, r.kind);
      const gps = it ? gpsSays(it, leg, now()) : 'unknown';
      // a truck that's rolling has left, whatever the status says. A short move can be another door, so it has to keep going
      const movingAt = gps === 'moved' ? (r.movingAt || now()) : null;
      if ((movingAt || null) !== (r.movingAt || null)) await patch(r.key, { movingAt }); // eslint-disable-line no-await-in-loop
      const gone = !!movingAt && now() - movingAt >= GONE_MS;
      // back at our own yard: it isn't waiting at the customer. A clock nobody approved just closes (no total email)
      const home = !!it && atOurYard(it, now());
      if (home && r.status !== 'approved') { await patch(r.key, { closedAt: now(), closedWhy: 'truck at our yard' }); continue; } // eslint-disable-line no-await-in-loop
      // a check-in stay: there until the driver taps out (Loaded & leaving / Delivered); the GPS only ends it if they never do
      const tapOut = r.checkin ? (((taps[r.trip] || {}).steps || {})[r.kind === 'shipper' ? 'loaded' : `delivered:${r.stopKey}`] || null) : null;
      const here = r.checkin ? !!it && !tapOut && !gone && !home : (r.anchored ? !!it : !!(a && a.arrivedMs === r.arrivedMs)) && !gone && !home;
      // the appointment may not have been on file when the truck got there
      if (here && !r.askedAt && !r.apptMs && leg && leg.apptMs) { const startMs = clockStart(r.arrivedMs, leg.apptMs); await patch(r.key, { apptMs: leg.apptMs, startMs, stop: r.stop || leg.label }); Object.assign(r, { apptMs: leg.apptMs, startMs, stop: r.stop || leg.label }); } // eslint-disable-line no-await-in-loop
      const step = stepOf(r, { here, now: now(), gps: r.checkin ? 'parked' : gps });   // the driver said they're there
      if (!step) continue;
      if (step === 'close') { await patch(r.key, { closedAt: now() }); continue; } // eslint-disable-line no-await-in-loop
      try {
        if (step === 'ask') { await patch(r.key, { askedAt: now() }); await send('start', { ...r, askedAt: now() }, it, link(r), await recipients()); continue; } // eslint-disable-line no-await-in-loop
        const left = (tapOut && Date.parse(tapOut.at)) || (!r.anchored && !r.quick && it && leftAt(it, r.arrivedMs)) || movingAt || now();
        const done = { ...r, leftMs: left, waitedMs: Math.max(0, left - r.startMs), closedAt: now() };
        await patch(r.key, done); await send('total', done, it, null, await recipients()); // eslint-disable-line no-await-in-loop
      } catch (e) { console.warn('[waiting-time]', r.key, e.message); }
    }
    const old = now() - KEEP_DAYS * 86400000;
    if (Object.values(stored).some((r) => r.closedAt && r.closedAt < old)) await db.update(KEY(SITE), (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([, r]) => !r.closedAt || r.closedAt >= old)), {});
  }

  // Trucks we know are at a shipper or receiver: a stop email would only repeat it.
  const openTrips = async () => new Set(Object.values(await all()).filter((r) => !r.closedAt).map((r) => r.trip));

  async function decide(p, { status, name, note }) {
    const by = oneLine(name, 80);
    if (!['approved', 'declined'].includes(status)) return { code: 400, error: 'Choose Approve or Don\'t approve.' };
    if (!by) return { code: 400, error: 'Add your name.' };
    if (p.x) return { code: 200, ok: true, example: true };
    const r = (await all())[p.k];
    if (!r || r.closedAt) return { code: 409, error: 'The truck already left.' };
    if (r.status === status) return { code: 200, ok: true, already: true };
    const fields = { status, decidedBy: by, decidedAt: now(), note: oneLine(note, 300) || null };
    await patch(p.k, fields);
    // everyone who got the question hears the answer
    try {
      const it = (((await getBoard()) || {}).trips || []).find((x) => tripNo(x) === r.trip) || null;
      await send('decided', { ...r, ...fields }, it, null, await recipients());
      return { code: 200, ok: true, emailed: true };
    } catch (e) { console.warn('[waiting-time]', e.message); return { code: 200, ok: true, emailed: false }; }
  }

  async function overlay(site0, trips) {
    const open = Object.values(await all()).filter((r) => !r.closedAt && r.askedAt);   // the card shows a clock only once it really began
    for (const it of trips) { const r = open.find((x) => x.trip === tripNo(it)); if (r) it._waiting = { startMs: r.startMs, status: r.status, kind: r.kind }; }
  }

  if (app) {
    app.get('/wt/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      const r = p && !p.x ? (await all())[p.k] : null;
      const done = r && r.status !== 'open' ? `<p><b>${esc(r.decidedBy)}</b> marked this <b>${r.status === 'approved' ? 'approved' : 'not approved'}</b>.</p>` : '';
      res.set('Cache-Control', 'no-store').type('html').send(!p ? page('Link not valid', '<h1>This link has expired</h1>') : page('Waiting time', `<style>.t{display:flex;border:1px solid #B8C3D3;border-radius:8px;overflow:hidden}.t input{position:absolute;opacity:0;width:1px;height:1px}.t label{flex:1;margin:0;padding:14px 8px;text-align:center;color:#13325B;cursor:pointer}.t input:checked+label{color:#fff}.t input#a:checked+label{background:#166534}.t input#d:checked+label{background:#C62828}button.go{background:#13325B}</style><h1>Waiting time</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}${p.s ? ` · ${esc(p.s)}` : ''}</p>${done}<form id="f"><div class="t" role="radiogroup" aria-label="Start the waiting time clock?"><input type="radio" name="s" id="a" value="approved"${req.query.d === 'approved' ? ' checked' : ''}><label for="a">Approve</label><input type="radio" name="s" id="d" value="declined"${req.query.d === 'declined' ? ' checked' : ''}><label for="d">Don't approve</label></div><label for="r">Note (optional)</label><textarea id="r" maxlength="300"></textarea><label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name"><button id="b" class="go" type="submit">Submit</button><div class="e" id="e" role="alert"></div></form><script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e'),s=document.querySelector('input[name=s]:checked');e.textContent='';if(!s){e.textContent='Choose one.';return;}b.disabled=true;try{var x=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:s.value,note:document.getElementById('r').value,name:document.getElementById('n').value})});var j=await x.json();if(!x.ok)throw new Error(j.error||'Could not save.');document.querySelector('.c').innerHTML='<h1>Saved</h1><p class="s">'+(j.emailed===false?'The email to the team did not go out, so please tell them.':'The team has the email.')+' You can close this page.</p>';}catch(y){e.textContent=y.message;b.disabled=false;}});</script>`));
    });
    app.post('/wt/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      try { const r = await decide(p, req.body || {}); return res.status(r.code).json(r); } catch (e) { console.warn('[waiting-time]', e.message); return res.status(500).json({ error: 'Could not save.' }); }
    });
  }
  return { process, overlay, decide, link, loadRows, openTrips };
}

// ---------------------------------------------------------------
// A truck's whole trip, for the Fleet map's "Trip history": the GPS trail since the load was
// dispatched, every stop of 15+ minutes with what happened there (sleeper / 10-hour reset /
// 34-hour restart / break / driver change / fuel or work / delivery / breakdown), who took the
// wheel when, TruckMate's status changes, and every text and Jarvis call with the drivers —
// each pinned to where the truck was at that moment.
// ---------------------------------------------------------------
import { samsaraTokenFrom, getLiveIndex, vehicleForUnit, vehicleGpsHistory, driverHosLogs, vehicleFuelHistory } from './samsara.js';
import { haversineMi } from './watchtower.js';

const SITE = 'florida-beauty';
const MIN = 60000;
const tripOf = (it) => (it && it.trip) || it || {};
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const ms = (x) => (typeof x === 'number' ? x : Date.parse(x || ''));

// Stops: the truck stays within `radiusMi` for `minMin`+ minutes (a lone fix before a GPS gap only
// counts if the truck was standing still). Pure. points: [{t, lat, lng, mph, place}] sorted by time.
export function findStops(points, { minMin = 15, radiusMi = 0.25 } = {}) {
  const pts = (points || []).filter((p) => p && p.lat != null && p.t);
  const out = [];
  let j = 0;
  while (j < pts.length) {
    const p = pts[j];
    let k = j;
    while (k + 1 < pts.length && haversineMi(pts[k + 1].lat, pts[k + 1].lng, p.lat, p.lng) <= radiusMi) k++;
    const end = k + 1 < pts.length ? ms(pts[k + 1].t) : ms(pts[k].t);
    const minutes = Math.round((end - ms(p.t)) / MIN);
    const still = k > j || (p.mph != null && p.mph <= 3);
    if (still && minutes >= minMin) out.push({ fromMs: ms(p.t), toMs: end, minutes, lat: p.lat, lng: p.lng, place: p.place || null, ongoing: k === pts.length - 1 });
    j = k + 1;
  }
  return out;
}

// Who was driving when: the driving segments from the duty logs, joined when the same driver keeps
// driving, and a change event each time a different driver takes the wheel. Pure.
export function wheelChanges(logs = [], names = {}) {
  const segs = (logs || []).filter((l) => l.status === 'driving').sort((a, b) => a.from - b.from);
  const out = [];
  let prev = null;
  for (const s of segs) {
    if (prev && prev.driverId !== s.driverId) out.push({ atMs: s.from, from: names[prev.driverId] || 'the other driver', to: names[s.driverId] || 'the other driver' });
    prev = s;
  }
  return out;
}

// The tank before and after a stop (last reading before it, the highest reading during / right after it);
// a rise of 10+ points is a fill-up. Pure. fuel: [{ t, pct }] sorted.
export function fuelAround(s, fuel = []) {
  if (!fuel.length) return null;
  const before = fuel.filter((f) => f.t <= s.fromMs + 2 * MIN).pop();
  const after = fuel.filter((f) => f.t >= s.fromMs && f.t <= s.toMs + 20 * MIN);
  if (!before && !after.length) return null;
  const from = before ? before.pct : after[0].pct;
  const to = after.length ? Math.max(...after.map((f) => f.pct)) : from;
  return { from, to, filled: to - from >= 10 };
}

const STATUS_WORD = { offDuty: 'off duty', sleeperBerth: 'sleeper', driving: 'driving', onDuty: 'on duty', yardMove: 'yard move', personalConveyance: 'personal conveyance' };
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);

// What happened at one stop — from the duty logs, the customer geofences, TruckMate's arrive/depart
// times and road calls. Pure.
export function classifyStop(s, { logs = [], names = {}, visits = [], statuses = [], roadCalls = [], fuel = [] } = {}) {
  const span = Math.max(1, s.toMs - s.fromMs);
  const overlaps = (a, b) => Math.min(s.toMs, b) - Math.max(s.fromMs, a);
  // per driver: share of the stop in each status
  const per = {};
  for (const l of logs) {
    const o = overlaps(l.from, l.to); if (o <= 0) continue;
    const d = (per[l.driverId || 'driver'] = per[l.driverId || 'driver'] || {});
    const st = l.status === 'sleeperBed' ? 'sleeperBerth' : l.status;   // Samsara's name for it
    d[st] = (d[st] || 0) + o;
  }
  const drivers = Object.entries(per).map(([id, d]) => {
    const top = Object.entries(d).sort((a, b) => b[1] - a[1])[0];
    const rest = (d.offDuty || 0) + (d.sleeperBerth || 0);
    // resting = what they did MOST of the stop was off duty / sleeper (a few on-duty minutes at the start don't count)
    const resting = (top && (top[0] === 'offDuty' || top[0] === 'sleeperBerth')) || rest / span >= 0.5;
    return { id, name: names[id] || null, status: top ? (STATUS_WORD[top[0]] || top[0]) : null, resting, offDuty: !!top && top[0] === 'offDuty', pc: (d.personalConveyance || 0) / span >= 0.3 };
  });
  // who drove right before and right after
  const driving = logs.filter((l) => l.status === 'driving');
  const before = driving.filter((l) => l.to <= s.fromMs + 5 * MIN).sort((a, b) => b.to - a.to)[0];
  const after = driving.filter((l) => l.from >= s.toMs - 5 * MIN).sort((a, b) => a.from - b.from)[0];
  const swap = before && after && before.driverId !== after.driverId ? { from: names[before.driverId] || 'one driver', to: names[after.driverId] || 'the other driver' } : null;
  const visit = visits.find((v) => v.enteredAt && overlaps(v.enteredAt, v.exitedAt || s.toMs) > 0);
  const tm = statuses.filter((x) => ms(x.at) >= s.fromMs - 10 * MIN && ms(x.at) <= s.toMs + 10 * MIN);
  const rc = roadCalls.find((r) => ms(r.at) >= s.fromMs - 30 * MIN && ms(r.at) <= s.toMs);
  const notes = [];
  let kind; let label;
  if (rc) { kind = 'breakdown'; label = `Road call — ${rc.type || 'breakdown'}`; if (rc.details) notes.push(rc.details); }
  else if (visit) { kind = 'delivery'; label = `At ${visit.name}`; }
  else if (tm.some((x) => /^(ARRCONS|DEPCONS)/.test(x.status))) { kind = 'delivery'; label = 'At a consignee (TruckMate)'; }
  else if (tm.some((x) => /^(ARRSHIP|DEPSHIP|LOADED)/.test(x.status))) { kind = 'pickup'; label = 'At the shipper (TruckMate)'; }
  else if (drivers.length && drivers.every((d) => d.resting)) {
    kind = 'rest';
    label = s.minutes >= 34 * 60 ? '34-hour restart' : s.minutes >= 10 * 60 ? '10-hour reset' : s.minutes >= 30 ? (drivers.some((d) => d.offDuty) ? 'Break (off duty)' : 'Rest (sleeper)') : 'Short break';
  } else if (drivers.some((d) => d.pc)) { kind = 'pc'; label = 'Personal conveyance'; }
  else if (drivers.length) { kind = 'work'; label = s.minutes > 75 ? 'On duty — stopped' : fuel.length ? 'On duty — no fuel added' : 'Fuel / work (on duty)'; }
  else { kind = 'stop'; label = 'Stopped (no duty status)'; }
  const tank = fuelAround(s, fuel);
  if (tank && tank.filled) { notes.push(`Fueled: ${tank.from}% → ${tank.to}%`); if (['work', 'stop', 'swap', 'rest'].includes(kind) && !(kind === 'rest' && s.minutes >= 8 * 60)) { kind = 'fuel'; label = 'Fuel stop'; } }
  if (swap) { notes.push(`Driver change: ${swap.from} → ${swap.to}`); if (kind === 'work' || kind === 'stop') { kind = 'swap'; label = 'Driver change'; } }
  for (const x of tm) notes.push(`TruckMate: ${x.desc || x.status}`);
  return { ...s, kind, label, duration: dur(s.minutes), drivers: drivers.map(({ id, name, status }) => ({ id, name, status })), swap, notes, fuel: tank };
}

// the trail point nearest a moment (for pinning a text / call / status change on the map). Pure.
export function pointAt(points, t) {
  if (!points.length || !Number.isFinite(t)) return null;
  let lo = 0; let hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ms(points[mid].t) < t) lo = mid + 1; else hi = mid; }
  const a = points[Math.max(0, lo - 1)]; const b = points[lo];
  const p = Math.abs(ms(a.t) - t) < Math.abs(ms(b.t) - t) ? a : b;
  return Math.abs(ms(p.t) - t) <= 3 * 3600000 ? { lat: p.lat, lng: p.lng } : null;
}

// Keep the trail light: at most `max` points, never dropping a stop's first point. Pure.
export function thin(points, max = 1500, keep = new Set()) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  return points.filter((p, i) => i % step === 0 || i === points.length - 1 || keep.has(ms(p.t)));
}

// When the trip started for this truck: dispatched (or departed the shipper), else 3 days back. Pure.
export function tripStart(item, now = Date.now()) {
  const t = (item && item._times) || {};
  // TruckMate's own DISPATCHED / DEPART SHIPPER first (its "dispatchedAt" can be when the trailer was being loaded)
  const hist = (t.statusHistory || []).filter((x) => /^(DISP|DEPSHIP)$/.test(x.status)).map((x) => ms(x.at)).filter(Number.isFinite);
  const cands = hist.length ? hist : [ms(t.dispatchedAt)].filter(Number.isFinite);
  const start = cands.length ? Math.min(...cands) - 60 * MIN : now - 72 * 3600000;
  return Math.max(start, now - 10 * 86400000);
}

export function initJourney(app, { requireAuth, db, getBoard, activity = null, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const cache = new Map();   // trip → { at, data }

  async function build(trip) {
    const board = await getBoard(SITE);
    const item = ((board && board.trips) || []).find((it) => String(tripOf(it).tripNumber || '') === String(trip));
    if (!item) return { error: 'This load is not on the board.' };
    const t = tripOf(item);
    const unit = String(t.powerUnit || '').trim();
    const token = samsaraTokenFrom(env);
    const startMs = tripStart(item, now());
    const fromIso = new Date(startMs).toISOString(); const toIso = new Date(now()).toISOString();
    const out = { trip: String(trip), truck: unit || null, from: fromIso, to: toIso, points: [], stops: [], events: [], source: null, note: null };
    if (!token) out.note = 'No Samsara connection — the trail is not available.';
    let idx = null; let pts = []; let logs = []; let fuel = []; const names = {};
    if (token && unit) {
      try {
        idx = await getLiveIndex(token);
        const veh = vehicleForUnit(idx, unit);
        if (veh && veh.id != null) {
          [pts, fuel] = await Promise.all([vehicleGpsHistory(token, veh.id, fromIso, toIso), vehicleFuelHistory(token, veh.id, fromIso, toIso).catch(() => [])]);
          out.source = 'Samsara';
        }
        else out.note = `Truck ${unit} is not in Samsara.`;
      } catch (e) { out.note = `GPS history unavailable (${e.message}).`; }
      try {
        const norm = (x) => String(x == null ? '' : x).trim().toLowerCase().replace(/^0+(?=\d)/, '');
        const ds = [t.driver, t.driver2].map((c) => idx && idx.driversByCode && idx.driversByCode[norm(c)]).filter(Boolean);
        for (const d of ds) names[String(d.id)] = d.name;
        if (ds.length) logs = await driverHosLogs(token, ds.map((d) => d.id), fromIso, toIso);
      } catch { logs = []; }
    }
    // what the board knows about this trip
    const visits = Object.values(item._visits || {}).filter((v) => v && v.enteredAt).map((v) => ({ name: (v.geofence && v.geofence.name) || 'a customer', enteredAt: v.enteredAt, exitedAt: v.exitedAt || null, dwellMin: v.dwellMin }));
    const statuses = ((item._times && item._times.statusHistory) || []).filter((x) => ms(x.at) >= startMs);
    const roadCalls = enabled ? ((await db.get(`taRoadCalls:${SITE}`, [])) || []).filter((r) => String(r.trip || '') === String(trip)) : [];

    const stops = findStops(pts).map((s) => classifyStop(s, { logs, names, visits, statuses, roadCalls, fuel }));
    out.fuelNow = fuel.length ? fuel[fuel.length - 1].pct : (item._samsara && item._samsara.fuelPct != null ? item._samsara.fuelPct : null);
    out.fueled = stops.filter((s) => s.fuel && s.fuel.filled).length;
    out.stops = stops.map((s, i) => ({ n: i + 1, ...s, from: new Date(s.fromMs).toISOString(), to: new Date(s.toMs).toISOString() }));
    const keep = new Set(stops.map((s) => s.fromMs));
    out.points = thin(pts, 1500, keep).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5, ms(p.t), p.mph]);
    let miles = 0; for (let i = 1; i < pts.length; i++) miles += haversineMi(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    out.miles = Math.round(miles);

    // the timeline: TruckMate status changes, driver changes, texts / replies / calls, road calls
    const ev = [];
    const at = (x) => { const p = pointAt(pts, ms(x)); return p ? { lat: p.lat, lng: p.lng } : {}; };
    for (const x of statuses) ev.push({ type: 'status', at: x.at, title: `TruckMate: ${x.desc || x.status}`, ...at(x.at) });
    for (const w of wheelChanges(logs, names)) {
      const inStop = stops.some((s) => w.atMs >= s.fromMs - 5 * MIN && w.atMs <= s.toMs + 10 * MIN);
      if (!inStop) ev.push({ type: 'swap', at: new Date(w.atMs).toISOString(), title: `${w.to} took the wheel`, detail: `from ${w.from}`, ...at(w.atMs) });
    }
    for (const r of roadCalls) ev.push({ type: 'roadcall', at: r.at, title: `Road call ${r.id} — ${r.type || 'breakdown'}`, detail: [r.details, r.status].filter(Boolean).join(' · '), ...at(r.at) });
    // texts and calls with the drivers on this load (Jarvis and dispatch)
    const comms = enabled ? (((await db.get(`taTripComms:${SITE}`, {})) || {})[String(trip)] || []) : [];
    const sam = item._samsara || {};
    const driverPhones = [sam.driver1Info && sam.driver1Info.phone, sam.driver2Info && sam.driver2Info.phone, item._oc && item._oc.driverPhone, item._oc && item._oc.driver2Phone].filter(Boolean);
    const jarvisCalls = activity && activity.callsWith ? await activity.callsWith(driverPhones, { days: 12 }).catch(() => []) : [];
    const nameFor = (phone) => {
      const P = last10(phone);
      if (P && sam.driver1Info && last10(sam.driver1Info.phone) === P) return sam.driver1 || null;
      if (P && sam.driver2Info && last10(sam.driver2Info.phone) === P) return sam.driver2 || null;
      return null;
    };
    const usedCalls = new Set();
    for (const c of comms) {
      if (ms(c.at) < startMs) continue;
      if (c.type === 'text' || c.type === 'reply') {
        const inbound = c.type === 'reply';
        const who = nameFor(inbound ? c.from : c.to) || (inbound ? c.from : c.to) || 'the driver';
        ev.push({ type: inbound ? 'reply' : 'text', at: c.at, title: inbound ? `${who} texted back` : `${c.ai || /jarvis/i.test(String(c.by || '')) ? 'Jarvis' : (c.by || 'Dispatch')} texted ${who}`, text: String(c.text || '').slice(0, 1200), by: c.by || null, ...at(c.at) });
      } else if (c.type === 'note') {
        ev.push({ type: 'note', at: c.at, title: `Note${c.by ? ` by ${c.by}` : ''}`, text: String(c.text || c.note || '').slice(0, 1200), ...at(c.at) });
      } else if (c.type === 'call') {
        const phone = c.to || c.from;
        const t0 = ms(c.at);
        const hit = jarvisCalls.find((x) => !usedCalls.has(x.id) && (c.callId ? x.id === `call:${c.callId}` : Math.abs(ms(x.at) - t0) < 4 * MIN));
        if (hit) usedCalls.add(hit.id);
        const who = nameFor(phone) || phone || 'the driver';
        ev.push({ type: 'call', at: c.at, title: c.label ? c.label.replace(/\+?\d[\d\s().-]{8,}\d/, who) : `Call with ${who}`, text: String(c.text || '').slice(0, 600), callId: hit ? hit.id : null, recording: hit ? hit.recording || null : null, hasTranscript: !!(hit && hit.hasTranscript), minutes: hit ? hit.minutes : null, ...at(c.at) });
      }
    }
    // Jarvis calls with these drivers that never made it into the load's log
    for (const x of jarvisCalls) {
      if (usedCalls.has(x.id) || ms(x.at) < startMs) continue;
      const out1 = x.direction === 'outbound';
      const who = nameFor(out1 ? x.to : x.from) || 'the driver';
      ev.push({ type: 'call', at: x.at, title: out1 ? `Jarvis called ${who}` : `${who} called Jarvis`, text: x.summary || '', callId: x.id, recording: x.recording || null, hasTranscript: !!x.hasTranscript, minutes: x.minutes, ...at(x.at) });
    }
    out.events = ev.filter((e) => Number.isFinite(ms(e.at))).sort((a, b) => ms(a.at) - ms(b.at));
    out.drivers = Object.values(names);
    return out;
  }

  app.get('/truckmate/journey/:trip', requireAuth, async (req, res) => {
    try {
      const trip = String(req.params.trip).replace(/\D/g, '');
      const hit = cache.get(trip);
      if (hit && now() - hit.at < 2 * MIN && !req.query.fresh) return res.json(hit.data);
      const data = await build(trip);
      if (data.error) return res.status(404).json(data);
      cache.set(trip, { at: now(), data });
      if (cache.size > 60) cache.delete(cache.keys().next().value);
      res.json(data);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { build };
}

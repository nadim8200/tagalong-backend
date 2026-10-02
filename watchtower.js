// ---------------------------------------------------------------
// Watchtower — the dispatch sheet's "Priority 1 / Critical" duty, done by the
// server around the clock.
//
// The morning/night shift sheets say every analyst must watch for reefer
// alerts, breakdowns, risk of delay, HOS trouble and loads in transit — and act
// before the load is lost. Nobody can stare at 179 trips all night, so this
// module checks every active TruckMate trip once a minute and keeps ONE ranked
// list of what needs a human, with the evidence attached.
//
// HOW AN ALERT LIVES
//   open  → detected this cycle. Critical ones push to the fleet managers'
//           phones (TagAlong app) right away.
//   ack   → someone tapped "I'm on it" — their name + time is the proof.
//           Unacknowledged criticals re-push every `escalateMin` (max 3).
//   resolved → the condition cleared for 2 cycles in a row (auto), or a person
//           closed it with a note. Kept 24h for the shift handoff.
//
// DESIGN RULES (same as dispatcher.js)
//   • Every alert is actionable and carries its evidence.
//   • Nothing is sent to drivers/customers from here — people stay in charge.
//   • Silence is the goal: warnings stay on the board, only criticals push.
// ---------------------------------------------------------------

const MIN = 60000;
const CRUISE_MPH = 55;
const SEV = { critical: 3, warning: 2, info: 1 };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^0+(?=\d)/, '');
const zipOf = (s) => { const m = String(s || '').match(/\b(\d{5})\b/); return m ? m[1] : ''; };
const fmtMin = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);
const fmtTime = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function haversineMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8; const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r; const dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Same HOS-aware estimate the console uses (55 mph bent to the DOT clock:
// 11h drive / 14h shift / 30-min break / 10h reset; teams ~20h per day).
function estimateArrival(miles, { team, driveLeftMin, shiftLeftMin, now = Date.now() } = {}) {
  if (!miles || miles <= 0) return null;
  const H = 3600000;
  let driveHrs = miles / CRUISE_MPH;
  let t = now;
  if (team) return t + driveHrs * (24 / 20) * H;
  let first = driveLeftMin != null ? driveLeftMin / 60 : 11;
  if (shiftLeftMin != null) first = Math.min(first, shiftLeftMin / 60);
  first = Math.max(first, 0);
  let d = Math.min(driveHrs, first);
  t += (d + (d > 8 ? 0.5 : 0)) * H;
  driveHrs -= d;
  let guard = 0;
  while (driveHrs > 0.01 && guard++ < 60) {
    t += 10 * H;
    d = Math.min(driveHrs, 11);
    t += (d + (d > 8 ? 0.5 : 0)) * H;
    driveHrs -= d;
  }
  return t;
}

const isDone = (code) => /^(delvd|deliv|del$|cmplt|complete|canc|void|avail|avbl|new)/i.test(String(code || ''));
const isRolling = (code) => /^(depship|intran|enroute)/i.test(String(code || ''));
const isAtStop = (code) => /^(arrship|arrcons|spot)/i.test(String(code || ''));

// Everything the rules need from one board item, flattened once.
function tripFacts(item, now) {
  const t = (item && item.trip) || item || {};
  const billsRaw = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  const bills = Array.isArray(billsRaw) ? billsRaw : [];
  const temps = bills.map((b) => num(b.temperature)).filter((x) => x > 0);
  const next = bills.find((b) => !b.actualDelivery) || null;
  const live = (item && item._samsara) || null;
  const gpsAgeMin = live && live.gpsAt ? (now - Date.parse(live.gpsAt)) / MIN : null;
  // delivery appointment: the rate con's last delivery wins, else TruckMate's due time
  let dueMs = null;
  const dels = (item && item._ratecon && item._ratecon.deliveries) || [];
  for (let i = dels.length - 1; i >= 0 && dueMs == null; i--) {
    const s = dels[i] || {};
    const ms = Date.parse([s.date, s.time || s.appointment].filter(Boolean).join(' '));
    if (!Number.isNaN(ms)) dueMs = ms;
  }
  if (dueMs == null && next) {
    const ms = Date.parse(next.deliverByEnd || next.deliverBy || '');
    if (!Number.isNaN(ms)) dueMs = ms;
  }
  const instr = (item && item._ratecon && Array.isArray(item._ratecon.specialInstructions))
    ? [...new Set(item._ratecon.specialInstructions.map((x) => String(x).trim()).filter(Boolean))] : [];
  const checks = (item && item._rccheck) || {};
  return {
    trip: String(t.tripNumber || (item && item._id) || ''),
    unit: String(t.powerUnit || ''),
    trailer: String(t.trailer || t.trailer2 || ''),
    driver: (live && live.driver1) || t.driver || '',
    team: !!(t.driver2 || (live && live.hos2 && live.hos2.status)),
    status: String(t.status || ''),
    origin: t.origZoneDesc || '',
    dest: t.destZoneDesc || '',
    nextTo: next ? (next.endZoneDescription || next.endZone || t.destZoneDesc || '') : (t.destZoneDesc || ''),
    reqTemp: temps.length ? Math.min(...temps) : null,
    dueMs,
    live,
    gpsFresh: gpsAgeMin != null && gpsAgeMin <= 30,
    gpsAgeMin,
    instrPending: instr.filter((s) => !(checks[s] && checks[s].done)).length,
    instrTotal: instr.length,
  };
}

// ---- the checks. Each returns an alert draft or null. ----
// ctx: { now, geo(zip) → {lat,lng}|null|undefined, unitState }
const RULES = [
  function reeferTemp(f) {
    const l = f.live;
    if (!l || l.tempF == null || l.tempStale) return null;
    const target = l.setpointF != null ? l.setpointF : f.reqTemp;
    if (target == null) return null;
    const dev = l.tempF - target;
    if (Math.abs(dev) <= 3) return null;
    return {
      code: 'reefer-temp', severity: Math.abs(dev) > 5 ? 'critical' : 'warning',
      title: `Reefer ${dev > 0 ? 'too warm' : 'too cold'} — ${l.tempF}°F (target ${target}°F)`,
      detail: `Trailer ${f.trailer || '—'} is ${Math.abs(Math.round(dev * 10) / 10)}° off. Call the driver to check the unit and doors.`,
    };
  },
  function reeferSetWrong(f) {
    const l = f.live;
    if (!l || l.setpointF == null || f.reqTemp == null || l.tempStale) return null;
    if (Math.abs(l.setpointF - f.reqTemp) <= 2) return null;
    return {
      code: 'reefer-setpoint', severity: 'critical',
      title: `Reefer set to ${l.setpointF}°F — load requires ${f.reqTemp}°F`,
      detail: `Trailer ${f.trailer || '—'} setpoint doesn't match the bill. Have the driver correct it now.`,
    };
  },
  function reeferOff(f) {
    const l = f.live;
    if (!l || f.reqTemp == null || !l.reeferState || l.tempStale) return null;
    if (!/off/i.test(String(l.reeferState))) return null;
    return {
      code: 'reefer-off', severity: 'critical',
      title: `Reefer OFF on a ${f.reqTemp}°F load`,
      detail: `Trailer ${f.trailer || '—'} reports the unit off. Confirm with the driver immediately.`,
    };
  },
  function lateRisk(f, ctx) {
    if (!f.dueMs || !f.live || !f.gpsFresh || f.live.lat == null) return null;
    const zip = zipOf(f.nextTo);
    const dest = zip ? ctx.geo(zip) : null;
    if (!dest) return null;
    const miles = haversineMi(f.live.lat, f.live.lng, dest.lat, dest.lng) * 1.2;
    if (miles < 5) return null;
    const hos = f.live.hos || {};
    const eta = estimateArrival(miles, { team: f.team, driveLeftMin: hos.driveLeftMin, shiftLeftMin: hos.shiftLeftMin, now: ctx.now });
    if (!eta) return null;
    const lateMin = (eta - f.dueMs) / MIN;
    if (lateMin <= 0) return null;
    return {
      code: 'late-risk', severity: lateMin > 60 ? 'critical' : 'warning',
      title: `Will miss delivery by ~${fmtMin(lateMin)}`,
      detail: `${Math.round(miles)} mi to ${f.nextTo}. Projected ${fmtTime(eta)} vs due ${fmtTime(f.dueMs)}${f.team ? ' (team)' : ` · drive left ${fmtMin(hos.driveLeftMin)}`}. Warn the broker/receiver or plan a rescue.`,
    };
  },
  function hosLow(f) {
    const l = f.live;
    if (!l || f.team || !l.hos || l.hos.driveLeftMin == null) return null;
    const left = l.hos.driveLeftMin;
    const moving = (l.speedMph || 0) > 5;
    if (!moving || left > 30) return null;
    return {
      code: 'hos-low', severity: left <= 0 ? 'critical' : 'warning',
      title: left <= 0 ? `Driving with NO hours left (${Math.round(l.speedMph)} mph)` : `Driver must stop in ${fmtMin(left)}`,
      detail: `${f.driver || 'Driver'} · shift left ${fmtMin(l.hos.shiftLeftMin)}. Confirm a safe place to take the 10-hour break.`,
    };
  },
  function stopped(f, ctx) {
    const l = f.live;
    if (!isRolling(f.status) || !l || !f.gpsFresh) return null;
    const st = ctx.unitState(f.unit);
    if (!st || !st.stoppedSince) return null;
    const mins = (ctx.now - st.stoppedSince) / MIN;
    if (mins < 60) return null;
    const left = l.hos && l.hos.driveLeftMin;
    if (left != null && left < 90) return null;            // likely a legal rest, not a problem
    const zip = zipOf(f.nextTo);
    const dest = zip ? ctx.geo(zip) : null;
    if (dest && l.lat != null && haversineMi(l.lat, l.lng, dest.lat, dest.lng) < 15) return null; // at/near the receiver
    const codes = (l.dtcCodes || []).length;
    return {
      code: 'stopped', severity: mins >= 120 || codes ? 'critical' : 'warning',
      title: codes ? `Possible breakdown — stopped ${fmtMin(mins)} with ${codes} engine code${codes === 1 ? '' : 's'}` : `Stopped ${fmtMin(mins)} in transit`,
      detail: `${l.location || 'Unknown location'} · drive left ${fmtMin(left)}. Call the driver; arrange road service or a rescue if needed.`,
    };
  },
  function checkEngine(f) {
    const codes = (f.live && f.live.dtcCodes) || [];
    if (!codes.length) return null;
    return {
      code: 'check-engine', severity: 'warning', key: codes.map((c) => c.code).sort().join(','),
      title: `Check engine — ${codes.length} code${codes.length === 1 ? '' : 's'}`,
      detail: codes.slice(0, 3).map((c) => `${c.code}: ${c.meaning}`).join(' · '),
    };
  },
  function trackingLost(f) {
    if (!isRolling(f.status) || !f.unit) return null;
    if (f.live && f.gpsAgeMin != null && f.gpsAgeMin <= 60) return null;
    return {
      code: 'tracking-lost', severity: 'warning',
      title: f.live && f.gpsAgeMin != null ? `No GPS for ${fmtMin(f.gpsAgeMin)}` : 'No live tracking for this truck',
      detail: 'In transit but not reporting. Call the driver for a location check.',
    };
  },
  function handlingPending(f) {
    if (!f.instrPending || !isAtStop(f.status)) return null;
    return {
      code: 'handling-pending', severity: 'warning',
      title: `${f.instrPending} handling instruction${f.instrPending === 1 ? '' : 's'} not signed off`,
      detail: 'Truck is at a stop. Review the rate-con checklist with the driver before departure.',
    };
  },
];

export function evaluateBoard(board, ctx) {
  const out = [];
  if (board && board.ageMinutes != null && board.ageMinutes > 30) {
    out.push({
      id: 'feed-stale', code: 'feed-stale', severity: 'critical', trip: '', unit: '',
      title: `TruckMate feed stopped ${fmtMin(board.ageMinutes)} ago`,
      detail: 'The board is not updating — check the TruckMate connector before trusting anything else.',
    });
  }
  for (const item of (board && board.trips) || []) {
    const f = tripFacts(item, ctx.now);
    if (!f.trip || isDone(f.status)) continue;
    for (const rule of RULES) {
      let a = null;
      try { a = rule(f, ctx); } catch { a = null; }
      if (!a) continue;
      out.push({
        ...a,
        id: `${a.code}:${f.trip}${a.key ? `:${a.key}` : ''}`,
        trip: f.trip, unit: f.unit, driver: f.driver, trailer: f.trailer,
        lane: `${f.origin || '—'} → ${f.dest || '—'}`,
      });
    }
  }
  return out;
}

export function initWatchtower(app, { requireAuth, db, env = process.env, buildBoard, push }) {
  if (!db || !db.enabled) { console.log('[watchtower] off — needs DATABASE_URL'); return; }
  const sites = String(env.WATCH_SITES || 'florida-beauty').split(',').map((s) => s.trim()).filter(Boolean);
  const CFG = 'taWatchCfg';
  const DEFAULT_CFG = { recipients: [], escalateMin: 15, maxPushes: 3 };
  const stateKey = (site) => `taWatch:${site}`;

  // ---- ZIP geocode cache (Google if a server key is set, else OpenStreetMap) ----
  let geoCache = null;
  const geoQueue = new Set();
  async function loadGeo() { if (!geoCache) geoCache = await db.get('taGeoZip', {}); return geoCache; }
  function geo(zip) {
    if (!geoCache) return undefined;
    if (zip in geoCache) return geoCache[zip];
    geoQueue.add(zip);
    return undefined;
  }
  async function drainGeo(limit = 8) {
    const key = env.GOOGLE_GEOCODE_KEY || env.GOOGLE_MAPS_KEY || '';
    let n = 0;
    for (const zip of [...geoQueue]) {
      if (n++ >= limit) break;
      geoQueue.delete(zip);
      let hit = null;
      try {
        if (key) {
          const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&components=country:US&key=${key}`); // eslint-disable-line no-await-in-loop
          const d = await r.json(); // eslint-disable-line no-await-in-loop
          if (d.status === 'OK' && d.results && d.results[0]) hit = d.results[0].geometry.location;
        }
        if (!hit) {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&postalcode=${zip}`, { headers: { 'User-Agent': 'TagAlong-Watchtower/1.0' } }); // eslint-disable-line no-await-in-loop
          const d = await r.json(); // eslint-disable-line no-await-in-loop
          if (d && d[0]) hit = { lat: Number(d[0].lat), lng: Number(d[0].lon) };
          await new Promise((ok) => setTimeout(ok, 1100)); // eslint-disable-line no-await-in-loop
        }
      } catch { continue; } // network hiccup — try again next cycle
      geoCache[zip] = hit ? { lat: hit.lat, lng: hit.lng } : null;
    }
    if (n) await db.set('taGeoZip', geoCache);
  }

  async function notify(cfg, alerts, { escalated = false } = {}) {
    if (!push || !push.sendToEmails || !cfg.recipients.length || !alerts.length) return;
    const tag = escalated ? '⏫ STILL OPEN — ' : '🚨 ';
    if (alerts.length > 5) {
      await push.sendToEmails(cfg.recipients, {
        title: `${tag}${alerts.length} Priority 1 alerts`,
        body: alerts.slice(0, 3).map((a) => `${a.unit ? `#${a.unit} ` : ''}${a.title}`).join(' · '),
        data: { type: 'watchtower' },
      });
      return;
    }
    for (const a of alerts) {
      await push.sendToEmails(cfg.recipients, { // eslint-disable-line no-await-in-loop
        title: `${tag}${a.unit ? `Truck ${a.unit} · ` : ''}${a.title}`.slice(0, 120),
        body: `${a.trip ? `Load ${a.trip}. ` : ''}${a.detail}`.slice(0, 220),
        data: { type: 'watchtower', id: a.id, trip: a.trip },
      });
    }
  }

  let running = false;
  async function cycle(site) {
    const now = Date.now();
    await loadGeo();
    const board = await buildBoard(site);
    const cfg = { ...DEFAULT_CFG, ...(await db.get(CFG, {})) };
    const toPush = []; const toEscalate = [];

    await db.update(stateKey(site), (prev) => {
      const s = { alerts: {}, units: {}, ...(prev || {}) };
      // track how long each rolling truck has been stationary
      for (const item of board.trips || []) {
        const t = (item && item.trip) || item || {};
        const l = item && item._samsara;
        const u = norm(t.powerUnit);
        if (!u || !l || l.speedMph == null) continue;
        const us = s.units[u] || {};
        if (l.speedMph > 3) { us.stoppedSince = null; us.lastMovingAt = now; } else if (!us.stoppedSince) us.stoppedSince = now;
        s.units[u] = us;
      }
      const ctx = { now, geo, unitState: (unit) => s.units[norm(unit)] };
      const found = evaluateBoard(board, ctx);
      const seen = new Set();
      for (const a of found) {
        seen.add(a.id);
        const cur = s.alerts[a.id];
        if (!cur || cur.resolvedAt) {
          s.alerts[a.id] = { ...a, openedAt: now, lastSeenAt: now, miss: 0, pushes: 0, ack: null, resolvedAt: null };
          if (a.severity === 'critical') toPush.push(s.alerts[a.id]);
        } else {
          const raised = SEV[a.severity] > SEV[cur.severity];
          Object.assign(cur, a, { lastSeenAt: now, miss: 0 });
          if (raised && a.severity === 'critical' && !cur.ack) toPush.push(cur);
          else if (cur.severity === 'critical' && !cur.ack && cur.pushes < cfg.maxPushes
            && now - (cur.lastPushAt || cur.openedAt) >= cfg.escalateMin * MIN) toEscalate.push(cur);
        }
      }
      // auto-resolve after two clean cycles; forget resolved ones after 24h
      for (const [id, a] of Object.entries(s.alerts)) {
        if (!a.resolvedAt && !seen.has(id)) {
          a.miss = (a.miss || 0) + 1;
          if (a.miss >= 2) { a.resolvedAt = now; a.resolvedBy = 'auto'; }
        }
        if (a.resolvedAt && now - a.resolvedAt > 24 * 60 * MIN) delete s.alerts[id];
      }
      for (const a of [...toPush, ...toEscalate]) { a.pushes = (a.pushes || 0) + 1; a.lastPushAt = now; }
      s.lastRun = now;
      s.feedAgeMinutes = board.ageMinutes;
      s.tripCount = board.count;
      return s;
    }, { alerts: {}, units: {} });

    await notify(cfg, toPush);
    await notify(cfg, toEscalate, { escalated: true });
    await drainGeo();
  }

  async function tick() {
    if (running) return;
    running = true;
    try { for (const site of sites) await cycle(site); } // eslint-disable-line no-await-in-loop
    catch (e) { console.log('[watchtower] cycle error:', e.message); }
    finally { running = false; }
  }
  if (env.WATCHTOWER_OFF !== 'true') {
    setTimeout(tick, 20000);
    setInterval(tick, 60000);
    console.log(`[watchtower] watching ${sites.join(', ')} every 60s`);
  }

  // ---- API for the console ----
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const site = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || sites[0]);
  const list = (s) => Object.values((s && s.alerts) || {});
  const rank = (a, b) => (SEV[b.severity] - SEV[a.severity]) || (b.openedAt - a.openedAt);

  app.get('/watchtower/board', requireAuth, async (req, res) => {
    try {
      const s = await db.get(stateKey(site(req)), { alerts: {} });
      const all = list(s);
      const open = all.filter((a) => !a.resolvedAt).sort(rank);
      res.json({
        site: site(req), lastRun: s.lastRun || null, tripCount: s.tripCount || 0, feedAgeMinutes: s.feedAgeMinutes,
        counts: { critical: open.filter((a) => a.severity === 'critical').length, warning: open.filter((a) => a.severity === 'warning').length, unacked: open.filter((a) => !a.ack && a.severity === 'critical').length },
        open,
        resolved: all.filter((a) => a.resolvedAt).sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, 50),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/watchtower/ack', requireAuth, async (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const s = await db.update(stateKey(site(req)), (prev) => {
        const st = prev || { alerts: {} };
        const a = st.alerts && st.alerts[id];
        if (a && !a.resolvedAt) a.ack = { by: who(req), at: Date.now() };
        return st;
      }, { alerts: {} });
      res.json({ ok: true, alert: s.alerts[id] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/watchtower/resolve', requireAuth, async (req, res) => {
    const { id, note = '' } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const s = await db.update(stateKey(site(req)), (prev) => {
        const st = prev || { alerts: {} };
        const a = st.alerts && st.alerts[id];
        if (a && !a.resolvedAt) {
          a.resolvedAt = Date.now(); a.resolvedBy = who(req); a.note = String(note).slice(0, 500);
          if (!a.ack) a.ack = { by: who(req), at: a.resolvedAt };
        }
        return st;
      }, { alerts: {} });
      res.json({ ok: true, alert: s.alerts[id] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Who gets Priority 1 pushes (TagAlong app accounts, by email).
  app.get('/watchtower/config', requireAuth, async (req, res) => {
    try {
      const cfg = { ...DEFAULT_CFG, ...(await db.get(CFG, {})) };
      const recipients = push && push.phonesFor ? await push.phonesFor(cfg.recipients) : cfg.recipients.map((email) => ({ email, phones: null }));
      res.json({ ...cfg, recipients, me: (req.user && req.user.email) || '', pushEnabled: !!(push && push.enabled) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/watchtower/config', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = await db.update(CFG, (prev) => {
        const c = { ...DEFAULT_CFG, ...(prev || {}) };
        if (Array.isArray(body.recipients)) {
          c.recipients = [...new Set(body.recipients.map((e) => String(e || '').trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e)))].slice(0, 20);
        }
        if (body.escalateMin != null) c.escalateMin = Math.max(5, Math.min(120, Number(body.escalateMin) || 15));
        return c;
      }, DEFAULT_CFG);
      res.json(cfg);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/watchtower/test', requireAuth, async (req, res) => {
    try {
      const cfg = { ...DEFAULT_CFG, ...(await db.get(CFG, {})) };
      if (!push || !push.sendToEmails) return res.json({ ok: false, reason: 'push not available' });
      const sent = await push.sendToEmails(cfg.recipients, { title: '🚨 Watchtower test', body: `Priority 1 alerts will arrive like this. Sent by ${who(req)}.`, data: { type: 'watchtower' } });
      res.json({ ok: true, enabled: !!push.enabled, sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Shift handoff: what's open, who's on it, what got fixed in the last 12h.
  app.get('/watchtower/handoff', requireAuth, async (req, res) => {
    try {
      const s = await db.get(stateKey(site(req)), { alerts: {} });
      const since = Date.now() - 12 * 60 * MIN;
      const all = list(s);
      res.json({
        site: site(req), generatedAt: Date.now(), by: who(req), tripCount: s.tripCount || 0,
        open: all.filter((a) => !a.resolvedAt).sort(rank),
        resolved: all.filter((a) => a.resolvedAt && a.resolvedAt >= since).sort((a, b) => b.resolvedAt - a.resolvedAt),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Run a cycle now (after a config change, or to check without waiting).
  app.post('/watchtower/run', requireAuth, async (_req, res) => {
    await tick();
    res.json({ ok: true });
  });
}

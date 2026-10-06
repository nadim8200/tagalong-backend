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

// TruckMate times carry no zone ("2026-10-03T06:00:00") — they are the
// receiver's local wall clock. Read them in the stop's time zone (by state).
const STATE_TZ = {
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York', MI: 'America/Detroit', NC: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VA: 'America/New_York', VT: 'America/New_York', WV: 'America/New_York', DC: 'America/New_York', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver', AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
};
const stateOf = (s) => { const m = String(s || '').match(/,\s*([A-Z]{2})\b/); return m ? m[1] : ''; };
function localToUtcMs(wall, tz) {
  const m = String(wall || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(String(wall))) return Date.parse(wall); // already has a zone
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
    const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return asUtc - (seen - asUtc);                    // shift by the zone's offset at that moment
  } catch { return asUtc; }
}

export function haversineMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8; const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r; const dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Same HOS-aware estimate the console uses (55 mph bent to the DOT clock:
// 11h drive / 14h shift / 30-min break / 10h reset; teams ~20h per day).
// restDoneMin: how long a driver who is out of hours has already been parked,
// so the 10-hour reset isn't assumed to start right now.
export function estimateArrival(miles, { team, driveLeftMin, shiftLeftMin, restDoneMin = 0, now = Date.now() } = {}) {
  if (!miles || miles <= 0) return null;
  const H = 3600000;
  let driveHrs = miles / CRUISE_MPH;
  let t = now;
  if (team) return t + driveHrs * (24 / 20) * H;
  let restCredit = Math.max(0, Math.min(10, restDoneMin / 60));
  let first = driveLeftMin != null ? driveLeftMin / 60 : 11;
  if (shiftLeftMin != null) first = Math.min(first, shiftLeftMin / 60);
  first = Math.max(first, 0);
  let d = Math.min(driveHrs, first);
  t += (d + (d > 8 ? 0.5 : 0)) * H;
  driveHrs -= d;
  let guard = 0;
  while (driveHrs > 0.01 && guard++ < 60) {
    t += (10 - restCredit) * H;
    restCredit = 0;
    d = Math.min(driveHrs, 11);
    t += (d + (d > 8 ? 0.5 : 0)) * H;
    driveHrs -= d;
  }
  return t;
}

const isDone = (code) => /^(delvd|deliv|del$|cmplt|complete|canc|void|avail|avbl|new)/i.test(String(code || ''));
// DEPSHIP / DEPCONS = departed shipper / departed a consignee → rolling to the next stop
const isRolling = (code) => /^(depship|depcons|intran|enroute)/i.test(String(code || ''));
// dispatched but the driver hasn't picked the trailer up yet — the truck's GPS
// isn't with the load, so no ETA / stopped / tracking judgements yet
const notStartedCode = (code) => /^(disp|assgn|assigned|printed|avail|avbl|new|plan)/i.test(String(code || ''));
// not started = TruckMate says so, or the trip sheet says the driver picks the
// load up later ("picking it up Friday around 6 AM") and that time hasn't come
const notStarted = (code, f, now) => notStartedCode(code) || !!(f && f.pickupAtMs && now != null && now < f.pickupAtMs);
const isAtStop = (code) => /^(arrship|arrcons|spot)/i.test(String(code || ''));

// Everything the rules need from one board item, flattened once.
function tripFacts(item, now) {
  const t = (item && item.trip) || item || {};
  const billsRaw = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  const bills = Array.isArray(billsRaw) ? billsRaw : [];
  const temps = bills.map((b) => num(b.temperature)).filter((x) => x > 0);
  // TruckMate sends one bill per consignee, sorted by BILL NUMBER (not stop
  // order), often several bills per dock. Group them into physical stops by
  // destination zone; a stop is delivered only when all its bills are.
  const yes = (v) => v === true || v === 'True' || v === 'true' || v === 'Y';
  const stopMap = new Map();
  for (const b of bills) {
    const label = b.endZoneDescription || b.endZone || '';
    const key = String(b.endZone || label);
    if (!key) continue;
    const st = stopMap.get(key) || { key, label, zip: zipOf(label) || zipOf(b.endZone), tz: STATE_TZ[stateOf(label)] || 'America/New_York', pieces: 0, bills: 0, delivered: true, apptMs: null, apptNeeded: false };
    st.pieces += num(b.pieces); st.bills += 1;
    if (!b.actualDelivery) st.delivered = false;
    // A REAL appointment is an exact time (deliverBy == deliverByEnd) or one
    // TruckMate flags as required/made. The default multi-day window on flower
    // bills (e.g. 10/02 00:00 → 10/06 23:59) is NOT an appointment.
    // Midnight-to-midnight "exact" dates are leftovers too (one 624134 bill
    // reads 09/22 00:00 → 09/22 00:00), so an unflagged exact time must have a
    // real clock time, and anything over a day in the past is ignored.
    // A flagged appointment still stamped 00:00 means the real time was never
    // typed in (e.g. Produce Junction, written by hand on the sheet).
    const by = localToUtcMs(b.deliverBy, st.tz); const end = localToUtcMs(b.deliverByEnd, st.tz);
    const midnight = /T00:00(:00)?$/.test(String(b.deliverBy || '').slice(0, 19));
    const exact = !Number.isNaN(by) && (Number.isNaN(end) || end === by);
    const flagged = yes(b.deliveryApptReq) || yes(b.deliveryApptMade);
    const fresh = !Number.isNaN(by) && by > now - 24 * 60 * MIN;
    if (fresh && !midnight && (exact || flagged)) st.apptMs = st.apptMs == null ? by : Math.min(st.apptMs, by);
    else if (flagged && midnight) st.apptNeeded = true;
    stopMap.set(key, st);
  }
  const stops = [...stopMap.values()];
  const next = bills.find((b) => !b.actualDelivery) || null;
  const live = (item && item._samsara) || null;
  const gpsAgeMin = live && live.gpsAt ? (now - Date.parse(live.gpsAt)) / MIN : null;
  // delivery appointment: the rate con's last delivery wins, else TruckMate's due time
  let dueMs = null;
  const dels = (item && item._ratecon && item._ratecon.deliveries) || [];
  for (let i = dels.length - 1; i >= 0 && dueMs == null; i--) {
    const s = dels[i] || {};
    const raw = [s.date, s.time || s.appointment].filter(Boolean).join(' ');
    const d = new Date(`${raw} UTC`);                   // read the wall clock as-is…
    if (!Number.isNaN(d.getTime())) {
      const lastOpen = stops.filter((st) => !st.delivered).pop();
      dueMs = localToUtcMs(d.toISOString().slice(0, 16), lastOpen ? lastOpen.tz : 'America/New_York'); // …then place it in the receiver's zone
    }
  }
  // a rate-con appointment belongs to the final undelivered stop
  if (dueMs != null) {
    const open = stops.filter((st) => !st.delivered);
    const last = open[open.length - 1];
    if (last && last.apptMs == null) last.apptMs = dueMs;
  }
  // The uploaded paper trip sheet is the source of truth for stop ORDER,
  // handwritten appointments, the pickup plan and call-ahead rules. Match its
  // stops to TruckMate's by city + state (a city can span several zips).
  const sheet = (item && item._manifest) || null;
  let pickupAtMs = null;
  if (sheet) {
    // same normalization as the trip-sheet reader: SAINT/ST, FORT/FT, MOUNT/MT
    const nc = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^SAINTE /, 'STE ').replace(/^SAINT /, 'ST ').replace(/^FORT /, 'FT ').replace(/^MOUNT /, 'MT ');
    const ck = (city, state) => `${nc(city)}|${String(state || '').trim().toUpperCase()}`;
    const byCity = new Map();
    for (const ms of sheet.stops || []) {
      if (!/DELIVER|PICKUP/i.test(ms.action || '')) continue;
      // a sheet stop paired with a differently-named TruckMate town uses that town
      const tp = ms.tmPlace ? String(ms.tmPlace).split(',').map((x) => x.trim()) : null;
      const k = tp ? ck(tp[0], tp[1]) : ck(ms.city, ms.state);
      const arr = byCity.get(k) || [];
      arr.push(ms);
      byCity.set(k, arr);
    }
    for (const st of stops) {
      const parts = st.label.split(',').map((x) => x.trim());
      const hits = byCity.get(ck(parts[0], parts[1])) || [];
      if (!hits.length) continue;
      st.seq = Math.min(...hits.map((h) => (h.stopNumber != null ? h.stopNumber : 999)));
      st.customers = [...new Set(hits.map((h) => h.customer).filter(Boolean))];
      st.callAhead = hits.flatMap((h) => h.callAhead || []).filter((c) => c && (c.phone || c.contact));
      for (const h of hits) {
        if (!h.apptDate || !h.apptTime) continue;
        const ms = localToUtcMs(`${h.apptDate}T${h.apptTime}`, st.tz);
        if (!Number.isNaN(ms) && (st.apptMs == null || ms < st.apptMs)) { st.apptMs = ms; st.apptFrom = h.apptSource || 'sheet'; st.apptNeeded = false; }
      }
    }
    if (sheet.pickupAt) {
      const ms = localToUtcMs(String(sheet.pickupAt).slice(0, 16), 'America/New_York');
      if (!Number.isNaN(ms)) pickupAtMs = ms;
    }
  }
  const instr = (item && item._ratecon && Array.isArray(item._ratecon.specialInstructions))
    ? [...new Set(item._ratecon.specialInstructions.map((x) => String(x).trim()).filter(Boolean))] : [];
  const checks = (item && item._rccheck) || {};
  // Outside carrier: no ELD/HOS/engine from us; tracking = check-ins.
  const oc = (item && item._oc) || null;
  const checkins = (item && item._checkins) || [];
  const lastCheckinMs = Math.max(0, ...checkins.map((c) => Date.parse(c.at) || 0), live && live.gpsAt ? Date.parse(live.gpsAt) || 0 : 0) || null;
  return {
    oc,
    driverLink: (item && item._driverLink) || null,
    lastCheckinMs,
    lastCheckin: checkins[0] || null,
    sheet,
    pickupAtMs,
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
    stops,
    live,
    gpsFresh: gpsAgeMin != null && gpsAgeMin <= 30,
    gpsAgeMin,
    instrPending: instr.filter((s) => !(checks[s] && checks[s].done)).length,
    instrTotal: instr.length,
  };
}

// Projected arrival at every open stop: truck → stops in trip-sheet order (or,
// without a sheet, outward from the terminal) with ~30 min unloading at each.
// Returns null when a check can't be trusted yet (not started, no fresh GPS,
// stops still geocoding).
function routeEtas(f, ctx) {
  if (notStarted(f.status, f, ctx.now) || !f.live || !f.gpsFresh || f.live.lat == null) return null;
  const open = f.stops.filter((st) => !st.delivered);
  if (!open.length) return null;
  const pts = new Map();
  for (const st of open) {
    const g = st.zip ? ctx.geo(st.zip) : null;
    if (!g) return null;
    pts.set(st.key, g);
  }
  const o = ctx.origin;
  const fromOrigin = (st) => haversineMi(o.lat, o.lng, pts.get(st.key).lat, pts.get(st.key).lng);
  const ordered = [...open].sort((a, b) => ((a.seq != null ? a.seq : 999) - (b.seq != null ? b.seq : 999)) || (fromOrigin(a) - fromOrigin(b)));
  const hos = f.live.hos || {};
  const restDoneMin = (hos.driveLeftMin != null && hos.driveLeftMin <= 0 && f.stoppedMin) ? f.stoppedMin : 0;
  const out = [];
  let miles = 0; let at = { lat: f.live.lat, lng: f.live.lng };
  ordered.forEach((st, i) => {
    const g = pts.get(st.key);
    miles += haversineMi(at.lat, at.lng, g.lat, g.lng) * 1.2;
    at = g;
    const eta = miles > 0 ? estimateArrival(miles, { team: f.team, driveLeftMin: hos.driveLeftMin, shiftLeftMin: hos.shiftLeftMin, restDoneMin, now: ctx.now }) : ctx.now;
    out.push({ stop: st, miles, etaMs: (eta || ctx.now) + i * 30 * MIN, stopsBefore: i });
  });
  out.guess = hos.driveLeftMin != null && hos.driveLeftMin <= 0 && f.stopStartUnknown;
  return out;
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
    const route = routeEtas(f, ctx);
    if (!route) return null;
    const hos = (f.live && f.live.hos) || {};
    let worst = null;
    for (const r of route) {
      if (r.stop.apptMs == null || r.miles < 5) continue;
      const lateMin = (r.etaMs - r.stop.apptMs) / MIN;
      if (lateMin > 0 && (!worst || lateMin > worst.lateMin)) worst = { ...r, lateMin };
    }
    if (!worst) return null;
    const t = worst.stop;
    const guess = route.guess;
    const where = (t.customers && t.customers[0]) ? `${t.customers[0]} (${t.label.replace(/, \d{5}$/, '')})` : t.label.replace(/, \d{5}$/, '');
    return {
      code: 'late-risk', severity: worst.lateMin > 60 && !guess ? 'critical' : 'warning', key: t.key,
      title: `Will miss ${where} appointment by ~${fmtMin(worst.lateMin)}`,
      detail: `${Math.round(worst.miles)} mi${worst.stopsBefore ? ` with ${worst.stopsBefore} stop${worst.stopsBefore === 1 ? '' : 's'} first` : ''}. Projected ${fmtTime(worst.etaMs)} vs appointment ${fmtTime(t.apptMs)}${t.apptFrom === 'handwritten' ? ' (handwritten on sheet)' : ''}${f.team ? ' (team)' : ` · drive left ${fmtMin(hos.driveLeftMin)}`}.${guess ? ' Break start unknown — confirm with the driver.' : ''} Warn the broker/receiver or plan a rescue.`,
    };
  },
  // "CALL ISRAEL 413-883-7695 1HR BEFORE ARRIVING" — raise it when the truck
  // is inside that window, so the call actually happens.
  function callAheadDue(f, ctx) {
    const route = routeEtas(f, ctx);
    if (!route) return null;
    for (const r of route) {
      for (const c of r.stop.callAhead || []) {
        const lead = c.leadMinutes != null ? c.leadMinutes : 60;
        const minsAway = (r.etaMs - ctx.now) / MIN;
        if (minsAway > lead + 20 || minsAway < -15) continue;
        const who = [c.contact, c.phone].filter(Boolean).join(' ');
        const where = (r.stop.customers && r.stop.customers[0]) || r.stop.label.replace(/, \d{5}$/, '');
        return {
          code: 'call-ahead', severity: 'warning', key: `${r.stop.key}:${c.phone || c.contact}`,
          title: `${c.method === 'text' ? 'Text' : 'Call'} ${who} now — ~${fmtMin(Math.max(0, minsAway))} from ${where}`,
          detail: `Trip sheet: ${c.method === 'text' ? 'text' : 'call'} ${lead >= 60 ? `${Math.round(lead / 60)} hr` : `${lead} min`} before arriving${c.purpose ? ` (${c.purpose})` : ''}.`,
        };
      }
    }
    return null;
  },
  // OC loads: no GPS from us, so the check-in IS the tracking. Flag when the
  // carrier hasn't reported in a while (or never) once the trip is moving.
  function carrierUpdateOverdue(f, ctx) {
    if (!f.oc || notStarted(f.status, f, ctx.now)) return null;
    const name = (f.oc.carrier && f.oc.carrier.name) || 'the carrier';
    const phone = f.oc.carrier && f.oc.carrier.dispatchPhone;
    const hrs = f.lastCheckinMs ? (ctx.now - f.lastCheckinMs) / 3600000 : null;
    if (hrs != null && hrs < 4) return null;
    // Driver tracking link: say what happened to it, so the call is targeted.
    const dl = f.driverLink;
    const linkNote = !dl || ['revoked', 'completed', 'expired'].includes(dl.status) ? ' No tracking link is active — send one from the Outside carrier section.'
      : dl.status === 'stopped' ? ' The driver turned off location sharing in the tracking link.'
      : dl.status === 'quiet' ? ' The driver’s tracking link went quiet (phone locked, app closed or no signal).'
      : dl.status === 'opened' ? ' The driver opened the tracking link but has not shared location.'
      : ' The driver has not opened the tracking link yet.';
    return {
      code: 'carrier-update-overdue', severity: hrs != null && hrs >= 8 ? 'critical' : 'warning',
      title: hrs == null ? `No check-in from ${name} yet` : `No update from ${name} in ${Math.floor(hrs)}h`,
      detail: `Outside carrier load${f.oc.truck ? ` (their truck ${f.oc.truck})` : ''}. ${phone ? `Call their dispatch ${phone}` : 'Call the carrier'}${f.oc.driverPhone ? ` or the driver ${f.oc.driverPhone}` : ''} and log the check-in.${linkNote}${f.lastCheckin ? ` Last: “${String(f.lastCheckin.text || '').slice(0, 80)}”` : ''}`,
    };
  },
  // OC loads must have every driver's name + phone (solo or team) and their
  // truck # / trailer #. Fires once the load is moving or pickup is ≤12h away.
  function ocInfoMissing(f, ctx) {
    const miss = (f.oc && f.oc.missing) || [];
    if (!miss.length) return null;
    const soon = f.pickupAtMs && f.pickupAtMs - ctx.now < 12 * 3600000;
    if (notStarted(f.status, f, ctx.now) && !soon) return null;
    const name = (f.oc.carrier && f.oc.carrier.name) || 'the carrier';
    const dl = f.driverLink;
    const how = dl && !['revoked', 'completed', 'expired'].includes(dl.status)
      ? 'The tracking link asks the driver for it before sharing — remind them to open it'
      : 'Send the tracking link (the driver must fill it in) or get it from the carrier';
    return {
      code: 'oc-info-missing', severity: 'warning', key: miss.join(','),
      title: `${f.oc.crew === 'team' ? 'Team' : 'Solo'} OC load missing driver info (${miss.length})`,
      detail: `${name}: missing ${miss.join(', ')}. ${how}${f.oc.carrier && f.oc.carrier.dispatchPhone ? ` · carrier dispatch ${f.oc.carrier.dispatchPhone}` : ''}.`,
    };
  },
  function sheetMismatch(f) {
    const diffs = (f.sheet && f.sheet.diffs) || [];
    if (!diffs.length) return null;
    return {
      code: 'sheet-mismatch', severity: 'warning', key: diffs.map((d) => d.kind).sort().join(','),
      title: `Trip sheet ≠ TruckMate (${diffs.length} difference${diffs.length === 1 ? '' : 's'})`,
      detail: diffs.slice(0, 4).map((d) => d.msg).join(' · '),
    };
  },
  function apptTimeMissing(f) {
    const st = f.stops.find((x) => !x.delivered && x.apptNeeded && x.apptMs == null);
    if (!st || notStarted(f.status, f, Date.now())) return null;
    return {
      code: 'appt-missing', severity: 'warning', key: st.key,
      title: `Appointment required at ${st.label.replace(/, \d{5}$/, '')} — no time in TruckMate`,
      detail: 'The receiver needs an appointment but the time was never entered, so lateness can\'t be checked. Enter the appointment in TruckMate.',
    };
  },
  function hosLow(f) {
    if (f.oc) return null;                              // outside carrier: not our ELD / engine
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
    if (f.oc) return null;                              // outside carrier: not our ELD / engine
    const l = f.live;
    if (!isRolling(f.status) || !l || !f.gpsFresh || !f.stoppedMin || notStarted(f.status, f, ctx.now)) return null;
    const mins = f.stoppedMin;
    // Resting = the ELD says off duty / sleeper (or the driver is out of hours).
    // Not resting = on duty or "driving" while parked — that's the one to chase.
    const duty = String((l.hos && l.hos.status) || '');
    const left = l.hos && l.hos.driveLeftMin;
    const resting = /^(offduty|sleeper|personalconveyance)/i.test(duty) || (left != null && left < 90);
    if (resting ? mins < 11 * 60 : mins < 45) return null;   // a rest past 11h (10h reset + 1h) is worth a look too
    // parked at / near any customer still to be delivered = unloading, not a problem
    const nearStop = f.stops.some((s2) => {
      if (s2.delivered || !s2.zip) return false;
      const g = ctx.geo(s2.zip);
      return g && l.lat != null && haversineMi(l.lat, l.lng, g.lat, g.lng) < 15;
    });
    if (nearStop) return null;
    // still at the Miami terminal / yard = waiting for pickup, not stuck
    const o = ctx.origin;
    if (l.lat != null && haversineMi(l.lat, l.lng, o.lat, o.lng) < 30) return null;
    const codes = (l.dtcCodes || []).length;
    const dutyLabel = { onDuty: 'on duty', driving: 'driving status', yardMove: 'yard move', offDuty: 'off duty', sleeperBerth: 'sleeper berth' }[duty] || (duty || 'duty status unknown');
    if (resting) {
      return {
        code: 'stopped', severity: 'warning',
        title: `Resting ${fmtMin(mins)} — longer than a 10-hour break`,
        detail: `${l.location || 'Unknown location'} · ${dutyLabel}. Check the driver is OK and when they'll roll; update the customer if the ETA moves.`,
      };
    }
    return {
      code: 'stopped', severity: mins >= 90 || codes ? 'critical' : 'warning',
      title: codes ? `Possible breakdown — stopped ${fmtMin(mins)} with ${codes} engine code${codes === 1 ? '' : 's'}` : `Stopped ${fmtMin(mins)} and not resting`,
      detail: `${l.location || 'Unknown location'} · ${dutyLabel} · drive left ${fmtMin(left)}. Call the driver. If it's a breakdown, arrange road service and turn on Breakdown on the load to notify the customers.`,
    };
  },
  function checkEngine(f) {
    if (f.oc) return null;                              // outside carrier: not our ELD / engine
    const codes = (f.live && f.live.dtcCodes) || [];
    if (!codes.length) return null;
    return {
      code: 'check-engine', severity: 'warning', key: codes.map((c) => c.code).sort().join(','),
      title: `Check engine — ${codes.length} code${codes.length === 1 ? '' : 's'}`,
      detail: codes.slice(0, 3).map((c) => `${c.code}: ${c.meaning}`).join(' · '),
    };
  },
  function trackingLost(f) {
    if (f.oc) return null;                              // outside carrier: not our ELD / engine
    if (!isRolling(f.status) || !f.unit || notStarted(f.status, f, Date.now())) return null;
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

// Florida Beauty's Miami terminal — where the outbound trips load.
export const MIAMI_TERMINAL = { lat: 25.795, lng: -80.33 };

export function evaluateBoard(board, ctxIn) {
  const ctx = { origin: MIAMI_TERMINAL, unitState: () => null, ...ctxIn };
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
    const us = ctx.unitState ? ctx.unitState(f.unit) : null;
    f.stoppedMin = us && us.stoppedSince ? (ctx.now - us.stoppedSince) / MIN : 0;
    f.stopStartUnknown = !!(us && us.stopStartUnknown);
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

export function initWatchtower(app, { requireAuth, db, env = process.env, buildBoard, push, afterBoard = null }) {
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
  async function drainGeo(limit = 25) {
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
    if (afterBoard) { try { await afterBoard(site, board, { geo, now }); } catch (e) { console.warn('[watchtower] afterBoard:', e.message); } }
    const cfg = { ...DEFAULT_CFG, ...(await db.get(CFG, {})) };
    const toPush = []; const toEscalate = [];

    const archived = [];
    await db.update(stateKey(site), (prev) => {
      const s = { alerts: {}, units: {}, ...(prev || {}) };
      // track how long each rolling truck has been stationary
      for (const item of board.trips || []) {
        const t = (item && item.trip) || item || {};
        const l = item && item._samsara;
        const u = norm(t.powerUnit);
        if (!u || !l || l.speedMph == null) continue;
        const isNew = !s.units[u];
        const us = s.units[u] || {};
        if (l.speedMph > 3) { us.stoppedSince = null; us.stopStartUnknown = false; us.lastMovingAt = now; } else if (!us.stoppedSince) {
          us.stoppedSince = now;
          us.stopStartUnknown = isNew;                  // already parked when we first saw it
        }
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
        if (a.resolvedAt && now - a.resolvedAt > 24 * 60 * MIN) { archived.push(a); delete s.alerts[id]; }
      }
      for (const a of [...toPush, ...toEscalate]) { a.pushes = (a.pushes || 0) + 1; a.lastPushAt = now; }
      s.lastRun = now;
      s.feedAgeMinutes = board.ageMinutes;
      s.tripCount = board.count;
      return s;
    }, { alerts: {}, units: {} });

    // resolved alerts leave the live board after 24h but stay on the load's record (rundown)
    if (archived.length) {
      await db.update(`taWatchArchive:${site}`, (cur) => {
        const all = { ...(cur || {}) };
        for (const a of archived) { const k = String(a.trip || ''); if (k) all[k] = [...(all[k] || []), a].slice(-100); }
        return all;
      }, {});
    }
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

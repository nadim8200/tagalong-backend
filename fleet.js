// ---------------------------------------------------------------
// Fleet state — what every truck is actually doing right now.
//
// Built from a real Samsara snapshot of 170 vehicles. The numbers in the
// comments are from that snapshot, not guesses.
//
// The point of this module is CLASSIFICATION. "Truck 2606 is at 75 mph on the
// Indiana Toll Road" and "truck 979 hasn't reported since April 2025" are both
// "not at a terminal", but only one of them is a truck. Without this, every
// downstream check drowns in noise from units that aren't in service — which is
// exactly how the tracker-offline alert became worthless earlier today.
// ---------------------------------------------------------------

const DAY = 86400000;

// Samsara names its known locations, and those names tell you what a stop MEANS.
// Learned from the live snapshot rather than invented.
const TERMINAL_PATTERNS = [
  /FB MIAMI YARD/i,               // 63 trucks — the hub
  /FLORIDA BEAUTY MIAMI TERMINAL/i,
  /FBE MEMPHIS YARD/i,            // Old Highway 78, Olive Branch MS 38654
  /VENTURA YARD/i,
  /\bOXTERM\b|\bMITERM\b/i,       // Oxnard / Miami terminal codes
];

// A truck at a repair shop is not a truck that's broken down on the road, and
// it must not read as "stopped unexpectedly".
const SHOP_PATTERNS = [
  /TRUCKMAX/i,
  /ULTRAMAR/i,
  /PAINT AND BODY/i,
  /\bTIRE\b|\bREPAIR\b|\bSERVICE CENTER\b/i,
];

export const STATE = {
  MOVING: 'moving',
  IDLING: 'idling',           // engine on, not moving — fuel burn, reefer running
  AT_TERMINAL: 'at-terminal',
  AT_SHOP: 'at-shop',
  AT_CUSTOMER: 'at-customer', // a named address that isn't ours
  PARKED: 'parked',           // stopped somewhere unnamed
  DORMANT: 'dormant',         // not reporting — probably out of service
};

// How long before silence means "out of service" rather than "asleep".
// From the snapshot: 32 of 170 units are past 14 days, the worst at 467 days.
// Those are not trucks that need chasing; they're units nobody has retired.
const DORMANT_DAYS = 14;

export function classify(vehicle, { now = Date.now(), dormantDays = DORMANT_DAYS } = {}) {
  const gps = vehicle.gps || null;
  const engine = (vehicle.engineState && vehicle.engineState.value) || null;
  const ageDays = gps && gps.time ? (now - Date.parse(gps.time)) / DAY : Infinity;

  if (!gps || ageDays > dormantDays) {
    return {
      state: STATE.DORMANT, ageDays: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
      // Explicitly excluded from alerting. A unit silent for a year is a
      // records problem, not an operational one.
      alertable: false,
      why: gps ? `no report for ${Math.round(ageDays)} days` : 'no GPS data',
    };
  }

  const mph = gps.speedMilesPerHour || 0;
  const addrName = (gps.address && gps.address.name) || '';
  const place = (gps.reverseGeo && gps.reverseGeo.formattedLocation) || '';
  const isTerminal = TERMINAL_PATTERNS.some((re) => re.test(addrName));
  const isShop = SHOP_PATTERNS.some((re) => re.test(addrName));

  if (mph > 1) {
    return { state: STATE.MOVING, mph: Math.round(mph), place, alertable: true, ageDays };
  }
  if (engine === 'On' || engine === 'Idle') {
    return {
      state: STATE.IDLING, place, addrName, alertable: true, ageDays,
      why: 'engine running while stationary',
    };
  }
  if (isTerminal) return { state: STATE.AT_TERMINAL, terminal: addrName, place, alertable: false, ageDays };
  if (isShop) return { state: STATE.AT_SHOP, shop: addrName, place, alertable: false, ageDays };
  if (addrName) return { state: STATE.AT_CUSTOMER, customer: addrName, place, alertable: true, ageDays };
  return { state: STATE.PARKED, place, alertable: true, ageDays };
}

export function summarise(vehicles = [], opts = {}) {
  const rows = vehicles.map((v) => ({
    id: v.id,
    name: v.name,
    vin: (v.externalIds && v.externalIds['samsara.vin']) || null,
    lat: v.gps ? v.gps.latitude : null,
    lng: v.gps ? v.gps.longitude : null,
    at: v.gps ? v.gps.time : null,
    ...classify(v, opts),
  }));

  const by = (s) => rows.filter((r) => r.state === s);
  return {
    rows,
    counts: {
      total: rows.length,
      moving: by(STATE.MOVING).length,
      idling: by(STATE.IDLING).length,
      atTerminal: by(STATE.AT_TERMINAL).length,
      atShop: by(STATE.AT_SHOP).length,
      atCustomer: by(STATE.AT_CUSTOMER).length,
      parked: by(STATE.PARKED).length,
      dormant: by(STATE.DORMANT).length,
      // The number that matters for alerting: how many units are actually in
      // play. Everything else is background.
      inService: rows.filter((r) => r.alertable).length,
    },
    // Surfaced deliberately: a fleet carrying 32 dead units is paying for
    // subscriptions and skewing every fleet-wide average.
    dormantUnits: by(STATE.DORMANT)
      .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
      .map((r) => ({ name: r.name, ageDays: r.ageDays, why: r.why })),
    idlingNow: by(STATE.IDLING).map((r) => ({ name: r.name, place: r.place })),
  };
}

export function initFleet(app, { requireAuth, db, env = process.env }) {
  const requireFleetRole = (req, res, next) => {
    if (!req.user || req.user.role !== 'fleet') return res.status(403).json({ error: 'Fleet account required.' });
    next();
  };

  // A fleet company connects its OWN telematics account. The token is stored
  // server-side and never returned to the browser — the fleet portal asks our
  // backend for vehicles, and our backend talks to Samsara.
  const cfgKey = 'taFleetTelematics';

  async function tokenFor(ownerKey) {
    // Per-company token first; fall back to a server-wide one for our own
    // testing. Never expose either.
    if (db && db.enabled) {
      const all = await db.get(cfgKey, {});
      const cfg = all[ownerKey];
      if (cfg && cfg.samsaraToken) return cfg.samsaraToken;
    }
    return env.SAMSARA_TOKEN || null;
  }

  // Connect (or replace) a fleet's Samsara credentials.
  app.put('/fleet/telematics', requireAuth, requireFleetRole, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    const { samsaraToken } = req.body || {};
    if (!samsaraToken) return res.status(400).json({ error: 'samsaraToken required.' });
    try {
      // Prove it works before saving — a token that fails silently is worse
      // than no token, because the fleet page just looks empty.
      const probe = await fetch('https://api.samsara.com/fleet/drivers?limit=1', {
        headers: { Authorization: `Bearer ${samsaraToken}` },
      });
      if (!probe.ok) return res.status(400).json({ error: `Samsara rejected that token (${probe.status}).` });
      const j = await probe.json().catch(() => ({}));
      const carrier = j.data && j.data[0] && j.data[0].carrierSettings && j.data[0].carrierSettings.carrierName;

      const owner = String(req.user.company || req.user.id);
      await db.update(cfgKey, (cur) => ({
        ...cur,
        [owner]: { provider: 'samsara', samsaraToken, carrier: carrier || null, connectedAt: new Date().toISOString() },
      }), {});
      res.json({ ok: true, provider: 'samsara', carrier: carrier || null });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/fleet/telematics', requireAuth, requireFleetRole, async (req, res) => {
    if (!db || !db.enabled) return res.json({ connected: false });
    const owner = String(req.user.company || req.user.id);
    const all = await db.get(cfgKey, {});
    const cfg = all[owner];
    // Never return the token itself.
    res.json({ connected: !!(cfg && cfg.samsaraToken), provider: cfg && cfg.provider, carrier: cfg && cfg.carrier, connectedAt: cfg && cfg.connectedAt });
  });

  // Every vehicle on this fleet, classified.
  app.get('/fleet/live', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const r = await fetch('https://api.samsara.com/fleet/vehicles/stats?types=gps,engineStates', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `Samsara ${r.status}`, detail: detail.slice(0, 200) });
      }
      const j = await r.json();
      const includeDormant = req.query.includeDormant === '1';
      const out = summarise(j.data || []);
      if (!includeDormant) out.rows = out.rows.filter((v) => v.state !== STATE.DORMANT);
      res.json(out);
    } catch (e) {
      console.error('[fleet] live pull failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- Hours of Service ----
  // The single most actionable number in a fleet: how much legal driving time
  // each driver has left. A driver at 0:15 remaining is a load that's about to
  // stop moving, and that's a dispatch decision, not a compliance report.
  app.get('/fleet/hos', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const r = await fetch('https://api.samsara.com/fleet/hos/clocks?limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `Samsara ${r.status}`, detail: detail.slice(0, 200) });
      }
      const j = await r.json();
      const MIN = 60 * 1000;
      const rows = (j.data || []).map((c) => {
        const clocks = c.clocks || {};
        const drive = clocks.drive || {};
        const shift = clocks.shift || {};
        const cycle = clocks.cycle || {};
        const driveMs = drive.driveRemainingDurationMs != null ? drive.driveRemainingDurationMs : null;
        const shiftMs = shift.shiftRemainingDurationMs != null ? shift.shiftRemainingDurationMs : null;
        const cycleMs = cycle.cycleRemainingDurationMs != null ? cycle.cycleRemainingDurationMs : null;
        const status = (c.currentDutyStatus && c.currentDutyStatus.hosStatusType) || null;
        // Ranked the way a dispatcher would: who stops soonest?
        const worstMs = [driveMs, shiftMs].filter((x) => x != null).sort((a, b) => a - b)[0];
        return {
          driverId: (c.driver && c.driver.id) || null,
          driverName: (c.driver && c.driver.name) || '',
          vehicle: (c.currentVehicle && c.currentVehicle.name) || null,
          status,
          driving: status === 'driving',
          driveRemainingMin: driveMs != null ? Math.round(driveMs / MIN) : null,
          shiftRemainingMin: shiftMs != null ? Math.round(shiftMs / MIN) : null,
          cycleRemainingMin: cycleMs != null ? Math.round(cycleMs / MIN) : null,
          timeUntilBreakMin: drive.timeUntilBreakDurationMs != null
            ? Math.round(drive.timeUntilBreakDurationMs / MIN) : null,
          worstRemainingMin: worstMs != null ? Math.round(worstMs / MIN) : null,
        };
      });
      const driving = rows.filter((r2) => r2.driving);
      res.json({
        rows: rows.sort((a, b) => (a.worstRemainingMin ?? 1e9) - (b.worstRemainingMin ?? 1e9)),
        counts: {
          total: rows.length,
          driving: driving.length,
          // Bands that mean something operationally, not just "in violation".
          outOfHours: rows.filter((r2) => r2.worstRemainingMin != null && r2.worstRemainingMin <= 0).length,
          under1h: driving.filter((r2) => r2.worstRemainingMin != null && r2.worstRemainingMin > 0 && r2.worstRemainingMin <= 60).length,
          under2h: driving.filter((r2) => r2.worstRemainingMin != null && r2.worstRemainingMin > 60 && r2.worstRemainingMin <= 120).length,
        },
      });
    } catch (e) {
      console.error('[fleet] hos failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- drivers, and which truck they're in ----
  //
  // Samsara already holds the roster and the current driver-vehicle assignment.
  // Asking a company to re-enter 193 drivers they've already got is exactly the
  // sort of duplicate data entry that makes people abandon a tool — and the two
  // copies would immediately drift apart.
  //
  // Assignment comes from the HOS clocks, which carry `currentVehicle`. That's
  // the live, authoritative answer to "who is in truck 2606 right now",
  // and it needs no extra permissions beyond what we already use.
  app.get('/fleet/drivers', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const headers = { Authorization: `Bearer ${token}` };

      // Roster (paginated — a 193-driver fleet needs more than one page).
      const drivers = [];
      let cursor = null, pages = 0;
      do {
        const qs = new URLSearchParams({ limit: '100' });
        if (cursor) qs.set('after', cursor);
        const r = await fetch(`https://api.samsara.com/fleet/drivers?${qs}`, { headers });
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          return res.status(502).json({ error: `Samsara ${r.status}`, detail: detail.slice(0, 200) });
        }
        const j = await r.json();
        for (const d of (j.data || [])) {
          drivers.push({
            id: String(d.id),
            name: d.name || '',
            username: d.username || '',
            phone: d.phone || '',
            license: d.licenseNumber || '',
            licenseState: d.licenseState || '',
            status: d.driverActivationStatus || '',
            timezone: d.timezone || null,
          });
        }
        const pg = j.pagination || {};
        cursor = pg.hasNextPage ? pg.endCursor : null;
        pages += 1;
      } while (cursor && pages < 10);

      // Live assignment + duty status from the HOS clocks.
      const byId = new Map(drivers.map((d) => [d.id, d]));
      try {
        const hr = await fetch('https://api.samsara.com/fleet/hos/clocks?limit=200', { headers });
        if (hr.ok) {
          const hj = await hr.json();
          for (const c of (hj.data || [])) {
            const id = c.driver && String(c.driver.id);
            if (!id) continue;
            const d = byId.get(id) || { id, name: (c.driver && c.driver.name) || '' };
            d.vehicle = (c.currentVehicle && c.currentVehicle.name) || null;
            d.vehicleId = (c.currentVehicle && String(c.currentVehicle.id)) || null;
            d.dutyStatus = (c.currentDutyStatus && c.currentDutyStatus.hosStatusType) || null;
            if (!byId.has(id)) { drivers.push(d); byId.set(id, d); }
          }
        }
      } catch { /* roster still useful without live assignment */ }

      const assigned = drivers.filter((d) => d.vehicleId);
      // Vehicle id → driver, so the vehicle list can label itself.
      const byVehicle = {};
      for (const d of assigned) byVehicle[d.vehicleId] = { id: d.id, name: d.name, phone: d.phone, dutyStatus: d.dutyStatus };

      res.json({
        drivers: drivers.sort((a, b) => String(a.name).localeCompare(String(b.name))),
        byVehicle,
        counts: {
          total: drivers.length,
          active: drivers.filter((d) => d.status === 'active').length,
          assigned: assigned.length,
          driving: drivers.filter((d) => d.dutyStatus === 'driving').length,
        },
      });
    } catch (e) {
      console.error('[fleet] drivers failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  console.log('[fleet] live fleet state ready — GET /fleet/live, /fleet/hos, /fleet/drivers, PUT /fleet/telematics');
  return { classify, summarise, STATE };
}

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

  // ---- what does this Samsara account actually expose? ----
  //
  // Written after guessing route field names from documentation and getting
  // them wrong. Rather than assume, probe: call each endpoint once, record the
  // HTTP status and the field names that come back, and report it. That tells
  // us what this specific account is licensed for and permitted to read —
  // which varies enormously between Samsara customers depending on their plan
  // and the token's scopes.
  //
  // Costs one small request per endpoint, run on demand only.
  const PROBES = [
    { key: 'vehicles', label: 'Vehicles', url: '/fleet/vehicles?limit=1' },
    { key: 'vehicleStats', label: 'Vehicle stats (live)', url: '/fleet/vehicles/stats?types=gps,engineStates,fuelPercents,obdOdometerMeters,engineRpm,engineCoolantTemperatureMilliC,batteryMilliVolts,ambientAirTemperature,defLevelMilliPercent,faultCodes,engineSeconds&limit=1' },
    { key: 'drivers', label: 'Drivers', url: '/fleet/drivers?limit=1' },
    { key: 'hosClocks', label: 'HOS clocks', url: '/fleet/hos/clocks?limit=1' },
    { key: 'hosLogs', label: 'HOS logs', url: '/fleet/hos/logs?limit=1' },
    { key: 'assets', label: 'Assets (trailers/equipment)', url: '/assets?limit=1' },
    { key: 'addresses', label: 'Addresses / geofences', url: '/addresses?limit=1' },
    { key: 'safetyEvents', label: 'Safety events', url: '/fleet/safety-events?limit=1' },
    { key: 'trailers', label: 'Trailers', url: '/fleet/trailers?limit=1' },
    { key: 'documents', label: 'Documents', url: '/fleet/documents?limit=1' },
    { key: 'forms', label: 'Forms', url: '/form-submissions?limit=1' },
    { key: 'maintenance', label: 'DVIRs', url: '/fleet/maintenance/dvirs?limit=1' },
    { key: 'tags', label: 'Tags', url: '/tags?limit=1' },
    { key: 'webhooks', label: 'Webhooks', url: '/webhooks' },
  ];

  // Field names, one level deep, so we can see the shape without dumping data.
  function shapeOf(v, depth = 0) {
    if (v == null) return null;
    if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
    if (typeof v === 'object') {
      if (depth >= 2) return '{…}';
      const out = {};
      for (const k of Object.keys(v).slice(0, 40)) out[k] = shapeOf(v[k], depth + 1);
      return out;
    }
    return typeof v;
  }

  app.get('/fleet/discover', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const headers = { Authorization: `Bearer ${token}` };

      const out = [];
      for (const p of PROBES) {
        try {
          const r = await fetch(`https://api.samsara.com${p.url}`, { headers });
          const body = await r.json().catch(() => null);
          const sample = body && (Array.isArray(body.data) ? body.data[0] : body.data) ;
          out.push({
            key: p.key,
            label: p.label,
            status: r.status,
            available: r.ok,
            // 403 usually means "not licensed / token lacks scope" rather than
            // "doesn't exist" — worth distinguishing for the customer.
            note: r.status === 403 ? 'Not permitted — check plan or token scopes.'
              : r.status === 404 ? 'Endpoint not available on this account.'
                : r.ok && !sample ? 'Reachable but returned no records.' : null,
            fields: sample ? Object.keys(sample) : [],
            shape: sample ? shapeOf(sample) : null,
          });
        } catch (e) {
          out.push({ key: p.key, label: p.label, status: 0, available: false, note: e.message, fields: [] });
        }
      }
      res.json({
        probes: out,
        summary: {
          available: out.filter((o) => o.available).length,
          total: out.length,
          blocked: out.filter((o) => o.status === 403).map((o) => o.label),
        },
      });
    } catch (e) {
      console.error('[fleet] discover failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- full vehicle detail ----
  // Everything Samsara will give us per truck, in one call. Values are
  // normalised out of Samsara's units (milli-anything) into what a human reads.
  app.get('/fleet/vehicles/full', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const types = [
        'gps', 'engineStates', 'fuelPercents', 'obdOdometerMeters', 'engineRpm',
        'engineCoolantTemperatureMilliC', 'batteryMilliVolts', 'ambientAirTemperature',
        'defLevelMilliPercent', 'faultCodes', 'engineSeconds',
      ].join(',');
      const r = await fetch(`https://api.samsara.com/fleet/vehicles/stats?types=${types}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `Samsara ${r.status}`, detail: detail.slice(0, 300) });
      }
      const j = await r.json();
      const val = (x) => (x && x.value != null ? x.value : null);
      const rows = (j.data || []).map((v) => {
        const gps = v.gps || {};
        const faults = v.faultCodes || {};
        const obd = faults.obdii || {};
        const j1939 = faults.j1939 || {};
        const codes = [
          ...((obd.diagnosticTroubleCodes || []).map((c) => c.dtcShortCode || c.fmiDescription).filter(Boolean)),
          ...((j1939.diagnosticTroubleCodes || []).map((c) => c.spnDescription || c.fmiDescription).filter(Boolean)),
        ];
        const odoM = val(v.obdOdometerMeters);
        const coolantMilliC = val(v.engineCoolantTemperatureMilliC);
        const battMv = val(v.batteryMilliVolts);
        const defMilli = val(v.defLevelMilliPercent);
        const ambient = v.ambientAirTemperature || {};
        return {
          id: v.id,
          name: v.name,
          vin: (v.externalIds && v.externalIds['samsara.vin']) || null,
          serial: (v.externalIds && v.externalIds['samsara.serial']) || null,
          engine: val(v.engineStates),
          lat: gps.latitude ?? null,
          lng: gps.longitude ?? null,
          speedMph: gps.speedMilesPerHour ?? null,
          heading: gps.headingDegrees ?? null,
          place: (gps.reverseGeo && gps.reverseGeo.formattedLocation) || null,
          addressName: (gps.address && gps.address.name) || null,
          addressId: (gps.address && gps.address.id) || null,
          gpsAt: gps.time || null,
          fuelPct: val(v.fuelPercents),
          odometerMi: odoM != null ? Math.round(odoM / 1609.34) : null,
          rpm: val(v.engineRpm),
          coolantF: coolantMilliC != null ? Math.round((coolantMilliC / 1000) * 9 / 5 + 32) : null,
          batteryV: battMv != null ? Number((battMv / 1000).toFixed(1)) : null,
          defPct: defMilli != null ? Math.round(defMilli / 1000) : null,
          ambientF: ambient.ambientAirTemperatureMilliC != null
            ? Math.round((ambient.ambientAirTemperatureMilliC / 1000) * 9 / 5 + 32) : null,
          engineHours: val(v.engineSeconds) != null ? Math.round(val(v.engineSeconds) / 3600) : null,
          faultCodes: codes,
          faultCount: codes.length,
        };
      });
      res.json({
        vehicles: rows,
        counts: {
          total: rows.length,
          withFaults: rows.filter((x) => x.faultCount > 0).length,
          lowFuel: rows.filter((x) => x.fuelPct != null && x.fuelPct < 20).length,
          lowDef: rows.filter((x) => x.defPct != null && x.defPct < 20).length,
          lowBattery: rows.filter((x) => x.batteryV != null && x.batteryV < 12.2).length,
        },
      });
    } catch (e) {
      console.error('[fleet] full vehicles failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- outbound LTL runs in progress ----
  //
  // The screen a dispatcher actually watches: which trucks are out on a
  // delivery run, how far through they are, what's next, and what's gone wrong.
  //
  // Mapping is duplicated from tms/samsara.js rather than imported, because the
  // backend repo is flat and the adapters aren't deployed there. Both were
  // VERIFIED against a live route payload — routes carry no `state` and no
  // `vehicle`, stop states are departed/skipped/en_route, `externalIds` is an
  // object keyed "0","1",…, and only `singleUseLocation` has coordinates.
  // If one changes, change both.
  const R_MI = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  function miles(aLat, aLng, bLat, bLng) {
    const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_MI * Math.asin(Math.sqrt(s));
  }
  const billsFrom = (ext) => {
    if (!ext) return [];
    const vals = Array.isArray(ext) ? ext : Object.values(ext);
    return vals.map((v) => String(v).split('-')[0].trim()).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
  };
  const DONE_STATES = new Set(['departed', 'completed', 'skipped']);

  // Samsara returns addresses in at least two shapes:
  //   "2306 Perimeter Park Dr., ATLANTA, GA 30341"       ← state+zip together
  //   "3315 NW 70th Ave, Miami-Dade County, FL, 33122"   ← zip its own part
  // A naive "last part is state" reads the second as city=FL, state=33122.
  // So: drop a trailing bare zip first, then read state off the new tail.
  function parseCityState(formatted) {
    const parts = String(formatted || '').split(',').map((s) => s.trim()).filter(Boolean);
    let zip = null;
    if (parts.length && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1])) {
      zip = parts.pop();
    }
    if (parts.length < 2) return { city: null, state: null, zip };
    const tail = parts[parts.length - 1];
    const m = tail.match(/^([A-Za-z]{2})\s*(\d{5})?$/);
    if (m) {
      return { city: parts[parts.length - 2] || null, state: m[1].toUpperCase(), zip: zip || m[2] || null };
    }
    return { city: parts[parts.length - 2] || null, state: tail || null, zip };
  }

  // ---- address book, cached ----
  // City and state come from here, not from the route stop.
  let addrCache = { at: 0, map: new Map() };
  async function addressBook(token) {
    if (Date.now() - addrCache.at < 60 * 60 * 1000 && addrCache.map.size) return addrCache.map;
    const map = new Map();
    try {
      let cursor = null, pages = 0;
      do {
        const qs = new URLSearchParams({ limit: '512' });
        if (cursor) qs.set('after', cursor);
        const r = await fetch(`https://api.samsara.com/addresses?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) break;
        const j = await r.json();
        for (const a of (j.data || [])) {
          const formatted = a.formattedAddress || '';
          // "2306 Perimeter Park Dr., ATLANTA, GA 30341" → city + state.
          // Parsed from the end so a street address containing commas doesn't
          // throw it off.
          const { city, state, zip } = parseCityState(formatted);
          map.set(String(a.id), {
            name: a.name || '',
            formatted,
            city: city || null,
            state: state || null,
            zip,
            lat: (a.geofence && a.geofence.circle && a.geofence.circle.latitude) || null,
            lng: (a.geofence && a.geofence.circle && a.geofence.circle.longitude) || null,
          });
        }
        const pg = j.pagination || {};
        cursor = pg.hasNextPage ? pg.endCursor : null;
        pages += 1;
      } while (cursor && pages < 12);
    } catch (e) {
      console.warn('[fleet] address book unavailable:', e.message);
    }
    if (map.size) addrCache = { at: Date.now(), map };
    return map;
  }

  // Customer names arrive as "FLORA GREENS LLC (44903)" — the trailing code is
  // their account number. Kept separately so the name reads cleanly but the
  // code is still searchable.
  function splitCustomer(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (m) return { name: m[1].replace(/\*+$/, '').trim(), code: m[2] };
    return { name: s.replace(/\*+$/, '').trim(), code: null };
  }

  app.get('/fleet/runs', requireAuth, async (req, res) => {
    try {
      const owner = String(req.user.company || req.user.id);
      const token = await tokenFor(owner);
      if (!token) return res.status(503).json({ error: 'No telematics account connected.' });
      const headers = { Authorization: `Bearer ${token}` };
      const now = Date.now();

      // Routes, live positions and HOS together — a run without the truck's
      // current position can't answer "where is it and will it make the next
      // appointment", which is the whole point of the screen.
      const start = new Date(now - 3 * 86400000).toISOString();
      const end = new Date(now + 7 * 86400000).toISOString();
      const [rr, vr, hr] = await Promise.all([
        fetch(`https://api.samsara.com/fleet/routes?startTime=${start}&endTime=${end}&limit=100`, { headers }),
        fetch('https://api.samsara.com/fleet/vehicles/stats?types=gps,engineStates', { headers }),
        fetch('https://api.samsara.com/fleet/hos/clocks?limit=200', { headers }),
      ]);

      // Route stops only carry { id, name } for saved locations — no city, no
      // state, no coordinates. The full address lives in Samsara's address book,
      // so resolve it once and reuse. Cached for an hour: an address book barely
      // changes, and re-pulling it on every load would be wasteful.
      const addrById = await addressBook(token);
      if (!rr.ok) {
        const detail = await rr.text().catch(() => '');
        return res.status(502).json({ error: `Samsara routes ${rr.status}`, detail: detail.slice(0, 250) });
      }
      const routes = (await rr.json()).data || [];
      const vehicles = vr.ok ? ((await vr.json()).data || []) : [];
      const clocks = hr.ok ? ((await hr.json()).data || []) : [];

      // driver id → { vehicle, hours left }
      const hosByDriver = new Map();
      for (const c of clocks) {
        const id = c.driver && String(c.driver.id);
        if (!id) continue;
        const drive = (c.clocks && c.clocks.drive) || {};
        const shift = (c.clocks && c.clocks.shift) || {};
        const ms = [drive.driveRemainingDurationMs, shift.shiftRemainingDurationMs]
          .filter((x) => x != null).sort((a, b) => a - b)[0];
        hosByDriver.set(id, {
          vehicleName: (c.currentVehicle && c.currentVehicle.name) || null,
          vehicleId: (c.currentVehicle && String(c.currentVehicle.id)) || null,
          remainingMin: ms != null ? Math.round(ms / 60000) : null,
          dutyStatus: (c.currentDutyStatus && c.currentDutyStatus.hosStatusType) || null,
        });
      }
      const vehById = new Map(vehicles.map((v) => [String(v.id), v]));

      const runs = routes.map((route) => {
        const stops = (route.stops || []).map((s) => {
          const sul = s.singleUseLocation || null;
          const addrId = (s.address && s.address.id) || null;
          const book = addrId ? addrById.get(String(addrId)) : null;
          const raw = s.name || (s.address && s.address.name) || '';
          const { name: customer, code: customerCode } = splitCustomer(raw);
          // Single-use locations carry their own address string; saved ones are
          // resolved from the address book above.
          let city = book ? book.city : null;
          let state = book ? book.state : null;
          if (!city && sul && sul.address) {
            const p = parseCityState(sul.address);
            city = p.city; state = p.state;
          }
          return {
            id: s.id,
            name: raw,
            customer,
            customerCode,
            city,
            state,
            where: [city, state].filter(Boolean).join(', ') || null,
            fullAddress: (book && book.formatted) || (sul && sul.address) || null,
            addressId: addrId,
            lat: sul ? sul.latitude : (book ? book.lat : null),
            lng: sul ? sul.longitude : (book ? book.lng : null),
            appointmentAt: s.scheduledArrivalTime || null,
            arrivedAt: s.actualArrivalTime || null,
            departedAt: s.actualDepartureTime || null,
            enRouteAt: s.enRouteTime || null,
            skippedAt: s.skippedTime || null,
            state: s.state || null,
            sequence: s.sequenceNumber || null,
            bills: billsFrom(s.externalIds),
            proofCount: (s.documents || []).length,
            notes: s.notes || '',
          };
        });

        const done = stops.filter((s) => DONE_STATES.has(s.state)).length;
        const skipped = stops.filter((s) => s.state === 'skipped');
        const next = stops.find((s) => !DONE_STATES.has(s.state)) || null;
        const driverId = (route.driver && String(route.driver.id)) || null;
        const hos = driverId ? hosByDriver.get(driverId) : null;
        const veh = hos && hos.vehicleId ? vehById.get(hos.vehicleId) : null;
        const gps = (veh && veh.gps) || null;

        // Distance and ETA to the next stop, when we have both ends.
        let milesToNext = null, etaAt = null, lateByMin = null;
        if (gps && next && next.lat != null) {
          milesToNext = Math.round(miles(gps.latitude, gps.longitude, next.lat, next.lng));
          const hrs = milesToNext / 48;
          etaAt = new Date(now + hrs * 3600000).toISOString();
          if (next.appointmentAt) {
            lateByMin = Math.round((Date.parse(etaAt) - Date.parse(next.appointmentAt)) / 60000);
          }
        }

        const complete = stops.length > 0 && done === stops.length;
        return {
          id: String(route.id),
          reference: route.name || String(route.id),
          driverId,
          driverName: (route.driver && route.driver.name) || '',
          truck: hos ? hos.vehicleName : null,
          dutyStatus: hos ? hos.dutyStatus : null,
          hoursLeftMin: hos ? hos.remainingMin : null,
          lat: gps ? gps.latitude : null,
          lng: gps ? gps.longitude : null,
          speedMph: gps ? Math.round(gps.speedMilesPerHour || 0) : null,
          place: (gps && gps.reverseGeo && gps.reverseGeo.formattedLocation) || null,
          gpsAt: gps ? gps.time : null,
          stopCount: stops.length,
          stopsDone: done,
          skippedCount: skipped.length,
          skippedStops: skipped.map((s) => ({ name: s.name, bills: s.bills })),
          totalBills: stops.reduce((n, s) => n + s.bills.length, 0),
          complete,
          nextStop: next ? {
            name: next.name, customer: next.customer, customerCode: next.customerCode,
            city: next.city, state: next.state, where: next.where,
            fullAddress: next.fullAddress,
            appointmentAt: next.appointmentAt, bills: next.bills,
            notes: next.notes, sequence: next.sequence,
          } : null,
          milesToNext, etaAt, lateByMin,
          scheduledStartAt: route.scheduledRouteStartTime || null,
          actualStartAt: route.actualRouteStartTime || null,
          timezone: route.orgLocalTimezone || null,
          stops,
        };
      });

      // In progress = started, not finished. That's what "on the road" means.
      const active = runs.filter((r) => !r.complete && (r.stopsDone > 0 || r.actualStartAt));
      const upcoming = runs.filter((r) => !r.complete && r.stopsDone === 0 && !r.actualStartAt);

      active.sort((a, b) => (b.lateByMin ?? -1e9) - (a.lateByMin ?? -1e9));

      res.json({
        active, upcoming,
        counts: {
          active: active.length,
          upcoming: upcoming.length,
          completed: runs.filter((r) => r.complete).length,
          stopsRemaining: active.reduce((n, r) => n + (r.stopCount - r.stopsDone), 0),
          skipped: active.reduce((n, r) => n + r.skippedCount, 0),
          late: active.filter((r) => r.lateByMin != null && r.lateByMin > 15).length,
          lowHours: active.filter((r) => r.hoursLeftMin != null && r.hoursLeftMin <= 60).length,
        },
      });
    } catch (e) {
      console.error('[fleet] runs failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  console.log('[fleet] ready — /fleet/live, /fleet/hos, /fleet/drivers, /fleet/vehicles/full, /fleet/runs, /fleet/discover');
  return { classify, summarise, STATE };
}

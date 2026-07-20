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

  console.log('[fleet] live fleet state ready — GET /fleet/live, PUT /fleet/telematics');
  return { classify, summarise, STATE };
}

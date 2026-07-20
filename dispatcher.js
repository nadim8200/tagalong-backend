// ---------------------------------------------------------------
// The AI dispatcher's legwork.
//
// A dispatcher's day is not making clever decisions — it's checking. Is that
// reefer still at 35°? Is truck 733 going to make a 4am appointment? Did the
// Charleston stop ever get delivered? Has anyone told Queens Flowers their
// flowers are late? Did the driver send the count sheet? Who hasn't been called
// an hour before arrival?
//
// One person can hold maybe a dozen of those in their head. Across a fleet
// running multi-stop LTL plus backhauls, most of them go unchecked until
// something goes wrong and someone works backwards.
//
// This module does that checking continuously and produces a ranked list of
// what needs a human. Each finding says what's wrong, what the evidence is,
// who should be told, and drafts the message — because "notify the customer"
// is itself twenty minutes of a dispatcher's day.
//
// DESIGN RULES
//  1. Every finding must be ACTIONABLE. "Truck is moving" is not a finding.
//  2. Every finding carries its evidence, so a human can disagree.
//  3. Messages are DRAFTED, never sent automatically. A wrong ETA email to a
//     customer costs more trust than it saves time.
//  4. Silence is the goal. A screen full of findings every morning trains
//     people to ignore it — the same way the 20-minute "tracker disconnected"
//     alert did.
// ---------------------------------------------------------------

export const SEVERITY = { CRITICAL: 3, WARNING: 2, INFO: 1 };

// Perishable freight: the trip sheet says 35°F continuous. Tolerance is tight
// because the cost of being wrong is the entire load.
const TEMP_TARGET_F = 35;
const TEMP_TOLERANCE_F = 4;      // 31–39°F is fine
const TEMP_CRITICAL_F = 8;       // beyond ±8° the flowers are at real risk

const MIN = 60 * 1000, HOUR = 60 * MIN;

const mins = (ms) => Math.round(ms / MIN);
const fmtTime = (d, tz) => new Date(d).toLocaleString('en-US', {
  timeZone: tz || 'America/New_York', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

// ---------- individual checks ----------
// Each returns a finding or null. Kept separate and pure so each can be tested
// and so a carrier can switch one off without touching the others.

export function checkTemperature(load, { now = Date.now() } = {}) {
  const t = load.telemetry || {};
  if (t.reeferF == null || !load.requiresReefer) return null;
  const drift = Math.abs(t.reeferF - (load.targetTempF || TEMP_TARGET_F));
  if (drift <= TEMP_TOLERANCE_F) return null;
  const critical = drift >= TEMP_CRITICAL_F;
  return {
    code: 'temp-excursion',
    severity: critical ? SEVERITY.CRITICAL : SEVERITY.WARNING,
    title: `${load.reference}: reefer at ${t.reeferF}°F (target ${load.targetTempF || TEMP_TARGET_F}°F)`,
    detail: critical
      ? 'Outside safe range for fresh cut flowers. The load is at risk NOW — call the driver.'
      : 'Drifting outside tolerance. Check the unit before it gets worse.',
    evidence: { reeferF: t.reeferF, target: load.targetTempF || TEMP_TARGET_F, at: t.at, driftF: drift },
    tell: ['driver', 'dispatcher'],
    draft: {
      to: 'driver',
      text: `Reefer on ${load.reference} is reading ${t.reeferF}°F, target is ${load.targetTempF || TEMP_TARGET_F}°F continuous. `
        + 'Please check the unit is running and set correctly, and confirm. If it can\'t hold temperature call dispatch immediately.',
    },
  };
}

// Will the truck make its next appointment? This is the check dispatchers do
// constantly in their heads and get wrong when they're busy.
export function checkAppointmentRisk(load, { now = Date.now() } = {}) {
  const stop = (load.stops || []).find((s) => !s.arrivedAt && !s.skippedAt && s.appointmentAt);
  if (!stop) return null;
  const t = load.telemetry || {};
  if (t.lat == null || stop.lat == null) return null;

  const milesOut = haversine(t.lat, t.lng, stop.lat, stop.lng);
  const mph = load.crew === 'team' ? 50 : 48;
  const etaMs = now + (milesOut / mph) * HOUR;
  const appt = new Date(stop.appointmentAt).getTime();
  const lateBy = etaMs - appt;

  if (lateBy < 15 * MIN) return null; // on time, or close enough

  const critical = lateBy > 2 * HOUR;
  return {
    code: 'appointment-risk',
    severity: critical ? SEVERITY.CRITICAL : SEVERITY.WARNING,
    title: `${load.reference}: running ~${mins(lateBy)} min late to ${stop.name}`,
    detail: `${Math.round(milesOut)} mi out, appointment ${fmtTime(appt, load.timezone)}. `
      + (critical ? 'Customer needs telling now — flowers are date-critical and a late arrival can be refused.'
        : 'Worth a heads-up before it becomes a refusal.'),
    evidence: { milesOut: Math.round(milesOut), etaAt: new Date(etaMs).toISOString(), appointmentAt: stop.appointmentAt, lateByMin: mins(lateBy) },
    tell: ['customer', 'dispatcher'],
    draft: {
      to: stop.contactName || 'customer',
      text: `Update on your delivery (${stop.bills && stop.bills.length ? `bill ${stop.bills.join(', ')}` : load.reference}): `
        + `our driver is currently ${Math.round(milesOut)} miles out and now estimated to arrive around `
        + `${fmtTime(etaMs, load.timezone)}, about ${mins(lateBy)} minutes later than the scheduled `
        + `${fmtTime(appt, load.timezone)}. The load is in temperature-controlled transit. `
        + 'Please let us know if that time works or if you need us to adjust.',
    },
  };
}

// "CALL ISRAEL 1HR BEFORE ARRIVING" — printed on the paperwork, currently
// dependent on a driver remembering while driving.
export function checkCallAhead(load, { now = Date.now() } = {}) {
  const stop = (load.stops || []).find((s) => !s.arrivedAt && !s.skippedAt && s.callAhead && !s.calledAheadAt);
  if (!stop) return null;
  const t = load.telemetry || {};
  if (t.lat == null || stop.lat == null) return null;

  const milesOut = haversine(t.lat, t.lng, stop.lat, stop.lng);
  const leadHours = stop.callAheadHours || 1;
  const etaHours = milesOut / 48;
  if (etaHours > leadHours + 0.25) return null; // not yet
  return {
    code: 'call-ahead-due',
    severity: SEVERITY.WARNING,
    title: `Call ahead now: ${stop.name}${stop.contactName ? ` (${stop.contactName})` : ''}`,
    detail: `About ${Math.round(etaHours * 60)} min out and the stop requires ${leadHours}h notice. `
      + (stop.contactPhone ? `Contact ${stop.contactPhone}.` : 'No phone on file — check the manifest.'),
    evidence: { milesOut: Math.round(milesOut), etaMin: Math.round(etaHours * 60), requiredLeadHours: leadHours, phone: stop.contactPhone || null },
    tell: ['driver', 'customer'],
    draft: {
      to: stop.contactName || stop.name,
      text: `Hello${stop.contactName ? ` ${stop.contactName}` : ''}, this is Florida Beauty — your delivery is about `
        + `${Math.round(etaHours * 60)} minutes out, arriving around ${fmtTime(now + etaHours * HOUR, load.timezone)}. `
        + 'Please confirm someone will be available to receive it.',
    },
  };
}

// Freight that never got delivered. Observed in live Samsara data — three of
// twelve stops on one route.
export function checkSkippedStops(load) {
  const skipped = (load.stops || []).filter((s) => s.skippedAt && !s.skippedHandled);
  if (!skipped.length) return null;
  const bills = skipped.flatMap((s) => s.bills || []);
  return {
    code: 'skipped-stop',
    severity: SEVERITY.CRITICAL,
    title: `${load.reference}: ${skipped.length} stop${skipped.length > 1 ? 's' : ''} skipped — freight not delivered`,
    detail: `${skipped.map((s) => s.name).join(', ')}. `
      + `${bills.length} bill${bills.length === 1 ? '' : 's'} undelivered. Customer must be told and the freight rescheduled.`,
    evidence: { stops: skipped.map((s) => ({ name: s.name, at: s.skippedAt, bills: s.bills })) },
    tell: ['customer', 'dispatcher'],
    draft: {
      to: 'customer',
      text: `We need to let you know that your delivery${bills.length ? ` (bill${bills.length > 1 ? 's' : ''} ${bills.join(', ')})` : ''} `
        + 'was not completed on this run. We are arranging redelivery and will confirm the new date shortly. '
        + 'Apologies for the inconvenience — please tell us if this affects your orders so we can prioritise.',
    },
  };
}

// The delivery packet: counts, signed BOL, pallet photos. Missing paperwork
// becomes an unwinnable claim weeks later.
export function checkMissingPod(load, { now = Date.now(), graceMin = 45 } = {}) {
  const delivered = (load.stops || []).filter((s) => s.departedAt && !s.skippedAt);
  const missing = delivered.filter((s) => {
    const since = now - new Date(s.departedAt).getTime();
    return since > graceMin * MIN && !s.podComplete;
  });
  if (!missing.length) return null;
  return {
    code: 'pod-missing',
    severity: SEVERITY.WARNING,
    title: `${load.reference}: paperwork outstanding for ${missing.length} completed stop${missing.length > 1 ? 's' : ''}`,
    detail: `${missing.map((s) => s.name).join(', ')} — no count sheet, signed BOL or pallet photos received. `
      + 'Chase the driver while they still remember the stop.',
    evidence: { stops: missing.map((s) => ({ name: s.name, departedAt: s.departedAt, has: s.podParts || [] })) },
    tell: ['driver'],
    draft: {
      to: 'driver',
      text: `Please send the delivery paperwork for ${missing.map((s) => s.name).join(', ')}: `
        + 'pallet counts, photo of the signed BOL, and photos of two sides of each pallet. Thanks.',
    },
  };
}

// A count discrepancy the driver recorded. This is a claim in the making, and
// it's cheapest to resolve on the day.
export function checkOsd(load) {
  const bad = (load.pods || []).filter((p) => p.osd && !p.osdReported);
  if (!bad.length) return null;
  const worst = bad[0];
  return {
    code: 'osd-unreported',
    severity: SEVERITY.CRITICAL,
    title: `${load.reference}: ${worst.osd} on bill ${worst.billNumber || '—'} not yet reported`,
    detail: `Counted ${worst.countedTotal} against ${worst.expectedTotal} expected (${worst.osdDelta > 0 ? '+' : ''}${worst.osdDelta}). `
      + 'The instructions require OSD to be reported at time of delivery — the claim gets harder every day it waits.',
    evidence: { pods: bad.map((p) => ({ bill: p.billNumber, osd: p.osd, delta: p.osdDelta })) },
    tell: ['customer', 'dispatcher'],
    draft: {
      to: 'customer',
      text: `On delivery of bill ${worst.billNumber || ''} our driver recorded a ${worst.osd}: `
        + `${worst.countedTotal} pieces received against ${worst.expectedTotal} expected. `
        + 'Photographs and the signed delivery sheet are on file. Please confirm your count so we can open a claim '
        + 'reference and resolve it quickly.',
    },
  };
}

// Truck empty with nothing booked home.
export function checkNoBackhaul(load) {
  if (load.type !== 'ltl') return null;
  const allDone = (load.stops || []).length
    && (load.stops || []).every((s) => s.departedAt || s.skippedAt);
  if (!allDone || load.backhaulBooked) return null;
  const last = (load.stops || [])[load.stops.length - 1] || {};
  return {
    code: 'no-backhaul',
    severity: SEVERITY.WARNING,
    title: `${load.reference}: empty at ${last.name || 'final stop'} with no return load booked`,
    detail: 'Every mile home without freight is unrecovered cost. Reload was marked "AS NEEDED" — it is needed now.',
    evidence: { finishedAt: last.departedAt, lat: last.lat, lng: last.lng },
    tell: ['dispatcher'],
    draft: null, // this one is a recommendation to run, not a message to send
    action: { type: 'find-backhaul', lat: last.lat, lng: last.lng, crew: load.crew },
  };
}

// Tracker silent while the truck should be moving.
export function checkStaleTelemetry(load, { now = Date.now(), staleMin = 90 } = {}) {
  const t = load.telemetry || {};
  if (!t.at) return null;
  const age = now - new Date(t.at).getTime();
  if (age < staleMin * MIN) return null;
  const active = (load.stops || []).some((s) => !s.departedAt && !s.skippedAt);
  if (!active) return null;
  return {
    code: 'telemetry-stale',
    severity: SEVERITY.WARNING,
    title: `${load.reference}: no position update for ${Math.round(age / HOUR)}h`,
    detail: 'Cannot verify location, temperature or ETA while the truck is dark. Stops still outstanding.',
    evidence: { lastAt: t.at, ageMin: mins(age) },
    tell: ['driver', 'dispatcher'],
    draft: { to: 'driver', text: 'We have lost tracking on your truck. Please confirm your location and that the unit is powered.' },
  };
}

// ---------- brokered-load checks ----------
// Broker freight arrives as a rate confirmation (see a real one: Backhaul
// Direct load #1237003). Those documents carry obligations that cost real money
// when missed, and every one of them is currently a human remembering.

// "ALL POs must be verified picked up before driver leaves. Report any PO not
// loaded!" — printed in the pickup instructions. If the driver leaves short,
// the carrier eats it.
export function checkPoVerification(load) {
  if (load.type !== 'brokered') return null;
  const pickup = (load.stops || [])[0];
  if (!pickup || !pickup.departedAt) return null;
  const expected = pickup.purchaseOrders || [];
  const verified = pickup.posVerified || [];
  if (!expected.length || verified.length >= expected.length) return null;
  const missing = expected.filter((po) => !verified.includes(po));
  return {
    code: 'po-unverified',
    severity: SEVERITY.CRITICAL,
    title: `${load.reference}: left the shipper with ${missing.length} PO(s) unverified`,
    detail: `PO ${missing.join(', ')} not confirmed loaded against the master BOL. `
      + 'The rate confirmation requires every PO be verified before departure — a shortage found later is the carrier\'s.',
    evidence: { expected, verified, missing },
    tell: ['driver', 'broker'],
    draft: {
      to: 'driver',
      text: `Before you get further — can you confirm PO ${missing.join(', ')} are on board for load ${load.reference}? `
        + 'The broker requires all POs verified against the master BOL at pickup.',
    },
  };
}

// A signed rate confirmation is a condition of getting paid. Unsigned rate
// cons are a quiet, recurring cause of slow payment.
export function checkRateConSigned(load) {
  if (load.type !== 'brokered') return null;
  if (load.rateConSigned) return null;
  const started = (load.stops || []).some((s) => s.arrivedAt || s.departedAt);
  if (!started) return null;
  return {
    code: 'ratecon-unsigned',
    severity: SEVERITY.WARNING,
    title: `${load.reference}: rate confirmation not signed`,
    detail: `Load is running${load.rateUsd ? ` at $${load.rateUsd}` : ''} but the signed rate con isn't on file. `
      + 'Brokers require it with the invoice — unsigned means delayed payment.',
    evidence: { broker: load.brokerName, rate: load.rateUsd },
    tell: ['dispatcher'],
    draft: null,
  };
}

// Lumper fees are paid by the carrier and reimbursed only with receipts.
// "ALL LUMPER FEES / PALLET COSTS MUST BE REPORTED A.S.A.P."
export function checkLumperReceipts(load) {
  const owed = (load.accessorials || []).filter((a) => /lumper|pallet/i.test(a.type) && !a.receiptOnFile);
  if (!owed.length) return null;
  const total = owed.reduce((n, a) => n + (Number(a.amount) || 0), 0);
  return {
    code: 'lumper-receipt-missing',
    severity: SEVERITY.WARNING,
    title: `${load.reference}: $${total.toFixed(2)} in lumper/pallet fees with no receipt`,
    detail: 'Reimbursement requires the receipt. Without it this is money the carrier simply loses.',
    evidence: { items: owed },
    tell: ['driver'],
    draft: {
      to: 'driver',
      text: `Please send photos of the lumper/pallet receipts for ${load.reference} — `
        + `$${total.toFixed(2)} can't be reimbursed without them.`,
    },
  };
}

// ---------- the sweep ----------
const CHECKS = [
  checkTemperature, checkSkippedStops, checkOsd, checkPoVerification,
  checkAppointmentRisk, checkCallAhead, checkMissingPod, checkRateConSigned,
  checkLumperReceipts, checkNoBackhaul, checkStaleTelemetry,
];

export function reviewLoad(load, ctx = {}) {
  const out = [];
  for (const fn of CHECKS) {
    try {
      const f = fn(load, ctx);
      if (f) out.push({ ...f, loadId: load.id, reference: load.reference, driver: load.driverName || null });
    } catch (e) {
      // One broken check must never blind the rest of the sweep.
      out.push({
        code: 'check-failed', severity: SEVERITY.INFO,
        title: `Check ${fn.name} failed on ${load.reference}`,
        detail: e.message, loadId: load.id, evidence: {}, tell: [], draft: null,
      });
    }
  }
  return out;
}

export function reviewFleet(loads = [], ctx = {}) {
  const findings = loads.flatMap((l) => reviewLoad(l, ctx));
  findings.sort((a, b) => b.severity - a.severity);
  return {
    findings,
    summary: {
      critical: findings.filter((f) => f.severity === SEVERITY.CRITICAL).length,
      warning: findings.filter((f) => f.severity === SEVERITY.WARNING).length,
      loadsReviewed: loads.length,
      loadsClean: loads.length - new Set(findings.map((f) => f.loadId)).size,
    },
  };
}

// ---------- geo ----------
function haversine(aLat, aLng, bLat, bLng) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------- HTTP ----------
export function initDispatcher(app, { requireAuth, db, pool }) {
  app.get('/dispatch/attention', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    try {
      const owner = String(req.user.company || req.user.id);
      const { rows } = await pool.query(
        `SELECT * FROM ta_loads WHERE owner_key = $1
           AND status NOT IN ('Complete','Invoiced','Cancelled')
         ORDER BY updated_at DESC LIMIT 200`, [owner]);
      const loads = rows.map((r) => ({ ...r.data, id: r.id, status: r.status, type: r.load_type }));
      res.json(reviewFleet(loads));
    } catch (e) {
      console.error('[dispatch] review failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  console.log('[dispatch] AI dispatcher review ready — GET /dispatch/attention');
  return { reviewLoad, reviewFleet };
}

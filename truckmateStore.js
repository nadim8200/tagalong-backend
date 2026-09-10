// ---------------------------------------------------------------
// TruckMate dispatcher feed — reads the data the on-premise connector
// delivers into the backend (/truckmate/ingest), plus the delivered-trip
// queue the dispatcher/AI acts on.
//
// The connector posts to POST /truckmate/ingest with a shared key. The
// dispatcher UI reads it back through these authenticated endpoints:
//   GET  /truckmate/ingest/latest?site=…   → latest snapshot (trips + meta)
//   GET  /truckmate/delivered?site=…        → delivered-trip queue
//   POST /truckmate/delivered/ack           → mark one handled
//
// Auth is the same Bearer/JWT the fleet + admin app already use.
// ---------------------------------------------------------------
import { API_BASE } from './config';
import { getJwt } from './traccar';

export const TM_SITE = 'florida-beauty';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}),
});

const asJson = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
};

// Latest snapshot the connector delivered: { site, receivedAt, collectedAt,
// tripCount, ageMinutes, paths, errors, data: { trips, rosters, baseline } }.
export async function getTruckMateStatus(site = TM_SITE) {
  if (!API_BASE) throw new Error('No backend configured.');
  const r = await fetch(`${API_BASE}/truckmate/ingest/latest?site=${encodeURIComponent(site)}`, {
    credentials: 'include', headers: authHeaders(),
  });
  return asJson(r);
}

// The whole active board (every live trip, not just the latest delta), plus a
// heartbeat: { site, count, trips, receivedAt, ageMinutes }. This is what the
// dispatcher panel reads so the trip count is stable instead of flickering with
// each connector cycle.
export async function getActiveTrips(site = TM_SITE) {
  if (!API_BASE) throw new Error('No backend configured.');
  const r = await fetch(`${API_BASE}/truckmate/active?site=${encodeURIComponent(site)}`, {
    credentials: 'include', headers: authHeaders(),
  });
  return asJson(r);
}

// GPS breadcrumb for one truck (power unit) → { points:[{t,lat,lng,mph}], vehicle,
// from, to, count }. `since` (ISO) bounds it to the trip start; else last `hours`.
export async function fetchTripRoute(unit, { hours, since } = {}) {
  if (!API_BASE) throw new Error('No backend configured.');
  const qs = new URLSearchParams();
  if (hours) qs.set('hours', String(hours));
  if (since) qs.set('since', since);
  const r = await fetch(`${API_BASE}/truckmate/route/${encodeURIComponent(unit)}${qs.toString() ? `?${qs}` : ''}`, {
    credentials: 'include', headers: authHeaders(),
  });
  return asJson(r);
}

// Delivered-trip queue (newest first). unacked=true → only ones not yet handled.
export async function getDelivered(site = TM_SITE, unacked = false) {
  if (!API_BASE) throw new Error('No backend configured.');
  const q = `site=${encodeURIComponent(site)}${unacked ? '&unacked=1' : ''}`;
  const r = await fetch(`${API_BASE}/truckmate/delivered?${q}`, {
    credentials: 'include', headers: authHeaders(),
  });
  return asJson(r);
}

// Mark a delivered trip handled so it drops out of the unacked list.
export async function ackDelivered(tripNumber, site = TM_SITE) {
  if (!API_BASE) throw new Error('No backend configured.');
  const r = await fetch(`${API_BASE}/truckmate/delivered/ack`, {
    method: 'POST', credentials: 'include', headers: authHeaders(),
    body: JSON.stringify({ site, tripNumber: String(tripNumber) }),
  });
  return asJson(r);
}

// ---- shaping the raw TruckMate rows into something the UI can render ----

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round1 = (n) => Math.round(n * 10) / 10;

// TruckMate status codes → friendly label + a colour bucket. We fall back to
// the row's own statusDesc text (and a neutral colour) for anything unmapped,
// so a code we've never seen still shows sensibly.
const STATUS_MAP = [
  [/^(avail|avbl|new)/i, { label: 'Available', tone: 'idle' }],
  [/^(disp|assigned)/i, { label: 'Dispatched', tone: 'go' }],
  [/^arrship/i, { label: 'At shipper', tone: 'wait' }],
  [/^(depship|intran|enroute)/i, { label: 'In transit', tone: 'go' }],
  [/^arrcons/i, { label: 'At consignee', tone: 'wait' }],
  [/^(delvd|deliv|del$|cmplt|complete)/i, { label: 'Delivered', tone: 'done' }],
  [/^spot/i, { label: 'Spotted', tone: 'wait' }],
  [/^(canc|void)/i, { label: 'Cancelled', tone: 'bad' }],
  [/^hold/i, { label: 'On hold', tone: 'bad' }],
];

export function statusMeta(code, desc) {
  const c = String(code || '');
  for (const [re, meta] of STATUS_MAP) if (re.test(c)) return meta;
  const label = (desc && String(desc).trim())
    ? String(desc).replace(/\b\w/g, (m) => m.toUpperCase())
    : (c || 'Unknown');
  return { label, tone: 'idle' };
}

// Flatten one ingest trip item ({ _id, trip:{…}, freightBills:[…] }) into a
// flat record the board renders. Defensive about shape — older payloads put the
// trip fields at the top level and call the bills "orders".
export function normalizeTrip(item) {
  const t = (item && item.trip) || item || {};
  const billsRaw = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  const bills = (Array.isArray(billsRaw) ? billsRaw : []).map((b) => ({
    billNumber: b.billNumber || b.billNo || b.bill || '',
    billTo: b.billToName || b.billTo || '',
    commodity: b.commodity || '',
    pieces: num(b.pieces),        // boxes (piecesUnits is BOX for floral)
    cube: num(b.cube),            // cubic feet (CBF) — TruckMate "Cbs"
    pallets: num(b.pallets),
    temp: num(b.temperature),     // REQUIRED setpoint (not a live reefer reading)
    tempUnits: b.temperatureUnits || 'F',
    weight: num(b.weight),
    charges: num(b.totalCharges || b.charges),
    from: b.startZoneDescription || b.startZone || '',
    to: b.endZoneDescription || b.endZone || '',
    service: b.serviceLevel || '',
    deliverBy: b.deliverBy || '',
    deliverByEnd: b.deliverByEnd || '',
    pickUpBy: b.pickUpBy || '',
    pickUpByEnd: b.pickUpByEnd || '',
    eta: b.estimatedDeliveryDate || b.deliverBy || '',   // system's estimated delivery
    miles: num(b.distance),                              // loaded miles for this bill/leg
    actualPickup: b.actualPickup || '',
    opCode: b.opCode || '',                              // operation / lane code
    siteId: b.siteId || '',                              // origin terminal/site
    createdTime: b.createdTime || '',
    createdBy: b.createdBy || '',
    pickedUp: !!(b.actualPickup) || b.pickupDone === 'True' || b.pickupDone === true,
    delivered: !!(b.actualDelivery),
    status: b.status || '',
    statusDesc: b.statusDescription || b.longStatusDescription || '',
  }));
  const current = t.currentZoneDesc || t.currentZone || '';
  const temps = bills.map((b) => b.temp).filter((tp) => tp > 0);
  const reqTempMin = temps.length ? Math.min(...temps) : null;
  const reqTempMax = temps.length ? Math.max(...temps) : null;
  const tempUnits = (bills.find((b) => b.tempUnits) || {}).tempUnits || 'F';

  // Live Samsara overlay + the discrepancies between it and TruckMate.
  const live = (item && item._samsara) || null;
  const alerts = [];
  if (live) {
    const nm = (s) => String(s || '').trim().toLowerCase();
    // reefer temp more than 3° off the setpoint (or the required temp) — only on
    // a fresh reading (stale legacy reefers report months-old values)
    if (live.tempF != null && !live.tempStale) {
      const target = live.setpointF != null ? live.setpointF : reqTempMin;
      if (target != null && Math.abs(live.tempF - target) > 3) {
        alerts.push({ kind: 'temp', msg: `Reefer ${live.tempF}°${tempUnits}, target ${target}°${tempUnits} (${live.tempF > target ? '+' : ''}${round1(live.tempF - target)}°)` });
      }
    }
    // driver on the truck (per Samsara) isn't EITHER of the trip's drivers.
    // Teams run two drivers and Samsara shows whichever is active/assigned, so we
    // only flag when the truck's driver matches neither Driver 1 nor Driver 2.
    if (live.samsaraDriver && (live.driver1 || live.driver2)) {
      const s = nm(live.samsaraDriver);
      const d1 = nm(live.driver1); const d2 = nm(live.driver2);
      if (!((d1 && s === d1) || (d2 && s === d2))) {
        alerts.push({ kind: 'driver', msg: `Truck shows ${live.samsaraDriver}, trip has ${live.driver1 || '—'}${live.driver2 ? ` / ${live.driver2}` : ''}` });
      }
    }
    // NOTE: no location-mismatch alert. Samsara streams GPS continuously while
    // TruckMate only updates its zone on a status/geofence event, so a moving
    // truck legitimately shows two different spots — that's timing lag, not a
    // problem. Both locations are still shown in the panel for eyeballing.
  }

  return {
    id: String((item && item._id) || t.tripNumber || ''),
    tripNumber: t.tripNumber || (item && item._id) || '',
    statusCode: t.status || '',
    statusDesc: t.statusDesc || t.statusDescription || '',
    driver: t.driver || '',
    driver2: t.driver2 || '',
    trailer: t.trailer || t.trailer2 || '',
    powerUnit: t.powerUnit || '',
    origin: t.origZoneDesc || '',
    destination: t.destZoneDesc || '',
    current,
    eta: t.eTA || t.expectedDate || '',
    etd: t.eTD || '',
    legCount: num(t.legCount),
    activeLeg: num(t.activeLeg),
    originZone: t.originZone || '',
    opCode: (bills.find((b) => b.opCode) || {}).opCode || '',
    siteId: (bills.find((b) => b.siteId) || {}).siteId || '',
    createdTime: (bills.find((b) => b.createdTime) || {}).createdTime || '',
    createdBy: (bills.find((b) => b.createdBy) || {}).createdBy || '',
    delivered: item && item._event === 'delivered',
    bills,
    billCount: bills.length,
    boxes: bills.reduce((s, b) => s + b.pieces, 0),
    cube: bills.reduce((s, b) => s + b.cube, 0),
    pallets: bills.reduce((s, b) => s + b.pallets, 0),
    weight: bills.reduce((s, b) => s + b.weight, 0),
    charges: bills.reduce((s, b) => s + b.charges, 0),
    // trip miles ≈ the farthest stop (no trip-level distance field); rev/mi from it
    miles: bills.reduce((mx, b) => Math.max(mx, b.miles || 0), 0),
    reqTempMin, reqTempMax, tempUnits,
    live, alerts,
  };
}

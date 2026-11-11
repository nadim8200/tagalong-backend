// ---------------------------------------------------------------
// TruckMate trace numbers vs the broker's rate con. Dispatch types the broker's load number into the bill as the
// Purchase Order (PO) and the shipper's pickup numbers as Pickup#s; the connector reads them per bill. Here they are
// checked against the rate con: the PO must be its load number, each Pickup# must be on it, and any pickup number on the
// rate con that TruckMate doesn't have is listed — so the driver never shows up with a wrong or missing number. Pure.
// ---------------------------------------------------------------
const key = (x) => String(x == null ? '' : x).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
const tripOf = (it) => (it && it.trip) || it || {};

export function traceCheck(item) {
  const bills = ((item && (item.freightBills || item.orders)) || []).filter((b) => b && Array.isArray(b.traceNumbers) && b.traceNumbers.length);
  if (!bills.length) return null;
  const all = bills.flatMap((b) => b.traceNumbers.map((t) => ({ bill: b.billNumber, number: String(t.traceNumber || '').trim(), type: String(t.traceType || ''), what: String(t.description || '') }))).filter((t) => t.number);
  const pos = [...new Set(all.filter((t) => /purchase|^p\.?o\.?$/i.test(t.what) || t.type === 'P').map((t) => t.number))];
  const pickups = [...new Set(all.filter((t) => /pick/i.test(t.what)).map((t) => t.number))];
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || null;
  if (!rc) return { pos, pickups, rateCon: false };
  const rcLoad = key(rc.loadNumber);
  // every number on the rate con: load #, references, each pickup's refs text
  const rcText = [rc.loadNumber, ...(rc.referenceNumbers || []), ...(rc.pickups || []).map((p) => p && p.refs)].filter(Boolean).join(' ');
  const rcNums = new Set((rcText.match(/[A-Z0-9-]{4,}/gi) || []).map(key).filter((x) => /\d/.test(x)));
  const rcPickupNums = [...new Set(((rc.pickups || []).map((p) => p && p.refs).filter(Boolean).join(' ').match(/[A-Z0-9-]{4,}/gi) || []).map(key).filter((x) => /\d/.test(x)))];
  const poMatch = pos.length ? (rcLoad ? pos.some((p) => key(p) === rcLoad || rcNums.has(key(p))) : null) : null;
  const pickupChecks = pickups.map((n) => ({ number: n, onRateCon: rcNums.has(key(n)) }));
  const tmKeys = new Set(all.map((t) => key(t.number)));
  const missing = rcPickupNums.filter((n) => n !== rcLoad && !tmKeys.has(n));
  const problems = [
    pos.length && poMatch === false ? `PO ${pos.join(', ')} isn't the rate con's load # ${rc.loadNumber}` : null,
    !pos.length && rc.loadNumber ? `No PO in TruckMate (rate con load # ${rc.loadNumber})` : null,
    ...pickupChecks.filter((p) => !p.onRateCon).map((p) => `Pickup# ${p.number} isn't on the rate con`),
    missing.length ? `Rate con pickup # ${missing.join(', ')} not in TruckMate` : null,
  ].filter(Boolean);
  return { pos, pickups, rateCon: true, loadNumber: rc.loadNumber || null, poMatch, pickupChecks, missing, problems, ok: problems.length === 0, trip: String(tripOf(item).tripNumber || '') };
}

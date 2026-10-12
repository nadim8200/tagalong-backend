// ---------------------------------------------------------------
// Reefer temperature and brokers / customers — protecting the company from temperature claims.
// A temperature reading or photo always goes to dispatch (and whoever booked the load); dispatch
// decides what the broker sees. Automatically, a broker update shows a LIVE reading only when it
// matches the rate con's temperature (within 3 °F of its range). Otherwise — or with no reading —
// the update says the temperature is being verified, and dispatch gets the reading separately.
// ---------------------------------------------------------------
export const TOLERANCE_F = 3;
const cToF = (c) => Math.round((c * 9) / 5 + 32);

// The required range in °F from rate-con text ("2-8C", "35-38°F", "-10F", "41 F continuous") or a bill's
// temperature. Pure. → { minF, maxF, text } | null
export function parseTempRange(text) {
  const s = String(text == null ? '' : text).replace(/º/g, '°');
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([CF])?\s*(?:-|–|to|\/)\s*(-?\d+(?:\.\d+)?)\s*°?\s*([CF])\b/i)
    || s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([CF])\b/i);
  if (!m) { const n = Number(s.trim()); return s.trim() !== '' && Number.isFinite(n) ? { minF: n, maxF: n, text: `${n}°F` } : null; }
  if (m.length >= 5 && m[3] != null) {
    const unit = (m[4] || m[2] || 'F').toUpperCase();
    const a = Number(m[1]); const b = Number(m[3]);
    const [lo, hi] = unit === 'C' ? [cToF(Math.min(a, b)), cToF(Math.max(a, b))] : [Math.min(a, b), Math.max(a, b)];
    return { minF: lo, maxF: hi, text: `${m[1]}–${m[3]}°${unit}` };
  }
  const unit = (m[2] || 'F').toUpperCase(); const v = Number(m[1]);
  const f = unit === 'C' ? cToF(v) : v;
  return { minF: f, maxF: f, text: `${v}°${unit}` };
}

// What the rate con (else TruckMate's bill) requires for this load. Pure.
export function requiredRange(item) {
  const rc = item && item._ratecon && (item._ratecon.data || item._ratecon);
  const fromRc = rc && (parseTempRange(rc.tempSetting) || parseTempRange((rc.specialInstructions || rc.instructions || []).join(' ').match(/-?\d+(?:\.\d+)?\s*-\s*-?\d+(?:\.\d+)?\s*°?\s*[CF]\b/i)?.[0] || ''));
  if (fromRc) return { ...fromRc, from: 'rate con' };
  const bills = (item && (item.freightBills || item.orders)) || [];
  const b = bills.find((x) => x && x.temperature != null && x.temperature !== '');
  return b ? { ...parseTempRange(String(b.temperature)), from: 'TruckMate' } : null;
}

// May this reading go to the broker? Pure. → { share: bool, why, offBy }
export function brokerMayShare(readingF, range) {
  if (readingF == null) return { share: false, why: 'no reading' };
  if (!range) return { share: false, why: 'no required temperature to check it against' };
  const offBy = readingF < range.minF ? range.minF - readingF : readingF > range.maxF ? readingF - range.maxF : 0;
  return offBy <= TOLERANCE_F ? { share: true, why: 'within the rate con range', offBy } : { share: false, why: `${Math.round(offBy)}°F outside the rate con range ${range.text}`, offBy };
}
export const VERIFYING = 'Verifying temperature with dispatch';

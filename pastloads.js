// ---------------------------------------------------------------
// Past loads: trips that already finished (delivered / closed / left the board) — kept 60 days with the trip
// (rundown.js `taRundowns:site`). Jarvis searches them when the load isn't on the board any more: "the truck to
// Direct Flowers that left Miami Tuesday — when did it leave and when did it deliver?"
// ---------------------------------------------------------------
import { leftAtMs, outboundDate, outboundDays, outboundLabel, hubSaid, deliveredWhen, nameScore } from './voice.js';
import { fmtLocalShort } from './localtime.js';

const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const cityOf = (s) => String(s || '').replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim();
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const fits = (a, b) => Math.max(nameScore(a || '', b || ''), nameScore(b || '', a || '')) >= 0.75;

// one finished trip, said plainly: truck, trailer, which hub it left and when, each customer's stop and when it
// was delivered. `customer` → only that customer's stops. Pure.
export function pastView(rec, { customer = null } = {}) {
  const it = rec && rec.rec && rec.rec.item; if (!it) return null;
  const t = tripOf(it);
  const groups = new Map();
  for (const b of billsOf(it)) {
    const name = String(b.billToName || '').replace(/\s*\*$/, '').trim(); const city = cityOf(b.endZoneDescription);
    if (customer && !fits(customer, name)) continue;
    const k = `${name}|${city}`;
    const g = groups.get(k) || { customer: name, city, boxes: 0, delivered: [] };
    g.boxes += Number(b.pieces) || 0;
    if (b.actualDelivery) g.delivered.push(b.actualDelivery);
    groups.set(k, g);
  }
  if (customer && !groups.size) return null;
  const left = leftAtMs(it); const od = outboundDate(it);
  return {
    trip: tripNo(it), truck: String(t.powerUnit || '').trim() || null, trailer: String(t.trailer || '').trim() || null,
    left_from: hubSaid(it) || null, left_at: left ? fmtLocalShort(left, 'FL') : null, outbound: outboundLabel(od),
    finished: rec.finishedAt ? fmtLocalShort(Date.parse(rec.finishedAt), 'FL') : null,
    stops: [...groups.values()].map((g) => ({ customer: g.customer, city: g.city, boxes: g.boxes || null, delivered_at: g.delivered.length ? deliveredWhen(g.delivered) : null })),
    _outbound: od, _deliveredDays: [...groups.values()].flatMap((g) => g.delivered.map((x) => String(x).slice(0, 10))),
  };
}

// search the finished trips. Pure.
export function searchPast(store = {}, { trip = null, truck = null, bill = null, customer = null, outboundDay = null, deliveredDay = null, now = Date.now() } = {}) {
  const n = trip ? String(trip).replace(/\D/g, '') : null;
  const u = truck ? String(truck).replace(/^0+/, '').toUpperCase() : null;
  const bl = bill ? String(bill).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const ob = outboundDay ? outboundDays(outboundDay, now) : null;
  const dd = deliveredDay ? outboundDays(deliveredDay, now) : null;
  const out = [];
  for (const rec of Object.values(store || {})) {
    const it = rec && rec.rec && rec.rec.item; if (!it) continue;
    if (n && tripNo(it) !== n) continue;
    if (u && String(tripOf(it).powerUnit || '').replace(/^0+/, '').toUpperCase() !== u) continue;
    if (bl && !billsOf(it).some((b) => String(b.billNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === bl)) continue;
    const v = pastView(rec, { customer });
    if (!v) continue;
    if (ob && ob.length && !ob.includes(v._outbound)) continue;
    if (dd && dd.length && !v._deliveredDays.some((d) => dd.includes(d))) continue;
    out.push(v);
  }
  return out.sort((a, b) => String(b._outbound || '').localeCompare(String(a._outbound || ''))).slice(0, 6).map(({ _outbound, _deliveredDays, ...v }) => v);
}

export function initPastLoads({ db, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  async function search(q = {}, site = 'florida-beauty') {
    if (!enabled) return [];
    const store = (await db.get(`taRundowns:${site}`, {})) || {};
    return searchPast(store, { ...q, now: now() });
  }
  return { search, ymd };
}

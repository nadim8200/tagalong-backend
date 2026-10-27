// ---------------------------------------------------------------
// Past loads: trips that already finished (delivered / closed / left the board) — kept 60 days with the trip
// (rundown.js `taRundowns:site`). Jarvis searches them when the load isn't on the board any more: "the truck to
// Direct Flowers that left Miami Tuesday — when did it leave and when did it deliver?"
// ---------------------------------------------------------------
import { leftAtMs, outboundDate, outboundDays, outboundLabel, hubSaid, deliveredWhen, nameScore } from './voice.js';
import { fmtLocalShort } from './localtime.js';
import { tripTimes } from './triptimes.js';

const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const cityOf = (s) => String(s || '').replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim();
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const fits = (a, b) => Math.max(nameScore(a || '', b || ''), nameScore(b || '', a || '')) >= 0.75;

// one finished trip, said plainly: truck, trailer, which hub it left and when, each customer's stop and when it
// was delivered. `customer` → only that customer's stops. Pure.
export function pastView(rec, { customer = null } = {}) {
  const it0 = rec && rec.rec && rec.rec.item; if (!it0) return null;
  // the saved record has the raw trip, not the board's status history — rebuild it (when it left) like the board does
  let it = it0;
  if (!(it0._times && (it0._times.statusHistory || []).length)) { try { it = { ...it0, _times: tripTimes(rec.rec) }; } catch { it = it0; } }
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
    left_from: hubSaid(it) || null, departed_at: left ? fmtLocalShort(left, 'FL') : null, outbound: outboundLabel(od),
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
  return out.sort((a, b) => String(b._outbound || '').localeCompare(String(a._outbound || ''))).slice(0, 12).map(({ _outbound, _deliveredDays, ...v }) => v);
}

export function initPastLoads({ db, etaReport = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  async function search(q = {}, site = 'florida-beauty') {
    if (!enabled) return [];
    const store = (await db.get(`taRundowns:${site}`, {})) || {};
    const found = searchPast(store, { ...q, now: now() });
    // each stop: the ETA we gave (first / last) and when the truck actually got there
    if (etaReport && etaReport.etaVsActual) {
      for (const v of found) {
        const rec = store[v.trip]; const it = rec && rec.rec && rec.rec.item;
        const rows = it ? await etaReport.etaVsActual(it, site).catch(() => []) : []; // eslint-disable-line no-await-in-loop
        for (const st of v.stops) {
          const r = rows.find((x) => String(x.stop || '').toUpperCase().startsWith(String(st.city || '').toUpperCase()) && (!x.customer || fits(st.customer, x.customer) || x.customer.includes(st.customer)));
          if (r) Object.assign(st, Object.fromEntries(Object.entries({ eta_we_gave_first: r.eta_we_gave_first, eta_we_gave_last: r.eta_we_gave_last, artis_eta: r.artis_eta, actual_arrival: r.actual_arrival, off_by_last_eta: r.off_by_last_eta, time_at_stop: r.time_at_stop }).filter(([, x]) => x)));
        }
      }
    }
    return found;
  }
  // a trip on the board or finished: the ETAs we gave vs when the truck got there, per stop
  async function etaVsActual({ trip, board = [] }, site = 'florida-beauty') {
    if (!enabled || !etaReport) return null;
    const n = String(trip || '').replace(/\D/g, '');
    let it = (board || []).find((x) => tripNo(x) === n);
    if (!it) { const rec = ((await db.get(`taRundowns:${site}`, {})) || {})[n]; it = rec && rec.rec && rec.rec.item; }
    return it ? { trip: n, truck: String(tripOf(it).powerUnit || '') || null, stops: await etaReport.etaVsActual(it, site) } : null;
  }
  return { search, etaVsActual, ymd };
}

// ---------------------------------------------------------------
// Florida Beauty's client list (flowers + produce customers) — from TruckMate's client report.
// Used to RECOGNIZE people: who is calling / emailing (by phone or email), what a caller's
// business is really called ("D B E C Wholesale" → D.B.E.C. WHOLESALE, Greensburg PA), and which
// loads on the board are theirs (client ID on the bill, else name / phone).
// Contact details are system-only: Jarvis never reads a client's phone / email out to anyone.
// ---------------------------------------------------------------
import { readFileSync } from 'fs';

const p10 = (x) => String(x || '').replace(/\D+/g, '').slice(-10);
const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];

export function loadClientFile(path = new URL('./clients-list.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

// Indexes over a client list. score: (said, name) → 0..1 (voice.js nameScore). Pure.
export function clientIndex(list = [], { score = () => 0 } = {}) {
  const byPhone = new Map(); const byEmail = new Map(); const byId = new Map();
  for (const c of list) {
    if (!c || !c.id) continue;
    byId.set(String(c.id), c);
    for (const p of [c.phone, c.fax, ...(c.phones || [])].map(p10).filter((x) => x.length === 10)) if (!byPhone.has(p)) byPhone.set(p, c);
    for (const e of c.emails || []) if (!byEmail.has(e)) byEmail.set(String(e).toLowerCase(), c);
  }
  const town = (x) => String(x || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
  return {
    size: list.length,
    byId: (id) => byId.get(String(id || '').padStart(5, '0')) || byId.get(String(id || '')) || null,
    byPhone: (p) => byPhone.get(p10(p)) || null,
    byEmail: (e) => byEmail.get(String(e || '').toLowerCase().trim()) || null,
    // the caller's business by name (and town, when they said one) — best first; active clients first
    byName: (said, { city = null, min = 0.75, max = 5 } = {}) => {
      if (!said) return [];
      const t = town(city).split(' ')[0];
      return list.map((c) => ({ c, s: score(said, c.name) + (t && town(c.city).startsWith(t) ? 0.2 : 0) - (c.inactive ? 0.05 : 0) }))
        .filter((x) => x.s >= min).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.c);
    },
  };
}

// Is this bill the client's? Client ID on TruckMate's bill-to / caller / consignee record, else the
// consignee / bill-to name, else the consignee phone. Pure.
export function billIsClient(b, c, score = () => 0) {
  if (!b || !c) return false;
  const recs = [b.billToCustomer, b.caller, b.consignee].filter((r) => r && typeof r === 'object');
  const ids = recs.flatMap((r) => [r.clientId, r.clientID, r.customerId, r.code, r.id]).filter(Boolean).map((x) => String(x).trim());
  if (ids.some((x) => x === c.id || x.padStart(5, '0') === c.id)) return true;
  const names = [b.billToName, ...recs.map((r) => r.name || r.clientName || r.customerName)].filter(Boolean);
  if (names.some((n) => score(c.name, n) >= 0.9 || score(n, c.name) >= 0.9)) return true;
  const phones = recs.flatMap((r) => Object.entries(r).filter(([k, v]) => /(phone|tel)/i.test(k) && v && typeof v !== 'object').map(([, v]) => p10(v)));
  return !!(c.phone && phones.includes(p10(c.phone)));
}

// The board loads that are the client's (bills or trip-sheet stops). Pure.
export function clientLoads(items = [], c, score = () => 0) {
  if (!c) return [];
  return items.filter((it) => billsOf(it).some((b) => billIsClient(b, c, score))
    || ((it._manifest && it._manifest.stops) || []).some((st) => /DELIVER/i.test(st.action || '') && score(c.name, st.customer) >= 0.9));
}
// The name to look a client's stops up by on one of their loads (the bill's own consignee / bill-to). Pure.
export function nameOnLoad(it, c, score = () => 0) {
  const b = billsOf(it).find((x) => billIsClient(x, c, score));
  if (!b) return c.name;
  const cons = b.consignee && (b.consignee.name || b.consignee.clientName);
  return cons || b.billToName || c.name;
}

export function initClients({ db = null, score }) {
  let list = loadClientFile();
  let idx = clientIndex(list, { score });
  // an admin re-import (later) can replace the file's list
  async function refresh() {
    if (!db || !db.enabled) return;
    const saved = await db.get('taClients:florida-beauty', null);
    if (Array.isArray(saved) && saved.length) { list = saved; idx = clientIndex(list, { score }); }
  }
  refresh().catch(() => {});
  return {
    size: () => list.length,
    byId: (x) => idx.byId(x), byPhone: (x) => idx.byPhone(x), byEmail: (x) => idx.byEmail(x),
    byName: (s, o) => idx.byName(s, o),
    loads: (items, c) => clientLoads(items, c, score),
    nameOnLoad: (it, c) => nameOnLoad(it, c, score),
  };
}

// ---------------------------------------------------------------
// Our clients near a place (Nov 21, 2026 — "what customers we have around Mickleton, NJ" got only the loads going there).
// From Florida Beauty's client list: each client's geofence point when it has one, else its ZIP (looked up once, kept in the
// mile calculator's cache). Only the place's state and its neighbors are checked, so a question costs a few new ZIP lookups at
// most and none once the area has been asked about. Distances are straight-line ("about").
// ---------------------------------------------------------------
import { haversineMi } from './watchtower.js';

export const NEIGHBORS = {
  AL: ['FL', 'GA', 'MS', 'TN'], AZ: ['CA', 'NM', 'NV', 'UT'], AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'], CA: ['AZ', 'NV', 'OR'], CO: ['KS', 'NE', 'NM', 'OK', 'UT', 'WY'],
  CT: ['MA', 'NY', 'RI'], DE: ['MD', 'NJ', 'PA'], DC: ['MD', 'VA'], FL: ['AL', 'GA'], GA: ['AL', 'FL', 'NC', 'SC', 'TN'], ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'],
  IL: ['IA', 'IN', 'KY', 'MO', 'WI'], IN: ['IL', 'KY', 'MI', 'OH'], IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'], KS: ['CO', 'MO', 'NE', 'OK'], KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'],
  LA: ['AR', 'MS', 'TX'], ME: ['NH'], MD: ['DC', 'DE', 'PA', 'VA', 'WV'], MA: ['CT', 'NH', 'NY', 'RI', 'VT'], MI: ['IN', 'OH', 'WI'], MN: ['IA', 'ND', 'SD', 'WI'],
  MS: ['AL', 'AR', 'LA', 'TN'], MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'], MT: ['ID', 'ND', 'SD', 'WY'], NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'], NV: ['AZ', 'CA', 'ID', 'OR', 'UT'],
  NH: ['MA', 'ME', 'VT'], NJ: ['DE', 'NY', 'PA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'], NY: ['CT', 'MA', 'NJ', 'PA', 'VT'], NC: ['GA', 'SC', 'TN', 'VA'], ND: ['MN', 'MT', 'SD'],
  OH: ['IN', 'KY', 'MI', 'PA', 'WV'], OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'], OR: ['CA', 'ID', 'NV', 'WA'], PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'], RI: ['CT', 'MA'],
  SC: ['GA', 'NC'], SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'], TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'], TX: ['AR', 'LA', 'NM', 'OK'], UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'],
  VT: ['MA', 'NH', 'NY'], VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'], WA: ['ID', 'OR'], WV: ['KY', 'MD', 'OH', 'PA', 'VA'], WI: ['IA', 'IL', 'MI', 'MN'], WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};
const STATES = new Set(Object.keys(NEIGHBORS));
// the state in a place or a geocoder's formatted address ("Mickleton, NJ 08056, USA" → NJ). Pure.
export function stateOf(...texts) {
  for (const t of texts) {
    const m = String(t || '').toUpperCase().match(/(?:,|\s)\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,\s*USA)?\s*$/) || String(t || '').toUpperCase().match(/,\s*([A-Z]{2})\b/);
    if (m && STATES.has(m[1])) return m[1];
  }
  return null;
}

// → { found, place, radiusMiles, clients: [{ id, name, address, city, state, zip, miles, located, lastDelivery }], checked, unlocated }
export async function clientsNear({ place, radiusMiles = 30, list = [], fences = {}, locate, max = 25, maxNewLookups = 150, concurrency = 8 }) {
  const where = String(place || '').trim();
  if (!where) return { found: false, note: 'Which city, ZIP or address?' };
  const p = await locate(where).catch(() => null);
  if (!p || !Number.isFinite(p.lat)) return { found: false, note: `Couldn't find "${where}" on the map — try the city and state, or a ZIP.` };
  const st = stateOf(where, p.formatted);
  const area = st ? new Set([st, ...(NEIGHBORS[st] || [])]) : null;
  const pool = list.filter((c) => c && !c.inactive && (!area || area.has(String(c.state || '').toUpperCase())));
  const pts = new Map(); let fresh = 0; let unlocated = 0;
  const queue = [...pool];
  const work = async () => {
    while (queue.length) {
      const c = queue.shift();
      const f = fences[String(c.id || '').padStart(5, '0')];
      if (f && Number.isFinite(f.lat)) { pts.set(c, { lat: f.lat, lng: f.lng, by: 'geofence' }); continue; }
      const zip = String(c.zip || '').slice(0, 5);
      if (!/^\d{5}$/.test(zip)) { unlocated += 1; continue; }
      if (fresh >= maxNewLookups) { unlocated += 1; continue; }
      fresh += 1;   // counted before the lookup: the cache answers repeats for free, so the cap only ever under-counts
      const g = await locate(`${zip}, ${c.state || ''}`).catch(() => null); // eslint-disable-line no-await-in-loop
      if (g && Number.isFinite(g.lat)) pts.set(c, { lat: g.lat, lng: g.lng, by: 'zip' }); else unlocated += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  const near = [...pts].map(([c, q]) => ({ c, q, mi: haversineMi(p.lat, p.lng, q.lat, q.lng) })).filter((x) => x.mi <= radiusMiles).sort((a, b) => a.mi - b.mi).slice(0, max);
  return {
    found: near.length > 0, place: p.formatted || where, radiusMiles,
    clients: near.map(({ c, q, mi }) => ({ id: c.id, name: c.name, address: c.address || null, city: c.city || null, state: c.state || null, zip: c.zip || null,
      miles: Math.round(mi * 10) / 10, located: q.by === 'geofence' ? 'geofence' : 'ZIP area', lastDelivery: c.lastDelivery || null })),
    checked: pool.length, unlocated,
    note: 'Straight-line miles ("about"); ZIP-located clients are placed at their ZIP area, not their door.',
  };
}

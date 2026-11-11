// ---------------------------------------------------------------
// Customer delivery instructions for Jarvis: the Notes from each customer's TruckMate profile (read by the reefer agent
// and saved on our customer profile). Any employee may ask for them by any channel (Ask Jarvis, email, text, call), and
// Jarvis can text them — to the employee who asked, or to a load's driver. Pure helpers.
// ---------------------------------------------------------------
import { normName } from './profiles.js';

const S = (x) => String(x == null ? '' : x).trim();
// where that profile's customer is: TruckMate's address, else its first saved location
const placeOf = (p) => { const l = (p.locations || [])[0]; return S(p.truckmate && p.truckmate.address) || (l && typeof l === 'object' ? [l.address, l.city, l.state].map(S).filter(Boolean).join(', ') : S(l)) || null; };

// The instructions for a customer (by name) and / or a load's stops. → [{ customer, code, place, instructions, readAt }]
export function instructionsFor({ profiles = {}, item = null, customer = '' } = {}) {
  const n = normName(customer);
  // every word they said is in the name ("PFG Virginia" → PFG THE VIRGINIA FOOD SERVICE GROUP)
  const like = (name) => { const m = normName(name); if (!n) return true; if (!m) return false; const w = new Set(m.split(' ')); return m === n || m.includes(n) || n.split(' ').every((x) => w.has(x)); };
  const out = new Map();
  for (const c of (item && item._customerNotes) || []) {
    if (like(c.name)) out.set(c.code, { customer: c.name, code: c.code, place: null, instructions: c.notes, readAt: c.readAt });
  }
  if (n && !out.size) {
    for (const p of Object.values(profiles || {})) {
      if (p.type !== 'customer' || !p.truckmate) continue;
      if (![p.name, p.truckmate.name, ...(p.aliases || [])].some((x) => normName(x) === n) && !like(p.name)) continue;
      out.set(p.truckmate.code || p.id, { customer: p.name, code: p.truckmate.code || null, place: placeOf(p), instructions: p.truckmate.notes || null, readAt: p.truckmate.syncedAt || null });
      if (out.size >= 5) break;
    }
    // asked about a load's stop: another location of the same customer is not that stop's instructions
    if (item && out.size > 1) return [];
  }
  return [...out.values()];
}

// Asked by customer name only and that customer has several locations (MOBI'S): don't guess which one — ask for the load
// (trailer / trip / truck and outbound day) or the city first. → null, or what to say. Pure.
export function whichLocation(list, item) {
  if (item || !list || new Set(list.map((c) => c.code || c.customer)).size < 2) return null;
  return {
    several: true, locations: list.map((c) => ({ customer: c.customer, code: c.code, place: c.place })),
    note: `${list.length} locations match. Ask which load it's for (trailer, trip or truck number, and the outbound day) or the city, then look again with it — don't read or text any of them until it's clear.`,
  };
}

// The load an employee or driver means, by trip / trailer / truck — and the outbound day when the trailer or truck has
// more than one load on the board. items: the board. Pure-ish (uses voice's findLoad). → item | null
export function loadFor(items, { trip, trailer, truck, outboundDay } = {}, findLoad) {
  const day = String(outboundDay || '').trim();
  const pool = day ? (items || []).filter((it) => !it._tb || !it._tb.date || it._tb.date === day) : (items || []);
  const hit = (trip || trailer || truck) ? findLoad(pool, { trip, trailer, truck }) : null;
  return hit ? hit.item : null;
}

// One text message with the instructions (several customers in one text, kept short). Pure.
export function instructionsSms(list, { trip = null } = {}) {
  const parts = (list || []).filter((c) => S(c.instructions)).map((c) => `${S(c.customer).toUpperCase()}${c.place ? ` (${c.place})` : ''}: ${S(c.instructions).replace(/\s*\n\s*/g, ' / ')}`);
  if (!parts.length) return null;
  const head = `Delivery instructions${trip ? ` — trip ${trip}` : ''}:`;
  return `${head}\n${parts.join('\n')}`.slice(0, 1200);
}

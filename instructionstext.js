// ---------------------------------------------------------------
// Customer delivery instructions for Jarvis: the Notes from each customer's TruckMate profile (read by the reefer agent
// and saved on our customer profile). Any employee may ask for them by any channel (Ask Jarvis, email, text, call), and
// Jarvis can text them — to the employee who asked, or to a load's driver. Pure helpers.
// ---------------------------------------------------------------
import { normName } from './profiles.js';

const S = (x) => String(x == null ? '' : x).trim();

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
      out.set(p.truckmate.code || p.id, { customer: p.name, code: p.truckmate.code || null, place: (p.locations || [])[0] || null, instructions: p.truckmate.notes || null, readAt: p.truckmate.syncedAt || null });
      if (out.size >= 5) break;
    }
  }
  return [...out.values()];
}

// One text message with the instructions (several customers in one text, kept short). Pure.
export function instructionsSms(list, { trip = null } = {}) {
  const parts = (list || []).filter((c) => S(c.instructions)).map((c) => `${S(c.customer).toUpperCase()}${c.place ? ` (${c.place})` : ''}: ${S(c.instructions).replace(/\s*\n\s*/g, ' / ')}`);
  if (!parts.length) return null;
  const head = `Delivery instructions${trip ? ` — trip ${trip}` : ''}:`;
  return `${head}\n${parts.join('\n')}`.slice(0, 1200);
}

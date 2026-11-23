// ---------------------------------------------------------------
// Mass text (Nov 22): one dispatcher's message to many drivers at once, each as their own text from the company number
// (their reply comes back to their own conversation in Phone & messages).
//   audience 'all'    — every driver we have a cell for (drivers on loads + every driver profile)
//   audience 'active' — the drivers on a load on the board now
//   audience 'area'   — the trucks a dispatcher drew a circle / shape around on the live map ({ unit, driver } each):
//                       the drivers on that truck's load, else the driver profile on that truck, else by the map's driver name
// Never: a cell that replied STOP, a driver without a text agreement on file, a number twice. Pure.
// → { recipients: [{ phone, name, truck, trip }], skipped: [{ name, truck, why }] }
// ---------------------------------------------------------------
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const unitKey = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameKey = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
export const MASS_MAX = 400;

export function massRecipients({ audience, units = [], loads = [], roster = [], consent = {}, optOut = {} }) {
  const found = [];   // { phone, name, truck, trip } in order, phone may be missing
  const put = (d, l) => found.push({ phone: last10(d.phone), name: d.name || null, truck: (l && l.truck) || d.truck || null, trip: (l && l.trip) || null });
  const rosterPhones = (d) => [d.phone, ...((d.phones || []).map((x) => (x && x.number) || x))].map(last10).filter((x) => x.length === 10);
  if (audience === 'active' || audience === 'all') for (const l of loads) for (const d of l.drivers || []) put(d, l);
  if (audience === 'all') for (const d of roster) { const ph = rosterPhones(d); put({ ...d, phone: ph[0] || null }, null); }
  if (audience === 'area') {
    for (const u of units) {
      const k = unitKey(u && u.unit);
      const onLoad = k ? loads.filter((l) => unitKey(l.truck) === k && (l.drivers || []).length) : [];
      if (onLoad.length) { onLoad.forEach((l) => l.drivers.forEach((d) => put(d, l))); continue; }
      const prof = (k && roster.find((d) => unitKey(d.truck) === k)) || (u && u.driver && roster.find((d) => nameKey(d.name) && nameKey(d.name) === nameKey(u.driver)));
      if (prof) { put({ ...prof, phone: rosterPhones(prof)[0] || null, truck: (u && u.unit) || prof.truck }, null); continue; }
      found.push({ phone: '', name: (u && u.driver) || null, truck: (u && u.unit) || null, trip: null });
    }
  }
  const recipients = []; const skipped = []; const seen = new Set();
  for (const r of found) {
    if (r.phone && seen.has(r.phone)) continue;
    if (r.phone.length !== 10) { if (audience === 'area' || r.trip) skipped.push({ name: r.name, truck: r.truck, why: 'no cell number on file' }); continue; }
    seen.add(r.phone);
    if (optOut[r.phone]) skipped.push({ name: r.name, truck: r.truck, why: 'replied STOP' });
    else if (!consent[r.phone]) skipped.push({ name: r.name, truck: r.truck, why: 'no text agreement on file' });
    else recipients.push(r);
  }
  return { recipients: recipients.slice(0, MASS_MAX), skipped, capped: recipients.length > MASS_MAX };
}

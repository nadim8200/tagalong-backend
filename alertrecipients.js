// ---------------------------------------------------------------
// Who gets each alert email — edited in the console (Employees → Alert emails), never fixed in Render.
// Each alert has a list of entries; an entry is an email address, an employee's name (their email on
// the Employees list) or an email group (Employees → Email groups, e.g. "Dispatch").
// ---------------------------------------------------------------
import { findStaff } from './directory.js';

const KEY = 'taAlertRecipients';
export const ALERTS = [
  { key: 'artis_left_short', label: 'Truck left — boxes not received from the shipper', when: 'A truck departed while ARTIS shows boxes for its customers never received at our terminal (once per trip): verify if rejected or contact the shipper.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'transfer', label: 'Truck transfer', when: 'A trip sheet plans a truck change (e.g. 734 → 4504): planned, every 2 h while apart (rolling or stopped, distance), when the trucks are together, and the driver\'s answer on whether the transfer is done.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'reefer_temp', label: 'Reefer temperature (internal)', when: 'Every reefer temperature photo from a driver, and any live reading held back from a broker because it is off the rate con range. The broker never gets these automatically — dispatch decides.', defaults: ['Dispatch', 'Luis Jimenez', 'Gustavo'] },
  { key: 'artis_missing_call', label: 'Customer asked about a load with boxes not received', when: 'A customer called about their delivery and ARTIS shows boxes for them never received at our terminal (the customer is only told what is loaded).', defaults: ['Frank Ducassi', 'Sebastian Manotas', 'Ronen', 'Nadim'] },
];
const isEmail = (x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x || '').trim());

// Clean what the console sent: known alerts only, trimmed, no duplicates, ≤ 30 entries each. Pure.
export function cleanRecipients(input = {}) {
  const out = {};
  for (const a of ALERTS) {
    const list = Array.isArray(input[a.key]) ? input[a.key] : null;
    if (!list) continue;
    out[a.key] = [...new Set(list.map((x) => String(x || '').trim().slice(0, 120)).filter(Boolean).map((x) => (isEmail(x) ? x.toLowerCase() : x)))].slice(0, 30);
  }
  return out;
}

// Entries → email addresses (+ what couldn't be resolved). Pure-ish: directory data passed in.
export function resolveEntries(entries = [], { people = [], groupEmail = () => null } = {}) {
  const emails = []; const unresolved = [];
  for (const e of entries) {
    if (isEmail(e)) { emails.push(e.toLowerCase()); continue; }
    const g = groupEmail(e);
    if (g) { emails.push(String(g).toLowerCase()); continue; }
    const p = findStaff(people, e, 1)[0];
    if (p && p.email) { emails.push(String(p.email).toLowerCase()); continue; }
    if (/^nadim$/i.test(e)) { emails.push('ntellez@floridabeauty.us'); continue; }
    unresolved.push(e);
  }
  return { emails: [...new Set(emails)], unresolved };
}

export function initAlertRecipients(app, { requireAuth, requireAdmin = null, db, directory }) {
  const enabled = !!(db && db.enabled);
  async function lists() {
    const saved = enabled ? ((await db.get(KEY, {})) || {}) : {};
    return Object.fromEntries(ALERTS.map((a) => [a.key, Array.isArray(saved[a.key]) ? saved[a.key] : a.defaults]));
  }
  async function dirData() {
    const d = directory && directory.load ? await directory.load().catch(() => ({ people: [], groups: [] })) : { people: [], groups: [] };
    const groups = (d.groups || []).filter((g) => g.active !== false && g.email);
    const fold = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const groupEmail = (name) => { const n = fold(name); const g = groups.find((x) => fold(x.name) === n || (x.aliases || []).some((al) => fold(al) === n)); return g ? g.email : null; };
    return { people: d.people || [], groups, groupEmail };
  }
  // the email addresses for one alert right now
  async function resolve(key) {
    const l = (await lists())[key] || [];
    const r = resolveEntries(l, await dirData());
    if (r.unresolved.length) console.warn(`[alerts] ${key}: no email for`, r.unresolved.join(', '));
    return r.emails;
  }

  app.get('/truckmate/alert-recipients', requireAdmin || requireAuth, async (req, res) => {
    const l = await lists(); const d = await dirData();
    res.json({
      alerts: ALERTS.map((a) => { const r = resolveEntries(l[a.key], d); return { key: a.key, label: a.label, when: a.when, entries: l[a.key], emails: r.emails, unresolved: r.unresolved }; }),
      groups: d.groups.map((g) => g.name), people: d.people.filter((p) => p.email).map((p) => p.name),
    });
  });
  app.put('/truckmate/alert-recipients', requireAdmin || requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const clean = cleanRecipients((req.body && req.body.alerts) || {});
    await db.update(KEY, (cur) => ({ ...(cur || {}), ...clean }), {});
    res.json({ ok: true, saved: clean });
  });
  return { resolve, lists };
}

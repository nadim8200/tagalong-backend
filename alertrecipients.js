// ---------------------------------------------------------------
// Who gets each alert email — edited in the console (Employees → Alert emails), never fixed in Render.
// Each alert has a list of entries; an entry is an email address, an employee's name (their email on
// the Employees list) or an email group (Employees → Email groups, e.g. "Dispatch").
// ---------------------------------------------------------------
import { findStaff } from './directory.js';

const KEY = 'taAlertRecipients';
const TEXT_KEY = 'taAlertTexts';   // who gets a TEXT for alerts that send one (phone numbers or employees)
export const ALERTS = [
  { key: 'driver_paperwork', label: 'Paperwork from a driver', when: 'A driver sends paperwork from the driver page (POD, BOL, lumper receipt, receipts): what it is, the freight bill number and box count, and the load\'s information, with the files.', defaults: ['POD Accounting'] },
  { key: 'stop_box_mismatch', label: 'Box count mismatch at a stop (driver app)', when: 'On an LTL load a driver marks a stop done with a box count different from the trip sheet: how many missing or extra. Meant for Customer Service (CustomerService@) and dispatch once checked.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'stop_pod', label: 'Signed paperwork from a stop (driver app)', when: 'On an LTL load the driver scans the paperwork the customer signed when marking a stop done: the PDF attached. Meant for Customer Service (CustomerService@), cc Saray, once checked.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'stop_issue', label: 'Issue at a stop (driver app)', when: 'A driver reports an issue at a stop on an LTL load, with photos. Meant for Customer Service and dispatch once checked.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'trip_completed', label: 'Trip completed by the driver (driver app)', when: 'The driver completes an LTL load at the last stop: every stop with time, boxes against the trip sheet, issues, and the signed paperwork attached. Meant for Customer Service, cc Saray, once checked.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'trailer_drop', label: 'Driver dropped a trailer at the yard', when: 'On a load dispatch released to a yard (free or paid release), the driver taps "I dropped the trailer" in the driver app: the yard, the trailer dropped, and the trailer they picked up.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'load_report', label: 'Load report when a load finishes', when: 'A load is delivered or closed, LTL or broker: the whole report of the load with the rate con, the driver\'s paperwork and box counts, the emails, calls and texts, and the alerts.', defaults: ['outbound@floridabeauty.us', 'POD Accounting'] },
  { key: 'ratecon_inbound', label: 'New rate con to enter', when: 'Gus sends a rate con to Jarvis: forwarded right away with his instructions, so the load can be entered in the system.', defaults: ['inbound-dispatch@floridabeauty.us'] },
  { key: 'ratecon_accounting', label: 'Rate con for Accounting (and revised rate cons, TONU)', when: 'A rate con from Gus shows up in TruckMate with a trip and a truck: the load information and the rate con. A revised rate con or a TONU goes right away with what changed.', defaults: ['POD Accounting', 'Rafael Romero'] },
  { key: 'artis_left_short', label: 'Truck left — boxes not received from the shipper', when: 'A truck departed while ARTIS shows boxes for its customers never received at our terminal (once per trip): verify if rejected or contact the shipper.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'transfer', label: 'Truck transfer', when: 'A trip sheet plans a truck change (e.g. 734 → 4504): planned, every 2 h while apart (rolling or stopped, distance), when the trucks are together, and the driver\'s answer on whether the transfer is done.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'reefer_temp', label: 'Reefer temperature (internal)', when: 'Every reefer temperature photo from a driver, and any live reading held back from a broker because it is off the rate con range. The broker never gets these automatically — dispatch decides.', defaults: ['Dispatch', 'Luis Jimenez', 'Gustavo'] },
  { key: 'door_temp', label: 'Trailer loaded off temperature', when: 'ARTIS records a trailer loaded far from its set temperature at the dock: the door check, the temperatures and the dock photos.', defaults: ['warehouse@floridabeauty.us', 'outbound@floridabeauty.us'] },
  { key: 'team_stopped', label: 'Team truck stopped', when: 'A team truck has been stopped 2 hours 15 minutes with a driver who can still drive, away from its stops and the Miami yard. One email at 2 hours 15 minutes, one more at 3 hours, none once someone takes ownership or authorizes the stop, and one when that truck is confirmed rolling again.', defaults: ['strujillo@floridabeauty.us', 'outbound@floridabeauty.us', 'ronen@floridabeauty.us', 'ntellez@floridabeauty.us'] },
  { key: 'waiting_time', label: 'Waiting time', when: 'On a broker load, a truck at a shipper or receiver reaches 3 hours past its appointment (or past arrival if it came late), and again with the total when it leaves.', defaults: ['strujillo@floridabeauty.us', 'outbound@floridabeauty.us', 'inbound-dispatch@floridabeauty.us', 'ntellez@floridabeauty.us'] },
  { key: 'broker_late', label: 'Broker load will miss the delivery time', when: 'Staff asked Jarvis to follow up on a broker load, the delivery time was confirmed, and the ETA is over an hour past it. The person who asked gets it too.', defaults: ['strujillo@floridabeauty.us', 'outbound@floridabeauty.us', 'ronen@floridabeauty.us', 'ntellez@floridabeauty.us'] },
  { key: 'delivery_confirm', label: 'Delivery confirmation (broker follow-up)', when: 'Jarvis asks staff for a broker load\'s delivery date and time, and the time is confirmed. These people get a copy of the request and of the confirmation, next to the person who asked.', defaults: ['inbound-dispatch@floridabeauty.us'] },
  { key: 'breakdown_report', label: 'Breakdown reported from the stopped email', when: 'Someone pressed Report breakdown on a team truck stopped email and wrote the reason. Starts the email chain for dispatch.', defaults: ['Dispatch', 'strujillo@floridabeauty.us', 'outbound@floridabeauty.us', 'ronen@floridabeauty.us', 'ntellez@floridabeauty.us'] },
  { key: 'tripsheet_check', label: 'Trip sheets checked against ARTIS (nightly)', when: 'Once a night per hub (Miami, then Ventura) after the trip sheets are read: what the AI read off the scanned trip sheets vs ARTIS\'s Truck Builder — box counts, stops, trailer — and which trips are verified.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'road_call', label: 'Road call (breakdown / tire)', when: 'A road call opens (driver call or text, or the console), it has everything and needs approval, it goes to the provider (Michelin ONCall), and every update from the provider until it is done.', defaults: ['Dispatch', 'ntellez@floridabeauty.us'] },
  { key: 'missing_boxes_case', label: 'Customer reported missing boxes (case opened)', when: 'A customer tells Jarvis (call or text) boxes are missing: what the customer said + what the system shows (ARTIS received / not received, trip sheet, splits). The customer is only told a case is open and the office will get back to them.', defaults: ['Customer Service', 'Sebastian Manotas', 'Sara Trujillo'] },
  { key: 'eta_report', label: 'ETA report when a trip finishes', when: 'When a trip is delivered / closed: for every customer on it, the ETAs we gave along the way (first, last and every change) vs when the truck actually got there (geofence, else TruckMate / ARTIS delivered time). Internal only.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'ltl_temp', label: 'LTL reefer 5°F off / set point wrong', texts: true, when: 'An LTL / flower load\'s reefer reads more than 5°F above or below its set point or the temperature the load needs (not while unloading at a receiver) — once each time it goes off, again only if 3°F worse; and when ARTIS\'s set point is not the temperature the load needs — once per set point. Texts go to Nadim and Ronen unless a text list is set here. Never broker loads.', defaults: ['inbound@floridabeauty.us'] },
  { key: 'running_late', label: 'Running late vs usual (LTL)', when: 'An LTL / flower load\'s ETA to a customer runs 1 h 30 min or more past the time our trucks usually get there (learned from the geofence arrivals: days after the outbound day + local time). Once as soon as Jarvis sees it, again only if it gets an hour worse. Never broker loads.', defaults: ['ntellez@floridabeauty.us'] },
  { key: 'late_commitment', label: 'Late for a committed time', texts: true, when: 'A stop has a date + time committed to the customer (📅 on the stop) and, from the morning after the truck left, the ETA is more than an hour past it: one email + one text per stop. Internal only — you decide who tells the customer.', defaults: ['Dispatch', 'ntellez@floridabeauty.us'] },
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

// Text entries: a phone number or an employee (their phone on the Employees list). Pure-ish.
const digits = (x) => String(x || '').replace(/\D+/g, '');
export function resolvePhones(entries = [], { people = [] } = {}) {
  const phones = []; const unresolved = [];
  for (const e of entries) {
    const d = digits(e);
    if (d.length === 10 || (d.length === 11 && d[0] === '1')) { phones.push(`+1${d.slice(-10)}`); continue; }
    const p = findStaff(people, e, 1)[0];
    if (p && digits(p.phone).length >= 10) { phones.push(`+1${digits(p.phone).slice(-10)}`); continue; }
    unresolved.push(e);
  }
  return { phones: [...new Set(phones)], unresolved };
}
const cleanTexts = (input = {}) => Object.fromEntries(ALERTS.filter((a) => a.texts && Array.isArray(input[a.key])).map((a) => [a.key, [...new Set(input[a.key].map((x) => String(x || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 20)]));

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

// Saray already gets Inbound and Dispatches, so she's taken off the other alert emails. She stays only on the
// extended stop email (Team truck stopped), and only Friday–Monday (Eastern). Pure.
const SARAY = /\bsaray\b/i;
const ET_DAY = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
export function sarayGetsIt(key, ms = Date.now()) { return key === 'team_stopped' && ['Fri', 'Sat', 'Sun', 'Mon'].includes(ET_DAY(ms)); }
export function dropSaray(emails = [], { key, people = [], now = Date.now() } = {}) {
  if (sarayGetsIt(key, now)) return emails;
  const hers = new Set(people.filter((p) => SARAY.test(p.name || '') && p.email).map((p) => String(p.email).toLowerCase()));
  return emails.filter((e) => !hers.has(e) && !/^[^@]*(saray|fabregas)[^@]*@/i.test(e));
}

export function initAlertRecipients(app, { requireAuth, requireAdmin = null, db, directory, now = () => Date.now() }) {
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
  async function textLists() { return enabled ? ((await db.get(TEXT_KEY, {})) || {}) : {}; }
  // the phone numbers that get a text for one alert right now (alerts with texts: true)
  async function phones(key) {
    const r = resolvePhones((await textLists())[key] || [], await dirData());
    if (r.unresolved.length) console.warn(`[alerts] ${key} texts: no phone for`, r.unresolved.join(', '));
    return r.phones;
  }
  // the email addresses for one alert right now
  async function resolve(key) {
    const l = (await lists())[key] || [];
    const d = await dirData();
    const r = resolveEntries(l, d);
    if (r.unresolved.length) console.warn(`[alerts] ${key}: no email for`, r.unresolved.join(', '));
    return dropSaray(r.emails, { key, people: d.people, now: now() });
  }

  app.get('/truckmate/alert-recipients', requireAdmin || requireAuth, async (req, res) => {
    const l = await lists(); const d = await dirData(); const tl = await textLists();
    res.json({
      alerts: ALERTS.map((a) => {
        const r = resolveEntries(l[a.key], d);
        const t = a.texts ? resolvePhones(tl[a.key] || [], d) : null;
        return { key: a.key, label: a.label, when: a.when, entries: l[a.key], emails: r.emails, unresolved: r.unresolved,
          ...(t ? { texts: true, textEntries: tl[a.key] || [], textUnresolved: t.unresolved, textCount: t.phones.length } : {}) };
      }),
      groups: d.groups.map((g) => g.name), people: d.people.filter((p) => p.email).map((p) => p.name),
    });
  });
  app.put('/truckmate/alert-recipients', requireAdmin || requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const clean = cleanRecipients((req.body && req.body.alerts) || {});
    await db.update(KEY, (cur) => ({ ...(cur || {}), ...clean }), {});
    const texts = cleanTexts((req.body && req.body.texts) || {});
    if (Object.keys(texts).length) await db.update(TEXT_KEY, (cur) => ({ ...(cur || {}), ...texts }), {});
    res.json({ ok: true, saved: clean, texts });
  });
  return { resolve, lists, phones };
}

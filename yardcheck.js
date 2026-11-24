// ---------------------------------------------------------------
// Yard checks (Nov 22, Nadim): twice a day — morning and night — the yard person walks the Miami and Ventura yards with
// a phone and adds every trailer and truck they find (the sheet starts empty; GPS only suggests numbers): here or not, loaded or empty, reefer on with its set point and reading, fuel,
// and damage (notes + photos). The sheet starts with what GPS says is in the yard (Thermo King / Samsara trailers, Samsara
// trucks — yardreport.js); anything found that GPS didn't list is added by hand. When it's sent, it's compared: on GPS but
// not found, found but not on GPS, a loaded trailer with the reefer off or its reading 5°F+ from the set point, damage.
// Shown on the Yard tab only — no texts or emails (Nov 22: the user's call).
// Nov 22 (2): the sheet from Nadim's design — each unit "Seen", the office's readiness (Available / Assigned and cleared /
// Hold — needs attention / Down), load (loaded / empty / partial), a trailer's inside (clean / needs cleaning / damaged), a
// truck's visible condition and access (blocked in), the truck's class (company / local / owner operator / outside carrier), one
// issue / comment box; who checked and when.
//
//   GET  /truckmate/yard-checks?yard=MIAMI   → the sheet: who should be there, today's morning / night checks, the last 14
//   POST /truckmate/yard-checks              → { yard, shift?, rows: [{ unit, kind, here, loaded, reeferOn, setF, tempF,
//                                                fuelPct, damage, photos }] } one check per yard, day and shift (sent again: replaced)
//   GET  /truckmate/yard-checks/days?yard=&month=YYYY-MM → the calendar: checks by day
//   GET  /truckmate/yard-checks/:id          → one check in full
//   POST /truckmate/yard-checks/photos       → { dataUrl } a damage photo (JPEG / PNG, ≤ 600 KB) → { id }
//   GET  /truckmate/yard-checks/photos/:id   → the picture
//   POST /truckmate/yard-checks/email-preview → a made-up check's email, to see it (to YARD_CHECK_EMAIL)
// Each submitted check is emailed as its summary (yardcheckemail.js) to YARD_CHECK_EMAIL (Nadim while training).
// Data: taYardChecks { list } (newest first, 400 kept) · taYardCheckPhoto:<id>
// ---------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import { sendMail as mailerSend } from './mailer.js';
import { yardCheckEmail, mockYardCheck } from './yardcheckemail.js';

export const CHECK_YARDS = { MIAMI: { name: 'Miami', tz: 'America/New_York' }, VENTURA: { name: 'Ventura', tz: 'America/Los_Angeles' } };
export const SHIFTS = ['morning', 'night'];
const KEY = 'taYardChecks';
const PHOTO = (id) => `taYardCheckPhoto:${id}`;
const PHOTO_MAX = 600 * 1024;
const norm = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^(TL|TRL|TRAILER|TK|TRUCK)\s*/, '').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// The yard's own clock: which day and which check a time belongs to. Morning 4:00 AM – 3:59 PM, night 4:00 PM – 3:59 AM (a
// night check after midnight still counts for the evening before). Pure. → { day: 'YYYY-MM-DD', shift, hour }
export function yardClock(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  if (hour < 4) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); day = d.toISOString().slice(0, 10); }
  return { day, shift: hour >= 4 && hour < 16 ? 'morning' : 'night', hour };
}

// Who should be in the yard now, from the yard report (trailers) and the truck report (trucks). Pure.
export function expectedUnits(report = {}, trucks = {}, yard = 'MIAMI') {
  const hub = ((report.hubs || []).find((h) => h.key === yard) || {}).trailers || [];
  const th = ((trucks.hubs || []).find((h) => h.key === yard) || {}).trucks || [];
  return [
    ...hub.map((t) => ({ unit: norm(t.trailer), kind: 'trailer', onLoad: t.onLoad || null, reefer: { on: t.unitOn ?? null, setF: t.setF ?? null, returnF: t.returnF ?? null }, seenAt: t.seenAt || null, source: t.source || null })),
    ...th.map((t) => ({ unit: norm(t.unit), kind: 'truck', onLoad: t.trip || null, driver: (t.drivers || [])[0] ? t.drivers[0].name || null : null, seenAt: t.gpsAt || null, source: 'Samsara' })),
  ].filter((u) => u.unit);
}

// Every truck and trailer on a load in TruckMate (Nov 24): the trip, where it goes, and its delivery date (the last bill's
// deliver-by), so a loaded trailer's card shows its load and a unit that left on a load is flagged on the next check.
// taTruckMateActive → { 'trailer:7280': { trip, to, deliverBy, status }, 'truck:4504': … }. Pure.
export function unitLoads(active = {}) {
  const out = {};
  for (const rec of Object.values((active && active.trips) || {})) {
    const it = (rec && rec.item) || {}; const t = it.trip || {};
    const bills = it.freightBills || it.orders || t.freightBills || [];
    if (!t.tripNumber || bills.length && bills.every((b) => b && b.actualDelivery)) continue;
    const open = bills.filter((b) => b && !b.actualDelivery);
    const deliverBy = open.map((b) => String(b.deliverByEnd || b.deliverBy || '').slice(0, 16)).filter(Boolean).sort().pop() || null;
    const load = { trip: String(t.tripNumber), to: t.destZoneDesc || null, deliverBy, status: t.status || null };
    if (t.trailer) out[`trailer:${norm(t.trailer)}`] = load;
    if (t.powerUnit) out[`truck:${norm(t.powerUnit)}`] = load;
  }
  return out;
}

// The sheet while it is being filled (Nov 24, Nadim: "when you start filling it out it populates everywhere"): every phone and
// computer on the same yard, day and shift shares one draft. Each card has an id and an updatedAt; a save merges card by card
// (the newer card wins) and a removed card leaves a marker so it doesn't come back from another device. Pure.
// cur: { rows: { id: row }, removed: { id: ms }, at } ; patch: { rows: [row], removed: [id] } → the merged draft
export function mergeDraft(cur = {}, patch = {}, nowMs = Date.now()) {
  const rows = { ...((cur && cur.rows) || {}) }; const removed = { ...((cur && cur.removed) || {}) };
  for (const id of (Array.isArray(patch.removed) ? patch.removed : []).slice(0, 400)) { const k = String(id).slice(0, 60); removed[k] = nowMs; delete rows[k]; }
  for (const r of (Array.isArray(patch.rows) ? patch.rows : []).slice(0, 400)) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    const id = String(r.id).slice(0, 60);
    if (JSON.stringify(r).length > 12000) continue;
    const at = Number(r.updatedAt) || 0;   // no edit time (a card carried from the last check) = oldest: never over a real edit
    if (removed[id] && removed[id] >= at) continue;
    if (rows[id] && (Number(rows[id].updatedAt) || 0) > at) continue;
    rows[id] = { ...r, id, updatedAt: at };
  }
  return { rows, removed, at: nowMs };
}
export const draftKeyOf = (yard, day, shift) => `${yard}:${day}:${shift}`;

// Shop updates (Nov 24): a truck or trailer in the shop (or at / needing the dealer) gets an update each time there is news,
// with when it should be ready. Kept per unit across checks, newest first. Pure. → the unit's list with the new update on top
export function addShopUpdate(list = [], { text = '', eta = null, by = null } = {}, nowMs = Date.now()) {
  const t = String(text || '').trim().slice(0, 1000);
  const e = /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(String(eta || '')) ? String(eta).slice(0, 16) : /^\d{4}-\d\d-\d\d$/.test(String(eta || '')) ? String(eta) : null;
  if (!t && !e) return null;
  return [{ id: `su${nowMs.toString(36)}`, at: new Date(nowMs).toISOString(), by: String(by || '').trim().slice(0, 80) || null, text: t || null, eta: e }, ...(list || [])].slice(0, 50);
}
export const unitKey = (kind, unit) => `${kind === 'truck' ? 'truck' : 'trailer'}:${norm(unit)}`;

// One row from the phone, cleaned. Pure.
export const READINESS = ['available', 'assigned', 'hold', 'down'];
export const READINESS_LABEL = { available: 'Available', assigned: 'Assigned and cleared', hold: 'Hold — needs attention', down: 'Down' };
const pick = (v, list) => (list.includes(v) ? v : null);
export const CONDITIONS = ['clear', 'issue', 'shop', 'dealer'];
// whole days at the dealer: from the day it went to the check's day. Pure.
export const dealerDays = (since, day) => (since && day ? Math.max(0, Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${since}T12:00:00Z`)) / 86400000)) : null);
export function cleanRow(r = {}) {
  const kind = r.kind === 'truck' ? 'truck' : 'trailer';
  const seen = r.seen === true || r.here === true ? true : r.seen === false || r.here === false ? false : null;
  return {
    unit: norm(r.unit), kind, here: seen,
    // a local truck (Nov 24) counts as local and is never available for dispatch
    readiness: r.kind === 'truck' && r.localTruck && r.readiness === 'available' ? null : pick(r.readiness, READINESS),
    loaded: pick(r.loaded, ['loaded', 'empty', 'partial']),
    inside: kind === 'trailer' ? pick(r.inside, ['clean', 'cleaning', 'damaged']) : null,
    // Nov 24: "In shop" (in a bay with our yard mechanics) and "Needs dealer"; "At dealer" with the day it went, carried from check
    // to check so the days count up until it is unchecked
    condition: kind === 'truck' ? pick(r.condition, CONDITIONS) : pick(r.condition, ['shop', 'dealer']),   // Nov 24: a trailer can be in the shop too
    atDealer: kind === 'truck' && !!r.atDealer,
    dealerSince: kind === 'truck' && r.atDealer && /^\d{4}-\d\d-\d\d$/.test(String(r.dealerSince || '')) ? String(r.dealerSince) : null,
    access: kind === 'truck' ? pick(r.access, ['clear', 'blocked']) : null,
    companyTruck: kind === 'truck' && !!r.companyTruck, localTruck: kind === 'truck' && !!r.localTruck, ownerOperator: kind === 'truck' && !!r.ownerOperator, outsideCarrier: kind === 'truck' && !!r.outsideCarrier,
    comments: String(r.comments || '').trim().slice(0, 1000) || null,
    // Nov 24: the issues added one by one on the card (comments carries them joined, for the summary and the email)
    issues: (Array.isArray(r.issues) ? r.issues : []).map((x) => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 20),
    notes: kind === 'truck' ? String(r.notes || '').trim().slice(0, 2000) || null : null,   // "Truck comments": repair notes, instructions for dispatch
    reeferOn: kind === 'trailer' && typeof r.reeferOn === 'boolean' ? r.reeferOn : null,
    setF: kind === 'trailer' ? num(r.setF) : null, tempF: kind === 'trailer' ? num(r.tempF) : null,
    fuelPct: num(r.fuelPct) != null ? Math.max(0, Math.min(100, Math.round(num(r.fuelPct)))) : null,
    damage: String(r.damage || '').trim().slice(0, 500) || null,
    photos: (Array.isArray(r.photos) ? r.photos : []).map(String).filter((x) => /^[a-f0-9]{12}$/.test(x)).slice(0, 4),
    added: !!r.added,
  };
}

// The check against what GPS said: what to look at. Pure. → { missing, extra, reefer, damage, unchecked, counts }
export function compareCheck(expected = [], rows = [], day = null) {
  const by = new Map(rows.map((r) => [`${r.kind}:${r.unit}`, r]));
  const expKeys = new Set(expected.map((u) => `${u.kind}:${u.unit}`));
  // the sheet starts empty and the yard person adds what they find (Nov 22, Nadim): on GPS but not added = not found
  const missing = expected.filter((u) => !(by.get(`${u.kind}:${u.unit}`) || {}).here).map((u) => ({ unit: u.unit, kind: u.kind, onLoad: u.onLoad || null }));
  const unchecked = [];
  const extra = rows.filter((r) => r.here && !expKeys.has(`${r.kind}:${r.unit}`)).map((r) => ({ unit: r.unit, kind: r.kind }));
  const reefer = rows.filter((r) => r.here && r.kind === 'trailer' && r.loaded === 'loaded' && (r.reeferOn === false || (r.setF != null && r.tempF != null && Math.abs(r.tempF - r.setF) >= 5)))
    .map((r) => ({ unit: r.unit, why: r.reeferOn === false ? 'loaded, reefer off' : `reading ${r.tempF}°F, set ${r.setF}°F` }));
  const damage = rows.filter((r) => r.here && (r.damage || r.inside === 'damaged' || r.condition === 'issue')).map((r) => ({ unit: r.unit, kind: r.kind, note: r.damage || r.comments || (r.inside === 'damaged' ? 'inside damaged' : 'visible issue'), photos: r.photos.length }));
  const here = rows.filter((r) => r.here);
  // what the yard saw that needs someone: blocked in, needs cleaning, on hold, down
  const atD = (r) => { const n = dealerDays(r.dealerSince, day); return `at the dealer${n != null ? ` (${n} day${n === 1 ? '' : 's'})` : ''}`; };
  const why = (r) => [r.condition === 'shop' ? 'in the shop' : null, r.condition === 'dealer' && !r.atDealer ? 'needs the dealer' : null, r.atDealer ? atD(r) : null, r.access === 'blocked' ? 'blocked in' : null, r.inside === 'cleaning' ? 'needs cleaning' : null, r.readiness === 'hold' ? 'on hold — needs attention' : null, r.readiness === 'down' ? 'down — cannot use' : null].filter(Boolean).join(', ');
  const observations = here.filter((r) => why(r)).map((r) => ({ unit: r.unit, kind: r.kind, why: why(r), comments: [r.comments, r.notes].filter(Boolean).join(' · ') || null }));
  const split = (list) => ({ trucks: list.filter((r) => r.kind === 'truck').length, trailers: list.filter((r) => r.kind === 'trailer').length });
  const readiness = Object.fromEntries(READINESS.map((k) => [k, split(here.filter((r) => r.readiness === k))]));
  const trucksHere = here.filter((r) => r.kind === 'truck');
  return { missing, extra, reefer, damage, observations, unchecked, readiness,
    classes: { companyTruck: trucksHere.filter((r) => r.companyTruck).length, localTruck: trucksHere.filter((r) => r.localTruck).length, ownerOperator: trucksHere.filter((r) => r.ownerOperator).length, outsideCarrier: trucksHere.filter((r) => r.outsideCarrier).length },
    counts: { here: here.length, trailers: here.filter((r) => r.kind === 'trailer').length, trucks: trucksHere.length, loaded: here.filter((r) => r.loaded === 'loaded').length, empty: here.filter((r) => r.loaded === 'empty').length, partial: here.filter((r) => r.loaded === 'partial').length, expected: expected.length } };
}

// Today's checks and whether one is late: morning not in by 11 AM, night not in by 11 PM (yard time). Pure.
export function dueNow(list = [], yard, now = Date.now()) {
  const { tz } = CHECK_YARDS[yard];
  const c = yardClock(now, tz);
  const mine = (shift) => list.find((x) => x.yard === yard && x.day === c.day && x.shift === shift) || null;
  const morning = mine('morning'); const night = mine('night');
  const hourNight = c.hour < 4 ? c.hour + 24 : c.hour;
  return { day: c.day, shiftNow: c.shift, morning: morning ? summary(morning) : null, night: night ? summary(night) : null,
    late: { morning: !morning && hourNight >= 11, night: !night && hourNight >= 23 } };
}
// One yard's checks in a month, by day (morning first). Pure.
export function checksByDay(list = [], yard, month) {
  const out = {};
  for (const x of list) if (x.yard === yard && String(x.day).startsWith(month)) (out[x.day] = out[x.day] || []).push(summary(x));
  for (const d of Object.keys(out)) out[d].sort((a, b) => (a.shift === b.shift ? 0 : a.shift === 'morning' ? -1 : 1));
  return out;
}
export const summary = (x) => ({ id: x.id, yard: x.yard, day: x.day, shift: x.shift, by: x.by, at: x.at, updated: x.updated || null, ...x.result.counts,
  missing: x.result.missing.length, extra: x.result.extra.length, reefer: x.result.reefer.length, damage: x.result.damage.length, unchecked: x.result.unchecked.length,
  observations: (x.result.observations || []).length, readiness: x.result.readiness || null, checkedAt: x.checkedAt || x.at });

export function initYardCheck(app, { requireAuth, db, report, trucks, now = () => Date.now(), env = process.env, sendMail = (m) => mailerSend(m, { env }) }) {
  const enabled = !!(db && db.enabled);
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatch';
  const yardOf = (v) => { const k = String(v || '').toUpperCase(); return CHECK_YARDS[k] ? k : null; };
  async function expected(yard) {
    const [r, t] = await Promise.all([report().catch(() => ({})), trucks().catch(() => ({}))]);
    return expectedUnits(r, t, yard);
  }
  // the summary email: to YARD_CHECK_EMAIL (default Nadim), with the units that have an open DVIR marked
  const emailTo = () => String(env.YARD_CHECK_EMAIL || 'ntellez@floridabeauty.us').split(/[,;\s]+/).filter(Boolean);
  async function emailCheck(c) {
    if (env.YARD_CHECK_EMAIL === 'off') return null;
    const open = Object.values((await db.get('taDvr:florida-beauty', {}).catch(() => ({}))) || {}).filter((d) => d.status !== 'completed');
    const dvrUnits = new Set(open.map((d) => (d.part === 'truck' ? `truck:${norm(d.truck)}` : `trailer:${norm(d.trailer)}`)));
    const m = yardCheckEmail(c, { dvrUnits });
    await sendMail({ to: emailTo(), subject: m.subject, html: m.html, text: m.text });
    return emailTo();
  }
  if (!app || !requireAuth) return { expected };

  app.get('/truckmate/yard-checks', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const yard = yardOf(req.query.yard) || 'MIAMI';
    try {
      const list = ((await db.get(KEY, { list: [] })) || {}).list || [];
      res.json({ yards: Object.entries(CHECK_YARDS).map(([key, y]) => ({ key, name: y.name, tz: y.tz, due: dueNow(list, key, now()) })), yard, expected: await expected(yard),
        loads: unitLoads(await db.get('taTruckMateActive:florida-beauty', { trips: {} }).catch(() => ({ trips: {} }))),
        today: dueNow(list, yard, now()), history: list.filter((x) => x.yard === yard).slice(0, 14).map(summary),
        // the last check's units (Nov 24): the next sheet starts with them so the yard person confirms instead of typing them again
        last: (() => { const l = list.filter((x) => x.yard === yard).sort((p, q) => String(q.checkedAt || q.at).localeCompare(String(p.checkedAt || p.at)))[0]; return l ? { id: l.id, day: l.day, shift: l.shift, by: l.by, at: l.checkedAt || l.at, rows: (l.rows || []).filter((r) => r.here) } : null; })() });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  // the calendar (Nov 22): every check in one month, by day → { days: { 'YYYY-MM-DD': [summary…] } }
  app.get('/truckmate/yard-checks/days', requireAuth, async (req, res) => {
    if (!enabled) return res.json({ days: {} });
    const yard = yardOf(req.query.yard) || 'MIAMI';
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date(now()).toISOString().slice(0, 7);
    res.json({ yard, month, days: checksByDay(((await db.get(KEY, { list: [] })) || {}).list || [], yard, month) });
  });
  app.get('/truckmate/yard-checks/:id', requireAuth, async (req, res, next) => {
    if (['photos', 'days', 'draft', 'shop-updates'].includes(req.params.id)) return next();
    const x = ((((await db.get(KEY, { list: [] })) || {}).list) || []).find((c) => c.id === String(req.params.id));
    return x ? res.json({ check: x }) : res.status(404).json({ error: 'No such check.' });
  });
  // the shared draft: read it, save changed cards (merged), gone once the check is sent
  const DRAFTS = 'taYardDraft:florida-beauty';
  const dkey = (q) => { const yard = yardOf(q.yard); const day = /^\d{4}-\d\d-\d\d$/.test(String(q.day || '')) ? String(q.day) : null; const shift = SHIFTS.includes(q.shift) ? q.shift : null; return yard && day && shift ? draftKeyOf(yard, day, shift) : null; };
  app.get('/truckmate/yard-checks/draft', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const k = dkey(req.query || {}); if (!k) return res.status(400).json({ error: 'Pick the yard, day and shift.' });
    const d = (((await db.get(DRAFTS, {})) || {})[k]) || null;
    res.json({ key: k, rows: d ? Object.values(d.rows || {}) : [], removed: d ? Object.keys(d.removed || {}) : [], at: d ? d.at : null });
  });
  app.post('/truckmate/yard-checks/draft', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {}; const k = dkey(b); if (!k) return res.status(400).json({ error: 'Pick the yard, day and shift.' });
    let out = null;
    await db.update(DRAFTS, (cur) => {
      const all = { ...(cur || {}) };
      for (const [key, v] of Object.entries(all)) if (!v || now() - (v.at || 0) > 3 * 86400000) delete all[key];   // drafts older than 3 days go
      all[k] = mergeDraft(all[k], { rows: b.rows, removed: b.removed }, now());
      out = all[k]; return all;
    });
    res.json({ key: k, rows: Object.values(out.rows), removed: Object.keys(out.removed), at: out.at });
  });
  // shop updates: every unit's list (newest first), and a new update with its ETA to be ready
  const SHOP = 'taShopUpdates:florida-beauty';
  app.get('/truckmate/yard-checks/shop-updates', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    res.json({ units: (await db.get(SHOP, {})) || {} });
  });
  app.post('/truckmate/yard-checks/shop-updates', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {}; const unit = norm(b.unit);
    if (!unit) return res.status(400).json({ error: 'Which truck or trailer?' });
    const k = unitKey(b.kind, unit); let list = null;
    await db.update(SHOP, (cur) => {
      const all = { ...(cur || {}) };
      const next = addShopUpdate(all[k], { text: b.text, eta: b.eta, by: b.by || who(req) }, now());
      if (next) { all[k] = next; list = next; }
      return all;
    });
    if (!list) return res.status(400).json({ error: 'Write the update or set when it will be ready.' });
    res.json({ ok: true, key: k, updates: list });
  });
  app.post('/truckmate/yard-checks', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const yard = yardOf(b.yard);
    if (!yard) return res.status(400).json({ error: 'Pick the yard: Miami or Ventura.' });
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 400).map(cleanRow).filter((r) => r.unit);
    if (!rows.some((r) => r.here != null)) return res.status(400).json({ error: 'Mark at least one unit here or not here.' });
    // "Checked by" and "Date & time" from the sheet: a time within the last day (not ahead) picks the day and shift
    const typed = Date.parse(String(b.checkedAt || ''));
    const checkedMs = Number.isFinite(typed) && typed <= now() + 3600000 && typed >= now() - 86400000 ? typed : now();
    const checkedBy = String(b.checkedBy || '').trim().slice(0, 80) || null;
    const clock = yardClock(checkedMs, CHECK_YARDS[yard].tz);
    const shift = SHIFTS.includes(b.shift) ? b.shift : clock.shift;
    try {
      const exp = await expected(yard);
      rows.forEach((r) => { if (r.atDealer && !r.dealerSince) r.dealerSince = clock.day; });   // checked today with no start day: it went today
      const result = compareCheck(exp, rows, clock.day);
      const at = new Date(now()).toISOString();
      let saved = null;
      await db.update(KEY, (cur) => {
        const list = ((cur && cur.list) || []);
        const old = list.find((x) => x.yard === yard && x.day === clock.day && x.shift === shift);
        saved = { id: old ? old.id : randomBytes(6).toString('hex'), yard, day: clock.day, shift, by: checkedBy || who(req), login: who(req), checkedAt: new Date(checkedMs).toISOString(), at: old ? old.at : at, ...(old ? { updated: at, updatedBy: who(req) } : {}), expected: exp, rows, result };
        return { list: [saved, ...list.filter((x) => x !== old)].slice(0, 400) };
      }, { list: [] });
      res.json({ ok: true, check: summary(saved), result });
      // sent: the shared draft for this yard, day and shift is done with (the sheet's own day too, when it differs)
      db.update(DRAFTS, (cur) => { const all = { ...(cur || {}) }; delete all[draftKeyOf(yard, clock.day, shift)]; if (/^\d{4}-\d\d-\d\d$/.test(String(b.draftDay || ''))) delete all[draftKeyOf(yard, String(b.draftDay), shift)]; return all; }).catch(() => {});
      emailCheck(saved).catch((e) => console.warn('[yard-check] email:', e.message));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/truckmate/yard-checks/email-preview', requireAuth, async (req, res) => {
    try { const to = await emailCheck(mockYardCheck(now())); res.json({ ok: true, to }); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/truckmate/yard-checks/photos', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const m = String((req.body || {}).dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Send a JPEG or PNG picture.' });
    if (m[2].length * 0.75 > PHOTO_MAX) return res.status(413).json({ error: 'That picture is too big.' });
    const id = randomBytes(6).toString('hex');
    await db.set(PHOTO(id), { type: m[1], data: m[2], by: who(req), at: new Date(now()).toISOString() });
    res.json({ id });
  });
  app.get('/truckmate/yard-checks/photos/:id', requireAuth, async (req, res) => {
    const p = /^[a-f0-9]{12}$/.test(String(req.params.id)) ? await db.get(PHOTO(req.params.id), null) : null;
    if (!p) return res.status(404).json({ error: 'No such picture.' });
    res.set('Content-Type', p.type); res.set('Cache-Control', 'private, max-age=86400');
    return res.send(Buffer.from(p.data, 'base64'));
  });
  return { expected };
}

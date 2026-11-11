// ---------------------------------------------------------------
// TruckMate reefer agent — reads Thermo King reefer readings off the TruckMate screen. READ ONLY.
//
// TruckMate keeps the TK readings per trailer (the "Reefer Events" window) but its API doesn't expose them, and IT can't
// give us database access, so a small script (agent/truckmate-reefer-agent.ps1) on a dedicated Windows desktop that stays
// signed in to TruckMate does what a person would: every hour it asks us which trailers to read, opens each one's Reefer
// Events window with a short, fixed list of steps (the "recipe", set here by an admin), screenshots it, and sends us the
// picture. Claude reads the picture; we keep only the latest reading per trailer on an active load and show it on the card.
//
// Read-only by design:
//   • the recipe may only click, type the trailer number (or digits), press ENTER / ESC / TAB / arrows / F5, wait and
//     take a screenshot — nothing else is accepted;
//   • a screenshot that isn't a Reefer Events window stops the run (the agent presses ESC and waits for the next hour);
//   • the agent signs in with its own key (never a TruckMate password; TruckMate stays signed in on that desktop).
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import { loadTarget } from './temppolicy.js';
import { applyTruckMateCustomer } from './profiles.js';

const SITE = 'florida-beauty';
const MIN = 60000;
export const EVERY_MIN = 120;   // a full read of the active loads' trailers every 2 hours (the agent checks in hourly)
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const KEYS = { noTemp: `taTkNoTemp:${SITE}`, key: 'taReeferAgentKey', recipe: 'taReeferAgentRecipe', billRecipe: 'taBillAgentRecipe', bills: `taTmBillStops:${SITE}`, custRecipe: 'taCustAgentRecipe', customers: `taTmCustomerNotes:${SITE}`, readings: `taTkReefer:${SITE}`, shots: 'taReeferAgentShots', runs: 'taReeferAgentRuns' };
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const unit = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

// keys the recipe may press. MENU = the context menu of the selected row; W = its "View Reefer Events…" (every W/V item in
// TruckMate's trailer menu only opens a view); ALT+C = the Reefer Events window's Close button.
// CTRL+F = TruckMate's Find (Find Freight Bill / Select Client: look-up only); CTRL+N = View Notes (Notes for Client).
export const ALLOWED_KEYS = ['ENTER', 'ESC', 'TAB', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'F5', 'HOME', 'END', 'MENU', 'W', 'ALT+C', 'CTRL+F', 'CTRL+N'];
// Steps the agent may run: only these, nothing that could change TruckMate. Pure. → { ok, steps } | { ok: false, error }
function cleanSteps(steps, label) {
  if (!Array.isArray(steps)) return { ok: true, steps: [] };
  if (steps.length > 30) return { ok: false, error: `${label}: at most 30 steps.` };
  const frac = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  const out = [];
  for (const [i, s] of steps.entries()) {
    const t = s && s.do; const at = `${label} step ${i + 1}`;
    if (t === 'click' || t === 'doubleclick') { if (!frac(s.x) || !frac(s.y)) return { ok: false, error: `${at}: x and y are 0–1 (part of the window).` }; out.push({ do: t, x: Number(s.x), y: Number(s.y), note: String(s.note || '').slice(0, 80) }); continue; }
    if (t === 'type') { const v = String(s.text || ''); if (!/^(\{trailer\}|\{bill\}|\{code\}|[0-9]{1,10})$/.test(v)) return { ok: false, error: `${at}: only the trailer number ({trailer}), the bill number ({bill}), the customer code ({code}) or digits may be typed.` }; out.push({ do: 'type', text: v }); continue; }
    if (t === 'key') { const k = String(s.key || '').toUpperCase(); if (!ALLOWED_KEYS.includes(k)) return { ok: false, error: `${at}: key must be one of ${ALLOWED_KEYS.join(', ')}.` }; out.push({ do: 'key', key: k }); continue; }
    if (t === 'wait') { const ms = Math.round(Number(s.ms)); if (!(ms >= 100 && ms <= 15000)) return { ok: false, error: `${at}: wait 100–15000 ms.` }; out.push({ do: 'wait', ms }); continue; }
    if (t === 'shot') { out.push({ do: 'shot' }); continue; }
    return { ok: false, error: `${at}: "${t}" is not allowed (click, doubleclick, type, key, wait, shot).` };
  }
  return { ok: true, steps: out };
}
// The recipe: steps that open one trailer's Reefer Events window and screenshot it, then steps that close it. Pure.
export function cleanRecipe(r = {}) {
  const main = cleanSteps(r.steps, 'Open');
  if (!main.ok) return main;
  if (!main.steps.some((s) => s.do === 'shot')) return { ok: false, error: 'The recipe has to take a screenshot (shot) of the Reefer Events window.' };
  const after = cleanSteps(r.after, 'Close');
  if (!after.ok) return after;
  return { ok: true, recipe: { windowTitle: String(r.windowTitle || 'TruckMate').slice(0, 80), steps: main.steps, after: after.steps.length ? after.steps.filter((s) => s.do !== 'shot') : [{ do: 'key', key: 'ESC' }] } };
}

// Trailers that don't track temp: no Thermo King reading on 3 different active temperature loads → skipped from then on.
// Still opened once a week (in case a unit was installed); a reading clears the flag. Pure helpers.
export const NO_TEMP_LOADS = 3;
export const RECHECK_DAYS = 7;
// book: { [trailer]: { loads: [trip…], lastAt, flaggedAt, recheckedAt } } → the updated entry after one read. Pure.
export function noteRead(entry = {}, { trip, hasTemp, tempLoad, at }) {
  const e = { loads: [], ...(entry || {}) };
  if (hasTemp) return null;                                         // it reads: not on the list (or off it again)
  if (!tempLoad || !trip) return e.loads.length || e.flaggedAt ? { ...e, recheckedAt: e.flaggedAt ? at : e.recheckedAt || null } : null;
  const loads = [...new Set([...e.loads, String(trip)])].slice(-10);
  return { ...e, loads, lastAt: at, flaggedAt: e.flaggedAt || (loads.length >= NO_TEMP_LOADS ? at : null), recheckedAt: e.flaggedAt ? at : e.recheckedAt || null };
}
// skip a flagged trailer, unless its weekly re-check is due. Pure.
export const skipNoTemp = (entry, now) => !!(entry && entry.flaggedAt) && now - Date.parse(entry.recheckedAt || entry.flaggedAt) < RECHECK_DAYS * 24 * 60 * MIN;

// The trailers to read: on active temperature loads (not dry loads, not outside carriers), one entry each, minus the ones
// that don't track temp. A dry load = no temperature on the rate con, the dispatcher's trip sheet or TruckMate's bill. Pure.
export function trailersToRead(trips = [], max = 40, { noTemp = {}, now = Date.now(), tempOnly = true } = {}) {
  const seen = new Map();
  for (const it of trips) {
    const t = tripOf(it);
    if (!t.trailer || (it && it._oc) || String(t.powerUnit || '').toUpperCase() === 'OC') continue;
    if (/^(canc|void|compl)/i.test(String(t.status || ''))) continue;
    if (tempOnly && !loadTarget(it)) continue;                       // dry load: nothing to read
    const k = unit(t.trailer);
    if (k && !seen.has(k) && !skipNoTemp(noTemp[k], now)) seen.set(k, { trailer: String(t.trailer), trip: tripNo(it) });
  }
  return [...seen.values()].slice(0, max);
}

// ---- freight bills: the Shipper / Consignee boxes (name, street address, phone, contact, appointment) ----
// TruckMate's feed has only the zones of each bill; the boxes' names and street addresses are read off the order screen
// (type the bill number, screenshot, close). A bill is read once, and again only when TruckMate updates it.
export const BILLS_PER_RUN = 40;
// The bills to read: on active loads (not outside carriers), not read yet or changed in TruckMate since. Pure.
export function billsToRead(trips = [], read = {}, max = BILLS_PER_RUN) {
  const out = [];
  const seen = new Set();
  for (const it of trips) {
    const t = tripOf(it);
    if ((it && it._oc) || /^(canc|void|compl)/i.test(String(t.status || ''))) continue;
    for (const b of (it.freightBills || it.orders || [])) {
      const n = String((b && b.billNumber) || '').trim();
      if (!/^[A-Za-z0-9-]{2,20}$/.test(n) || seen.has(n) || b.actualDelivery) continue;
      seen.add(n);
      const r = read[n];
      if (r && (!b.updatedTimestamp || r.updated === String(b.updatedTimestamp))) continue;
      out.push({ bill: n, trip: tripNo(it), updated: b.updatedTimestamp ? String(b.updatedTimestamp) : null, isNew: !r, ltl: !!(it._manifest && (it._manifest.stops || []).length) });
    }
  }
  // trip-sheet (LTL) loads first — their consignees are the customers whose instructions drivers need — then new bills
  return out.sort((a, b) => (b.ltl ? 2 : 0) + (b.isNew ? 1 : 0) - (a.ltl ? 2 : 0) - (a.isNew ? 1 : 0)).slice(0, max).map(({ isNew, ltl, ...x }) => x);
}

// A load's shippers and consignees from its bills' boxes, one entry per place (several bills to one place = one entry). Pure.
export function loadParties(item, read = {}) {
  const bills = ((item && (item.freightBills || item.orders)) || []).filter(Boolean);
  const key = (p) => String(`${p.name || ''}|${p.address1 || ''}|${p.city || ''}`).toUpperCase().replace(/[^A-Z0-9|]/g, '');
  const add = (map, p, b, when) => {
    if (!p || !(p.name || p.address1 || p.city)) return;
    const k = key(p);
    const cur = map.get(k) || { ...p, bills: [], appointments: [] };
    cur.bills.push(b.billNumber);
    if (when) cur.appointments.push(when);
    map.set(k, cur);
  };
  const S = new Map(); const C = new Map();
  for (const b of bills) {
    const r = read[String(b.billNumber || '').trim()];
    if (!r || !r.screen) continue;
    add(S, r.screen.shipper, b, r.screen.pickup);
    add(C, r.screen.consignee, b, r.screen.delivery);
  }
  if (!S.size && !C.size) return null;
  const shippers = [...S.values()]; const consignees = [...C.values()];
  return { shippers, consignees, multipleShippers: shippers.length > 1, multipleConsignees: consignees.length > 1, readBills: bills.filter((b) => read[String(b.billNumber || '').trim()]).length, totalBills: bills.length };
}

// ---- customer profiles: the Notes (Specifications) — what the driver needs at the stop — and phones / emails ----
// For the LTL customers: the consignees on loads with a trip sheet. Saved on our customer profile; a customer is opened in
// TruckMate again only when what we have is more than 10 days old.
export const CUSTOMERS_PER_RUN = 25;
export const CUSTOMER_REREAD_DAYS = 10;
const codeKey = (c) => String(c == null ? '' : c).trim().toUpperCase();
// The customer codes to read: the consignees read off the bills of trip-sheet (LTL) loads, not read in the last 10 days.
// ltlTrips: the trips with a trip sheet (null = every trip). Pure.
export function customersToRead(bills = {}, read = {}, { now = Date.now(), max = CUSTOMERS_PER_RUN, ltlTrips = null } = {}) {
  const out = new Map();
  for (const r of Object.values(bills)) {
    if (ltlTrips && !(r && ltlTrips.has(String(r.trip || '')))) continue;
    for (const [role, p] of [['consignee', r && r.screen && r.screen.consignee]]) {
      const k = codeKey(p && p.code);
      if (!/^[A-Z0-9-]{1,12}$/.test(k) || out.has(k)) continue;
      const done = read[k];
      if (done && now - Date.parse(done.at) < CUSTOMER_REREAD_DAYS * 24 * 60 * MIN) continue;
      out.set(k, { value: k, trip: r.trip || null, role, name: (p && p.name) || null, isNew: !done });
    }
  }
  return [...out.values()].sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0)).slice(0, max).map(({ isNew, ...x }) => x);
}
// A load's customer notes: each shipper / consignee on its bills that has notes in TruckMate. Pure.
export function loadCustomerNotes(item, bills = {}, customers = {}) {
  const out = new Map();
  for (const b of ((item && (item.freightBills || item.orders)) || [])) {
    const r = b && bills[String(b.billNumber || '').trim()];
    if (!r || !r.screen) continue;
    for (const [role, p] of [['shipper', r.screen.shipper], ['consignee', r.screen.consignee]]) {
      const k = codeKey(p && p.code); const c = customers[k];
      if (!k || !c || !String(c.notes || '').trim()) continue;
      const cur = out.get(k) || { code: k, name: c.name || (p && p.name) || null, roles: [], notes: c.notes, readAt: c.at };
      if (!cur.roles.includes(role)) cur.roles.push(role);
      out.set(k, cur);
    }
  }
  return out.size ? [...out.values()] : null;
}
const CUSTOMER_PROMPT = (code) => [
  `This is a screenshot from TruckMate (trucking software). We expect the "Customer & Vendor Profiles" window showing customer code ${code} (Code box at the top), on one of its tabs: Address, Notes (Specifications) or Shipping Instructions — or its "Notes for Client ${code}" window (tabs at the bottom: Caller, Shipper, Consignee, Sales, Collection Notes, Credit Notation).`,
  'Read it and return ONLY a JSON object (no prose):',
  '{ "isProfileScreen": boolean, "code": string|null, "name": string|null, "panel": "address"|"notes"|"shipping"|"clientNotes"|"other", "clientNotesTab": "caller"|"shipper"|"consignee"|"sales"|"collection"|"credit"|null, "dialogOpen": boolean,',
  '  "address": string|null, "city": string|null, "state": string|null, "zip": string|null,',
  '  "phones": [{ "label": string|null, "number": string }], "emails": [{ "label": string|null, "email": string }], "contact": string|null,',
  '  "instructions": string|null, "notes": string|null, "shippingOptions": [{ "text": string, "checked": boolean }] }',
  'Address tab: address / city / state / zip; phones = Phone (with Ext), Cell, and any other number (label it, e.g. "Cell KATHELY"; skip Fax); emails = EVERY email address in ANY box (staff often type emails in Web Site and notes in EMail).',
  '  instructions = any delivery instruction typed in any box instead of its normal value — gate / keypad codes, hours, "call before", etc. — exactly as written; null when none.',
  'Notes tab: notes = the full text of the Notes (Specifications) box, exactly as written, line breaks kept (\\n); null when empty.',
  'Notes for Client window: panel "clientNotes", clientNotesTab = the selected bottom tab, notes = its full text exactly as written (line breaks kept); code = the number in its title. This window is expected — it is not a dialog.',
  'Shipping Instructions tab: shippingOptions = each line under Pickup and Delivery Options with whether its box is checked.',
  'isProfileScreen is TRUE for the Customer & Vendor Profiles window (any tab) AND for its "Notes for Client" window — both are this customer\'s screens. It is false only for some other program, a login screen or a blank screen.',
  'dialogOpen is true only if a pop-up, message box, question, search window or error is showing on top (the Notes for Client window itself is not a dialog).',
].join('\n');

const BILL_PROMPT = (bill) => [
  `This is a screenshot from TruckMate (trucking software). We expect the order / freight bill screen for bill ${bill}, with its Shipper and Consignee boxes.`,
  'Read it and return ONLY a JSON object (no prose):',
  '{ "isBillScreen": boolean, "billNumber": string|null, "dialogOpen": boolean,',
  '  "shipper": { "code": string|null, "name": string|null, "address1": string|null, "address2": string|null, "city": string|null, "province": string|null, "postalCode": string|null, "phone": string|null, "contact": string|null },',
  '  "consignee": { same fields },',
  '  "pickup": { "from": string|null, "to": string|null, "apptRequired": boolean|null, "apptMade": boolean|null },',
  '  "delivery": { "from": string|null, "to": string|null, "apptRequired": boolean|null, "apptMade": boolean|null },',
  '  "startZone": string|null, "endZone": string|null }',
  'code = the customer code: the number in the first white box right under the "Shipper" / "Consignee" heading, after the small grey "F" (e.g. 37694, 51778). Read BOTH codes — never leave one null when a number is there. province = the 2-letter state. Dates / times exactly as shown (e.g. "11/11/2026 3:00").',
  'Text that is cut off at the edge: give what is visible. null when a field is blank.',
  'dialogOpen is true if any pop-up, message box, question or error is showing. isBillScreen is false for any other window, a login screen or a blank screen.',
].join('\n');

const PROMPT = (trailer) => [
  `This is a screenshot from TruckMate (trucking software). We expect the "Reefer Events for Trailer ${trailer}" window.`,
  'Read it and return ONLY a JSON object (no prose):',
  '{ "isReeferEvents": boolean, "trailer": string|null, "eventTime": string|null, "trip": string|null,',
  '  "mode": string|null, "powerOn": boolean|null, "tempUnits": "F"|"C"|null,',
  '  "setTemp": number|null, "returnTemp": number|null, "supplyTemp": number|null, "sensorTemp": number|null,',
  '  "compartments": [{ "n": number, "set": number|null, "return": number|null, "supply": number|null }],',
  '  "fuelLevel": string|null, "location": string|null,',
  '  "latestAlarm": { "time": string|null, "code": string|null, "description": string|null } | null }',
  'Use the NEWEST event (the highlighted / top row and the fields above it). Numbers exactly as shown; null when a field is blank.',
  'sensorTemp is the first value in the Reefer "Sensors" row (the box / current temperature); 0.0 next to blanks means no sensor — use null then.',
  'isReeferEvents is false if this is any other window, a dialog, an error, a login screen or a blank screen.',
].join('\n');

export function initReeferAgent(app, { requireAuth, requireAdmin, db, getBoard, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const iso = () => new Date(now()).toISOString();
  const model = env.REEFER_AGENT_MODEL || env.RATECON_MODEL || 'claude-haiku-4-5-20251001';

  async function agentOk(req) {
    const k = String(req.get('x-agent-key') || '');
    const stored = enabled ? await db.get(KEYS.key, null) : null;
    return !!(k && stored && stored.hash && crypto.timingSafeEqual(Buffer.from(hash(k)), Buffer.from(stored.hash)));
  }
  const agentOnly = (fn) => async (req, res) => { if (!(await agentOk(req))) return res.status(401).json({ error: 'Agent key missing or wrong.' }); return fn(req, res); };

  async function read(png, trailer, prompt = PROMPT(trailer)) {
    const key = env.ANTHROPIC_API_KEY || '';
    if (!key) throw new Error('AI reader not configured (ANTHROPIC_API_KEY).');
    const r = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: prompt }] }] }),
    });
    if (!r.ok) throw new Error(`AI error (${r.status})`);
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  }
  async function keepShot(kind, trailer, png, note) {
    await db.update(KEYS.shots, (cur) => [{ id: crypto.randomBytes(6).toString('hex'), at: iso(), kind, trailer: trailer || null, note: note || null, png }, ...(Array.isArray(cur) ? cur : [])].slice(0, 3), []);
  }

  // ---- the agent's side (its own key) ----
  app.get('/reefer-agent/jobs', agentOnly(async (req, res) => {
    const recipe = (await db.get(KEYS.recipe, null)) || null;
    // freight bills to read (only once an admin set the bill recipe): new bills, and bills TruckMate changed since
    // and customer profiles' Notes for the shippers / consignees on those bills (once the customer recipe is set)
    const billJobs = async (board) => {
      const [billRecipe, custRecipe, bills, customers] = await Promise.all([db.get(KEYS.billRecipe, null), db.get(KEYS.custRecipe, null), db.get(KEYS.bills, {}), db.get(KEYS.customers, {})]);
      const sets = [];
      if (billRecipe && billRecipe.steps && billRecipe.steps.length) sets.push({ kind: 'bill', recipe: billRecipe, items: billsToRead((board && board.trips) || [], bills || {}).map((x) => ({ value: x.bill, trip: x.trip, updated: x.updated })) });
      const ltlTrips = new Set(((board && board.trips) || []).filter((it) => it._manifest && (it._manifest.stops || []).length).map(tripNo));
      if (custRecipe && custRecipe.steps && custRecipe.steps.length) sets.push({ kind: 'customer', recipe: custRecipe, items: customersToRead(bills || {}, customers || {}, { now: now(), ltlTrips }).map((x) => ({ value: x.value, trip: x.trip })) });
      return sets.length ? { sets } : {};
    };
    // every EVERY_MIN: until then the hourly check-in gets no trailers (and its empty run isn't recorded)
    const last = ((await db.get(KEYS.runs, [])) || []).find((r) => r.of > 0);
    const board = getBoard ? await getBoard(SITE).catch(() => ({ trips: [] })) : { trips: [] };
    if (last && now() - Date.parse(last.at) < (EVERY_MIN - 10) * MIN) return res.json({ recipe: recipe && recipe.steps && recipe.steps.length ? recipe : null, trailers: [], ...(await billJobs(board)), intervalMin: EVERY_MIN, nextAt: new Date(Date.parse(last.at) + EVERY_MIN * MIN).toISOString() });
    const noTemp = (await db.get(KEYS.noTemp, {})) || {};
    res.json({ recipe: recipe && recipe.steps && recipe.steps.length ? recipe : null, trailers: trailersToRead((board && board.trips) || [], 40, { noTemp, now: now() }), ...(await billJobs(board)), intervalMin: EVERY_MIN });
  }));
  // a screenshot: { kind: 'calibrate' | 'reading', trailer, trip, png (base64) } → for a reading: { ok, stop } (stop = not the expected window)
  app.post('/reefer-agent/shot', agentOnly(async (req, res) => {
    const b = req.body || {};
    const png = String(b.png || '');
    if (!png || png.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Send one PNG screenshot (base64, under 9 MB).' });
    try {
      if (b.kind === 'customer') {
        const code = codeKey(b.value).slice(0, 12);
        const r = await read(png, code, CUSTOMER_PROMPT(code));
        const same = r && codeKey(r.code).replace(/^0+/, '') === code.replace(/^0+/, '');
        if (!r || !r.isProfileScreen || r.dialogOpen || !same) {
          const why = !r || !r.isProfileScreen ? 'That is not the customer profile screen.' : r.dialogOpen ? 'A pop-up / message is showing.' : `The screen shows customer ${r.code || '(none)'}, not ${code}.`;
          await keepShot('unexpected', code, png, why);
          return res.json({ ok: false, stop: true, dialog: !!(r && r.dialogOpen), why });
        }
        // one profile can take several shots (Notes, then contacts): each adds what it shows
        const list = (x) => (Array.isArray(x) ? x.filter(Boolean).slice(0, 30) : []);
        const saved = await db.update(KEYS.customers, (cur) => {
          const prev = (cur || {})[code] || {};
          const visit = prev.visitAt && now() - Date.parse(prev.visitAt) < 30 * MIN;   // the shots of one visit add up; a new visit starts over
          const base = visit ? { ...prev } : { code, visitAt: iso(), phones: [], emails: [] };
          const next = { ...base, at: iso(), code, name: r.name || base.name || prev.name || null };
          if (r.panel === 'address') Object.assign(next, { address: [r.address, r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null, contact: r.contact || null, boxNotes: r.instructions || null });
          if (r.panel === 'notes') next.profileNotes = r.notes || null;
          // Notes for Client: the Consignee tab is what the driver needs at delivery, the Shipper tab at pickup
          if (r.panel === 'clientNotes' && r.clientNotesTab === 'consignee') next.deliveryNotes = r.notes || null;
          if (r.panel === 'clientNotes' && r.clientNotesTab === 'shipper') next.pickupNotes = r.notes || null;
          if (r.panel === 'shipping') next.shipping = list(r.shippingOptions).filter((o) => o.checked).map((o) => String(o.text || '').trim()).filter(Boolean);
          next.phones = [...list(base.phones), ...list(r.phones)].filter((x, i, a) => x && x.number && a.findIndex((y) => String(y.number).replace(/\D/g, '') === String(x.number).replace(/\D/g, '')) === i);
          next.emails = [...list(base.emails), ...list(r.emails)].filter((x, i, a) => x && x.email && a.findIndex((y) => String(y.email).toLowerCase() === String(x.email).toLowerCase()) === i);
          // what drivers need, all in one place: what's typed in the Address boxes, the Notes, the checked shipping options
          next.notes = [next.deliveryNotes, next.boxNotes, next.profileNotes, ...(next.shipping || []), next.pickupNotes ? `At pickup: ${next.pickupNotes}` : null].filter(Boolean).join('\n').slice(0, 4000) || null;
          return { ...(cur || {}), [code]: next };
        }, {});
        // and on our customer profile (Customers & brokers): instructions, phones and emails
        await db.update(`taProfiles:${SITE}`, (cur) => applyTruckMateCustomer(cur || {}, saved[code], iso()).profiles, {}).catch((e) => console.warn('[reefer-agent] profile:', e.message));
        return res.json({ ok: true });
      }
      if (b.kind === 'bill') {
        const bill = String(b.value || b.bill || '').slice(0, 20);
        const r = await read(png, bill, BILL_PROMPT(bill));
        const same = r && r.billNumber && String(r.billNumber).toUpperCase().replace(/[^A-Z0-9]/g, '') === bill.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!r || !r.isBillScreen || r.dialogOpen || !same) {
          const why = !r || !r.isBillScreen ? 'That is not the bill screen.' : r.dialogOpen ? 'A pop-up / message is showing.' : `The screen shows bill ${r.billNumber || '(none)'}, not ${bill}.`;
          await keepShot('unexpected', bill, png, why);
          return res.json({ ok: false, stop: true, dialog: !!(r && r.dialogOpen), why });
        }
        const { isBillScreen, dialogOpen, ...screen } = r;
        await db.update(KEYS.bills, (cur) => ({ ...(cur || {}), [bill]: { at: iso(), bill, trip: String(b.trip || '') || null, updated: String(b.updated || '') || null, screen } }), {});
        return res.json({ ok: true });
      }
      if (b.kind !== 'reading') { await keepShot('calibrate', null, png, String(b.note || '').slice(0, 200)); return res.json({ ok: true }); }
      const trailer = String(b.trailer || '').slice(0, 20);
      const r = await read(png, trailer);
      if (!r || !r.isReeferEvents || (r.trailer && unit(r.trailer) !== unit(trailer))) {
        await keepShot('unexpected', trailer, png, r && r.isReeferEvents ? `showed trailer ${r.trailer}` : 'not a Reefer Events window');
        return res.json({ ok: false, stop: true, why: r && r.isReeferEvents ? `The window shows trailer ${r.trailer}, not ${trailer}.` : 'That is not the Reefer Events window.' });
      }
      await db.update(KEYS.readings, (cur) => ({ ...(cur || {}), [unit(trailer)]: { at: iso(), trailer, trip: String(b.trip || '') || null, reading: r } }), {});
      // no Thermo King reading on an active temperature load → a strike toward "doesn't track temp"
      const hasTemp = [r.returnTemp, r.setTemp, r.supplyTemp, ...((r.compartments || []).flatMap((c) => [c.return, c.set, c.supply]))].some((v) => v != null) || !!r.eventTime;
      const board = getBoard ? await getBoard(SITE).catch(() => null) : null;
      const item = board ? (board.trips || []).find((it) => tripNo(it) === String(b.trip || '')) : null;
      const tempLoad = !!(item && loadTarget(item));
      await db.update(KEYS.noTemp, (cur) => { const all = { ...(cur || {}) }; const k = unit(trailer); const next = noteRead(all[k], { trip: String(b.trip || ''), hasTemp, tempLoad, at: iso() }); if (next) all[k] = { ...next, trailer }; else delete all[k]; return all; }, {});
      return res.json({ ok: true });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }));
  app.post('/reefer-agent/run', agentOnly(async (req, res) => {
    const b = req.body || {};
    const run = { at: iso(), read: Number(b.read) || 0, of: Number(b.of) || 0, stopped: String(b.stopped || '').slice(0, 200) || null, agent: String(b.agent || '').slice(0, 60) || null };
    run.bills = Number(b.bills) || 0; run.billsOf = Number(b.billsOf) || 0; run.customers = Number(b.customers) || 0; run.customersOf = Number(b.customersOf) || 0;
    if (!run.of && !run.stopped && !run.billsOf && !run.customersOf) return res.json({ ok: true, skipped: true });   // an hourly check-in between the 2-hour reads
    await db.update(KEYS.runs, (cur) => [run, ...(Array.isArray(cur) ? cur : [])].slice(0, 24), []);
    // only trailers still on the board keep a reading
    const board = getBoard ? await getBoard(SITE).catch(() => null) : null;
    if (board) {
      const on = new Set(trailersToRead(board.trips || [], 500).map((x) => unit(x.trailer))); await db.update(KEYS.readings, (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([k]) => on.has(k))), {});
      const live = new Set((board.trips || []).flatMap((it) => (it.freightBills || it.orders || []).map((x) => String((x && x.billNumber) || '').trim())));
      await db.update(KEYS.bills, (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([k]) => live.has(k))), {});
    }
    res.json({ ok: true });
  }));

  // ---- enrollment: the agent asks once, an admin approves it in the console, the agent picks up its key ----
  const ENROLL = 'taReeferAgentEnroll';
  app.post('/reefer-agent/enroll', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const id = String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (id.length < 16) return res.status(400).json({ error: 'Send a random id (16+ characters).' });
    const cur = (await db.get(ENROLL, null)) || null;
    if (cur && cur.id === id && cur.key) { await db.set(ENROLL, { ...cur, key: null, pickedUpAt: iso() }); return res.json({ approved: true, key: cur.key }); }   // handed over once
    if (cur && cur.id === id) return res.json({ approved: false, waiting: true });
    if (cur && !cur.pickedUpAt && !cur.key && Date.now() - Date.parse(cur.at) < 30 * MIN) return res.status(409).json({ error: 'Another agent is already waiting for approval.' });
    await db.set(ENROLL, { id, at: iso(), machine: String(b.machine || '').slice(0, 60) || null, key: null });
    res.json({ approved: false, waiting: true });
  });
  app.post('/truckmate/reefer-agent/approve', requireAdmin, async (req, res) => {
    const cur = (await db.get(ENROLL, null)) || null;
    if (!cur || cur.pickedUpAt || Date.now() - Date.parse(cur.at) > 30 * MIN) return res.status(404).json({ error: 'No agent is waiting for approval (run the agent first).' });
    const k = `RA-${crypto.randomBytes(24).toString('base64url')}`;
    await db.set(KEYS.key, { hash: hash(k), at: iso(), by: (req.user && (req.user.name || req.user.email)) || 'admin', machine: cur.machine });
    await db.set(ENROLL, { ...cur, key: k, approvedAt: iso() });
    res.json({ ok: true, machine: cur.machine, note: 'Approved. The agent picks up its key on its next try; the old key (if any) stops working.' });
  });
  app.get('/truckmate/reefer-agent/enroll', requireAdmin, async (req, res) => { const cur = (await db.get(ENROLL, null)) || null; res.json(cur ? { waiting: !cur.approvedAt && !cur.pickedUpAt, machine: cur.machine, at: cur.at, approvedAt: cur.approvedAt || null, pickedUpAt: cur.pickedUpAt || null } : { waiting: false }); });

  // ---- admins ----
  app.post('/truckmate/reefer-agent/key', requireAdmin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const k = `RA-${crypto.randomBytes(24).toString('base64url')}`;
    await db.set(KEYS.key, { hash: hash(k), at: iso(), by: (req.user && (req.user.name || req.user.email)) || 'admin' });
    res.json({ key: k, note: 'Shown once. Put it in the agent config on the TruckMate desktop; making a new key stops the old one.' });
  });
  // the list: trailers with no Thermo King reading on active temperature loads (flagged ones are skipped)
  app.get('/truckmate/reefer-agent/no-temp', requireAuth, async (req, res) => {
    const all = Object.values((await db.get(KEYS.noTemp, {})) || {});
    res.json({ flagged: all.filter((e) => e.flaggedAt).sort((a, b) => String(b.flaggedAt).localeCompare(String(a.flaggedAt))), watching: all.filter((e) => !e.flaggedAt).sort((a, b) => b.loads.length - a.loads.length), rule: `${NO_TEMP_LOADS} active temperature loads with no reading → flagged and skipped; re-checked every ${RECHECK_DAYS} days` });
  });
  app.get('/truckmate/reefer-agent/status', requireAdmin, async (req, res) => {
    const [recipe, runs, shots, readings, key, billRecipe, bills, custRecipe, customers] = await Promise.all([db.get(KEYS.recipe, null), db.get(KEYS.runs, []), db.get(KEYS.shots, []), db.get(KEYS.readings, {}), db.get(KEYS.key, null), db.get(KEYS.billRecipe, null), db.get(KEYS.bills, {}), db.get(KEYS.custRecipe, null), db.get(KEYS.customers, {})]);
    res.json({ keySet: !!(key && key.hash), recipe, billRecipe, custRecipe, customers: Object.values(customers || {}), runs: runs || [], shots: (shots || []).map(({ png, ...s }) => s), readings: Object.values(readings || {}), bills: Object.values(bills || {}) });
  });
  app.get('/truckmate/reefer-agent/shot/:id', requireAdmin, async (req, res) => {
    const s = ((await db.get(KEYS.shots, [])) || []).find((x) => x.id === String(req.params.id));
    if (!s) return res.status(404).end();
    res.type('png').send(Buffer.from(s.png, 'base64'));
  });
  app.put('/truckmate/reefer-agent/recipe', requireAdmin, async (req, res) => {
    const c = cleanRecipe(req.body || {});
    if (!c.ok) return res.status(400).json({ error: c.error });
    await db.set(KEYS.recipe, { ...c.recipe, by: (req.user && (req.user.name || req.user.email)) || 'admin', at: iso() });
    res.json(c.recipe);
  });

  // the bill screen recipe: open one bill by its number ({bill}) and screenshot it, then close it. /off turns it off.
  app.put('/truckmate/reefer-agent/bill-recipe', requireAdmin, async (req, res) => {
    const c = cleanRecipe(req.body || {});
    if (!c.ok) return res.status(400).json({ error: c.error.replace('Reefer Events window', 'bill screen') });
    if (!c.recipe.steps.some((x) => x.do === 'type' && x.text === '{bill}')) return res.status(400).json({ error: 'The bill recipe has to type the bill number ({bill}).' });
    await db.set(KEYS.billRecipe, { ...c.recipe, by: (req.user && (req.user.name || req.user.email)) || 'admin', at: iso() });
    res.json(c.recipe);
  });
  // the customer Notes recipe: open one customer profile by its code ({code}) on the Notes panel and screenshot it
  app.put('/truckmate/reefer-agent/customer-recipe', requireAdmin, async (req, res) => {
    const c = cleanRecipe(req.body || {});
    if (!c.ok) return res.status(400).json({ error: c.error.replace('Reefer Events window', 'customer Notes screen') });
    if (!c.recipe.steps.some((x) => x.do === 'type' && x.text === '{code}')) return res.status(400).json({ error: 'The customer recipe has to type the customer code ({code}).' });
    await db.set(KEYS.custRecipe, { ...c.recipe, by: (req.user && (req.user.name || req.user.email)) || 'admin', at: iso() });
    res.json(c.recipe);
  });
  app.post('/truckmate/reefer-agent/customer-recipe/off', requireAdmin, async (req, res) => { await db.set(KEYS.custRecipe, null); res.json({ ok: true, off: true }); });
  app.post('/truckmate/reefer-agent/bill-recipe/off', requireAdmin, async (req, res) => { await db.set(KEYS.billRecipe, null); res.json({ ok: true, off: true }); });

  // every board build: the latest TruckMate (Thermo King) reading on the load's trailer
  async function overlay(site, trips) {
    if (!enabled) return;
    const all = (await db.get(KEYS.readings, {})) || {};
    for (const it of trips) { const r = all[unit(tripOf(it).trailer)]; if (r && now() - Date.parse(r.at) < 3 * 60 * MIN) it._tkReefer = r; }
    // the Shipper / Consignee boxes read off each bill: on the bill (geofences, Jarvis) and the load's list of places
    const bills = (await db.get(KEYS.bills, {})) || {};
    if (!Object.keys(bills).length) return;
    const customers = (await db.get(KEYS.customers, {})) || {};
    for (const it of trips) {
      for (const b of (it.freightBills || it.orders || [])) {
        const r = b && bills[String(b.billNumber || '').trim()];
        if (!r || !r.screen) continue;
        if (!(b.shipper && b.shipper.address1) && r.screen.shipper) b.shipper = r.screen.shipper;
        if (!(b.consignee && b.consignee.address1) && r.screen.consignee) b.consignee = r.screen.consignee;
        b._boxesReadAt = r.at;
      }
      const p = loadParties(it, bills);
      if (p) it._parties = p;
      const n = loadCustomerNotes(it, bills, customers);
      if (n) it._customerNotes = n;
    }
  }

  console.log(`[reefer-agent] TruckMate reefer screen reader ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { overlay };
}

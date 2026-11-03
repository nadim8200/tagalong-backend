// ---------------------------------------------------------------
// Load sheets: the message dispatch sends a driver for a load (FB#, TRIP#, TEMP, PU#, PICK UP, DELIVERY #1…, notes like
// "*** NO RELEASE ***", "THANKS, HS."). TruckMate only has the towns, so this message is where the driver's full load info lives:
// names, street addresses, PU numbers, appointment times, continuous or cycle, release notes, extra pay.
// A dispatcher pastes it in the console (or emails it to Jarvis); it's read into a sheet on the trip, the driver sees it organized
// in the app with what TruckMate has, and taps "OK" instead of texting it back. It can also go out by app message and / or text.
// ---------------------------------------------------------------

const SITE = 'florida-beauty';
const KEY = `taLoadSheets:${SITE}`;           // trip → sheet
const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const clean = (s) => String(s || '').replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim();
const RULE = /^\s*[-=_*~]{5,}\s*$/;
const HEAD = /^\s*(PICK\s*-?\s*UP|DELIVERY|DROP\s*OFF|STOP)\s*(?:#\s*(\d+))?\s*:\s*(.*)$/i;
const FIELD = /^\s*(FB|TRIP|TEMP|PU|PO|LOAD|REF)\s*#?\s*:\s*(.*)$/i;
const CITY = /^(.*?)[,\s]+([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/i;

// "3P M" → "3 PM", "@ASAP" → "ASAP", "08:00 AM" stays
export function cleanTime(t) {
  const s = clean(t).replace(/^@\s*/, '').replace(/(\d)\s*([AP])\s*\.?\s*M\b\.?/i, (m, d, a) => `${d}${a.toUpperCase()}M`).replace(/(\d)\s*([AP]M)\b/i, '$1 $2');
  return s || null;
}
// "11/2/26" → "2026-11-02" (null when it isn't a date)
export function isoDate(d) {
  const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
// "***28F CONTINUOS***" → { degrees: 28, unit: 'F', mode: 'continuous' }
export function readTemp(t) {
  const s = clean(t);
  if (!s) return null;
  const n = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FC])?/i);
  const mode = /CONT/i.test(s) ? 'continuous' : /CYC|START\s*\/?\s*STOP/i.test(s) ? 'cycle' : /DRY|OFF/i.test(s) ? 'off' : null;
  return { degrees: n ? Number(n[1]) : null, unit: n && n[2] ? n[2].toUpperCase() : (n ? 'F' : null), mode, text: s };
}
const list = (s) => clean(s).split(/\s*[,;/]\s*|\s{2,}/).map((x) => x.trim()).filter(Boolean);

// A dispatch message → a load sheet. Pure; null when it isn't one.
export function parseDispatchMessage(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const sheet = { bill: null, trip: null, temp: null, pickupNumbers: [], refs: [], notes: [], stops: [], from: null };
  let stop = null; let pendingField = null; let seenStop = false;
  const endStop = () => { if (stop) { sheet.stops.push(stop); stop = null; } };
  const noteOut = (n) => { const last = stop || sheet.stops[sheet.stops.length - 1]; if (last) (last.notesAfter = last.notesAfter || []).push(n); else sheet.notes.push(n); };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (RULE.test(line)) { endStop(); pendingField = null; continue; }
    // sign-off: "PLEASE CONFIRM WITH "OK" … THANKS, HS."
    if (/PLEASE\s+CONFIRM|CONFIRM\s+WITH/i.test(line)) { endStop(); continue; }
    const thanks = line.match(/THANKS?\s*,?\s*([A-Z][A-Z .'-]{0,30}?)\.?\s*$/i);
    if (thanks && /THANK/i.test(line) && !stop) { if (clean(thanks[1]) && !/^YOU$/i.test(clean(thanks[1]))) sheet.from = clean(thanks[1]); continue; }
    if (/^THANKS?\s*,?\s*$/i.test(line) || /^RECEIVE THIS MESSAGE/i.test(line)) continue;
    // the value of the last field on its own line ("FB#:" then "B180764")
    if (pendingField && !FIELD.test(line) && !HEAD.test(line)) { take(pendingField, line); pendingField = null; continue; }
    const f = line.match(FIELD);
    if (f && !stop) { if (clean(f[2])) take(f[1].toUpperCase(), f[2]); else pendingField = f[1].toUpperCase(); continue; }
    const h = line.match(HEAD);
    if (h && !/^\s*(DATE|TIME)/i.test(line)) {
      endStop(); seenStop = true;
      const kind = /PICK/i.test(h[1]) ? 'pickup' : 'delivery';
      stop = { kind, n: h[2] ? Number(h[2]) : null, name: null, street: [], city: null, state: null, zip: null, date: null, dateIso: null, time: null, other: [], notesAfter: [] };
      if (clean(h[3])) stop.name = clean(h[3]);
      continue;
    }
    if (stop) {
      const dt = line.match(/DATE\s*:?\s*([0-9/]+)?\s*(?:TIME\s*:?\s*(.*))?$/i);
      if (/^\s*(DATE|TIME)\s*:/i.test(line) && dt) {
        if (dt[1]) { stop.date = dt[1]; stop.dateIso = isoDate(dt[1]); }
        const tm = (dt[2] != null ? dt[2] : (line.match(/TIME\s*:?\s*(.*)$/i) || [])[1]);
        if (tm != null && cleanTime(tm)) stop.time = cleanTime(tm);
        continue;
      }
      if (/^\s*\*{2,}/.test(line) || /\*{2,}\s*$/.test(line)) { stop.notesAfter.push(clean(line)); continue; }
      const c = line.match(CITY);
      if (!stop.name) stop.name = clean(line);
      else if (c && !stop.city) { stop.city = clean(c[1]).replace(/,$/, ''); stop.state = c[2].toUpperCase(); stop.zip = c[3]; }
      else if (!stop.city) stop.street.push(clean(line));
      else stop.other.push(clean(line));
      continue;
    }
    // anything else outside a stop is a note for the driver ("$70 extra short run", "*** NO RELEASE ***")
    if (clean(line)) noteOut(clean(line));
  }
  endStop();
  function take(k, v) {
    if (k === 'FB') sheet.bill = clean(v).split(/\s+/)[0].toUpperCase();
    else if (k === 'TRIP') sheet.trip = (clean(v).match(/\d{5,8}/) || [null])[0];
    else if (k === 'TEMP') sheet.temp = readTemp(v);
    else if (k === 'PU' || k === 'PO') sheet.pickupNumbers.push(...list(v));
    else sheet.refs.push(`${k}# ${clean(v)}`);
  }
  // numbered in order when the message didn't number them
  let p = 0; let d = 0;
  for (const s of sheet.stops) { if (s.kind === 'pickup') { p += 1; s.n = s.n || p; } else { d += 1; s.n = s.n || d; } s.street = s.street.join(', ') || null; s.other = s.other.length ? s.other : undefined; if (!s.notesAfter.length) delete s.notesAfter; }
  sheet.pickupNumbers = [...new Set(sheet.pickupNumbers)];
  if (!seenStop && !sheet.trip && !sheet.bill) return null;
  if (!(sheet.trip || sheet.bill) || !sheet.stops.length) return null;
  return sheet;
}
// cheap check before reading an email as a load message
export const looksLikeDispatchMessage = (text) => /\bTRIP\s*#\s*:/i.test(text) && /\bPICK\s*-?\s*UP\b/i.test(text) && /\bDELIVERY\b/i.test(text);

// Google Maps search link for a stop's address. Pure.
export const mapsLink = (s) => { const q = [s.name, s.street, [s.city, s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null; };

// The trip a sheet belongs to: its TRIP#, else the board load with its FB#. Pure.
export function tripForSheet(sheet, items = []) {
  if (!sheet) return null;
  if (sheet.trip) return String(sheet.trip);
  const it = items.find((x) => billsOf(x).some((b) => String(b.billNumber || '').toUpperCase() === sheet.bill));
  return it ? String(tripOf(it).tripNumber) : null;
}
// What the driver sees: the sheet with the map links (stored sheets stay plain). Pure.
export const forDriver = (s) => (s ? { ...s, raw: undefined, stops: (s.stops || []).map((x) => ({ ...x, map: mapsLink(x) })) } : null);

export function initLoadSheets(app, { requireAuth, db, getBoard = null, sendApp = null, sendText = null, log = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async () => (enabled ? (await db.get(KEY, {})) || {} : {});
  const board = async () => (getBoard ? (((await getBoard(SITE)) || {}).trips || []) : []);
  const get = async (trip) => (await all())[String(trip)] || null;
  async function save(sheet, raw, by, trip) {
    const rec = { ...sheet, trip: String(trip), raw: String(raw).slice(0, 4000), by, at: new Date(now()).toISOString(), confirmedAt: null, confirmedBy: null };
    await db.update(KEY, (cur) => {
      const next = { ...(cur || {}), [rec.trip]: rec };
      const keep = Object.values(next).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 600);   // the newest 600 loads
      return Object.fromEntries(keep.map((x) => [x.trip, x]));
    }, {});
    if (log) await log(SITE, rec.trip, { type: 'note', kind: 'load-sheet', text: `Load info for the driver saved (${rec.stops.length} stop${rec.stops.length === 1 ? '' : 's'})`, by, noThread: true }).catch(() => {});
    return rec;
  }
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';

  // read it first (the console shows what Jarvis understood before saving)
  app.post('/truckmate/loadsheet/preview', requireAuth, async (req, res) => {
    const sheet = parseDispatchMessage((req.body || {}).text);
    if (!sheet) return res.status(400).json({ error: 'That doesn\'t look like a load message. It needs TRIP# or FB#, a PICK UP and a DELIVERY.' });
    const trip = (req.body || {}).trip ? String(req.body.trip) : tripForSheet(sheet, await board());
    res.json({ sheet: forDriver(sheet), trip, onBoard: !!trip && (await board()).some((it) => String(tripOf(it).tripNumber) === trip) });
  });
  // save it on the trip, and send it: app (the driver's load chat, a push when the app is installed) and / or a text
  app.post('/truckmate/loadsheet', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const b = req.body || {};
    const sheet = parseDispatchMessage(b.text);
    if (!sheet) return res.status(400).json({ error: 'That doesn\'t look like a load message. It needs TRIP# or FB#, a PICK UP and a DELIVERY.' });
    const trip = b.trip ? String(b.trip) : tripForSheet(sheet, await board());
    if (!trip) return res.status(400).json({ error: 'Which trip is it? Add TRIP# to the message.' });
    const rec = await save(sheet, b.text, who(req), trip);
    const via = Array.isArray(b.via) ? b.via : [];
    const sent = {};
    const body = String(b.text).trim();
    if (via.includes('app')) sent.app = sendApp ? await sendApp(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    if (via.includes('text')) sent.text = sendText ? await sendText(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    res.json({ ok: true, trip, sheet: forDriver(rec), sent });
  });
  app.get('/truckmate/loadsheet/:trip', requireAuth, async (req, res) => res.json({ sheet: forDriver(await get(req.params.trip)) }));

  // a dispatcher emailed the load message to Jarvis → saved on the trip (nothing is sent). → the saved sheet or null
  async function fromEmail(site, { text, from }) {
    if (!enabled || !looksLikeDispatchMessage(text)) return null;
    const sheet = parseDispatchMessage(text);
    const trip = tripForSheet(sheet, await board());
    return trip ? save(sheet, text, `${(from && (from.name || from.address)) || 'dispatch'} (email)`, trip) : null;
  }
  // the driver tapped OK
  async function confirm(trip, by) {
    const at = new Date(now()).toISOString();
    let out = null;
    await db.update(KEY, (cur) => { const c = { ...(cur || {}) }; if (c[trip]) { c[trip] = { ...c[trip], confirmedAt: at, confirmedBy: by }; out = c[trip]; } return c; }, {});
    if (out && log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `OK — ${by} confirmed the load info`, noThread: true }).catch(() => {});
    return out;
  }
  // on the board for the console: has a sheet, and whether the driver said OK
  async function overlay(site, trips) {
    const s = await all();
    for (const it of trips || []) { const r = s[String(tripOf(it).tripNumber)]; if (r) it._loadSheet = { at: r.at, by: r.by, confirmedAt: r.confirmedAt, confirmedBy: r.confirmedBy }; }
  }
  return { get, fromEmail, confirm, overlay, forDriver };
}

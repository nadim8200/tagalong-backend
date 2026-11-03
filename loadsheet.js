// ---------------------------------------------------------------
// Load sheets: the message dispatch sends a driver for a load (FB#, TRIP#, TEMP, PU#, PICK UP, DELIVERY #1…, notes like
// "*** NO RELEASE ***", "THANKS, HS."). TruckMate only has the towns, so this message is where the driver's full load info lives:
// names, street addresses, PU numbers, appointment times, continuous or cycle, release notes, extra pay.
// A dispatcher pastes it in the console (or emails it to Jarvis); it's read into a sheet on the trip, the driver sees it organized
// in the app with what TruckMate has, and taps "OK" instead of texting it back. It can also go out by app message and / or text.
// ---------------------------------------------------------------

const SITE = 'florida-beauty';
const KEY = `taLoadSheets:${SITE}`;           // trip → sheet
const YARDS = `taYards:${SITE}`;              // NAME → { name, address }: dispatch types a yard's address once
// Florida Beauty's own yards (Nov 3, 2026). An address dispatch saves for one of these wins.
export const KNOWN_YARDS = {
  MIAMI: { name: 'Miami yard', address: '2355 NW 70th Ave, Miami, FL 33122' },
  VENTURA: { name: 'Ventura yard', address: '6205 Ventura Blvd, Ventura, CA 93003' },
  MEMPHIS: { name: 'Memphis yard', address: '11153 HWY 178, Olive Branch, MS 38654' },
  BARTOW: { name: 'Bartow yard', address: '5361 Rifle Range Rd, Bartow, FL 33830' },
};
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
  let releaseAt = null;
  // a release: the trailer goes to a yard after the stops so far; the stops after it are delivered from the yard (not by this driver)
  const isRelease = (n) => { const r = readRelease(n); if (!r) return false; sheet.release = r; releaseAt = sheet.stops.length + (stop ? 1 : 0); return true; };
  const noteOut = (n) => { if (isRelease(n)) return; const last = stop || sheet.stops[sheet.stops.length - 1]; if (last) (last.notesAfter = last.notesAfter || []).push(n); else sheet.notes.push(n); };
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
      if (/^\s*\*{2,}/.test(line) || /\*{2,}\s*$/.test(line)) { if (!isRelease(line)) stop.notesAfter.push(clean(line)); continue; }
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
  if (sheet.release) sheet.release.stops = sheet.stops.map((x, i) => (i >= releaseAt && x.kind === 'delivery' ? i : null)).filter((i) => i != null);
  else sheet.release = null;
  if (!seenStop && !sheet.trip && !sheet.bill) return null;
  if (!(sheet.trip || sheet.bill) || !sheet.stops.length) return null;
  return sheet;
}
// "FREE RELEASE BARTOW YARD", "PAID RELEASE @ MIAMI YARD" → { type, yard }. "NO RELEASE" isn't one. Pure.
export function readRelease(line) {
  const m = clean(line).match(/\b(FREE|PAID)\s+RELEASE\b\s*(?:AT|@|IN|TO|-|:)?\s*(.*)$/i);
  if (!m) return null;
  const yard = clean(m[2]).replace(/\byard\b\.?/i, '').trim();
  return { type: m[1].toLowerCase(), yard: yard ? yard.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : null };
}
const yardKey = (n) => clean(n).toUpperCase().replace(/\s+YARD$/, '');
export const yardLabel = (n) => (n ? `${clean(n).replace(/\s+yard$/i, '')} yard` : 'the yard');

// cheap check before reading an email as a load message
export const looksLikeDispatchMessage = (text) => /\bTRIP\s*#\s*:/i.test(text) && /\bPICK\s*-?\s*UP\b/i.test(text) && /\bDELIVERY\b/i.test(text);

// A rate con's load as the driver's load info, when dispatch hasn't sent a message: the stops (name, street, town, date and time),
// pickup numbers, the temperature and mode, and the handwritten notes for the driver ("No release", "$75 bonus"). Never the rate, the
// broker's contacts or penalties. Pure → a sheet, or null when the rate con has no stops.
const isoFrom = (d) => { const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) || String(d || '').match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; if (m[1].length === 4) return `${m[1]}-${m[2]}-${m[3]}`; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const looksStreet = (x) => /^\d+\s+\S/.test(String(x || '').trim());
const OWN_NOTE = /^(tr(uck)?\.?\s*#?\s*)?\d{3,4}$|^part\s*#?\s*\d+$|^p\s*\/\s*u\b|^-?\d+\s*°?\s*f\b/i;   // truck number, "Part 2", pickup time, the temperature: shown elsewhere
export function sheetFromRateCon(rc, { trip = null } = {}) {
  if (!rc || !((rc.pickups || []).length || (rc.deliveries || []).length)) return null;
  const hand = (rc.handwrittenNotes || []).map((x) => clean(x)).filter(Boolean);
  const tempText = rc.tempSetting || hand.find((x) => /-?\d+\s*°?\s*F\b/i.test(x)) || null;
  const temp = tempText ? readTemp(`${tempText}${!/cont|cyc/i.test(tempText) && hand.some((x) => /\bcont/i.test(x)) ? ' CONTINUOUS' : ''}`) : null;
  const stop = (kind) => (x) => {
    const street = x.address || (looksStreet(x.refs) ? x.refs : null);
    const date = x.date || null;
    return { kind, n: null, name: clean(x.name) || null, street: street ? clean(street) : null, city: clean(x.city) || null, state: clean(x.state).toUpperCase() || null, zip: clean(x.zip) || null,
      date, dateIso: isoFrom(date), time: cleanTime(x.appointment || x.time) || null, ...(x.refs && !looksStreet(x.refs) ? { other: [clean(x.refs)] } : {}) };
  };
  const stops = [...(rc.pickups || []).map(stop('pickup')), ...(rc.deliveries || []).map(stop('delivery'))];
  // "P/U 11/4 ASAP" written by hand: the pickup's date and time when the rate con doesn't print one
  const puNote = hand.map((x) => x.match(/^p\s*\/\s*u\b\s*:?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*@?\s*(.*)$/i)).find(Boolean);
  const firstPu = stops.find((x) => x.kind === 'pickup');
  if (puNote && firstPu && !firstPu.dateIso) {
    const year = ((stops.find((x) => x.dateIso) || {}).dateIso || new Date().toISOString()).slice(0, 4);
    if (puNote[1]) { firstPu.date = puNote[1]; firstPu.dateIso = isoFrom(puNote[1].split('/').length === 2 ? `${puNote[1]}/${year}` : puNote[1]); }
    if (!firstPu.time && clean(puNote[2])) firstPu.time = cleanTime(puNote[2]);
  }
  let p = 0; let d = 0; for (const s0 of stops) { if (s0.kind === 'pickup') { p += 1; s0.n = p; } else { d += 1; s0.n = d; } }
  const rel = hand.map(readRelease).find(Boolean) || null;
  const notes = hand.filter((x) => x.length > 3 && !OWN_NOTE.test(x) && !readRelease(x) && !/cont(inuous)?\.?$/i.test(x));
  const pu = [...new Set([rc.loadNumber, ...(rc.pickups || []).map((x) => x.refs).filter((r) => r && !looksStreet(r))].filter(Boolean).map((x) => clean(x)))];
  return { bill: rc.fbfBillNumber ? String(rc.fbfBillNumber).toUpperCase() : null, trip: trip ? String(trip) : null, temp, pickupNumbers: pu, refs: [], notes, stops,
    from: 'the rate con', release: rel ? { ...rel, stops: [] } : null, fromRateCon: true };
}

// Google Maps search link for a stop's address. Pure.
export const mapsLink = (s) => { const q = [s.name, s.street, [s.city, s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null; };

// The trip a sheet belongs to: its TRIP#, else the board load with its FB#. Pure.
export function tripForSheet(sheet, items = []) {
  if (!sheet) return null;
  if (sheet.trip) return String(sheet.trip);
  const it = items.find((x) => billsOf(x).some((b) => String(b.billNumber || '').toUpperCase() === sheet.bill));
  return it ? String(tripOf(it).tripNumber) : null;
}
// The yard a release goes to, with its address when dispatch gave one. Pure.
const yardOf = (r, yards = {}) => { const y = yards[yardKey(r.yard)] || null; const q = y && y.address ? `${yardLabel(r.yard)}, ${y.address}` : null; return { name: yardLabel(r.yard), address: (y && y.address) || null, map: q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null }; };
// Dispatch's view: every stop with its map link, the ones going to the yard marked. Pure.
export const forConsole = (s, yards = {}) => (s ? { ...s, raw: undefined, stops: (s.stops || []).map((x, i) => ({ ...x, map: mapsLink(x), toYard: !!(s.release && (s.release.stops || []).includes(i)) })), release: s.release ? { ...s.release, ...yardOf(s.release, yards), yard: s.release.yard } : null } : null);
// What the driver sees: only the stops they deliver (the ones going to the yard are someone else's), and the release with the yard. Pure.
export const forDriver = (s, yards = {}) => {
  if (!s) return null;
  const hidden = new Set((s.release && s.release.stops) || []);
  return { ...s, raw: undefined, stops: (s.stops || []).filter((_, i) => !hidden.has(i)).map((x) => ({ ...x, map: mapsLink(x) })),
    release: s.release ? { type: s.release.type, ...yardOf(s.release, yards), hide: (s.stops || []).filter((_, i) => hidden.has(i)).map((x) => ({ zip: x.zip || null, city: x.city || null })), dropped: s.dropped || null } : null };
};

export function initLoadSheets(app, { requireAuth, db, getBoard = null, sendApp = null, sendText = null, log = null, sendMail = null, recipients = async () => [], now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async () => (enabled ? (await db.get(KEY, {})) || {} : {});
  const board = async () => (getBoard ? (((await getBoard(SITE)) || {}).trips || []) : []);
  const get = async (trip) => (await all())[String(trip)] || null;
  const yards = async () => ({ ...KNOWN_YARDS, ...(enabled ? (await db.get(YARDS, {})) || {} : {}) });
  const rememberYard = async (name, address) => { if (!name || !clean(address)) return; await db.update(YARDS, (cur) => ({ ...(cur || {}), [yardKey(name)]: { name: yardLabel(name), address: clean(address).slice(0, 200) } }), {}); };
  // dispatch's pick: which yard, free or paid, and which stops go there (null clears it). → the release as stored
  const releaseFrom = (r, stops) => {
    if (!r || !['free', 'paid'].includes(r.type)) return null;
    const ok = (Array.isArray(r.stops) ? r.stops : []).map(Number).filter((i) => Number.isInteger(i) && stops[i] && stops[i].kind === 'delivery');
    return { type: r.type, yard: clean(r.yard).replace(/\s+yard$/i, '').slice(0, 60) || null, stops: [...new Set(ok)].sort((a, b) => a - b) };
  };
  async function save(sheet, raw, by, trip) {
    const rec = { ...sheet, trip: String(trip), raw: String(raw).slice(0, 4000), by, at: new Date(now()).toISOString(), confirmedAt: null, confirmedBy: null, dropped: null };
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
    res.json({ sheet: forConsole(sheet, await yards()), trip, onBoard: !!trip && (await board()).some((it) => String(tripOf(it).tripNumber) === trip) });
  });
  // save it on the trip, and send it: app (the driver's load chat, a push when the app is installed) and / or a text
  app.post('/truckmate/loadsheet', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const b = req.body || {};
    const sheet = parseDispatchMessage(b.text);
    if (!sheet) return res.status(400).json({ error: 'That doesn\'t look like a load message. It needs TRIP# or FB#, a PICK UP and a DELIVERY.' });
    const trip = b.trip ? String(b.trip) : tripForSheet(sheet, await board());
    if (!trip) return res.status(400).json({ error: 'Which trip is it? Add TRIP# to the message.' });
    if (b.release !== undefined) { sheet.release = releaseFrom(b.release, sheet.stops); if (b.release) await rememberYard(b.release.yard, b.release.address); }
    const rec = await save(sheet, b.text, who(req), trip);
    const via = Array.isArray(b.via) ? b.via : [];
    const sent = {};
    const body = String(b.text).trim();
    if (via.includes('app')) sent.app = sendApp ? await sendApp(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    if (via.includes('text')) sent.text = sendText ? await sendText(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    res.json({ ok: true, trip, sheet: forConsole(rec, await yards()), sent });
  });
  app.get('/truckmate/loadsheet/:trip', requireAuth, async (req, res) => res.json({ sheet: forConsole(await get(req.params.trip), await yards()) }));
  // change the yard drop on a saved sheet: { type: 'free'|'paid', yard, address, stops: [stop indexes] } or { release: null }
  app.put('/truckmate/loadsheet/:trip/release', requireAuth, async (req, res) => {
    const trip = String(req.params.trip); const b = req.body || {};
    const cur = await get(trip);
    if (!cur) return res.status(404).json({ error: 'Send the load info first.' });
    const r = b.release === null ? null : releaseFrom(b, cur.stops || []);
    if (b.release !== null && !r) return res.status(400).json({ error: 'Pick free or paid release.' });
    if (r) await rememberYard(b.yard, b.address);
    await db.update(KEY, (c) => ({ ...(c || {}), [trip]: { ...(c || {})[trip], release: r } }), {});
    if (log) await log(SITE, trip, { type: 'note', kind: 'load-sheet', text: r ? `Yard drop set: ${r.type} release at ${yardLabel(r.yard)}${r.stops.length ? ` (${r.stops.length} stop${r.stops.length === 1 ? '' : 's'} from the yard)` : ''}` : 'Yard drop removed', by: who(req), noThread: true }).catch(() => {});
    res.json({ ok: true, sheet: forConsole(await get(trip), await yards()) });
  });
  app.get('/truckmate/yards', requireAuth, async (req, res) => res.json({ yards: Object.values(await yards()).sort((a, b) => a.name.localeCompare(b.name)) }));

  // a dispatcher emailed the load message to Jarvis → saved on the trip (nothing is sent). → the saved sheet or null
  async function fromEmail(site, { text, from }) {
    if (!enabled || !looksLikeDispatchMessage(text)) return null;
    const sheet = parseDispatchMessage(text);
    const trip = tripForSheet(sheet, await board());
    return trip ? save(sheet, text, `${(from && (from.name || from.address)) || 'dispatch'} (email)`, trip) : null;
  }
  // no message from dispatch yet but a rate con on the load: the driver gets the load from it (saved once; a message dispatch sends replaces it)
  async function ensureFromRateCon(item) {
    if (!enabled || !item) return null;
    const trip = String(tripOf(item).tripNumber);
    const have = await get(trip);
    if (have) return have;
    const rc = item._ratecon && (item._ratecon.data || item._ratecon);
    const sheet = sheetFromRateCon(rc, { trip });
    return sheet ? save(sheet, '(read from the rate con)', 'Jarvis (from the rate con)', trip) : null;
  }
  // the driver tapped OK
  async function confirm(trip, by) {
    const at = new Date(now()).toISOString();
    let out = null;
    await db.update(KEY, (cur) => { const c = { ...(cur || {}) }; if (c[trip]) { c[trip] = { ...c[trip], confirmedAt: at, confirmedBy: by }; out = c[trip]; } return c; }, {});
    if (out && log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `OK — ${by} confirmed the load info`, noThread: true }).catch(() => {});
    return out;
  }
  // the driver dropped the trailer at the yard (and maybe picked up another): saved on the sheet, and an email to the team
  async function dropped(trip, by, { pickedUp = null, truck = null, trailer = null } = {}) {
    const cur = await get(trip);
    if (!cur || !cur.release) return null;
    const d = { at: new Date(now()).toISOString(), by, yard: yardLabel(cur.release.yard), type: cur.release.type, pickedUp: clean(pickedUp).toUpperCase().slice(0, 20) || null };
    await db.update(KEY, (c) => ({ ...(c || {}), [trip]: { ...(c || {})[trip], dropped: d } }), {});
    const what = `Trailer ${trailer || '?'} dropped at ${d.yard}`;
    if (log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `${what}${d.pickedUp ? `, picked up trailer ${d.pickedUp}` : ''} (${by})`, noThread: true }).catch(() => {});
    const to = await recipients();
    if (sendMail && to.length) {
      const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const rows = [['Driver', by], ['Trip', trip], ['Truck', truck || 'not on file'], ['Trailer dropped', trailer || 'not on file'], ['Yard', d.yard], ['Release', d.type === 'paid' ? 'Paid release' : 'Free release'], ['Trailer picked up', d.pickedUp || 'None said'], ['Time', new Date(d.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET']];
      const hidden = (cur.release.stops || []).map((i) => cur.stops[i]).filter(Boolean);
      const left = hidden.length ? `Still to deliver from the yard: ${hidden.map((x) => [x.name, [x.city, x.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ')).join('; ')}` : null;
      await sendMail({ to, subject: `TRAILER DROPPED // ${d.yard.toUpperCase()} // TK ${truck || 'N/A'} TL ${trailer || 'N/A'} TO ${trip}${d.pickedUp ? ` // PICKED UP ${d.pickedUp}` : ''}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;max-width:600px"><p style="font-size:22px;font-weight:bold;margin:0 0 10px">${esc(what)}</p><table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6B7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>${left ? `<p>${esc(left)}</p>` : ''}<p style="color:#6B7280;font-size:13px">Sent from the driver app · Jarvis · AI Dispatcher</p></div>`,
        text: [what, ...rows.map(([k, v]) => `${k}: ${v}`), ...(left ? ['', left] : [])].join('\n') }).catch((e) => console.warn('[loadsheet] drop email:', e.message));
    }
    return d;
  }
  // on the board for the console: has a sheet, and whether the driver said OK
  async function overlay(site, trips) {
    const s = await all();
    for (const it of trips || []) { const r = s[String(tripOf(it).tripNumber)]; if (r) it._loadSheet = { at: r.at, by: r.by, confirmedAt: r.confirmedAt, confirmedBy: r.confirmedBy, release: r.release ? { type: r.release.type, yard: yardLabel(r.release.yard) } : null, dropped: r.dropped || null }; }
  }
  return { get, fromEmail, confirm, dropped, overlay, ensureFromRateCon, forDriver: async (s) => forDriver(s, await yards()) };
}

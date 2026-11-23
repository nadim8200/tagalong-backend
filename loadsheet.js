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
// The first line of what the driver gets (Nov 21, 2026): a push shows only the start of a message, so a release and a bonus
// written further down are said up top too. "🔁 FREE RELEASE · Bartow yard (after delivery #1) · 💵 BONUS $75". Pure. → string | null
export function sendHeadline(sheet) {
  if (!sheet) return null;
  const bits = [];
  const r = sheet.release;
  if (r) {
    const drops = (sheet.stops || []).map((x, i) => ({ ...x, i })).filter((x) => x.kind === 'delivery');
    const firstYard = drops.find((x) => (r.stops || []).includes(x.i));
    const done = firstYard ? drops.filter((x) => x.i < firstYard.i).length : drops.length;
    bits.push(`🔁 ${r.type === 'paid' ? 'PAID' : 'FREE'} RELEASE · ${yardLabel(r.yard)}${done ? ` (after delivery #${done})` : ' (before the deliveries)'}`);
  }
  const notes = [...(sheet.notes || []), ...(sheet.stops || []).flatMap((x) => x.notesAfter || [])];
  const b = notes.find((n) => /\b(bonus|bono)\b/i.test(n));
  const amt = b && (b.match(/\$\s*(\d{1,4}(?:\.\d{2})?)/) || [])[1];
  if (amt) bits.push(`💵 BONUS $${amt}`);
  return bits.length ? bits.join(' · ') : null;
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

// TruckMate's stops for a load: pickups from each bill's start zone, deliveries from its end zone, with TruckMate's times. Pure.
const up = (x) => String(x || '').trim().toUpperCase();
const zoneOf = (z) => { const [city, state, zip] = String(z || '').split(',').map((x) => x.trim()); return { city: city || null, state: state ? state.toUpperCase() : null, zip: /^\d{5}$/.test(zip || '') ? zip : null }; };
const tmWhen = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m) return { date: null, dateIso: null, time: null }; const h = Number(m[4]); const time = m[4] === '00' && m[5] === '00' ? null : `${((h + 11) % 12) + 1}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`; return { date: `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`, dateIso: `${m[1]}-${m[2]}-${m[3]}`, time }; };
export function truckMateStops(item) {
  const bills = (item && (item.freightBills || item.orders)) || [];
  const out = []; const seen = new Set();
  // the shipper (pickup) and consignee (receiver) records, when TruckMate sends them (connector expand=shipper,consignee)
  const party = (o) => (o && typeof o === 'object' ? { name: clean(o.name || o.clientName || o.customerName) || null, street: clean([o.address1 || o.address || o.street, o.address2].filter(Boolean).join(', ')) || null } : { name: null, street: null });
  const add = (kind, zone, when, who) => { const z = zoneOf(zone); const p0 = party(who); const k = `${kind}|${z.zip || z.city}|${p0.name || ''}`; if (!z.city || seen.has(k)) return; seen.add(k); out.push({ kind, n: null, ...p0, ...z, ...tmWhen(when) }); };
  for (const b of bills) add('pickup', b.startZoneDescription, b.pickUpAppt || b.pickUpBy, b.shipper);
  for (const b of bills) add('delivery', b.endZoneDescription, b.deliveryAppt || b.deliverBy, b.consignee);   // every receiver on the load, one stop each
  return out;
}
// A load for the driver when dispatch hasn't sent a message: the stops, dates and times from TruckMate; from the rate con only the pickup
// numbers, each stop's instructions, the load instructions and the temperature and mode (and, since TruckMate has no names or street
// addresses, the stop's name and street). Never the rate, the broker's contacts or anything else on it. Pure → a sheet, or null.
const isoFrom = (d) => { const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) || String(d || '').match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; if (m[1].length === 4) return `${m[1]}-${m[2]}-${m[3]}`; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const looksStreet = (x) => /^\d+\s+\S/.test(String(x || '').trim());
const OWN_NOTE = /^(tr(uck)?\.?\s*#?\s*)?\d{3,4}$|^part\s*#?\s*\d+$|^p\s*\/\s*u\b|^-?\d+\s*°?\s*f\b/i;   // truck number, "Part 2", pickup time, the temperature: shown elsewhere
export function sheetFromRateCon(rc, { trip = null, item = null } = {}) {
  if (!rc) return null;
  const hand = (rc.handwrittenNotes || []).map((x) => clean(x)).filter(Boolean);
  const tempText = rc.tempSetting || hand.find((x) => /-?\d+\s*°?\s*F\b/i.test(x)) || null;
  const temp = tempText ? readTemp(`${tempText}${!/cont|cyc/i.test(tempText) && hand.some((x) => /\bcont/i.test(x)) ? ' CONTINUOUS' : ''}`) : null;
  const rcStop = (kind) => (x) => {
    const street = x.address || (looksStreet(x.refs) ? x.refs : null);
    return { kind, name: clean(x.name) || null, street: street ? clean(street) : null, city: clean(x.city) || null, state: clean(x.state).toUpperCase() || null, zip: clean(x.zip) || null,
      date: x.date || null, dateIso: isoFrom(x.date), time: cleanTime(x.appointment || x.time) || null,
      other: [...(x.instructions || []).map((y) => clean(y)).filter(Boolean), ...(x.refs && !looksStreet(x.refs) ? [clean(x.refs)] : [])] };
  };
  const rcStops = [...(rc.pickups || []).map(rcStop('pickup')), ...(rc.deliveries || []).map(rcStop('delivery'))];
  const tm = truckMateStops(item);
  // TruckMate's stops, each matched to the rate con's stop of the same kind and town for its name, street and instructions
  const used = new Set();
  const match = (s0) => rcStops.find((r) => !used.has(r) && r.kind === s0.kind && ((s0.zip && r.zip === s0.zip) || (r.city && s0.city && up(r.city) === up(s0.city))));
  let stops = tm.map((s0) => { const r = match(s0); if (r) used.add(r); return { ...s0, name: s0.name || (r ? r.name : null), street: s0.street || (r ? r.street : null), ...(!s0.dateIso && r ? { date: r.date, dateIso: r.dateIso } : {}), ...(!s0.time && r && r.time ? { time: r.time } : {}), other: r && r.other.length ? r.other : undefined }; });
  for (const r of rcStops) if (!used.has(r)) stops.push({ ...r, other: r.other.length ? r.other : undefined });   // a stop TruckMate doesn't have yet
  stops = [...stops.filter((x) => x.kind === 'pickup'), ...stops.filter((x) => x.kind === 'delivery')];
  if (!stops.length) return null;
  // "P/U 11/4 ASAP" written by hand: the pickup's date and time when neither TruckMate nor the rate con has one
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
  const bills = (item && (item.freightBills || item.orders)) || [];
  return { bill: (bills[0] && bills[0].billNumber) || (rc.fbfBillNumber ? String(rc.fbfBillNumber).toUpperCase() : null), trip: trip ? String(trip) : null, temp, pickupNumbers: pu, refs: [], notes,
    instructions: (rc.specialInstructions || []).map((x) => clean(x)).filter(Boolean), stops, from: 'the rate con', release: rel ? { ...rel, stops: [] } : null, fromRateCon: true };
}

// The driver's text message, written like dispatch writes it (Nov 23, Nadim's examples): the bonus first ("$150 FLAT FEE"), then
// FB#, TRIP#, TEMP, PU#, each PICK UP and DELIVERY with name, street, city/state/zip, date and time and the stop's notes, the release
// line ("*** NO RELEASE ***" or "***FREE RELEASE BARTOW YARD***" after the delivery where the trailer goes to the yard), the
// confirm line signed with the dispatcher's initials. parseDispatchMessage reads it back the same. Pure.
export function composeDispatchMessage(d = {}, { bonus = '', release = null, initials = '' } = {}) {
  const RULE_L = '---------------------------------------------';
  const stops = (d.stops || []).filter((x) => x && (x.city || x.zip || x.name));
  const pus = stops.filter((x) => x.kind === 'pickup'); const dels = stops.filter((x) => x.kind === 'delivery');
  const t = d.temp ? (typeof d.temp === 'string' ? d.temp : d.temp.text || `${d.temp.degrees != null ? `${d.temp.degrees}${d.temp.unit || 'F'}` : ''}${d.temp.mode ? `  ***${String(d.temp.mode).toUpperCase()}***` : ''}`) : '';
  const block = (label, x) => {
    const csz = [[x.city, x.state].filter(Boolean).join(', '), x.zip].filter(Boolean).join(' ');
    return [`${label}:`, '', ...[x.name, x.street, csz].filter(Boolean).map((v) => String(v).toUpperCase()), '', `DATE: ${x.date || (x.dateIso ? `${Number(x.dateIso.slice(5, 7))}/${Number(x.dateIso.slice(8, 10))}/${x.dateIso.slice(2, 4)}` : '')}  TIME: ${x.time || ''}`.trimEnd(),
      ...((x.other || []).map((n) => String(n).toUpperCase()))];
  };
  const relLine = release && ['free', 'paid'].includes(release.type) ? `***${release.type.toUpperCase()} RELEASE${release.yard ? ` ${String(release.yard).replace(/\s+yard$/i, '').toUpperCase()} YARD` : ''}***` : '*** NO RELEASE ***';
  // the release goes after delivery #after (the stops after it are delivered from the yard); none / no number → after the last
  const after = release && ['free', 'paid'].includes(release.type) ? Math.min(Math.max(Number(release.after) || dels.length, 0), dels.length) : null;
  const out = [];
  if (String(bonus || '').trim()) out.push(String(bonus).trim().toUpperCase());
  out.push('--------------------------------------------', `FB#: ${d.bill || ''}`, `TRIP#: ${d.trip || ''}`, `TEMP: ${t}`, `PU#: ${(d.pickupNumbers || []).join(', ')}`, RULE_L);
  pus.forEach((x, i) => { out.push(...block(pus.length > 1 ? `PICK UP #${i + 1}` : 'PICK UP', x), RULE_L); });
  if (after == null || after === 0) out.push(`           ${relLine}`, RULE_L);
  dels.forEach((x, i) => {
    out.push(...block(dels.length > 1 ? `DELIVERY #${i + 1}` : 'DELIVERY', x), RULE_L);
    if (after != null && after > 0 && i + 1 === after && i + 1 < dels.length) out.push(relLine, RULE_L);
  });
  if (after != null && after > 0 && after >= dels.length) out.push(relLine, RULE_L);
  if ((d.instructions || []).length) out.push(...d.instructions.map((n) => `- ${String(n).toUpperCase()}`), RULE_L);
  out.push('PLEASE CONFIRM WITH "OK" ONCE YOU', `RECEIVE THIS MESSAGE, THANKS, ${String(initials || '').toUpperCase()}.`);
  return out.join('\n');
}
// The driver info email to the broker, the way dispatch writes it (Nov 23, Nadim's examples, B181051 / B181100 / B181091):
// subject "RXO LOGISTICS LOAD 24720958 MA TO FL // TK: 2614 TL: 7371 // B181051"; body "Good day, / Please see the driver info
// below", truck, trailer, temperature, each driver "NAME (ID)", the phones under PH#, then the dispatcher's comments and
// signature. The company's dispatch box is always CC'd. Pure. → { subject, body, to: [suggested broker emails], cc }
export const BROKER_INFO_CC = ['Inbound-Dispatch@floridabeauty.us'];
const ph = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : ''; };
export function brokerInfoEmail({ rc = {}, bill = '', truck = '', trailer = '', drivers = [], dispatcher = {} } = {}) {
  const st = (x) => (x && (x.state || (String(x.city || '').match(/,\s*([A-Z]{2})\b/) || [])[1])) || '';
  const pu = (rc.pickups || [])[0]; const del = (rc.deliveries || [])[(rc.deliveries || []).length - 1];
  const lane = [st(pu), st(del)].every(Boolean) ? ` ${String(st(pu)).toUpperCase()} TO ${String(st(del)).toUpperCase()}` : '';
  const broker = String(rc.broker || '').replace(/,?\s*(inc|llc|corp|co)\.?$/i, '').trim().toUpperCase();
  const subject = `${broker || 'BROKER'} LOAD ${rc.loadNumber || ''}${lane} // TK: ${truck || ''} TL: ${trailer || ''} // ${bill || rc.fbfBillNumber || ''}`.replace(/\s+/g, ' ').trim();
  const t = readTemp(String(rc.tempSetting || ''));
  const temp = t && t.degrees != null ? `${t.degrees}${t.unit || 'F'}` : '';
  const ds = (drivers || []).filter((d) => d && (d.name || d.code));
  const body = ['Good day,', '', 'Please see the driver info below', '', truck, trailer, temp, ...ds.map((d) => `${String(d.name || '').toUpperCase()}${d.code ? ` (${String(d.code).replace(/^0+/, '')})` : ''}`), '',
    'PH#', ...ds.filter((d) => ph(d.phone)).map((d) => `${String(d.name || '').toUpperCase()}: ${ph(d.phone)}`)].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').replace(/\n{3,}/g, '\n\n');
  const own = /@floridabeauty\.(us|com)$/i;
  const to = [...new Set([rc.brokerEmail, ...((rc.contacts || []).filter((c) => /broker_rep|tracking|dispatch|after_hours/.test(c.role || '')).map((c) => c.email))].filter((e) => e && /@/.test(e) && !own.test(e)).map((e) => String(e).trim().toLowerCase()))].slice(0, 6);
  return { subject, body, to, cc: BROKER_INFO_CC, signature: [dispatcher.name || '', 'Florida Beauty Express', dispatcher.email ? `Email: ${dispatcher.email}` : ''].filter(Boolean).join('\n') };
}
// The whole email as sent: the body, the comments, "Thanks," and the signature. Pure.
export const brokerInfoText = (body, comments, signature) => [String(body || '').trim(), String(comments || '').trim(), 'Thanks,', '', String(signature || '').trim()].filter(Boolean).join('\n\n').replace(/Thanks,\n\n\n\n/, 'Thanks,\n\n');

// how dispatch signs: the first name ("THANKS, JEREMY."). "Nadim Tellez" / "ntellez@…" → "NADIM" / "NTELLEZ". Pure.
export const initialsOf = (name) => (String(name || '').split(/[\s@]+/).find((w) => /^[A-Za-z]/.test(w)) || '').replace(/[^A-Za-z'-]/g, '').toUpperCase();


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

// Does the driver see it? Everything dispatch sent; a draft Jarvis made from a rate con only once a dispatcher sends it. Pure.
export const visible = (s) => !!s && !(s.fromRateCon && !s.sentAt);

export function initLoadSheets(app, { requireAuth, db, getBoard = null, sendApp = null, sendText = null, log = null, sendMail = null, recipients = async () => [], nextRateCon = null, notify = null, now = () => Date.now() }) {
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
    const rec = { ...sheet, trip: String(trip), raw: String(raw).slice(0, 4000), by, at: new Date(now()).toISOString(), sentAt: new Date(now()).toISOString(), confirmedAt: null, confirmedBy: null, dropped: null };
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
  // a text goes to driver 1 and, on a team, driver 2 too (each needs their own agreement to texts)
  const textBoth = async (trip, body, by) => {
    const one = await sendText(SITE, trip, body, by, 1).catch((e) => ({ skipped: e.message }));
    const two = await sendText(SITE, trip, body, by, 2).catch((e) => ({ skipped: e.message }));
    const to = [one, two].filter((r) => r && r.sent).map((r) => r.to).filter(Boolean);
    return to.length ? { sent: true, to, ...(two && !two.sent && !/no phone/i.test(two.skipped || '') ? { second: two.skipped } : {}) } : one;
  };
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
    const head = sendHeadline(rec);
    const body = `${head ? `${head}\n` : ''}${String(b.text).trim()}`;
    if (via.includes('app')) sent.app = sendApp ? await sendApp(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    if (via.includes('text')) sent.text = sendText ? await textBoth(trip, body, who(req)) : { skipped: 'not available' };
    if (notify && via.includes('app') && !(sent.app && sent.app.sent)) await notify(trip, 'Load info from dispatch', `${head ? `${head} · ` : ''}Trip ${trip}: open TagAlong for the pickup, delivery and instructions.`).catch(() => {});
    res.json({ ok: true, trip, sheet: forConsole(rec, await yards()), sent });
  });
  app.get('/truckmate/loadsheet/:trip', requireAuth, async (req, res) => res.json({ sheet: forConsole(await get(req.params.trip), await yards()) }));
  // the rate con made into the driver's load (TruckMate's stops and times + the rate con's pickup numbers, instructions, temperature):
  // a draft for dispatch to check. The rate con on the trip, else the one Jarvis queued for this trip as a truck's next load
  const draftFor = async (trip) => {
    const item = (await board()).find((it) => String(tripOf(it).tripNumber) === String(trip));
    if (!item) return { error: 'That load is not on the board.', code: 404 };
    const rc = (item._ratecon && (item._ratecon.data || item._ratecon)) || (nextRateCon ? await nextRateCon(item).catch(() => null) : null);
    const sheet = rc ? sheetFromRateCon(rc, { trip, item }) : null;
    return sheet ? { sheet, item } : { error: 'No rate con on this load yet.', code: 404 };
  };
  // "Send load info": the driver's text message written for dispatch to check and edit — from the rate con (TruckMate's stops + the
  // rate con's names, streets, PU#, notes, temperature), else TruckMate alone; the bonus and the release dispatch picks. POST so
  // the popup can rewrite it when the bonus / release change.
  // Is it an LTL? Florida Beauty's own LTL leaves from the hubs and never gets this text (Nov 23, Nadim): a B bill is a broker
  // load; M/G/H/P bills, a terminal pickup or a flower manifest are LTL. Pure.
  const isLtlLoad = (item) => {
    const bills = (item && (item.freightBills || item.orders)) || [];
    if (bills.some((b) => /^B\d/i.test(String(b.billNumber || '')))) return false;
    if (bills.some((b) => /^[MGHP]\d/i.test(String(b.billNumber || '')))) return true;
    const t = tripOf(item); const m = item && item._manifest;
    return /TERMINAL/i.test(String(t.origZoneDesc || '')) || !!(m && (/FLOWER/i.test(String(m.commodity || '')) || (m.stops || []).some((x) => /^LOAD/i.test(x.action || '') && /TERMINAL/i.test(String(x.customer || '')))));
  };
  // "Send load info" (Nov 23, Nadim): dispatch sends a driver their NEXT load while they're still on this one (a flower run, or a
  // broker load they're delivering) — or, on a broker load not sent yet, the current one. The card's trip is :trip; body.target
  // says which load the text is for: { trip } (a TruckMate trip — the current one or a booked next one) or { nextId } (a rate
  // con Jarvis queued as the truck's next load). The text is written ONLY from that load's rate con (plus TruckMate's stops when
  // it has the trip): no rate con → { needRateCon } and the pop-up asks for it. An LTL load never gets this text.
  const nextRateConById = async (id) => {
    const n = ((((await db.get(`taNextLoads:${SITE}`, { list: [] })) || {}).list) || []).find((x) => x.id === id && !x.doneAt);
    if (!n) return { n: null, rc: null };
    if (n.pendingId) { const p0 = ((await db.get(`taRateConPending:${SITE}`, [])) || []).find((x) => x.id === n.pendingId); if (p0 && p0.record) return { n, rc: p0.record.data || p0.record }; }
    const t = n.trip || (n.verified && n.verified.trip);
    if (t) { const r = ((await db.get(`taTruckMateRateCon:${SITE}`, {})) || {})[t]; if (r) return { n, rc: r.data || r }; }
    return { n, rc: null };
  };
  app.post('/truckmate/loadsheet/:trip/compose', requireAuth, async (req, res) => {
    const b = req.body || {}; const target = b.target || { trip: String(req.params.trip) };
    const [active, rcs] = await Promise.all([db.get(`taTruckMateActive:${SITE}`, { trips: {} }).catch(() => ({ trips: {} })), db.get(`taTruckMateRateCon:${SITE}`, {}).catch(() => ({}))]);
    const itemOf = (t) => { const rec = Object.entries((active && active.trips) || {}).find(([k, r]) => k === String(t) || String(tripOf((r && r.item) || {}).tripNumber) === String(t)); return rec && rec[1] && rec[1].item; };
    let rc = null; let trip = null; let item = null; let nx = null;
    if (target.nextId) {
      const got = await nextRateConById(String(target.nextId));
      if (!got.n) return res.status(404).json({ error: 'That next load is not waiting any more.' });
      nx = got.n; rc = got.rc; trip = nx.trip || (nx.verified && nx.verified.trip) || (b.trip ? String(b.trip) : null);
    } else {
      trip = String(target.trip || req.params.trip);
      rc = (rcs || {})[trip] ? ((rcs[trip].data) || rcs[trip]) : null;
    }
    if (trip) item = itemOf(trip);
    if (item && isLtlLoad(item)) return res.status(409).json({ error: 'This is an LTL load — LTL leaves from the hubs, so there is no dispatch text. Pick the truck\'s next broker load.', ltl: true });
    if (!rc) return res.status(409).json({ needRateCon: true, trip, error: 'Please upload the rate con so we can dispatch the driver.' });
    const draft = sheetFromRateCon(rc, { trip, item });
    if (!draft) return res.status(409).json({ needRateCon: true, trip, error: 'The rate con has no pickup or delivery Jarvis could read. Please upload a clearer copy so we can dispatch the driver.' });
    if (draft.temp && !draft.temp.text && draft.temp.degrees == null) draft.temp = null;
    const sent = trip ? await get(trip) : null;
    const release = b.release !== undefined ? b.release : (draft.release ? { ...draft.release, after: null } : null);
    const initials = b.initials != null ? String(b.initials).slice(0, 20) : initialsOf(who(req));
    const t0 = item ? tripOf(item) : {};
    const email = brokerInfoEmail({ rc, bill: draft.bill, truck: String(t0.powerUnit || b.truck || ''), trailer: String(t0.trailer || b.trailer || ''), drivers: Array.isArray(b.drivers) ? b.drivers.slice(0, 2) : [], dispatcher: { name: who(req), email: (req.user && req.user.email) || '' } });
    res.json({ email, text: composeDispatchMessage(draft, { bonus: b.bonus || '', release, initials }), source: item ? 'rate con' : 'rate con only', trip, broker: rc.broker || null, loadNumber: rc.loadNumber || null, initials, release,
      sentBefore: sent && sent.sent !== false ? { at: sent.at, by: sent.by } : null, deliveries: draft.stops.filter((x) => x.kind === 'delivery').map((x) => [x.name, x.city].filter(Boolean).join(', ')) });
  });
  // the driver info email to the broker, right after the driver's text (the pop-up's Send). From the Jarvis mailbox; replies go
  // to the dispatcher and the dispatch box. Training mode (the mailer's guard) still holds outside emails.
  app.post('/truckmate/loadsheet/:trip/broker-email', requireAuth, async (req, res) => {
    const b = req.body || {}; const trip = String(req.params.trip);
    if (!sendMail) return res.status(503).json({ error: 'Email is not set up on the server.' });
    const to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)))].slice(0, 10);
    if (!to.length) return res.status(400).json({ error: 'Add the broker\'s email.' });
    const subject = String(b.subject || '').trim().slice(0, 250);
    if (!subject) return res.status(400).json({ error: 'The email needs a subject.' });
    const me = (req.user && req.user.email) || '';
    const extraCc = (Array.isArray(b.cc) ? b.cc : []).map((x) => String(x).trim()).filter((x) => /@/.test(x));
    const cc = [...new Set([...BROKER_INFO_CC, ...extraCc].map((x) => x.toLowerCase()))].filter((x) => !to.includes(x));
    const text = brokerInfoText(b.body, b.comments, b.signature || [who(req), 'Florida Beauty Express', me ? `Email: ${me}` : ''].filter(Boolean).join('\n'));
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      const r = await sendMail({ to, cc, subject, html: `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</div>`, replyTo: [me, ...BROKER_INFO_CC].filter(Boolean) });
      if (log) await log(SITE, trip, { type: 'email', kind: 'broker-driver-info', to: to.join(', '), text: subject, by: who(req), noThread: true }).catch(() => {});
      res.json({ ok: true, to, cc, subject, held: !!(r && r.held), sentTo: (r && r.to) || to });
    } catch (e) { res.status(502).json({ error: e.message || 'Could not send the email.' }); }
  });
  app.get('/truckmate/loadsheet/:trip/ratecon-draft', requireAuth, async (req, res) => {
    const d = await draftFor(String(req.params.trip));
    return d.error ? res.status(d.code).json({ error: d.error }) : res.json({ sheet: forConsole(d.sheet, await yards()) });
  });
  // dispatch checked it: the driver gets it now (the Next load tab, a notification), by app and / or text
  app.post('/truckmate/loadsheet/:trip/ratecon-send', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const trip = String(req.params.trip); const b = req.body || {};
    const d = await draftFor(trip);
    if (d.error) return res.status(d.code).json({ error: d.error });
    if (b.release !== undefined) { d.sheet.release = releaseFrom(b.release, d.sheet.stops); if (b.release) await rememberYard(b.release.yard, b.release.address); }
    const rec = await save(d.sheet, '(from the rate con, checked by dispatch)', who(req), trip);
    const via = Array.isArray(b.via) ? b.via : ['app'];
    const first = rec.stops[0]; const last = rec.stops[rec.stops.length - 1];
    const body = `New load: trip ${trip}${first ? ` · pick up ${[first.name, first.city].filter(Boolean).join(', ')}${first.dateIso ? ` ${first.date || ''}` : ''}${first.time ? ` ${first.time}` : ''}` : ''}${last && last !== first ? ` · deliver ${[last.name, last.city].filter(Boolean).join(', ')}` : ''}. Open TagAlong for everything.`.replace(/\s+/g, ' ');
    const sent = {};
    if (via.includes('app')) sent.app = sendApp ? await sendApp(SITE, trip, body, who(req)).catch((e) => ({ skipped: e.message })) : { skipped: 'not available' };
    if (via.includes('text')) sent.text = sendText ? await textBoth(trip, body, who(req)) : { skipped: 'not available' };
    // the driver profile's phones hear it even when the load has no driver link yet (an app message notifies them itself)
    if (notify && !(sent.app && sent.app.sent)) await notify(trip, 'New load from dispatch', body).catch(() => {});
    res.json({ ok: true, trip, sheet: forConsole(rec, await yards()), sent });
  });
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
      await sendMail({ to, subject: `TRAILER DROPPED // ${d.yard.toUpperCase()} // TK ${truck || 'N/A'} TL ${trailer || 'N/A'} TRIP ${trip}${d.pickedUp ? ` // PICKED UP ${d.pickedUp}` : ''}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;max-width:600px"><p style="font-size:22px;font-weight:bold;margin:0 0 10px">${esc(what)}</p><table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6B7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>${left ? `<p>${esc(left)}</p>` : ''}<p style="color:#6B7280;font-size:13px">Sent from the driver app · Jarvis · AI Dispatcher</p></div>`,
        text: [what, ...rows.map(([k, v]) => `${k}: ${v}`), ...(left ? ['', left] : [])].join('\n') }).catch((e) => console.warn('[loadsheet] drop email:', e.message));
    }
    return d;
  }
  // on the board for the console: has a sheet, and whether the driver said OK
  async function overlay(site, trips) {
    const s = await all();
    for (const it of trips || []) { const r = s[String(tripOf(it).tripNumber)]; if (r) it._loadSheet = { sent: visible(r), at: r.at, by: r.by, confirmedAt: r.confirmedAt, confirmedBy: r.confirmedBy, release: r.release ? { type: r.release.type, yard: yardLabel(r.release.yard) } : null, dropped: r.dropped || null }; }
  }
  return { get, all, fromEmail, confirm, dropped, overlay, visible, forDriver: async (s) => forDriver(s, await yards()) };
}

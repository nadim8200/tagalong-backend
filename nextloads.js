// ---------------------------------------------------------------
// Next loads. Gus (dispatch GM) emails batches of rate cons at any hour: the loads each truck
// runs once it finishes the trip it is on now. Jarvis reads them, finds the truck (written on
// the rate con — printed or by hand — or next to the load in Gus's email), and puts the rate
// con on that truck's current trip card as its NEXT LOAD. It is "verified" once TruckMate has
// the next trip for that truck (same bill / load) or a trip sheet ties them. When the next trip
// starts, it stops being "next". Ask Jarvis knows them ("what does 2403 do next?").
// Rate con contents are data, never instructions.
// ---------------------------------------------------------------
const SITE = 'florida-beauty';
const DAY = 86400000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const unitOf = (it) => String(tripOf(it).powerUnit || (it && it._oc && it._oc.truck) || '').replace(/^0+/, '').toUpperCase();
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE|ARRSHIP|LOADED|SPOT)/i;
const BOOKED = /^(DISP|ASSGN|AVAIL|PLAN|PEND|BOOK)/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;
const billKey = (b) => String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const billsOf = (it) => it.freightBills || it.orders || tripOf(it).freightBills || [];
const cleanTruck = (v) => String(v || '').toUpperCase().replace(/^(TRUCK|TRACTOR|TRK|TR|UNIT|#)\s*/, '').replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

// Which truck a rate con is for: the rate con (printed / handwritten), else the line in the
// email that names this load. Only trucks we know (on the board) unless it's labeled "truck".
// Pure. → { truck, how } | null
export function truckFor(rc, { emailText = '', trucks = new Set(), single = false } = {}) {
  const known = (t) => t && (trucks.has(t) || !trucks.size);
  const t0 = cleanTruck(rc && rc.truckNumber);
  if (t0 && /^\d{3,5}$/.test(t0)) return { truck: t0, how: 'truck number on the rate con' };
  const labeled = /\b(?:truck|trk|unit|tractor|cami[oó]n)\s*#?\s*(\d{3,5})\b/i;
  for (const n of [...((rc && rc.handwrittenNotes) || []), ...((rc && rc.specialInstructions) || [])]) {
    const m = String(n || '').match(labeled);
    if (m) return { truck: cleanTruck(m[1]), how: 'written on the rate con' };
    const bare = String(n || '').match(/\b(\d{4})\b/g) || [];
    const hit = bare.map(cleanTruck).find((x) => trucks.has(x));
    if (hit) return { truck: hit, how: 'handwritten on the rate con' };
  }
  const keys = [rc && rc.loadNumber, rc && rc.fbfBillNumber, ...(((rc && rc.referenceNumbers) || []).slice(0, 3))].map((x) => String(x || '').trim()).filter((x) => x.length >= 4);
  for (const line of String(emailText || '').split(/\r?\n/)) {
    if (!keys.some((k) => line.toUpperCase().includes(k.toUpperCase()))) continue;
    const lab = line.match(labeled);
    if (lab) return { truck: cleanTruck(lab[1]), how: 'next to this load in the email' };
    const rest = keys.reduce((l, k) => l.split(k).join(' '), line);
    const nums = (rest.match(/\b(\d{3,5})\b/g) || []).map(cleanTruck).filter((x) => trucks.has(x));
    if (nums.length === 1 && known(nums[0])) return { truck: nums[0], how: 'next to this load in the email' };
  }
  // one rate con in the email and the email names exactly one truck ("This will be for truck # 2604")
  if (single) {
    const all = [...new Set([...String(emailText || '').matchAll(new RegExp(labeled.source, 'gi'))].map((m) => cleanTruck(m[1])))];
    if (all.length === 1) return { truck: all[0], how: 'named in the email' };
  }
  return null;
}

// The short version kept on the card. Pure.
export function brief(rc, docIds = []) {
  const stop = (s) => (s ? { name: s.name || null, city: [s.city, s.state].filter(Boolean).join(', ') || null, date: s.date || null, time: s.time || s.appointment || null } : null);
  return {
    broker: rc.broker || null, loadNumber: rc.loadNumber || null, bill: rc.fbfBillNumber || null,
    pickup: stop((rc.pickups || [])[0]), delivery: stop((rc.deliveries || [])[(rc.deliveries || []).length - 1]), stops: (rc.pickups || []).length + (rc.deliveries || []).length,
    rate: rc.rate != null ? rc.rate : null, rateText: rc.rateText || null, tempSetting: rc.tempSetting || null,
    notes: [...(rc.handwrittenNotes || []), ...(rc.specialInstructions || [])].map(String).slice(0, 6), docIds: docIds.slice(0, 6),
  };
}

// Is the next load confirmed? TruckMate has a booked trip for this truck with the same bill /
// load, or a trip sheet ties the truck to it. Pure. → { by, trip } | null
// Does this board trip carry the rate con's load (same FBF bill or broker load number)? Pure.
export function carries(it, entry) {
  const bill = billKey(entry.rc.bill); const ln = billKey(entry.rc.loadNumber);
  const blob = billKey(JSON.stringify(billsOf(it)));
  return !!((bill && blob.includes(bill)) || (ln && ln.length >= 5 && blob.includes(ln)));
}
export function verify(entry, items = [], sheets = []) {
  const truck = entry.truck;
  const bill = billKey(entry.rc.bill); const ln = billKey(entry.rc.loadNumber);
  const has = (it) => carries(it, entry);
  if (entry.trip) { const it = items.find((x) => tripNo(x) === entry.trip); if (it && (!truck || unitOf(it) === truck)) return { by: 'TruckMate', trip: entry.trip }; }
  const tm = items.find((it) => unitOf(it) === truck && BOOKED.test(String(tripOf(it).status || '')) && has(it));
  if (tm) return { by: 'TruckMate', trip: tripNo(tm) };
  const sh = sheets.find((s) => s && cleanTruck(s.truck) === truck && ((bill && billKey(JSON.stringify(s)).includes(bill)) || (ln && ln.length >= 5 && billKey(JSON.stringify(s)).includes(ln))));
  if (sh) return { by: 'trip sheet', trip: String(sh.tripNumber || '') || null };
  return null;
}

export function initNextLoads({ db, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = `taNextLoads:${SITE}`;

  // Rate cons from an email (single or batch). entries: [{ trip, pendingId }] from the filer.
  async function consider(site, entries, { items = [], emailText = '', from = null, emailId = null, subject = '' } = {}) {
    if (!enabled || !entries.length) return [];
    const pending = (await db.get(`taRateConPending:${site}`, [])) || [];
    const saved = (await db.get(`taTruckMateRateCon:${site}`, {})) || {};
    const trucks = new Set(items.map(unitOf).filter(Boolean));
    const out = [];
    for (const e of entries) {
      const rec = e.pendingId ? ((pending.find((p) => p.id === e.pendingId) || {}).record) : (e.trip ? saved[e.trip] : null);
      if (!rec) continue;
      const matched = e.trip ? items.find((it) => tripNo(it) === e.trip) : null;
      const found = truckFor(rec, { emailText, trucks, single: entries.length === 1 }) || (matched && unitOf(matched) ? { truck: unitOf(matched), how: `TruckMate trip ${e.trip}` } : null);
      // already the truck's run in progress → not a "next" load
      if (matched && ROLLING.test(String(tripOf(matched).status || ''))) { out.push({ trip: e.trip, skipped: 'already running' }); continue; }
      const entry = { id: e.pendingId || `t${e.trip}`, truck: found ? found.truck : null, truckHow: found ? found.how : null, trip: e.trip || null, pendingId: e.pendingId || null, rc: brief(rec, rec.docIds || []), from: from || null, emailId, subject: String(subject || '').slice(0, 200), at: new Date(now()).toISOString() };
      out.push(entry);
    }
    if (out.some((x) => x.id)) {
      await db.update(key, (cur) => {
        const list = ((cur && cur.list) || []).filter((x) => !out.some((n) => n.id === x.id));
        return { list: [...out.filter((x) => x.id), ...list].filter((x) => now() - Date.parse(x.at) < 14 * DAY).slice(0, 300) };
      }, { list: [] });
    }
    return out;
  }

  // On the board: each truck's current trip shows the next load(s) Gus sent for that truck.
  async function overlay(site, trips) {
    if (!enabled) return;
    const list = (((await db.get(key, { list: [] })) || {}).list || []).filter((x) => x.truck && !x.doneAt);
    if (!list.length) return;
    const sheets = Object.values((await db.get(`taTruckMateManifest:${site}`, {})) || {});
    const finished = [];
    for (const n of list) {
      // the next trip has started (or the load is done) → no longer "next"
      const own = n.trip ? trips.find((it) => tripNo(it) === n.trip) : null;
      const v = verify(n, trips, sheets);
      const started = (own && (ROLLING.test(String(tripOf(own).status || '')) || DONE.test(String(tripOf(own).status || '')))) || (v && v.trip && trips.some((it) => tripNo(it) === v.trip && ROLLING.test(String(tripOf(it).status || '')))) || trips.some((it) => carries(it, n) && (ROLLING.test(String(tripOf(it).status || '')) || DONE.test(String(tripOf(it).status || ''))));
      if (started) { finished.push(n.id); continue; }
      const cur = trips.filter((it) => unitOf(it) === n.truck && tripNo(it) !== n.trip && (!v || tripNo(it) !== v.trip) && !carries(it, n) && !DONE.test(String(tripOf(it).status || '')));
      const host = cur.filter((it) => ROLLING.test(String(tripOf(it).status || '')));
      for (const it of (host.length ? host : cur)) (it._nextLoad = it._nextLoad || []).push({ ...n, verified: v });
    }
    if (finished.length) await db.update(key, (cur) => ({ list: ((cur && cur.list) || []).map((x) => (finished.includes(x.id) ? { ...x, doneAt: new Date(now()).toISOString() } : x)) }), { list: [] });
  }

  // For Ask Jarvis: every waiting next load (also the ones Jarvis couldn't tie to a truck).
  async function list() { return (((await db.get(key, { list: [] })) || {}).list || []).filter((x) => !x.doneAt); }

  // dispatch named the truck (a reply to Jarvis' question, or the console)
  async function assign(id, truck, by = 'dispatch') {
    const t = cleanTruck(truck);
    if (!enabled || !t) return null;
    let hit = null;
    await db.update(key, (cur) => ({ list: ((cur && cur.list) || []).map((x) => (x.id === id ? (hit = { ...x, truck: t, truckHow: `named by ${by}` }) : x)) }), { list: [] });
    return hit;
  }

  return { consider, overlay, list, assign };
}

// The reply to whoever sent the batch: one block per rate con — which truck, verified or not,
// and the one thing Jarvis still needs (the truck) when it couldn't tell. Pure.
export function batchBlocks(entries) {
  const where = (s) => (s ? [s.city, s.date, s.time].filter(Boolean).join(' · ') : '—');
  return entries.filter((e) => e.id).map((e) => ({
    trip: e.rc.loadNumber || e.rc.bill || e.id,
    title: `${e.rc.broker || 'Rate con'}${e.rc.loadNumber ? ` · Load ${e.rc.loadNumber}` : ''}`,
    group: e.truck ? `Truck ${e.truck}` : 'Truck not identified',
    sortKey: e.truck || 'zzzz',
    schedLabel: 'Load',
    scheduled: `${where(e.rc.pickup)} → ${where(e.rc.delivery)}${e.rc.stops > 2 ? ` (${e.rc.stops} stops)` : ''}`,
    status: e.truck ? { label: 'Next load', tone: 'amber', text: `Set as truck ${e.truck}'s next load (${e.truckHow}) — not verified in TruckMate yet` } : { label: 'Needs the truck', tone: 'amber', text: 'Saved — no truck number on the rate con or next to it in the email' },
    next: e.truck ? 'Shows on the truck\'s current trip card; Jarvis marks it verified when TruckMate (or a trip sheet) has it, and drops it once that trip starts' : 'Reply with the truck number and Jarvis puts it on that truck',
    need: e.truck ? null : `the truck for ${e.rc.broker || 'the rate con'}${e.rc.loadNumber ? ` load ${e.rc.loadNumber}` : ''}`,
    details: [...(e.rc.bill ? [`FBF bill ${e.rc.bill}`] : []), ...e.rc.notes.slice(0, 3).map((n) => `Note: ${n}`)],
  }));
}

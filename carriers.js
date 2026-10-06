// ---------------------------------------------------------------
// Outside carriers (OC) for the AI dispatcher.
//
// Some loads ride an OUTSIDE carrier's truck, not a company truck. TruckMate
// shows them with an "OC####" unit (e.g. OC1016), or the trip sheet says so in
// handwriting ("OC Track & Trace ZEAL XPRESS INC"). Those trucks are not in
// Samsara, so there is no ELD, HOS or engine data — tracking comes from the
// carrier: check calls, their emails, and later a driver tracking link or a
// shared ELD / tracking platform.
//
//   GET  /truckmate/carriers               → carrier list
//   POST /truckmate/carriers               → add a carrier
//   PUT  /truckmate/carriers/:id           → edit (contacts, MC/DOT, tracking method, OC codes)
//   POST /truckmate/oc/:trip               → mark / edit / clear a trip as OC
//   POST /truckmate/checkins/:trip         → log a check call (where the truck is, note)
//
// Carrier contacts are stored once and reused; nothing here contacts anyone.
// ---------------------------------------------------------------

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\b(INC|LLC|CORP|CO|LTD|THE)\b/g, ' ').replace(/\s+/g, ' ').trim();
const OC_UNIT = /^OC[\s-]?\d+/i;
export const isOcUnit = (u) => OC_UNIT.test(String(u || '').trim());
export const TRACKING_METHODS = ['check_call', 'driver_link', 'eld_share', 'platform', 'email'];

// What an OC load still needs from the carrier/driver: names and phones for
// every driver (one solo, two team), their truck # and trailer #. Pure.
export function ocMissing(oc) {
  if (!oc) return [];
  const digits = (p) => String(p || '').replace(/\D+/g, '').length >= 10;
  const out = [];
  const team = oc.crew === 'team';
  if (!oc.driverName) out.push(team ? 'driver 1 name' : 'driver name');
  if (!digits(oc.driverPhone)) out.push(team ? 'driver 1 phone' : 'driver phone');
  if (team && !oc.driver2Name) out.push('driver 2 name');
  if (team && !digits(oc.driver2Phone)) out.push('driver 2 phone');
  if (!oc.truck) out.push('truck #');
  if (!oc.trailer) out.push('trailer #');
  return out;
}

// The OC picture for one board item from every source we have. Pure, so the
// Watchtower and the console agree. Priority: manual mark > trip sheet > unit code.
export function ocFor(item, store) {
  const t = (item && item.trip) || item || {};
  const trip = String(t.tripNumber || '');
  const unit = String(t.powerUnit || '');
  const mark = (store.marks || {})[trip] || null;
  if (mark && mark.cleared) return null;
  const sheet = item && item._manifest && item._manifest.outsideCarrier;
  const fromSheet = sheet && sheet.isOutsideCarrier ? sheet : null;
  const code = isOcUnit(unit) ? unit.toUpperCase().replace(/[\s-]/g, '') : null;
  if (!mark && !fromSheet && !code) return null;
  const carriers = store.carriers || {};
  let carrier = null;
  if (mark && mark.carrierId) carrier = carriers[mark.carrierId] || null;
  if (!carrier && code && (store.codes || {})[code]) carrier = carriers[store.codes[code]] || null;
  if (!carrier && fromSheet && fromSheet.name) carrier = Object.values(carriers).find((c) => norm(c.name) === norm(fromSheet.name)) || null;
  const pick = (k) => (mark && mark[k]) || (fromSheet && fromSheet[k]) || null;
  const out = {
    isOC: true,
    code,
    source: mark && mark.source ? mark.source : (fromSheet ? 'trip sheet' : (code ? 'TruckMate unit code' : 'manual')),
    carrier: carrier || (fromSheet && fromSheet.name ? { id: null, name: fromSheet.name, dispatchPhone: fromSheet.dispatchPhone || null, email: fromSheet.email || null, mc: fromSheet.mc || null, dot: fromSheet.dot || null, trackingMethod: 'check_call', unsaved: true } : null),
    truck: pick('truck') || (code ? null : unit || null),
    trailer: pick('trailer') || t.trailer || null,
    driverName: pick('driverName'),
    driverPhone: pick('driverPhone'),
    driver2Name: pick('driver2Name'),
    driver2Phone: pick('driver2Phone'),
    // solo / team is the dispatcher's call; TruckMate's 2nd driver is the default hint
    crew: (mark && mark.crew) || (t.driver2 ? 'team' : 'solo'),
    infoFrom: mark && mark.infoAt ? { by: mark.infoBy || 'driver app', at: mark.infoAt } : null,
    // the driver agreed to load texts — who recorded it and when (carrier proof)
    smsConsent: mark && mark.smsConsent ? mark.smsConsent : null,
    markedBy: mark ? mark.by || null : null,
    markedAt: mark ? mark.at || null : null,
    evidence: fromSheet ? fromSheet.evidence || null : null,
  };
  out.missing = ocMissing(out);
  return out;
}

export function initCarriers(app, { requireAuth, db }) {
  const enabled = !!(db && db.enabled);
  const key = (site) => `taCarriers:${site}`;
  const ckKey = (site) => `taCarrierCheckins:${site}`;
  const empty = { carriers: {}, codes: {}, marks: {} };
  const siteOf = (req) => String((req.query && req.query.site) || (req.body && req.body.site) || 'florida-beauty');
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clean = (v) => (v == null ? null : String(v).trim().slice(0, 200) || null);

  // Add or update a carrier found on a trip sheet. Never overwrites a value a
  // dispatcher typed in (fields listed in `edited`).
  function upsertInto(store, found, code = null) {
    if (!found || !found.name) return null;
    const s = { ...empty, ...store, carriers: { ...store.carriers }, codes: { ...store.codes } };
    let c = Object.values(s.carriers).find((x) => norm(x.name) === norm(found.name));
    if (!c) { c = { id: newId(), name: clean(found.name), trackingMethod: 'check_call', codes: [], edited: [], createdAt: new Date().toISOString(), source: 'trip sheet' }; }
    c = { ...c };
    for (const k of ['dispatchPhone', 'email', 'mc', 'dot']) {
      if (found[k] && !(c.edited || []).includes(k) && !c[k]) c[k] = clean(found[k]);
    }
    if (code && !(c.codes || []).includes(code)) { c.codes = [...(c.codes || []), code]; s.codes[code] = c.id; }
    s.carriers[c.id] = c;
    return { store: s, carrier: c };
  }

  async function read(site) { return enabled ? { ...empty, ...(await db.get(key(site), empty)) } : { ...empty }; }

  // Called by the trip-sheet reader with every OC it found.
  async function recordFromSheets(site, found) {
    if (!enabled || !found.length) return;
    await db.update(key(site), (cur) => {
      let s = { ...empty, ...(cur || {}) };
      for (const f of found) { const r = upsertInto(s, f.carrier, f.code); if (r) s = r.store; }
      return s;
    }, empty);
  }

  async function addCheckins(site, trip, list) {
    if (!enabled || !list.length) return;
    await db.update(ckKey(site), (cur) => {
      const all = { ...(cur || {}) };
      const have = all[trip] || [];
      const sig = (c) => `${c.source}|${c.at}|${String(c.text || '').slice(0, 80)}`;
      const seen = new Set(have.map(sig));
      const add = list.filter((c) => !seen.has(sig(c)));
      all[trip] = [...add, ...have].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
      return all;
    }, {});
  }

  // The driver filled in the tracking-link form: names, phones, truck, trailer.
  // Merged into the trip's mark so every screen and the Watchtower see it.
  async function setDriverInfo(site, trip, info) {
    if (!enabled) return null;
    let mark = null;
    await db.update(key(site), (cur) => {
      const s = { ...empty, ...(cur || {}), marks: { ...((cur || {}).marks || {}) } };
      const prev = s.marks[trip] && !s.marks[trip].cleared ? s.marks[trip] : {};
      const [d1 = {}, d2 = {}] = info.drivers || [];
      mark = {
        ...prev,
        driverName: clean(d1.name) || prev.driverName || null, driverPhone: clean(d1.phone) || prev.driverPhone || null,
        driver2Name: clean(d2.name) || (info.crew === 'team' ? prev.driver2Name || null : null),
        driver2Phone: clean(d2.phone) || (info.crew === 'team' ? prev.driver2Phone || null : null),
        truck: clean(info.truck) || prev.truck || null, trailer: clean(info.trailer) || prev.trailer || null,
        crew: prev.crew || info.crew || null,
        infoAt: new Date().toISOString(), infoBy: clean(d1.name) ? `${clean(d1.name)} (driver app)` : 'driver app',
      };
      s.marks[trip] = mark;
      return s;
    }, empty);
    return mark;
  }

  // Board overlay: _oc and _checkins on every item (one read each per build).
  async function overlay(site, trips) {
    if (!enabled) return;
    const store = await read(site);
    const checks = await db.get(ckKey(site), {});
    for (const item of trips) {
      const t = (item && item.trip) || item || {};
      const oc = ocFor(item, store);
      if (oc) item._oc = oc;
      const list = checks[String(t.tripNumber || '')];
      if (list && list.length) item._checkins = list;
    }
  }

  app.get('/truckmate/carriers', requireAuth, async (req, res) => {
    try { const s = await read(siteOf(req)); res.json(Object.values(s.carriers).sort((a, b) => a.name.localeCompare(b.name))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  const applyEdits = (c, b, by) => {
    const n = { ...c, edited: [...new Set([...(c.edited || [])])] };
    for (const k of ['name', 'dispatchPhone', 'email', 'trackingEmail', 'mc', 'dot', 'notes', 'trackingRef']) {
      if (k in b) { n[k] = clean(b[k]); if (!n.edited.includes(k)) n.edited.push(k); }
    }
    if (b.trackingMethod && TRACKING_METHODS.includes(b.trackingMethod)) n.trackingMethod = b.trackingMethod;
    if (Array.isArray(b.codes)) n.codes = [...new Set(b.codes.map((x) => String(x).toUpperCase().replace(/[\s-]/g, '')).filter((x) => isOcUnit(x)))];
    n.updatedBy = by; n.updatedAt = new Date().toISOString();
    return n;
  };

  app.post('/truckmate/carriers', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    if (!clean(b.name)) return res.status(400).json({ error: 'Carrier name is required.' });
    try {
      let created = null;
      await db.update(key(siteOf(req)), (cur) => {
        const s = { ...empty, ...(cur || {}), carriers: { ...((cur || {}).carriers || {}) }, codes: { ...((cur || {}).codes || {}) } };
        const existing = Object.values(s.carriers).find((x) => norm(x.name) === norm(b.name));
        created = applyEdits(existing || { id: newId(), name: clean(b.name), trackingMethod: 'check_call', codes: [], createdAt: new Date().toISOString(), source: 'manual' }, b, who(req));
        s.carriers[created.id] = created;
        (created.codes || []).forEach((code) => { s.codes[code] = created.id; });
        return s;
      }, empty);
      res.json(created);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/truckmate/carriers/:id', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    try {
      let updated = null;
      await db.update(key(siteOf(req)), (cur) => {
        const s = { ...empty, ...(cur || {}), carriers: { ...((cur || {}).carriers || {}) }, codes: { ...((cur || {}).codes || {}) } };
        const c = s.carriers[req.params.id];
        if (!c) return s;
        updated = applyEdits(c, req.body || {}, who(req));
        Object.keys(s.codes).forEach((code) => { if (s.codes[code] === c.id && !(updated.codes || []).includes(code)) delete s.codes[code]; });
        (updated.codes || []).forEach((code) => { s.codes[code] = updated.id; });
        s.carriers[c.id] = updated;
        return s;
      }, empty);
      if (!updated) return res.status(404).json({ error: 'Carrier not found.' });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mark a trip as OC (or edit / clear it). carrierName creates the carrier if new.
  app.post('/truckmate/oc/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const trip = String(req.params.trip || '').trim();
    const b = req.body || {};
    try {
      let mark = null;
      await db.update(key(siteOf(req)), (cur) => {
        let s = { ...empty, ...(cur || {}), marks: { ...((cur || {}).marks || {}) } };
        if (b.clear) { s.marks[trip] = { cleared: true, by: who(req), at: new Date().toISOString() }; mark = s.marks[trip]; return s; }
        let carrierId = b.carrierId || null;
        if (!carrierId && clean(b.carrierName)) { const r = upsertInto(s, { name: b.carrierName }); s = r.store; carrierId = r.carrier.id; }
        // carrier's main phone, typed by the dispatcher on the OC form
        // carrier details typed on the OC form (main phone, email, MC, DOT) — kept
        // as the dispatcher's values, so a later trip sheet never overwrites them
        const fields = { carrierPhone: 'dispatchPhone', carrierEmail: 'email', mc: 'mc', dot: 'dot' };
        if (carrierId && s.carriers[carrierId] && Object.keys(fields).some((k) => k in b)) {
          const c = { ...s.carriers[carrierId] };
          const edited = new Set(c.edited || []);
          for (const [k, f] of Object.entries(fields)) if (k in b) { c[f] = clean(b[k]); edited.add(f); }
          if (clean(b.carrierName) && clean(b.carrierName) !== c.name) { c.name = clean(b.carrierName); edited.add('name'); }
          c.edited = [...edited];
          s.carriers = { ...s.carriers, [carrierId]: c };
        }
        const prev = s.marks[trip] && !s.marks[trip].cleared ? s.marks[trip] : {};
        mark = {
          carrierId, truck: clean(b.truck), trailer: clean(b.trailer), driverName: clean(b.driverName), driverPhone: clean(b.driverPhone),
          driver2Name: clean(b.driver2Name), driver2Phone: clean(b.driver2Phone),
          crew: b.crew === 'team' || b.crew === 'solo' ? b.crew : (prev.crew || null),
          infoAt: prev.infoAt || null, infoBy: prev.infoBy || null,
          source: 'manual', by: who(req), at: new Date().toISOString(),
        };
        s.marks = { ...s.marks, [trip]: mark };
        return s;
      }, empty);
      res.json(mark);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Record (or withdraw) that the driver agreed to texts about this load.
  app.post('/truckmate/oc/:trip/consent', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const trip = String(req.params.trip || '').trim();
    const agreed = !!(req.body && req.body.agreed);
    try {
      let mark = null;
      await db.update(key(siteOf(req)), (cur) => {
        const s = { ...empty, ...(cur || {}), marks: { ...((cur || {}).marks || {}) } };
        const prev = s.marks[trip] && !s.marks[trip].cleared ? s.marks[trip] : {};
        mark = { ...prev, smsConsent: agreed ? { by: who(req), at: new Date().toISOString(), how: clean(req.body && req.body.how) || 'verbal (dispatcher call)' } : null };
        s.marks[trip] = mark;
        return s;
      }, empty);
      res.json({ smsConsent: mark.smsConsent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/truckmate/checkins/:trip', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const text = clean(b.note) || clean(b.location);
    if (!text) return res.status(400).json({ error: 'Add where the truck is or a note.' });
    try {
      const entry = { at: new Date().toISOString(), source: 'check call', location: clean(b.location), text: clean(b.note) || `Location: ${clean(b.location)}`, issue: !!b.issue, by: who(req) };
      await addCheckins(siteOf(req), String(req.params.trip), [entry]);
      res.json(entry);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log(`[carriers] outside-carrier tracking ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { overlay, recordFromSheets, addCheckins, read, setDriverInfo };
}

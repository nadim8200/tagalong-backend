// ---------------------------------------------------------------
// OC loads Jarvis creates from email. Some loads never come from TruckMate: staff email Jarvis "create / follow / track this
// load (outside carrier)" with the broker's rate con attached, and Jarvis puts a card on the board just like a TruckMate one,
// marked outside carrier and labeled "OC LOAD <the rate con's load number>".
//   • It gets a trip number from its own range (990001 and up) so everything that works by trip number works on it.
//   • When TruckMate shows the same load (its bill, or a rate con with the same load / reference number), the email card folds
//     into the TruckMate card: the OC info, tracking link and rate con move over, and the email card goes away.
//   • It closes when the OC driver confirms delivery in the TagAlong app: the board sweep then finishes it and the final load
//     report email goes out (finished.js / rundown.js).
// ---------------------------------------------------------------
const FIRST = 990000;
const key = (site) => `taOcLoads:${site}`;
const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
const place = (p) => [p && p.city, p && p.state].filter(Boolean).join(', ');
const tripOf = (it) => (it && it.trip) || it || {};

// The numbers a rate con can be found by: load #, the broker's references, our bill. Pure.
export function idsOf(rc = {}) {
  return [...new Set([rc.loadNumber, ...(rc.referenceNumbers || []), rc.fbfBillNumber].map(norm).filter((x) => x.length >= 4))];
}

// The card for an email OC load, shaped like a TruckMate trip. Pure.
export function ocLoadItem(load) {
  const rc = load.record || {};
  const pickups = rc.pickups || []; const deliveries = rc.deliveries || [];
  const last = deliveries[deliveries.length - 1] || null;
  const label = `OC LOAD ${load.loadNumber || load.id}`;
  const bill = rc.fbfBillNumber || (load.loadNumber ? `RC ${load.loadNumber}` : `OC ${load.id}`);
  const bills = (deliveries.length ? deliveries : [null]).map((d, i) => ({
    billNumber: i === 0 ? bill : `${bill}-${i + 1}`, billToName: rc.broker || null,
    endZoneDescription: d ? [d.city, d.state, d.zip].filter(Boolean).join(', ') : null, consignee: d && d.name ? { name: d.name } : null,
    deliverBy: d && d.date ? `${d.date}${d.time ? ` ${d.time}` : ''}` : null, actualDelivery: load.deliveredAt || null,
  }));
  return {
    _id: load.id,
    trip: { tripNumber: load.id, powerUnit: 'OC', trailer: rc.trailerNumber || '', status: 'DISP', statusDesc: 'OC load created from email',
      origZoneDesc: place(pickups[0]) || null, destZoneDesc: place(last) || null, driver: null },
    freightBills: bills,
    _ocEmail: { label, loadNumber: load.loadNumber || null, broker: rc.broker || null, createdBy: load.createdBy, createdAt: load.createdAt, subject: load.subject || null, deliveredAt: load.deliveredAt || null, deliveredBy: load.deliveredBy || null },
  };
}

// Which TruckMate trip is this email load: our bill on it, or its rate con has the same load / reference number. Pure.
export function foldTarget(load, tmTrips = [], rcByTrip = {}) {
  const ids = new Set(idsOf(load.record));
  if (!ids.size) return null;
  for (const it of tmTrips) {
    const n = String(tripOf(it).tripNumber || '');
    if (!n || Number(n) > FIRST) continue;
    const bills = ((it && (it.freightBills || it.orders)) || []).map((b) => norm(b && b.billNumber));
    if (bills.some((b) => ids.has(b))) return n;
    if (idsOf(rcByTrip[n] || {}).some((x) => ids.has(x))) return n;
  }
  return null;
}

export function initOcLoads({ app = null, requireAuth = null, db, ratecon = null, carriers = null, driverLinks = null, now = () => Date.now() } = {}) {
  const enabled = !!(db && db.enabled);
  const iso = () => new Date(now()).toISOString();
  const all = async (site) => ((enabled && (await db.get(key(site), null))) || { seq: 0, loads: {} });

  // A rate con staff sent with "create / track this load": the card (or the one already made for that load number).
  async function create(site, { record, by, emailId = null, subject = null, docIds = [] }) {
    if (!enabled) return { ok: false, error: 'Needs the database.' };
    if (!record || (!record.loadNumber && !(record.pickups || []).length && !(record.deliveries || []).length)) return { ok: false, error: 'I could not read a load number or stops on the rate con.' };
    const ids = new Set(idsOf(record));
    let made = null; let existing = null;
    await db.update(key(site), (cur) => {
      const s = { seq: 0, loads: {}, ...(cur || {}) }; s.loads = { ...(s.loads || {}) };
      existing = Object.values(s.loads).find((l) => !l.foldedInto && !l.deliveredAt && idsOf(l.record).some((x) => ids.has(x))) || null;
      if (existing) return s;
      s.seq = (s.seq || 0) + 1;
      const id = String(FIRST + s.seq);
      made = { id, loadNumber: record.loadNumber || (record.referenceNumbers || [])[0] || null, record, createdAt: iso(), createdBy: by, emailId, subject, docIds };
      s.loads[id] = made;
      return s;
    }, { seq: 0, loads: {} });
    if (existing) return { ok: true, existing: true, id: existing.id, label: ocLoadItem(existing)._ocEmail.label };
    if (ratecon && ratecon.save) await ratecon.save(site, made.id, { ...record, source: 'email (Jarvis OC load)', uploadedBy: by, uploadedAt: made.createdAt, docIds }).catch(() => {});
    if (carriers && carriers.markOc) await carriers.markOc(site, made.id, { by, evidence: `created from email${subject ? `: ${subject}` : ''}` }).catch(() => {});
    return { ok: true, id: made.id, label: ocLoadItem(made)._ocEmail.label };
  }

  // Every board build: the open email loads as cards; one TruckMate now has is folded into it.
  async function extra(site, tmTrips = []) {
    if (!enabled) return [];
    const s = await all(site);
    const open = Object.values(s.loads || {}).filter((l) => !l.foldedInto && !(l.deliveredAt && now() - Date.parse(l.deliveredAt) > 7 * 86400000));
    if (!open.length) return [];
    const rcByTrip = (await db.get(`taTruckMateRateCon:${site}`, {})) || {};
    const out = [];
    for (const l of open) {
      const target = l.deliveredAt ? null : foldTarget(l, tmTrips, rcByTrip);
      if (target) { await fold(site, l, target, rcByTrip).catch((e) => console.warn('[oc-loads] fold:', e.message)); continue; } // eslint-disable-line no-await-in-loop
      out.push(ocLoadItem(l));
    }
    return out;
  }

  async function fold(site, l, trip, rcByTrip = {}) {
    if (carriers && carriers.moveMark) await carriers.moveMark(site, l.id, trip);
    if (driverLinks && driverLinks.moveLink) await driverLinks.moveLink(site, l.id, trip);
    if (ratecon && ratecon.save && !rcByTrip[trip]) await ratecon.save(site, trip, { ...l.record, source: `email (Jarvis OC load ${l.loadNumber || l.id})` });
    await db.update(key(site), (cur) => { const s = { ...(cur || {}), loads: { ...((cur || {}).loads || {}) } }; if (s.loads[l.id]) s.loads[l.id] = { ...s.loads[l.id], foldedInto: trip, foldedAt: iso() }; return s; }, { seq: 0, loads: {} });
    console.log(`[oc-loads] OC LOAD ${l.loadNumber || l.id} folded into TruckMate trip ${trip}`);
  }

  // The OC driver confirmed delivery in the TagAlong app: the next board sweep finishes it and the final report goes out.
  async function delivered(site, id, by) {
    if (!enabled) return false;
    let ok = false;
    await db.update(key(site), (cur) => { const s = { ...(cur || {}), loads: { ...((cur || {}).loads || {}) } }; const l = s.loads[String(id)]; if (l && !l.deliveredAt && !l.foldedInto) { s.loads[String(id)] = { ...l, deliveredAt: iso(), deliveredBy: by }; ok = true; } return s; }, { seq: 0, loads: {} });
    return ok;
  }

  // dispatch makes one by hand (a load with no email, or a test): the load #, broker, our bill and the stops, like a rate con would
  //   POST /truckmate/oc-loads { loadNumber, broker, billNumber, pickup: { name, city, state, date, time }, delivery: { … } }
  if (app && requireAuth) {
    app.post('/truckmate/oc-loads', requireAuth, async (req, res) => {
      const b = req.body || {}; const s = (v, n = 80) => String(v || '').trim().slice(0, n) || null;
      const stop = (x) => (x && (x.city || x.name) ? { name: s(x.name), address: s(x.address, 120), city: s(x.city, 60), state: s(x.state, 20), zip: s(x.zip, 10), date: s(x.date, 20), time: s(x.time, 20) } : null);
      const record = { broker: s(b.broker), loadNumber: s(b.loadNumber, 40), fbfBillNumber: s(b.billNumber, 20), referenceNumbers: [], pickups: [stop(b.pickup)].filter(Boolean), deliveries: [stop(b.delivery)].filter(Boolean), summary: b.test ? 'Test load made by dispatch' : 'Made by dispatch' };
      if (!record.loadNumber) return res.status(400).json({ error: 'Load number missing.' });
      try { return res.json(await create(String(b.site || 'florida-beauty'), { record, by: (req.user && (req.user.name || req.user.email)) || 'dispatch', subject: b.test ? 'TEST load' : null })); } catch (e) { return res.status(500).json({ error: e.message }); }
    });
  }

  const isEmailLoad = (trip) => Number(trip) > FIRST;
  const list = async (site) => Object.values((await all(site)).loads || {});
  return { create, extra, delivered, isEmailLoad, list };
}

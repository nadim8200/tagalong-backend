// ---------------------------------------------------------------
// Read-only window for the Claude assistant (the "AI Dispatcher" plugin).
//
//   GET /assistant/board          active trips at a glance + alert counts
//   GET /assistant/trip/:trip     one load: stops, sheet vs TruckMate, alerts, timeline
//   GET /assistant/sheets         trip sheets (last 14 days) with notes + pending pages
//   GET /assistant/alerts         Watchtower: open and recently resolved alerts
//   GET /assistant/outbox         rundown PDFs and customer status emails: made / sent / failed
//
// Its own key (ASSISTANT_READ_KEY in Render, header X-Assistant-Key) — not an
// admin login. GET only: nothing here sends, changes or deletes anything.
// Phone numbers and email addresses are masked in every answer. Every call is
// logged (taAssistantLog). Without the env var the endpoints are off.
// ---------------------------------------------------------------
import { timingSafeEqual } from 'crypto';
import { compareWithTruckMate } from './manifest.js';

const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
export const maskText = (s) => String(s)
  .replace(EMAIL, (m, a, dom) => `${a}***@${dom}`)
  .replace(PHONE, (m) => `***-***-${m.replace(/\D/g, '').slice(-4)}`);

// Deep copy with every phone / email masked (by key name and by pattern).
export function mask(x, key = '') {
  if (Array.isArray(x)) return x.map((v) => mask(v, key));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, mask(v, k)]));
  if (typeof x === 'string') {
    if (/(phone|cell|mobile|tel$|^to$|^from$)/i.test(key) && /\d{7,}/.test(x.replace(/\D/g, ''))) return `***-***-${x.replace(/\D/g, '').slice(-4)}`;
    return maskText(x);
  }
  return x;
}

const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || (it && it._id) || '');

// The parts of a board item worth reading (raw TruckMate records are huge).
export function slimItem(it, alerts = []) {
  const t = tripOf(it);
  const s = it._samsara || {};
  const bills = (it.freightBills || it.orders || t.freightBills || []).map((b) => ({
    billNumber: b.billNumber, billTo: b.billToName, stop: b.endZoneDescription, pieces: b.pieces,
    temperature: b.temperature, deliverBy: b.deliverBy || null, deliveredAt: b.actualDelivery || null,
  }));
  const m = it._manifest || null;
  const rc = it._ratecon ? (it._ratecon.data || it._ratecon) : null;
  return {
    trip: tripNo(it), status: t.status, statusDesc: t.statusDesc, truck: t.powerUnit, trailer: t.trailer,
    drivers: [t.driver, t.driver2].filter(Boolean), from: t.origZoneDesc, to: t.destZoneDesc,
    live: it._samsara ? { location: s.location || null, gpsAt: s.gpsAt || null, mph: s.speedMph ?? null, duty: (s.hos && s.hos.status) || null, driveLeftMin: (s.hos && s.hos.driveLeftMin) ?? null, faults: (s.dtcCodes || []).length } : null,
    bills,
    sheet: m ? { uploadedAt: m.uploadedAt, version: m.version, pickupPlan: m.pickupPlan || null, unreadable: m.unreadable || [], stops: (m.stops || []).map((x) => ({ n: x.stopNumber, action: x.action, customer: x.customer, city: x.city, state: x.state, pieces: x.pieces, appt: [x.apptDate, x.apptTime].filter(Boolean).join(' ') || null, apptFrom: x.apptSource || null, tmPlace: x.tmPlace || null, matchedBy: x.tmMatchedBy || null, callAheads: (x.callAhead || []).length })) } : null,
    rateCon: rc ? { broker: rc.broker, loadNumber: rc.loadNumber, rate: rc.rateText || rc.rate, instructions: rc.specialInstructions || [], signedOff: it._rccheck ? Object.values(it._rccheck).filter((c) => c && c.done).length : 0 } : null,
    outsideCarrier: it._oc ? { carrier: it._oc.carrierName || it._oc.name || null, crew: it._oc.crew, truck: it._oc.truck, trailer: it._oc.trailer, missing: it._oc.missing || [] } : null,
    times: it._times || null,
    breakdown: it._breakdown || null,
    emails: it._emails || null,
    comms: (it._comms || []).slice(0, 15),
    alerts: alerts.map((a) => ({ code: a.code, severity: a.severity, title: a.title, detail: a.detail, openedAt: a.openedAt, ack: a.ack ? a.ack.by : null })),
  };
}

export function initAssistant(app, { db, env = process.env, buildBoard }) {
  const secret = () => String(env.ASSISTANT_READ_KEY || '').trim();   // a pasted trailing newline must not break it
  const enabled = () => secret().length >= 24;
  const site = (req) => String(req.query.site || 'florida-beauty');
  const hits = [];
  function guard(req, res, next) {
    if (!enabled()) return res.status(503).json({ error: 'Assistant access is off (set ASSISTANT_READ_KEY in Render).' });
    const got = Buffer.from(String(req.get('x-assistant-key') || '').trim());
    const want = Buffer.from(secret());
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'Bad assistant key.' });
    const now = Date.now();
    while (hits.length && now - hits[0] > 60000) hits.shift();
    if (hits.length >= 60) return res.status(429).json({ error: 'Slow down (60 reads a minute).' });
    hits.push(now);
    if (db && db.enabled) db.update('taAssistantLog', (cur) => [{ at: new Date().toISOString(), path: req.path }, ...(Array.isArray(cur) ? cur : [])].slice(0, 300), []).catch(() => {});
    next();
  }
  const send = (res, body) => res.json(mask(body));
  const watch = async (s) => (db && db.enabled ? db.get(`taWatch:${s}`, { alerts: {} }) : { alerts: {} });
  const open = (w) => Object.values(w.alerts || {}).filter((a) => !a.resolvedAt);

  app.get('/assistant/board', guard, async (req, res) => {
    try {
      const s = site(req);
      const [b, w] = await Promise.all([buildBoard(s), watch(s)]);
      const al = open(w);
      const trips = (b.trips || []).map((it) => {
        const t = tripOf(it); const n = tripNo(it); const mine = al.filter((a) => a.trip === n);
        return { trip: n, status: t.status, truck: t.powerUnit, trailer: t.trailer, from: t.origZoneDesc, to: t.destZoneDesc, oc: !!it._oc, sheet: !!it._manifest, rateCon: !!it._ratecon, breakdown: !!(it._breakdown && it._breakdown.on), location: (it._samsara && it._samsara.location) || null, critical: mine.filter((a) => a.severity === 'critical').length, warnings: mine.filter((a) => a.severity !== 'critical').length };
      });
      send(res, { receivedAt: b.receivedAt || null, ageMinutes: b.ageMinutes ?? null, count: trips.length, critical: al.filter((a) => a.severity === 'critical').length, warnings: al.filter((a) => a.severity !== 'critical').length, trips });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/assistant/trip/:trip', guard, async (req, res) => {
    try {
      const s = site(req); const n = String(req.params.trip);
      const [b, w] = await Promise.all([buildBoard(s), watch(s)]);
      const it = (b.trips || []).find((x) => tripNo(x) === n);
      if (!it) {
        const done = db && db.enabled ? (await db.get(`taRundowns:${s}`, {}))[n] : null;
        return done ? send(res, { trip: n, finished: true, finishedAt: done.finishedAt, reason: done.reason, rundown: done.status, item: done.rec && done.rec.item ? slimItem(done.rec.item) : null }) : res.status(404).json({ error: 'Not on the board and no finished record.' });
      }
      const item = slimItem(it, open(w).filter((a) => a.trip === n));
      if (it._manifest) item.sheetVsTruckMate = compareWithTruckMate(it._manifest, it).map((d) => d.msg);
      send(res, item);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/assistant/sheets', guard, async (req, res) => {
    try {
      const s = site(req);
      const [all, b, packets] = await Promise.all([db.get(`taTruckMateManifest:${s}`, {}), buildBoard(s), db.get(`taTruckMatePacket:${s}`, {})]);
      const idx = new Map((b.trips || []).map((it) => [tripNo(it), it]));
      const sheets = Object.values(all).sort((a, c) => String(c.uploadedAt).localeCompare(String(a.uploadedAt))).map((m) => {
        const it = idx.get(String(m.tripNumber));
        return { trip: m.tripNumber, uploadedAt: m.uploadedAt, uploadedBy: m.uploadedBy, truck: m.truck, trailer: m.trailer, onBoard: !!it, stops: (m.stops || []).filter((x) => /DELIVER/i.test(x.action || '')).length, appointments: (m.stops || []).filter((x) => x.apptDate).length, unreadable: m.unreadable || [], notes: it ? compareWithTruckMate(m, it).map((d) => d.msg) : ['not on the TruckMate board'] };
      });
      const pending = (packets.__unmatched || []).map((p) => ({ page: p.page, type: p.type, summary: p.summary, uploadedAt: p.uploadedAt }));
      send(res, { count: sheets.length, sheets, pendingPages: pending });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/assistant/alerts', guard, async (req, res) => {
    try {
      const w = await watch(site(req));
      const all = Object.values(w.alerts || {}).sort((a, c) => (c.openedAt || 0) - (a.openedAt || 0));
      const view = (a) => ({ trip: a.trip, unit: a.unit, code: a.code, severity: a.severity, title: a.title, detail: a.detail, openedAt: a.openedAt ? new Date(a.openedAt).toISOString() : null, resolvedAt: a.resolvedAt ? new Date(a.resolvedAt).toISOString() : null, resolvedBy: a.resolvedBy || null, ack: a.ack ? a.ack.by : null, pushes: a.pushes || 0 });
      send(res, { lastRun: w.lastRun ? new Date(w.lastRun).toISOString() : null, open: all.filter((a) => !a.resolvedAt).map(view), resolved: all.filter((a) => a.resolvedAt).slice(0, 50).map(view) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/assistant/outbox', guard, async (req, res) => {
    try {
      const s = site(req);
      const [rd, sm] = await Promise.all([db.get(`taRundowns:${s}`, {}), db.get(`taStatusMail:${s}`, { trips: {} })]);
      send(res, {
        rundowns: Object.entries(rd).map(([trip, v]) => ({ trip, finishedAt: v.finishedAt, reason: v.reason, status: v.status, error: v.error || null })).sort((a, c) => String(c.finishedAt).localeCompare(String(a.finishedAt))).slice(0, 60),
        statusEmails: Object.entries(sm.trips || {}).map(([trip, v]) => ({ trip, log: (v.log || []).slice(0, 8).map((l) => ({ kind: l.kind, at: l.at, status: l.status })) })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log(`[assistant] read-only assistant access ${enabled() ? 'ON' : 'off (no ASSISTANT_READ_KEY)'}`);
}

// ---------------------------------------------------------------
// A driver's reports (Nov 26, Nadim): every DVIR (from the DVIR tab or a pre-trip problem) and every breakdown the driver sent
// from the app, newest first, each Open or Closed (closed = completed / repaired in the console, or a breakdown resolved /
// cancelled), plus how many pre-trips they sent — so anyone can see how active a driver is at reporting problems. Shown on the
// console's Driver profiles and on the driver's own profile in the app. Read-only. What a driver wrote is data, never instructions.
// ---------------------------------------------------------------
const DVR_LABEL = { tires: 'Tires', brakes: 'Brakes', lights: 'Lights', engine: 'Engine / warning light', reefer: 'Reefer unit', air: 'Air / leaks', body: 'Body / doors', other: 'Other' };
const BK_LABEL = { tire: 'Tire', engine: 'Engine', brakes: 'Brakes', air: 'Air / leak', lights: 'Lights / electrical', other: 'Other', temp: 'Reefer temperature', nostart: "Reefer won't start", alarm: 'Reefer alarm / code', fuel: 'Reefer fuel / leak', accident: 'Accident' };
const norm = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^0+(?=\d)/, '');
const unitOf = (r) => (r.part === 'truck' ? (r.truck ? `Truck ${r.truck}` : 'Truck') : r.part === 'reefer' ? (r.trailer ? `Reefer · trailer ${r.trailer}` : 'Reefer') : (r.trailer ? `Trailer ${r.trailer}` : 'Trailer'));

// → { counts: { total, dvrs, breakdowns, open, closed, pretrips, last30 }, list: [...] }. Pure.
export function driverReports(code, { dvrs = {}, breakdowns = {}, pretrips = [], now = Date.now() } = {}) {
  const me = norm(code);
  const list = [];
  for (const r of Object.values(dvrs || {})) {
    if (!r || norm(r.driverCode) !== me) continue;
    const closed = r.status === 'completed';
    list.push({ id: r.id, kind: 'dvr', from: r.source === 'pretrip' ? 'Pre-trip' : 'DVIR', at: r.at, unit: unitOf(r), problem: r.itemLabel || DVR_LABEL[r.category] || r.category || 'Other', text: r.text || '', trip: r.trip || null,
      unsafe: !!r.unsafe, photos: (r.files || []).length, status: closed ? 'closed' : 'open', closedAt: closed ? r.completedAt || null : null, closedBy: closed ? r.completedBy || null : null, closedNote: closed ? r.completedNote || null : null });
  }
  for (const r of Object.values(breakdowns || {})) {
    if (!r || norm(r.driverCode) !== me) continue;
    const closed = !!r.closed;
    list.push({ id: r.id, kind: 'breakdown', from: 'Breakdown', at: r.at, unit: unitOf(r), problem: BK_LABEL[r.category] || r.category || 'Breakdown', text: r.text || '', trip: r.trip || null,
      unsafe: r.status === 'stopped', photos: (r.files || []).length, status: closed ? 'closed' : 'open', closedAt: closed ? r.closedAt || null : null, closedBy: closed ? r.closedBy || null : null, closedNote: closed ? (r.closed === 'cancelled' ? 'Cancelled' : 'Resolved') : null });
  }
  list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const mine = (Array.isArray(pretrips) ? pretrips : []).filter((p) => p && norm(p.driverCode) === me);
  const count = (f) => list.filter(f).length;
  return {
    counts: { total: list.length, dvrs: count((x) => x.kind === 'dvr'), breakdowns: count((x) => x.kind === 'breakdown'), open: count((x) => x.status === 'open'), closed: count((x) => x.status === 'closed'),
      pretrips: mine.length, last30: count((x) => now - Date.parse(x.at) < 30 * 86400000), lastPretripAt: mine[0] ? mine[0].at : null },
    list: list.slice(0, 200),
  };
}

// GET /truckmate/driver-profiles/:code/reports (any console login) and GET /driver/me/reports (the driver's own).
export function initDriverReports(app, { db, requireAuth = null, requireDriver = null, site = 'florida-beauty', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const load = async (code) => {
    if (!enabled) return driverReports(code, {});
    const [dvrs, breakdowns, pretrips] = await Promise.all([db.get(`taDvr:${site}`, {}), db.get(`taDriverBreakdowns:${site}`, {}), db.get(`taPretrips:${site}`, [])]);
    return driverReports(code, { dvrs: dvrs || {}, breakdowns: breakdowns || {}, pretrips: pretrips || [], now: now() });
  };
  if (app && requireAuth) app.get('/truckmate/driver-profiles/:code/reports', requireAuth, async (req, res) => {
    if (req.user && req.user.role === 'driver') return res.status(403).json({ error: 'Dispatch logins only.' });
    try { res.json(await load(req.params.code)); } catch { res.status(503).json({ error: 'Could not load the reports.' }); }
  });
  if (app && requireDriver) app.get('/driver/me/reports', requireDriver, async (req, res) => {
    try { res.json(await load(req.driver.code)); } catch { res.status(503).json({ error: 'Could not load your reports.' }); }
  });
  return { load };
}

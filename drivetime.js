// ---------------------------------------------------------------
// Driving time on the truck card (Nov 19): each driver's last 24 hours of duty status from the Samsara ELD — the graph
// (off duty / sleeper / driving / on duty), the totals, when they last drove and since when they're in the status they're
// in now. Read only when dispatch opens the card's "Driving time" (cached 5 min a trip), so the board stays light.
// ---------------------------------------------------------------
import { driverHosLogs, samsaraTokenFrom } from './samsara.js';

const HOUR = 3600000; const MIN = 60000;
const tripOf = (it) => (it && it.trip) || it || {};
const STATUS = { offDuty: 'off', sleeperBerth: 'sleeper', driving: 'driving', onDuty: 'on', yardMove: 'on', personalConveyance: 'off' };

// A driver's logs → their last 24 hours. Pure.
export function dayOf(logs = [], driverId, now = Date.now(), hours = 24) {
  const from = now - hours * HOUR;
  const mine = logs.filter((l) => String(l.driverId) === String(driverId)).sort((a, b) => a.from - b.from);
  const segments = mine.filter((l) => l.to > from && l.from < now).map((l) => ({ status: STATUS[l.status] || 'on', from: Math.max(l.from, from), to: Math.min(l.to || now, now) }));
  const totals = { off: 0, sleeper: 0, driving: 0, on: 0 };
  for (const s of segments) totals[s.status] += Math.round((s.to - s.from) / MIN);
  const lastDrive = [...mine].reverse().find((l) => (STATUS[l.status] || 'on') === 'driving');
  // since when in the status they're in now (back-to-back logs of the same kind join)
  let since = null;
  if (mine.length) {
    const cur = STATUS[mine[mine.length - 1].status] || 'on';
    since = mine[mine.length - 1].from;
    for (let i = mine.length - 2; i >= 0; i--) { if ((STATUS[mine[i].status] || 'on') !== cur || mine[i].to < since - MIN) break; since = mine[i].from; }
  }
  return { from, to: now, segments, totals, lastDroveAt: lastDrive ? Math.min(lastDrive.to || now, now) : null, statusSince: since };
}

// One board load → each ELD driver's last 24 hours (also what Jarvis reads for "when did he last drive?"). →
// { drivers: [...] } or { drivers: [], note }. Throws only when Samsara fails.
export async function driveTimeFor(it, { env = process.env, logsFn = driverHosLogs, now = Date.now() } = {}) {
  const s = (it && it._samsara) || {};
  const crew = [[s.driver1, s.hos], [s.driver2, s.hos2]].filter(([, h]) => h && h.driverId);
  const token = samsaraTokenFrom(env);
  if (!crew.length || !token) return { drivers: [], note: !token ? 'Samsara isn\'t connected.' : 'No ELD driver on this truck in Samsara.' };
  const logs = await logsFn(token, crew.map(([, h]) => h.driverId), new Date(now - 26 * HOUR).toISOString(), new Date(now).toISOString());
  return { at: new Date(now).toISOString(), drivers: crew.map(([name, h]) => ({ name: name || h.driverName || null, driverId: h.driverId, ...dayOf(logs, h.driverId, now) })) };
}

export function initDriveTime(app, { requireAuth, getBoard, env = process.env, logsFn = driverHosLogs, now = () => Date.now() }) {
  const cache = new Map();   // trip → { at, out }
  app.get('/truckmate/drivetime/:trip', requireAuth, async (req, res) => {
    try {
      const trip = String(req.params.trip);
      const hit = cache.get(trip);
      if (hit && now() - hit.at < 5 * MIN) return res.json(hit.out);
      const it = (((await getBoard('florida-beauty')) || {}).trips || []).find((x) => String(tripOf(x).tripNumber) === trip);
      if (!it) return res.status(404).json({ error: 'That load isn\'t on the board.' });
      const t = now();
      const out = await driveTimeFor(it, { env, logsFn, now: t });
      if (!out.drivers.length) return res.json(out);
      cache.set(trip, { at: t, out });
      res.json(out);
    } catch (e) { res.status(502).json({ error: `Samsara didn't answer: ${e.message}` }); }
  });
}

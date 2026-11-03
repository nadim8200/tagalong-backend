// ---------------------------------------------------------------
// Driver profiles. A company driver signs in with what dispatch already has on file: their driver ID and their cell. The roster is
// Samsara's drivers (their username is the TruckMate driver ID, like 0986). They stay signed in until they sign out; a driver who leaves
// the roster, or whose cell changes, is out on the next request. Signed in, a driver sees their current and next loads, sends paperwork and
// messages dispatch on each load (through the load's own driver link), and sees what they sent. Outside carriers keep the load link they get by text.
// ---------------------------------------------------------------
const SITE = 'florida-beauty';
const MIN = 60000;
const MAX_TRIES = 10;               // wrong sign-ins per phone, or per connection, in 15 minutes
const SESSION = '3650d';            // until they sign out
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE|ARRSHIP|LOADED|SPOT)/i;
const BOOKED = /^(DISP|ASSGN|AVAIL|PLAN|PEND|BOOK)/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const norm = (x) => String(x || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];

// The driver's loads on the board by their TruckMate driver ID: rolling now, then booked next. Pure.
export function loadsFor(code, items = []) {
  const mine = items.filter((it) => [tripOf(it).driver, tripOf(it).driver2].some((c) => c && norm(c) === norm(code)) && !DONE.test(String(tripOf(it).status || '')));
  const brief = (it) => { const t = tripOf(it); return { trip: tripNo(it), status: t.status || null, truck: t.powerUnit || null, trailer: t.trailer || null, from: t.origZoneDesc || null, to: t.destZoneDesc || null, stops: billsOf(it).slice(0, 20).map((b) => ({ bill: b.billNumber || null, to: b.endZoneDescription || null, customer: b.billToName || null, deliverBy: b.deliverBy || null, pieces: b.pieces != null ? Number(b.pieces) : null, delivered: !!b.actualDelivery })) }; };
  return { current: mine.filter((it) => ROLLING.test(String(tripOf(it).status || ''))).map(brief), next: mine.filter((it) => BOOKED.test(String(tripOf(it).status || ''))).map(brief) };
}

export function initDriverAuth(app, { requireAuth, db, sign, roster, getBoard, docsLink = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const tripsKey = (code) => `taDriverTrips:${SITE}:${norm(code)}`;
  const byCode = async (code) => (await roster()).find((d) => norm(d.code) === norm(code)) || null;
  const misses = new Map();   // phone or connection → wrong tries in the last 15 minutes
  const tooMany = (k) => (misses.get(k) || []).filter((t) => now() - t < 15 * MIN).length >= MAX_TRIES;
  const miss = (k) => misses.set(k, [...(misses.get(k) || []).filter((t) => now() - t < 15 * MIN), now()]);

  app.post('/driver/auth/login', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const id = String((req.body && req.body.driverId) || '').trim(); const p = last10(req.body && req.body.phone);
    if (!id || !p) return res.status(400).json({ error: 'Enter your driver ID and your 10-digit cell number.' });
    const ip = String(req.ip || 'unknown');
    if (tooMany(p) || tooMany(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes or call dispatch.' });
    try {
      const d = await byCode(id);
      if (!d || last10(d.phone) !== p) { miss(p); miss(ip); return res.status(401).json({ error: 'That driver ID and cell don\'t match what dispatch has. Call dispatch.' }); }
      const user = { role: 'driver', driverCode: norm(d.code), name: d.name, phone: p };
      return res.json({ token: sign(user, SESSION), name: d.name });
    } catch { return res.status(503).json({ error: 'Could not check. Try again.' }); }
  });

  // a signed-in driver who is still on the roster
  const requireDriver = (req, res, next) => requireAuth(req, res, async () => {
    if (!req.user || req.user.role !== 'driver') return res.status(403).json({ error: 'Driver sign-in only.' });
    try {
      const d = await byCode(req.user.driverCode);
      if (!d || last10(d.phone) !== req.user.phone) return res.status(401).json({ error: 'Sign in again.' });
      req.driver = d; return next();
    } catch { return res.status(503).json({ error: 'Could not check your profile. Try again.' }); }
  });
  const board = async () => (((await getBoard(SITE)) || {}).trips || []);

  app.get('/driver/me', requireDriver, async (req, res) => {
    try {
      const loads = loadsFor(req.driver.code, await board());
      const trips = [...loads.current, ...loads.next].map((l) => l.trip);
      if (trips.length) await db.update(tripsKey(req.driver.code), (cur) => [...new Set([...trips, ...(Array.isArray(cur) ? cur : [])])].slice(0, 300), []);
      res.json({ name: req.driver.name, driverId: req.driver.code, ...loads });
    } catch (e) { res.status(502).json({ error: 'Could not load your loads. Try again.' }); }
  });
  // a load's own driver page (paperwork, messages): only for a load that's theirs
  app.post('/driver/me/loads/:trip/link', requireDriver, async (req, res) => {
    const trip = String(req.params.trip);
    const loads = loadsFor(req.driver.code, await board());
    if (![...loads.current, ...loads.next].some((l) => l.trip === trip)) return res.status(404).json({ error: 'That load is not yours.' });
    if (!docsLink) return res.status(503).json({ error: 'Not available right now.' });
    const url = await docsLink(SITE, trip, `${req.driver.name} (driver profile)`);
    return url ? res.json({ token: url.split('/t/')[1] }) : res.status(503).json({ error: 'Not available right now.' });
  });
  app.get('/driver/me/paperwork', requireDriver, async (req, res) => {
    const mine = new Set((await db.get(tripsKey(req.driver.code), [])) || []);
    const list = ((await db.get(`taDriverPaperwork:${SITE}`, [])) || []).filter((p) => mine.has(String(p.trip))).slice(0, 100).map(({ docIds, ...p }) => p);
    res.json({ paperwork: list });
  });
  return { requireDriver };
}
